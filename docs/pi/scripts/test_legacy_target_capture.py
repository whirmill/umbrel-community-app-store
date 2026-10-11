"""Finite synthetic fixtures; no Docker, app startup, network or host receipts."""
import contextlib
import fcntl
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import signal
import sqlite3
import stat
import sys
import tempfile
import time
import unittest
from unittest import mock

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[2] / 'whirmill-satssurge-autopilot'
SPEC = importlib.util.spec_from_file_location('legacy_target_capture', HERE / 'legacy-target-capture.py')
TOOL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(TOOL)
HELPERS = TOOL.load_helpers(ROOT)
CHECKPOINT, LAUNCHER, LOCKS = HELPERS
SOURCE = 'b081f6b091bc59f5c6500d527f5da79151f16cd8'
IMAGE = 'sha256:' + 'a' * 64  # Synthetic, NOT a qualified platform digest.


class CaptureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = pathlib.Path(self.temp.name).resolve()
        self.data = self.base / 'data'
        self.data.mkdir(mode=0o700)
        self.output = self.base / 'new-capture'
        self.expected = LAUNCHER.fingerprint(ROOT)
        self.budget = TOOL.Budget(30)
        for name in CHECKPOINT.FILES:
            with contextlib.closing(sqlite3.connect(self.data / name)) as db, db:
                db.execute('PRAGMA user_version=7')
                db.execute('CREATE TABLE receipts (id TEXT PRIMARY KEY, body TEXT)')
                db.execute('INSERT INTO receipts VALUES (?,?)', ('original-id', 'synthetic-not-for-output'))
                if name == 'durable.sqlite':
                    db.execute('CREATE TABLE durable_schema (singleton INTEGER PRIMARY KEY, version INTEGER)')
                    db.execute('INSERT INTO durable_schema VALUES (1,11)')
            os.chmod(self.data / name, 0o600)
        for name in ('owner.secret', 'telegram.secret'):
            (self.data / name).write_text('synthetic-not-for-output')
            os.chmod(self.data / name, 0o600)

    def run_pair(self, **changes):
        values = dict(data=self.data, output=self.output, root=ROOT, expected=self.expected,
                      source=SOURCE, image=IMAGE, helpers=HELPERS, budget=self.budget)
        values.update(changes)
        stream = io.StringIO()
        with contextlib.redirect_stdout(stream):
            code = TOOL.capture_pair(**values)
        return code, [json.loads(line) for line in stream.getvalue().splitlines()]

    def fenced(self):
        for name in ('executor.lock', 'maintenance-admission.lock', 'maintenance.lock'):
            with (self.data / name).open('r') as stream:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def test_real_helpers_double_capture_fences_rows_ddl_and_secrets(self):
        for name in ('executor.lock', 'maintenance-admission.lock', 'maintenance.lock'):
            (self.data / name).write_text('synthetic-stable-inode')
            (self.data / name).chmod(0o600)
        original_schemas = LAUNCHER.schemas(self.data)
        originals = {path.name: (path.read_bytes(), stat.S_IMODE(path.stat().st_mode), path.stat().st_ino)
                     for path in self.data.iterdir()}
        events = []
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        for module, name in ((CHECKPOINT, 'capture'), (CHECKPOINT, 'verify'), (LAUNCHER, 'schemas')):
            original = getattr(module, name)
            def wrapped(*args, _original=original, _name=name, **kwargs):
                self.fenced()
                events.append(_name)
                return _original(*args, **kwargs)
            stack.enter_context(mock.patch.object(module, name, side_effect=wrapped))
        original_emit = TOOL.emit
        def emit(value):
            self.fenced()
            original_emit(value)
        stack.enter_context(mock.patch.object(TOOL, 'emit', side_effect=emit))
        code, summaries = self.run_pair()
        stack.close()
        self.assertEqual(code, 0)
        self.assertEqual(events.count('capture'), 2)
        self.assertEqual(events.count('verify'), 2)
        self.assertEqual(summaries[0]['hostQualification'], 'HOLD')
        self.assertEqual(summaries[0]['schemas'], original_schemas)
        self.assertNotIn('synthetic-not-for-output', json.dumps(summaries))
        for label in ('capture-1', 'capture-2'):
            target = self.output / label
            self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o700)
            manifest = CHECKPOINT.verify(target)
            self.assertEqual(manifest['files'], summaries[0]['files'])
            for name in CHECKPOINT.FILES:
                self.assertEqual(hashlib.sha256((target / name).read_bytes()).hexdigest(), manifest['files'][name]['sha256'])
                with contextlib.closing(sqlite3.connect(target / name)) as db:
                    self.assertEqual(db.execute('SELECT id,body FROM receipts').fetchall(),
                                     [('original-id', 'synthetic-not-for-output')])
                self.assertEqual(stat.S_IMODE((target / name).stat().st_mode), 0o600)
        for name, (content, mode, inode) in originals.items():
            self.assertEqual((self.data / name).read_bytes(), content)
            self.assertEqual(stat.S_IMODE((self.data / name).stat().st_mode), mode)
            self.assertEqual((self.data / name).stat().st_ino, inode)
        self.assertFalse((self.data / 'offline-cutover.json').exists())
        self.assertFalse((self.data / 'lifecycle.json').exists())
        for name in ('executor.lock', 'maintenance-admission.lock', 'maintenance.lock'):
            with (self.data / name).open('r') as stream:
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def test_wal_pending_rows_preserved(self):
        db = sqlite3.connect(self.data / 'operational.sqlite')
        self.addCleanup(db.close)
        db.execute('PRAGMA journal_mode=WAL')
        db.execute('PRAGMA wal_autocheckpoint=0')
        db.execute('INSERT INTO receipts VALUES (?,?)', ('pending-durable-id', 'pending'))
        db.commit()
        before = {suffix: (self.data / ('operational.sqlite' + suffix)).read_bytes()
                  for suffix in ('', '-wal', '-shm')}
        shm_path = self.data / 'operational.sqlite-shm'
        shm_info = shm_path.stat()
        code, _ = self.run_pair()
        self.assertEqual(code, 0)
        for suffix in ('', '-wal'):
            self.assertEqual((self.data / ('operational.sqlite' + suffix)).read_bytes(), before[suffix])
        # Ordinary read-only SQLite may update SHM read marks, not DB/WAL rows.
        self.assertEqual((shm_path.stat().st_ino, shm_path.stat().st_size),
                         (shm_info.st_ino, shm_info.st_size))
        for label in ('capture-1', 'capture-2'):
            with contextlib.closing(sqlite3.connect(self.output / label / 'operational.sqlite')) as copy:
                self.assertEqual(copy.execute('SELECT id FROM receipts ORDER BY id').fetchall(),
                                 [('original-id',), ('pending-durable-id',)])

    def test_explicit_expectation_failure_before_modification(self):
        for changes in ({'expected': '0' * 64}, {'expected': ''}, {'source': ''}, {'image': 'latest'}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.run_pair(**changes)
        self.assertFalse(self.output.exists())
        self.assertFalse((self.data / 'executor.lock').exists())

    def test_missing_database_receipts_and_output_ambiguity_rejected(self):
        for marker in ('offline-cutover.json', 'lifecycle.json'):
            path = self.data / marker
            path.symlink_to(self.base / 'absent')
            with self.assertRaises(ValueError):
                self.run_pair()
            path.unlink()  # Fixture-owned only; never production lock/evidence.
        missing = self.data / 'oauth.sqlite'
        missing.rename(self.base / 'saved-oauth.sqlite')
        with self.assertRaises(FileNotFoundError):
            self.run_pair()
        (self.base / 'saved-oauth.sqlite').rename(missing)
        self.output.mkdir()
        with self.assertRaises(ValueError):
            self.run_pair()
        self.assertFalse((self.data / 'executor.lock').exists())

    def test_symlinks_nonregular_hardlinks_and_uri_paths_rejected(self):
        alias = self.base / 'alias'
        alias.symlink_to(self.data, target_is_directory=True)
        for value in (alias, alias / 'nested', str(self.data) + '/..',
                      str(self.data) + '?mode=rw', str(self.data) + '%2f..'):
            with self.subTest(path=value), self.assertRaises((ValueError, FileNotFoundError)):
                self.run_pair(data=value)
        output_alias = self.base / 'output-alias'
        output_alias.symlink_to(self.base, target_is_directory=True)
        with self.assertRaises(ValueError):
            self.run_pair(output=output_alias / 'new')
        for name in ('oauth.sqlite', 'operational.sqlite-wal', 'durable.sqlite-shm', 'executor.lock'):
            path = self.data / name
            saved = self.base / ('saved-' + name)
            if path.exists():
                path.rename(saved)
            for kind in ('symlink', 'fifo', 'hardlink'):
                if kind == 'symlink':
                    path.symlink_to(self.base / 'absent')
                elif kind == 'fifo':
                    os.mkfifo(path)
                else:
                    os.link(self.data / 'owner.secret', path)
                with self.subTest(name=name, kind=kind), self.assertRaises(ValueError):
                    self.run_pair()
                path.unlink()
            if saved.exists():
                saved.rename(path)
        self.assertFalse(self.output.exists())

    def test_output_overlap_permissions_and_captured_symlink_rejected(self):
        for output in (self.data, self.data / 'nested', self.base):
            with self.subTest(output=output), self.assertRaises(ValueError):
                self.run_pair(output=output)
        parent = self.base / 'public-parent'
        parent.mkdir(mode=0o777)
        parent.chmod(0o777)
        with self.assertRaises(PermissionError):
            self.run_pair(output=parent / 'new')
        original = CHECKPOINT.capture
        def alias_copy(*args, **kwargs):
            result = original(*args, **kwargs)
            path = args[1] / 'oauth.sqlite'
            path.rename(args[1] / 'saved-oauth.sqlite')
            path.symlink_to(self.data / 'oauth.sqlite')
            return result
        with mock.patch.object(CHECKPOINT, 'capture', side_effect=alias_copy):
            code, summaries = self.run_pair()
        self.assertEqual(code, 1)
        self.assertEqual(summaries[-1]['status'], 'HOLD')
        self.assertFalse((self.output / 'capture-2').exists())

    def test_installed_real_signals_and_timer_are_sticky(self):
        numbers = (signal.SIGTERM, signal.SIGINT, signal.SIGALRM)
        previous = {number: signal.getsignal(number) for number in numbers}
        timer = signal.getitimer(signal.ITIMER_REAL)
        try:
            for number in (signal.SIGTERM, signal.SIGINT):
                budget = TOOL.Budget(1)
                budget.install()
                os.kill(os.getpid(), number)  # Real handler latches without teardown.
                with self.assertRaises(InterruptedError):
                    budget.check()
                signal.setitimer(signal.ITIMER_REAL, 0)
            budget = TOOL.Budget(.03)
            budget.install()
            time.sleep(.2)
            with self.assertRaises(InterruptedError):
                budget.check()
            self.assertTrue(budget.stopped)
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            for number, handler in previous.items():
                signal.signal(number, handler)
            signal.setitimer(signal.ITIMER_REAL, *timer)

    def test_lock_contention_is_bounded_and_preserves_inode(self):
        with LOCKS.lock_file(self.data, 'maintenance.lock') as held:
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            inode = os.fstat(held.fileno()).st_ino
            self.budget = TOOL.Budget(.08)
            start = time.monotonic()
            code, summaries = self.run_pair()
            self.assertEqual(code, 1)
            self.assertLess(time.monotonic() - start, 2)
            self.assertEqual(summaries[-1]['status'], 'HOLD')
            self.assertEqual((self.data / 'maintenance.lock').stat().st_ino, inode)
            self.assertFalse(self.output.exists())

    def test_partial_capture_cancellation_retains_evidence_and_fenced_diagnostics(self):
        original = CHECKPOINT.capture
        original_emit = TOOL.emit
        def cancelled(*args, **kwargs):
            self.fenced()
            def stop():
                self.budget.interrupt(signal.SIGTERM, None)
                self.budget.check()
            kwargs['final_guard'] = stop
            return original(*args, **kwargs)
        def emit(value):
            self.fenced()
            original_emit(value)
        with mock.patch.object(CHECKPOINT, 'capture', side_effect=cancelled), mock.patch.object(TOOL, 'emit', side_effect=emit):
            code, summaries = self.run_pair()
        self.assertEqual(code, 1)
        self.assertEqual(summaries[-1]['status'], 'HOLD')
        self.assertEqual(set(path.name for path in (self.output / 'capture-1').iterdir()), set(CHECKPOINT.FILES))
        self.assertFalse((self.output / 'capture-2').exists())

    def test_signal_after_serialization_is_nonzero_hold(self):
        original_emit = TOOL.emit
        def emit(value):
            self.fenced()
            original_emit(value)
            if value['status'] == 'capture-only':
                self.budget.interrupt(signal.SIGINT, None)
        with mock.patch.object(TOOL, 'emit', side_effect=emit):
            code, summaries = self.run_pair()
        self.assertEqual(code, 1)
        self.assertEqual([item['status'] for item in summaries], ['capture-only', 'HOLD'])
        self.assertTrue((self.output / 'capture-2' / 'manifest.json').exists())

    def test_manifest_difference_and_source_schema_change_hold(self):
        original_capture = CHECKPOINT.capture
        count = 0
        def mutate(*args, **kwargs):
            nonlocal count
            result = original_capture(*args, **kwargs)
            count += 1
            if count == 1:
                # A deliberately non-cooperating fixture writer; never real data.
                with contextlib.closing(sqlite3.connect(self.data / 'oauth.sqlite')) as db, db:
                    db.execute("INSERT INTO receipts VALUES ('intruder','synthetic')")
            return result
        with mock.patch.object(CHECKPOINT, 'capture', side_effect=mutate):
            code, summaries = self.run_pair()
        self.assertEqual(code, 1)
        self.assertEqual(summaries[-1]['status'], 'HOLD')
        self.assertTrue((self.output / 'capture-2' / 'manifest.json').exists())
        other = self.base / 'schema-capture'
        def schema_mutate(*args, **kwargs):
            result = original_capture(*args, **kwargs)
            with contextlib.closing(sqlite3.connect(self.data / 'oauth.sqlite')) as db, db:
                db.execute('CREATE TABLE changed_schema (id INTEGER)')
            return result
        with mock.patch.object(CHECKPOINT, 'capture', side_effect=schema_mutate):
            code, summaries = self.run_pair(output=other)
        self.assertEqual(code, 1)
        self.assertEqual(summaries[-1]['status'], 'HOLD')
        self.assertFalse((other / 'capture-2').exists())

    def test_real_production_entrypoint_guard_cannot_be_hidden_by_fixture_use(self):
        args = ['capture', '--data', str(self.data), '--output', str(self.output),
                '--expected-fingerprint', self.expected, '--release-source', SOURCE, '--platform-digest', IMAGE]
        with mock.patch.object(sys, 'argv', args), mock.patch.object(TOOL, 'load_helpers') as load:
            with self.assertRaises(PermissionError):
                TOOL.main()  # REAL host PID/platform/UID/GID checks; not mocked.
            load.assert_not_called()
        self.assertFalse(self.output.exists())
        self.assertFalse((self.data / 'executor.lock').exists())
        for field, wrong in (('getpid', 2), ('getuid', 0), ('geteuid', 0), ('getgid', 0), ('getegid', 0)):
            with contextlib.ExitStack() as stack:
                stack.enter_context(mock.patch.object(sys, 'platform', 'linux'))
                for name in ('getpid', 'getuid', 'geteuid', 'getgid', 'getegid'):
                    stack.enter_context(mock.patch.object(os, name, return_value=wrong if name == field else (1 if name == 'getpid' else 1000)))
                with self.subTest(field=field), self.assertRaises(PermissionError):
                    TOOL.require_runtime()

    def test_first_real_signal_during_failure_diagnostic_retains_fences(self):
        numbers = (signal.SIGTERM, signal.SIGINT, signal.SIGALRM)
        previous = {number: signal.getsignal(number) for number in numbers}
        timer = signal.getitimer(signal.ITIMER_REAL)
        original_emit = TOOL.emit
        emitted = []
        def emit(value):
            self.fenced()
            os.kill(os.getpid(), signal.SIGTERM)
            self.fenced()
            original_emit(value)
            emitted.append(value['status'])
        try:
            self.budget.install()
            with mock.patch.object(CHECKPOINT, 'capture', side_effect=ValueError('synthetic failure')), mock.patch.object(TOOL, 'emit', side_effect=emit):
                code, summaries = self.run_pair()
            self.assertEqual(code, 1)
            self.assertEqual(emitted, ['HOLD'])
            self.assertEqual(summaries[0]['status'], 'HOLD')
            self.assertTrue(self.budget.stopped)
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            for number, handler in previous.items():
                signal.signal(number, handler)
            signal.setitimer(signal.ITIMER_REAL, *timer)

    def test_uninitialized_shm_rejects_before_sqlite_and_changed_extent_holds(self):
        path = self.data / 'operational.sqlite-shm'
        for size in (0, 1, 32767, 32769):
            path.write_bytes(bytes(size))
            identity = (path.stat().st_ino, path.stat().st_size)
            with mock.patch.object(LAUNCHER, 'schemas') as schemas, self.assertRaises(ValueError):
                self.run_pair()
            schemas.assert_not_called()
            self.assertEqual((path.stat().st_ino, path.stat().st_size), identity)
            self.assertFalse(self.output.exists())
        path.write_bytes(bytes(32768))
        original = CHECKPOINT.capture
        def enlarged(*args, **kwargs):
            result = original(*args, **kwargs)
            # Closed synthetic DELETE-journal fixture; no live mapped SHM is truncated.
            path.write_bytes(bytes(65536))
            return result
        with mock.patch.object(CHECKPOINT, 'capture', side_effect=enlarged):
            code, summaries = self.run_pair()
        self.assertEqual(code, 1)
        self.assertEqual(summaries[-1]['status'], 'HOLD')
        self.assertTrue((self.output / 'capture-1' / 'manifest.json').exists())
        self.assertFalse((self.output / 'capture-2').exists())
        self.assertEqual(path.stat().st_size, 65536)  # No reset/restore hides a failure.

    def test_real_signal_after_final_success_check_cannot_return_zero(self):
        numbers = (signal.SIGTERM, signal.SIGINT, signal.SIGALRM)
        previous = {number: signal.getsignal(number) for number in numbers}
        timer = signal.getitimer(signal.ITIMER_REAL)
        try:
            for number in numbers:
                budget = TOOL.Budget(30, exit_policy=True)
                budget.install()
                original_check = budget.check
                observed = []
                def check():
                    original_check()
                    if all(signal.getsignal(n) is signal.default_int_handler for n in numbers):
                        self.fenced()
                        observed.append(number)
                        os.kill(os.getpid(), number)  # After the final successful check.
                with mock.patch.object(budget, 'check', side_effect=check), self.assertRaises(KeyboardInterrupt):
                    self.run_pair(output=self.base / ('final-signal-' + str(number)), budget=budget)
                self.assertEqual(observed, [number])
                for name in ('executor.lock', 'maintenance-admission.lock', 'maintenance.lock'):
                    with (self.data / name).open('r') as stream:
                        fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            for number, handler in previous.items():
                signal.signal(number, handler)
            signal.setitimer(signal.ITIMER_REAL, *timer)

    def test_deadline_bounds_and_expired_budget_no_output(self):
        for seconds in (0, -1, 301, float('inf'), float('nan')):
            with self.assertRaises(ValueError):
                TOOL.Budget(seconds)
        self.budget.deadline = time.monotonic() - 1
        with self.assertRaises(TimeoutError):
            self.run_pair()
        self.assertFalse(self.output.exists())


if __name__ == '__main__':
    unittest.main()
