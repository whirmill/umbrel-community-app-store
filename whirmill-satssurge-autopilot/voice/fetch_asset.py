"""Build-only bounded immutable assets. Never copied into the runtime image."""
import hashlib
import os
from pathlib import Path
import sys
import time
import urllib.request

ASSETS = {
    'whisper.tar.gz': ('https://codeload.github.com/ggml-org/whisper.cpp/tar.gz/d1be6fde11ac6e0407606b4e42fe72d34add8037', 9631456, '645445da884df6dbd52b30f82d7be7c01d1767c938714e477e786b88d529e9f4'),
    'ffmpeg.tar.xz': ('https://ffmpeg.org/releases/ffmpeg-7.1.1.tar.xz', 11019500, '733984395e0dbbe5c046abda2dc49a5544e7e0e1e2366bba849222ae9e3a03b1'),
    'ggml-base.bin': ('https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.bin', 147951465, '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe'),
}

def fetch(output, url, expected_bytes, expected_hash, opener=urllib.request.urlopen):
    output = Path(output)
    temporary = output.with_name(output.name + '.download-' + os.urandom(8).hex())
    until = time.monotonic() + 600
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        h, size = hashlib.sha256(), 0
        with os.fdopen(fd, 'wb', closefd=False) as target, opener(url, timeout=30) as response:
            while True:
                if time.monotonic() >= until:
                    raise ValueError('asset_timeout')
                chunk = response.read(min(1024 * 1024, expected_bytes-size+1))
                if not chunk:
                    break
                size += len(chunk)
                if size > expected_bytes:
                    raise ValueError('asset_size')
                h.update(chunk)
                target.write(chunk)
            if size != expected_bytes or h.hexdigest() != expected_hash:
                raise ValueError('asset_integrity')
            target.flush()
            os.fsync(fd)
        os.replace(temporary, output)
        output.chmod(0o444)
    finally:
        os.close(fd)
        temporary.unlink(missing_ok=True)

if __name__ == '__main__':
    try:
        name = sys.argv[1]
        url, size, sha = ASSETS[name]
        fetch(name, url, size, sha)
    except Exception:
        raise SystemExit('Immutable asset unavailable or integrity check failed') from None
