import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest

spec = importlib.util.spec_from_file_location('voice_worker', Path(__file__).parents[1] / 'worker.py')
w = importlib.util.module_from_spec(spec)
spec.loader.exec_module(w)

class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.root.chmod(0o700)
        self.attempt = 'a' * 32
        self.request = {'protocol': 1, 'runtime': w.RUNTIME, 'model': w.MODEL, 'language': 'it', 'decoder': w.DECODER, 'attempt': self.attempt, 'bytes': 4, 'duration': 2, 'audioHash': w.digest(b'abcd')}
        w.STOP = False
    def tearDown(self):
        self.temp.cleanup()
    def publish(self):
        w.atomic(self.root, self.attempt + '.request.json', self.request)
        return self.root / (self.attempt + '.request.json')
    def result(self):
        return json.loads(w.read_regular(self.root / (self.attempt + '.result.json'), 65536))
    def test_manifest_freezes_hash_and_duplicate_does_not_transform(self):
        path = self.publish()
        calls = []
        transform = lambda *_: calls.append(1) or 'Una domanda italiana'
        w.handle(self.root, path, None, lambda: None, transform)
        r = self.result()
        self.assertEqual(r['status'], 'ok')
        self.assertEqual(r['requestHash'], w.digest(path.read_bytes()))
        self.assertEqual(r['transcriptHash'], w.digest('Una domanda italiana'.encode()))
        self.assertEqual(r['release'], 'confirmed')
        w.handle(self.root, path, None, lambda: None, transform)
        self.assertEqual(len(calls), 1)
    def test_model_mismatch_and_request_pins_fail_closed(self):
        model = self.root / 'model'
        model.write_bytes(b'bad')
        model.chmod(0o444)
        with self.assertRaises(w.Held):
            w.verify_model(model)
        for key, value in [('runtime', 'wrong'), ('model', 'wrong'), ('language', 'en'), ('duration', 121), ('bytes', 0), ('attempt', '../outside')]:
            bad = {**self.request, key: value}
            with self.subTest(key=key), self.assertRaises(w.Closed):
                w.validate_request(json.dumps(bad).encode(), self.attempt)
    def test_symlink_world_readable_and_hardlink_refused(self):
        original = self.root / 'original'
        original.write_bytes(b'private')
        with self.assertRaises(w.Closed):
            w.read_regular(original, 100)
        original.chmod(0o600)
        link = self.root / 'link'
        link.symlink_to(original)
        with self.assertRaises(OSError):
            w.read_regular(link, 100)
        link.unlink()
        os.link(original, link)
        with self.assertRaises(w.Closed):
            w.read_regular(original, 100)
    def test_metadata_codec_streams_duration_and_forged_bounds(self):
        valid = {'format': {'format_name': 'ogg', 'duration': '2.0'}, 'streams': [{'codec_type': 'audio', 'codec_name': 'opus', 'channels': 1}]}
        self.assertEqual(w.metadata(json.dumps(valid), 2), 2)
        for bad in [b'broken', json.dumps({**valid, 'format': {'format_name': 'mp3', 'duration': '2'}}), json.dumps({**valid, 'format': {'format_name': 'ogg', 'duration': 'nan'}}), json.dumps({**valid, 'format': {'format_name': 'ogg', 'duration': '121'}}), json.dumps({**valid, 'streams': []})]:
            with self.assertRaises(w.Closed):
                w.metadata(bad, 2)
    def test_cancel_tombstone_prevents_transform(self):
        path = self.publish()
        w.atomic(self.root, self.attempt + '.cancel.json', {'attempt': self.attempt})
        w.handle(self.root, path, None, lambda: None, lambda *_: self.fail('Cancelled work executed'))
        self.assertEqual(self.result()['status'], 'cancelled')
    def test_uncertain_process_release_has_no_result(self):
        path = self.publish()
        def uncertain(*_):
            raise w.Held('child_release_unknown')
        with self.assertRaises(w.Held):
            w.handle(self.root, path, None, lambda: None, uncertain)
        self.assertFalse((self.root / (self.attempt + '.result.json')).exists())
    def test_timeout_and_output_overflow_reap_owned_child(self):
        for mode in ['timeout', 'overflow', 'cancel']:
            pidfile = self.root / ('pid-' + mode)
            script = "import os,time;open(%r,'w').write(str(os.getpid()));%s" % (str(pidfile), "print('x'*10000,flush=True);time.sleep(10)" if mode == 'overflow' else 'time.sleep(10)')
            started = time.monotonic()
            with self.subTest(mode=mode), self.assertRaises(w.Closed):
                w.run([sys.executable, '-c', script], 0.3, 100, lambda: mode == 'cancel' and time.monotonic()-started > 0.1, lambda: None)
            self.assertLess(time.monotonic()-started, 2.5)
            pid = int(pidfile.read_text())
            with self.assertRaises(ProcessLookupError):
                os.kill(pid, 0)
    def test_process_lock_survives_supervisor_death_until_owned_child_exits(self):
        # The supervisor passes its lock fd to child; a replacement cannot run
        # while that actual child is still alive after supervisor SIGKILL.
        lock = self.root / 'lock'
        pidfile = self.root / 'child'
        script = "import os,fcntl,subprocess,time;f=os.open(%r,os.O_CREAT|os.O_RDWR,0o600);fcntl.flock(f,fcntl.LOCK_EX);p=subprocess.Popen(['%s','-c','import time;time.sleep(10)'],pass_fds=(f,),start_new_session=True);open(%r,'w').write(str(p.pid));time.sleep(10)" % (str(lock), sys.executable, str(pidfile))
        p = subprocess.Popen([sys.executable, '-c', script], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        child = None
        try:
            until = time.monotonic()+2
            while not pidfile.exists() and time.monotonic()<until:
                time.sleep(0.01)
            child = int(pidfile.read_text())
            p.kill()
            p.wait(timeout=2)
            import fcntl
            fd = os.open(lock, os.O_RDWR)
            try:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(fd, fcntl.LOCK_EX|fcntl.LOCK_NB)
            finally:
                os.close(fd)
        finally:
            if p.poll() is None:
                p.kill()
                p.wait(timeout=2)
            if child:
                try:
                    os.killpg(child, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                until = time.monotonic() + 2
                while True:
                    try:
                        os.killpg(child, 0)
                    except ProcessLookupError:
                        break
                    self.assertLess(time.monotonic(), until, 'Owned child group did not exit')
                    time.sleep(0.01)
                import fcntl
                fd = os.open(lock, os.O_RDWR)
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                finally:
                    os.close(fd)
    def test_failure_receipt_does_not_contain_private_error(self):
        path = self.publish()
        def bad(*_):
            raise RuntimeError('private transcript token URL payload')
        w.handle(self.root, path, None, lambda: None, bad)
        raw = (self.root / (self.attempt + '.result.json')).read_text()
        self.assertNotIn('private', raw)
        self.assertEqual(self.result()['status'], 'failed')

if __name__ == '__main__':
    unittest.main()
