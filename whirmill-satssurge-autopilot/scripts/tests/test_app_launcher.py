import fcntl
import importlib.util
import json
import pathlib
import sqlite3
import subprocess
import os
import signal
import time
import contextlib
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from app_launcher import transition
from checkpoint import FILES, capture, schema_identity
from maintenance_lock import acquire, lock_file, writer_lock


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.data = pathlib.Path(self.temp.name)
        self.calls = 0

    def tearDown(self):
        self.temp.cleanup()

    def migrate(self):
        self.calls += 1
        for name in FILES:
            with contextlib.closing(sqlite3.connect(self.data / name)) as connection:
                connection.execute('CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY, value TEXT)')
                connection.execute("INSERT OR IGNORE INTO receipts VALUES('original','synthetic-identity-submission-oauth')")
                connection.execute('PRAGMA user_version=1')
                connection.commit()

    def test_fresh_upgrade_and_restart_preserve_baseline(self):
        first = transition(self.data, self.data, 'release-a', self.migrate)
        self.assertEqual(first['phase'], 'ready')
        transition(self.data, self.data, 'release-a', self.migrate)
        self.assertEqual(self.calls, 1)
        second = transition(self.data, self.data, 'release-b', self.migrate)
        baseline = self.data / second['baseline']
        digest = (baseline / 'manifest.json').read_bytes()
        transition(self.data, self.data, 'release-b', self.migrate)
        self.assertEqual(self.calls, 2)
        self.assertEqual((baseline / 'manifest.json').read_bytes(), digest)
        for name in FILES:
            with contextlib.closing(sqlite3.connect(baseline / name)) as db:
                self.assertEqual(db.execute('SELECT id FROM receipts').fetchone()[0], 'original')

    def test_schema6_to7_storage_transition_keeps_current_baseline_and_same_fingerprint_guard(self):
        def original_schema6():
            for name in FILES:
                with contextlib.closing(sqlite3.connect(self.data / name)) as db:
                    db.execute('CREATE TABLE original_receipts(id TEXT PRIMARY KEY, value TEXT)')
                    db.execute("INSERT INTO original_receipts VALUES('original', 'synthetic-original-identity')")
                    db.execute('PRAGMA user_version=6')
                    db.commit()
        transition(self.data, self.data, 'schema6-release', original_schema6)
        def migration():
            with contextlib.closing(sqlite3.connect(self.data / 'operational.sqlite')) as db:
                db.execute('CREATE TABLE canonical_fixture(id TEXT PRIMARY KEY, original_digest TEXT)')
                db.execute('PRAGMA user_version=7')
                db.commit()
        state = transition(self.data, self.data, 'schema7-release', migration)
        baseline = self.data / state['baseline']
        with contextlib.closing(sqlite3.connect(baseline / 'operational.sqlite')) as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 6)
        transition(self.data, self.data, 'schema7-release', migration)
        with contextlib.closing(sqlite3.connect(self.data / 'operational.sqlite')) as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 7)
            self.assertEqual(db.execute('SELECT value FROM original_receipts').fetchone()[0], 'synthetic-original-identity')
            db.execute('PRAGMA user_version=6')
        with self.assertRaisesRegex(ValueError, 'schema identity'):
            transition(self.data, self.data, 'schema7-release', migration)

    def test_migration_crash_retry_never_recaptures_partial_state(self):
        transition(self.data, self.data, 'a', self.migrate)
        def partial():
            with contextlib.closing(sqlite3.connect(self.data / FILES[0])) as db:
                db.execute('PRAGMA user_version=2')
            raise RuntimeError('synthetic crash')
        with self.assertRaises(RuntimeError):
            transition(self.data, self.data, 'b', partial)
        state = json.loads((self.data / 'lifecycle.json').read_text())
        digest = (self.data / state['baseline'] / 'manifest.json').read_bytes()
        transition(self.data, self.data, 'b', self.migrate)
        self.assertEqual((self.data / state['baseline'] / 'manifest.json').read_bytes(), digest)
        with contextlib.closing(sqlite3.connect(self.data / state['baseline'] / FILES[0])) as db:
            self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], 1)

    def test_interrupted_capture_is_discarded_and_retried(self):
        transition(self.data, self.data, 'a', self.migrate)
        def partial(source, target, **kwargs):
            target.mkdir(parents=True)
            (target / FILES[0]).write_bytes(b'partial')
            raise MemoryError('synthetic OOM')
        with patch('app_launcher.capture', side_effect=partial):
            with self.assertRaises(MemoryError):
                transition(self.data, self.data, 'b', self.migrate)
        interrupted = json.loads((self.data / 'lifecycle.json').read_text())
        self.assertEqual((interrupted['phase'], self.calls), ('capturing', 1))
        state = transition(self.data, self.data, 'b', self.migrate)
        self.assertEqual((state['phase'], self.calls), ('ready', 2))
        self.assertFalse((self.data / interrupted['baseline']).exists())
        self.assertTrue((self.data / state['baseline'] / 'manifest.json').is_file())

    def test_interrupted_capture_can_return_to_source_release(self):
        transition(self.data, self.data, 'a', self.migrate)
        with patch('app_launcher.capture', side_effect=OSError('disk full')):
            with self.assertRaises(OSError):
                transition(self.data, self.data, 'b', self.migrate)
        state = transition(self.data, self.data, 'a', self.migrate)
        self.assertEqual((state['phase'], state['destination'], self.calls), ('ready', 'a', 1))

    def test_code_only_release_skips_baseline(self):
        transition(self.data, self.data, 'a', self.migrate)
        current = {name: {'userVersion': 1, 'durableVersion': None} for name in FILES}
        state = transition(self.data, self.data, 'b', self.migrate, targets=current)
        self.assertEqual((state['phase'], state['baseline'], self.calls), ('ready', None, 2))
        self.assertFalse((self.data / 'checkpoints').exists())

    def test_legacy_requires_exact_qualified_baseline(self):
        self.migrate()
        with self.assertRaises(FileNotFoundError):
            transition(self.data, self.data, 'b', self.migrate)
        manifest = capture(self.data, self.data / 'legacy-fixture')
        (self.data / 'offline-cutover.json').write_text(json.dumps({
            'protocol': 1, 'source': 'legacy-fixture-release', 'destination': 'b',
            'fence': 'offline-exclusive-v1', 'writers': {'app': 'stopped', 'lm-backfill': 'disabled'},
            'schemas': {name: schema_identity(self.data / name) for name in FILES}, 'files': manifest['files']}))
        transition(self.data, self.data, 'b', self.migrate)
        self.assertEqual(self.calls, 2)

    def test_backfill_shared_fence_excludes_checkpoint(self):
        with writer_lock(self.data):
            with lock_file(self.data, 'maintenance.lock') as other:
                with self.assertRaises(TimeoutError):
                    acquire(other, fcntl.LOCK_EX, timeout=.05)
        with lock_file(self.data, 'maintenance.lock') as other:
            acquire(other, fcntl.LOCK_EX, timeout=.05)
            with self.assertRaises(TimeoutError):
                with writer_lock(self.data, timeout=.05):
                    self.fail('exclusive fence was bypassed')

    def test_new_release_cannot_take_over_interrupted_transition(self):
        with patch('app_launcher.atomic_json', side_effect=OSError('full')):
            with self.assertRaises(OSError):
                transition(self.data, self.data, 'a', self.migrate)
        self.assertEqual(self.calls, 0)

    def test_inherited_locks_survive_launcher_sigkill(self):
        child_pid = self.data / 'child-pid'
        scripts = str(pathlib.Path(__file__).resolve().parents[1])
        code = """import sys, pathlib, subprocess, fcntl, time
sys.path.insert(0, sys.argv[1])
from maintenance_lock import lock_file, acquire
root=pathlib.Path(sys.argv[2])
executor=lock_file(root,'executor.lock'); acquire(executor,fcntl.LOCK_EX)
maintenance=lock_file(root,'maintenance.lock'); acquire(maintenance,fcntl.LOCK_SH)
child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)'],pass_fds=(executor.fileno(),maintenance.fileno()))
(root/'child-pid').write_text(str(child.pid))
time.sleep(30)
"""
        wrapper = subprocess.Popen([sys.executable, '-c', code, scripts, str(self.data)])
        pid = None
        try:
            deadline = time.monotonic() + 3
            while not child_pid.exists() and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertTrue(child_pid.exists())
            pid = int(child_pid.read_text())
            wrapper.kill()
            wrapper.wait(timeout=3)
            with lock_file(self.data, 'executor.lock') as executor:
                with self.assertRaises(TimeoutError):
                    acquire(executor, fcntl.LOCK_EX, timeout=.05)
            with lock_file(self.data, 'maintenance.lock') as maintenance:
                with self.assertRaises(TimeoutError):
                    acquire(maintenance, fcntl.LOCK_EX, timeout=.05)
        finally:
            if wrapper.poll() is None:
                wrapper.kill(); wrapper.wait(timeout=3)
            if pid:
                os.kill(pid, signal.SIGTERM)
                deadline = time.monotonic() + 3
                with lock_file(self.data, 'executor.lock') as executor:
                    acquire(executor, fcntl.LOCK_EX, timeout=3)

    def test_release_cycle_keeps_newest_two_baselines_and_manual_checkpoints(self):
        states = [transition(self.data, self.data, 'a', self.migrate)]
        manual = self.data / 'checkpoints' / 'pre-021-manual'
        manual.mkdir(parents=True)
        (manual / 'manifest.json').write_text('{"capturedAt": "2000-01-01T00:00:00.000Z"}')
        states += [transition(self.data, self.data, release, self.migrate) for release in ('b', 'a', 'b')]
        paths = [state['baseline'] for state in states if state['baseline']]
        self.assertEqual(len(set(paths)), 3)
        self.assertEqual([(self.data / path).exists() for path in paths], [False, True, True])
        self.assertTrue(manual.exists())
        kept = (self.data / paths[-1] / 'manifest.json').read_bytes()
        retry = transition(self.data, self.data, 'b', self.migrate)
        self.assertEqual(retry['transitionId'], states[-1]['transitionId'])
        self.assertEqual((self.data / paths[-1] / 'manifest.json').read_bytes(), kept)
        self.assertEqual(self.calls, 4)

    def test_sigterm_during_actual_main_migration_forwards_reaps_and_releases(self):
        fixture = self.data / 'fixture'
        fixture.mkdir()
        data = fixture / 'data'
        data.mkdir()
        pid_file, term_file = fixture / 'pid', fixture / 'term'
        node = fixture / 'node'
        node.write_text('''#!/usr/bin/env python3
import os, pathlib, signal, sys, time
pathlib.Path(os.environ['FIXTURE_PID']).write_text(str(os.getpid()))
def stop(number, frame):
    pathlib.Path(os.environ['FIXTURE_TERM']).write_text(str(number))
    sys.exit(0)
signal.signal(signal.SIGTERM, stop)
time.sleep(30)
''')
        node.chmod(0o700)
        scripts = str(pathlib.Path(__file__).resolve().parents[1])
        code = "import os,sys; sys.path.insert(0,sys.argv[1]); import app_launcher; os.getuid=lambda:1000; app_launcher.main()"
        env = {**os.environ, 'PATH': str(fixture) + os.pathsep + os.environ['PATH'],
               'DATA_DIR': str(data), 'FIXTURE_PID': str(pid_file), 'FIXTURE_TERM': str(term_file)}
        wrapper = subprocess.Popen([sys.executable, '-c', code, scripts], env=env, stderr=subprocess.DEVNULL)
        pid = None
        try:
            deadline = time.monotonic() + 3
            while not pid_file.exists() and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertTrue(pid_file.exists())
            pid = int(pid_file.read_text())
            self.assertEqual(json.loads((data / 'lifecycle.json').read_text())['phase'], 'migrating')
            wrapper.terminate()
            self.assertNotEqual(wrapper.wait(timeout=7), 0)
            self.assertEqual(term_file.read_text(), str(signal.SIGTERM))
            with self.assertRaises(ProcessLookupError):
                os.kill(pid, 0)
            with lock_file(data, 'executor.lock') as executor:
                acquire(executor, fcntl.LOCK_EX, timeout=.1)
            with lock_file(data, 'maintenance.lock') as maintenance:
                acquire(maintenance, fcntl.LOCK_EX, timeout=.1)
            self.assertEqual(json.loads((data / 'lifecycle.json').read_text())['phase'], 'migrating')
        finally:
            if wrapper.poll() is None:
                wrapper.kill(); wrapper.wait(timeout=3)
            if pid:
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass

    def test_signal_during_spawn_registration_is_queued_and_child_reaped(self):
        from app_launcher import ChildSupervisor
        original = subprocess.Popen
        children = []
        def race(*args, **kwargs):
            child = original(*args, **kwargs)
            children.append(child)
            os.kill(os.getpid(), signal.SIGTERM)
            return child
        with ChildSupervisor() as supervisor:
            with patch('app_launcher.subprocess.Popen', side_effect=race):
                with self.assertRaises(InterruptedError):
                    supervisor.run([sys.executable, '-c', 'import time; time.sleep(30)'], timeout=3)
        self.assertIsNotNone(children[0].returncode)
        with self.assertRaises(ProcessLookupError):
            os.kill(children[0].pid, 0)

    def test_migration_deadline_kills_and_reaps_unresponsive_child(self):
        from app_launcher import ChildSupervisor
        original = subprocess.Popen
        children = []
        def observe(*args, **kwargs):
            child = original(*args, **kwargs)
            children.append(child)
            return child
        started = time.monotonic()
        with ChildSupervisor() as supervisor, patch('app_launcher.subprocess.Popen', side_effect=observe):
            with self.assertRaises(subprocess.TimeoutExpired):
                supervisor.run([sys.executable, '-c', 'import time; time.sleep(30)'], timeout=.1)
        self.assertLess(time.monotonic() - started, 2)
        self.assertIsNotNone(children[0].returncode)
        with self.assertRaises(ProcessLookupError):
            os.kill(children[0].pid, 0)
