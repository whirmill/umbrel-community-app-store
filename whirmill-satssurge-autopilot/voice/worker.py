"""Offline finite voice transformer. No app DB, credentials, network or admission API."""
import array
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import selectors
import signal
import stat
import subprocess
import tempfile
import time
import wave

RUNTIME = 'd1be6fde11ac6e0407606b4e42fe72d34add8037'
MODEL = '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe'
DECODER = 'ffmpeg-7.1.1-ogg-opus-pcm16-v1'
MODEL_BYTES = 147951465
MAX_AUDIO = 10 * 1024 * 1024
MAX_PCM = 3840000
ATTEMPT = re.compile(r'^[a-f0-9]{32}$')
STOP = False
LOCK_FD = None

class Held(Exception):
    pass

class Closed(Exception):
    pass

def digest(data):
    return hashlib.sha256(data).hexdigest()

def read_regular(path, cap):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        s = os.fstat(fd)
        if not stat.S_ISREG(s.st_mode) or s.st_uid != os.getuid() or s.st_nlink != 1 or s.st_mode & 0o077 or s.st_size > cap:
            raise Closed('file_invalid')
        with os.fdopen(fd, 'rb', closefd=False) as f:
            data = f.read(cap + 1)
        if len(data) > cap:
            raise Closed('file_invalid')
        return data
    finally:
        os.close(fd)

def atomic(root, name, value):
    data = json.dumps(value, separators=(',', ':'), ensure_ascii=False).encode()
    if len(data) > 65536:
        raise Closed('result_size')
    temp = root / (name + '.tmp-' + os.urandom(8).hex())
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb', closefd=False) as f:
            f.write(data)
            f.flush()
            os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(temp, root / name)
    fd = os.open(root, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)

def verify_model(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        s = os.fstat(fd)
        if not stat.S_ISREG(s.st_mode) or s.st_size != MODEL_BYTES or s.st_mode & 0o222:
            raise Held('model_invalid')
        h = hashlib.sha256()
        with os.fdopen(fd, 'rb', closefd=False) as f:
            for part in iter(lambda: f.read(1024 * 1024), b''):
                h.update(part)
        if h.hexdigest() != MODEL:
            raise Held('model_invalid')
    finally:
        os.close(fd)

def read_asset(path, cap):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        s = os.fstat(fd)
        if not stat.S_ISREG(s.st_mode) or s.st_uid != 0 or s.st_mode & 0o022 or s.st_size > cap:
            raise Held('runtime_invalid')
        with os.fdopen(fd, 'rb', closefd=False) as f:
            data = f.read(cap + 1)
        if len(data) > cap:
            raise Held('runtime_invalid')
        return data
    finally:
        os.close(fd)

def verify_runtime(directory):
    manifest = json.loads(read_asset(directory / 'runtime-manifest.json', 4096))
    if manifest.get('runtime') != RUNTIME or manifest.get('decoder') != DECODER:
        raise Held('runtime_invalid')
    for name in ('whisper-cli', 'ffmpeg', 'ffprobe'):
        data = read_asset(directory / name, 100 * 1024 * 1024)
        if digest(data) != manifest.get('files', {}).get(name):
            raise Held('runtime_invalid')

def terminate(p):
    # Close the whole owned process group, including an unexpected descendant.
    # Reaping only its leader would not establish cancellation closure.
    try:
        os.killpg(p.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    try:
        p.wait(timeout=2)
    except subprocess.TimeoutExpired:
        raise Held('child_release_unknown')
    until = time.monotonic() + 2
    while True:
        try:
            os.killpg(p.pid, 0)
        except ProcessLookupError:
            return
        if time.monotonic() >= until:
            raise Held('child_release_unknown')
        time.sleep(0.01)

def run(argv, deadline, cap, cancelled, heartbeat, output_guard=lambda: True):
    p = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                         start_new_session=True, pass_fds=(() if LOCK_FD is None else (LOCK_FD,)), env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'OMP_NUM_THREADS': '2'})
    data = bytearray()
    sel = selectors.DefaultSelector()
    sel.register(p.stdout, selectors.EVENT_READ)
    until = time.monotonic() + deadline
    try:
        eof = False
        while not eof or p.poll() is None:
            heartbeat()
            if STOP or cancelled() or time.monotonic() >= until or not output_guard():
                raise Closed('cancelled_or_timeout')
            for key, _ in sel.select(0.05):
                chunk = os.read(key.fileobj.fileno(), 65536)
                if not chunk:
                    eof = True
                    sel.unregister(key.fileobj)
                else:
                    data.extend(chunk)
                    if len(data) > cap:
                        raise Closed('output_bound')
        if p.wait() != 0:
            raise Closed('transform_failed')
        return bytes(data)
    finally:
        terminate(p)
        sel.close()
        p.stdout.close()

def metadata(data, declared):
    try:
        m = json.loads(data)
        streams = m['streams']
        duration = float(m['format']['duration'])
        if m['format']['format_name'] != 'ogg' or len(streams) != 1 or streams[0]['codec_type'] != 'audio' or streams[0]['codec_name'] != 'opus' or streams[0]['channels'] not in (1, 2) or not math.isfinite(duration) or duration <= 0 or duration > 120 or abs(duration - declared) > 2:
            raise ValueError()
    except (ValueError, KeyError, TypeError):
        raise Closed('media_invalid') from None
    return duration

def transcribe(root, request, model, heartbeat):
    attempt = request['attempt']
    cancelled = lambda: (root / (attempt + '.cancel.json')).exists()
    audio = read_regular(root / (attempt + '.ogg'), MAX_AUDIO)
    if len(audio) != request['bytes'] or digest(audio) != request['audioHash']:
        raise Closed('audio_invalid')
    with tempfile.TemporaryDirectory(prefix='voice-', dir='/tmp') as temporary:
        directory = Path(temporary)
        original = directory / 'audio.ogg'
        original.write_bytes(audio)
        original.chmod(0o600)
        probe = run(['/opt/voice/ffprobe', '-v', 'error', '-show_format', '-show_streams', '-of', 'json', str(original)], 5, 16384, cancelled, heartbeat)
        duration = metadata(probe, request['duration'])
        pcm = run(['/opt/voice/ffmpeg', '-v', 'error', '-nostdin', '-threads', '2', '-i', str(original), '-map', '0:a:0', '-ac', '1', '-ar', '16000', '-f', 's16le', 'pipe:1'], 15, MAX_PCM, cancelled, heartbeat)
        if not pcm or len(pcm) % 2 or len(pcm) > MAX_PCM or abs(len(pcm) / 32000 - duration) > 2:
            raise Closed('decoded_duration')
        samples = array.array('h', pcm)
        if math.sqrt(sum(x*x for x in samples) / len(samples)) < 100:
            raise Closed('silence')
        wav = directory / 'audio.wav'
        with wave.open(str(wav), 'wb') as f:
            f.setnchannels(1)
            f.setsampwidth(2)
            f.setframerate(16000)
            f.writeframes(pcm)
        output = directory / 'transcript'
        text_path = directory / 'transcript.txt'
        guard = lambda: not text_path.exists() or text_path.stat().st_size <= 65536
        run(['/opt/voice/whisper-cli', '-m', str(model), '-f', str(wav), '-l', 'it', '-t', '2', '-ng', '-np', '-nt', '-mc', '0', '-nf', '-otxt', '-of', str(output)], 120, 65536, cancelled, heartbeat, guard)
        if cancelled() or STOP:
            raise Closed('cancelled')
        data = text_path.read_bytes()
        if len(data) > 65536:
            raise Closed('transcript_bound')
        text = data.decode('utf-8').strip()
        if not text or len(text) > 16000 or '\x00' in text or text.lower() in ('[blank_audio]', '[silence]', '(silenzio)', '[musica]'):
            raise Closed('no_speech')
        return text

def validate_request(raw, attempt):
    r = json.loads(raw)
    if not ATTEMPT.fullmatch(attempt) or r.get('attempt') != attempt or r.get('protocol') != 1 or r.get('runtime') != RUNTIME or r.get('model') != MODEL or r.get('language') != 'it' or r.get('decoder') != DECODER or not isinstance(r.get('bytes'), int) or not 0 < r['bytes'] <= MAX_AUDIO or not isinstance(r.get('duration'), int) or not 0 < r['duration'] <= 120 or not re.fullmatch(r'[a-f0-9]{64}', r.get('audioHash', '')):
        raise Closed('request_invalid')
    return r

def handle(root, path, model, heartbeat, transform=transcribe):
    attempt = path.name.removesuffix('.request.json')
    if not ATTEMPT.fullmatch(attempt):
        return
    result = root / (attempt + '.result.json')
    if result.exists():
        return
    raw = read_regular(path, 4096)
    request_hash = digest(raw)
    status, text = 'failed', None
    try:
        r = validate_request(raw, attempt)
        if (root / (attempt + '.cancel.json')).exists() or STOP:
            status = 'cancelled'
        else:
            text = transform(root, r, model, heartbeat)
            status = 'cancelled' if (root / (attempt + '.cancel.json')).exists() or STOP else 'ok'
    except Held:
        # Unknown release must never be acknowledged as safe to retry.
        raise
    except Exception:
        status = 'failed'
    receipt = {'attempt': attempt, 'requestHash': request_hash, 'runtime': RUNTIME, 'model': MODEL, 'language': 'it', 'decoder': DECODER, 'release': 'confirmed', 'status': status}
    if status == 'ok':
        receipt.update(text=text, transcriptHash=digest(text.encode()))
    atomic(root, attempt + '.result.json', receipt)

def main():
    global STOP, LOCK_FD
    root = Path('/voice-spool')
    s = root.lstat()
    if not stat.S_ISDIR(s.st_mode) or s.st_uid != os.getuid() or s.st_mode & 0o077:
        raise Held('spool_invalid')
    model = Path('/opt/voice/ggml-base.bin')
    verify_model(model)
    verify_runtime(Path('/opt/voice'))
    lock_fd = os.open(root / 'worker.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    s = os.fstat(lock_fd)
    if not stat.S_ISREG(s.st_mode) or s.st_uid != os.getuid() or s.st_mode & 0o077 or s.st_nlink != 1:
        raise Held('lock_invalid')
    fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    LOCK_FD = lock_fd
    last = 0
    def heartbeat(force=False):
        nonlocal last
        if force or time.monotonic() - last >= 1:
            atomic(root, 'ready.json', {'protocol': 1, 'runtime': RUNTIME, 'model': MODEL, 'language': 'it', 'decoder': DECODER, 'state': 'ready', 'at': int(time.time()*1000)})
            last = time.monotonic()
    def stop(*_):
        global STOP
        STOP = True
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        while not STOP:
            heartbeat()
            for path in sorted(root.glob('*.request.json'), key=lambda p: p.stat().st_mtime_ns):
                if STOP:
                    break
                handle(root, path, model, heartbeat)
            time.sleep(0.1)
    finally:
        atomic(root, 'ready.json', {'protocol': 1, 'state': 'stopped', 'at': int(time.time()*1000)})
        os.close(lock_fd)

if __name__ == '__main__':
    try:
        main()
    except Exception:
        # No raw exception, transcript, audio, path, URL or credential in logs.
        raise SystemExit(1) from None
