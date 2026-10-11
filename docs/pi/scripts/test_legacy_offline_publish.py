"""Isolated synthetic fixtures, never production authorization or host evidence."""
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
# Test-only selection for native immutable-image fixtures; production main
# always fixes root=/app and never reads this environment variable.
ROOT = (pathlib.Path(os.environ['SATSSURGE_FIXTURE_APP_ROOT'])
        if 'SATSSURGE_FIXTURE_APP_ROOT' in os.environ
        else HERE.parents[2] / 'whirmill-satssurge-autopilot')
SPEC = importlib.util.spec_from_file_location('legacy_offline_publish', HERE / 'legacy-offline-publish.py')
TOOL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(TOOL)
PROCEDURE = TOOL.load_procedure(HERE / 'legacy-target-capture.py')
HELPERS = PROCEDURE.load_helpers(ROOT)
CHECKPOINT, LAUNCHER, LOCKS = HELPERS
SOURCE = 'b081f6b091bc59f5c6500d527f5da79151f16cd8'
IMAGE = 'sha256:' + 'a' * 64  # Synthetic, never an independently verified image.
LEGACY = {'source': 'b' * 40, 'imageDigest': 'sha256:' + 'c' * 64}


class PublisherTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = pathlib.Path(self.temp.name).resolve()
        self.data = self.base / 'data'
        self.data.mkdir(mode=0o700)
        self.captures = self.base / 'earlier-captures'
        self.output = self.base / 'new-publish'
        self.evidence_dir = self.base / 'reviewed-evidence'
        self.evidence_dir.mkdir(mode=0o700)
        self.evidence = self.evidence_dir / 'packet.json'
        self.expected = LAUNCHER.fingerprint(ROOT)
        self.target = {'source': SOURCE, 'imageDigest': IMAGE, 'destination': self.expected}
        self.budget = PROCEDURE.Budget(30)
        for name in CHECKPOINT.FILES:
            with contextlib.closing(sqlite3.connect(self.data / name)) as db, db:
                db.execute('PRAGMA user_version=7')
                db.execute('CREATE TABLE receipts (id TEXT PRIMARY KEY, body TEXT)')
                db.execute('INSERT INTO receipts VALUES (?, ?)', ('original-id', 'synthetic-private-row'))
                if name == 'durable.sqlite':
                    db.execute('CREATE TABLE durable_schema (singleton INTEGER PRIMARY KEY, version INTEGER)')
                    db.execute('INSERT INTO durable_schema VALUES (1,11)')
            (self.data / name).chmod(0o600)
        self.wal_db = sqlite3.connect(self.data / 'operational.sqlite')
        self.addCleanup(self.wal_db.close)
        self.wal_db.execute('PRAGMA journal_mode=WAL')
        self.wal_db.execute('PRAGMA wal_autocheckpoint=0')
        self.wal_db.execute("INSERT INTO receipts VALUES ('pending-original-id', 'pending')")
        self.wal_db.commit()
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(PROCEDURE.capture_pair(self.data, self.captures, ROOT, self.expected,
                                                   SOURCE, IMAGE, HELPERS, PROCEDURE.Budget(30)), 0)
        observations = {}
        for role in sorted(TOOL.ROLES):
            path = self.evidence_dir / (role + '.json')
            # Fictional host observation: only fixture code is authorized here.
            path.write_text(json.dumps({'fixture': role, 'legacy': LEGACY, 'target': self.target}))
            path.chmod(0o600)
            observations[role] = {'file': path.name, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}
        self.packet = {'protocol': 1, 'legacy': LEGACY, 'target': self.target, 'observations': observations}
        self.write_packet()

    def write_packet(self):
        self.evidence.write_text(json.dumps(self.packet, separators=(',', ':')))
        self.evidence.chmod(0o600)
        self.admitted = hashlib.sha256(self.evidence.read_bytes()).hexdigest()

    def run_publish(self, **changes):
        values = dict(data=self.data, captures=self.captures, evidence=self.evidence,
                      admitted=self.admitted, output=self.output, root=ROOT, expected=self.expected,
                      source=SOURCE, image=IMAGE, helpers=HELPERS, procedure=PROCEDURE, budget=self.budget)
        values.update(changes)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = TOOL.publish(**values)
        return code, [json.loads(line) for line in output.getvalue().splitlines()]

    def fenced(self):
        for name in TOOL.LOCK_NAMES:
            with (self.data / name).open('r') as stream:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def released(self):
        for name in TOOL.LOCK_NAMES:
            with (self.data / name).open('r') as stream:
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def assert_hold(self, result, receipt=False):
        code, summaries = result
        self.assertEqual(code, 1)
        self.assertEqual(summaries[-1]['status'], 'HOLD')
        self.assertEqual(summaries[-1]['reconcileRequired'], receipt)
        self.assertEqual(os.path.lexists(self.data / 'offline-cutover.json'), receipt)
        self.released()

    def test_real_fresh_capture_and_publication_hold_all_three_fences_preserve_rows(self):
        before = {path.name: (path.read_bytes(), path.stat().st_ino, path.stat().st_size)
                  for path in self.data.iterdir()}
        original_schemas = LAUNCHER.schemas(self.data)
        events = []
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        for module, name in ((CHECKPOINT, 'capture'), (CHECKPOINT, 'verify'),
                             (LAUNCHER, 'schemas'), (TOOL, 'publish_no_clobber')):
            original = getattr(module, name)
            def checked(*args, _original=original, _name=name, **kwargs):
                self.fenced()
                events.append(_name)
                result = _original(*args, **kwargs)
                self.fenced()
                return result
            stack.enter_context(mock.patch.object(module, name, side_effect=checked))
        original_link = os.link
        def link(*args, **kwargs):
            self.fenced()
            events.append('commit-link')
            return original_link(*args, **kwargs)
        stack.enter_context(mock.patch.object(os, 'link', side_effect=link))
        original_emit = PROCEDURE.emit
        def emit(value):
            self.fenced()
            original_emit(value)
        stack.enter_context(mock.patch.object(PROCEDURE, 'emit', side_effect=emit))
        code, summaries = self.run_publish()
        stack.close()
        self.assertEqual(code, 0)
        self.assertEqual(events.count('capture'), 1)
        self.assertEqual(events.count('commit-link'), 1)
        self.assertEqual(summaries[-1]['status'], 'published')
        self.assertNotIn('synthetic-private-row', json.dumps(summaries))
        receipt_path = self.data / 'offline-cutover.json'
        receipt = json.loads(receipt_path.read_bytes())
        self.assertEqual(receipt['source'], 'git:' + LEGACY['source'] + '@' + LEGACY['imageDigest'])
        self.assertEqual(receipt['destination'], self.expected)
        self.assertEqual(receipt['hostEvidenceSha256'], self.admitted)
        self.assertEqual(receipt['writers'], {'app': 'stopped', 'lm-backfill': 'disabled'})
        self.assertEqual(receipt['schemas'], original_schemas)
        self.assertEqual(receipt['files'], CHECKPOINT.verify(self.captures / 'capture-1')['files'])
        self.assertEqual(stat.S_IMODE(receipt_path.stat().st_mode), 0o600)
        self.assertEqual(receipt_path.stat().st_nlink, 1)
        self.assertFalse(list(self.data.glob('.offline-cutover-*.tmp')))
        for name, (content, inode, size) in before.items():
            if not name.endswith('-shm'):
                self.assertEqual((self.data / name).read_bytes(), content)
            self.assertEqual(((self.data / name).stat().st_ino, (self.data / name).stat().st_size), (inode, size))
        fresh = self.output / 'fresh-capture'
        self.assertEqual(stat.S_IMODE(fresh.stat().st_mode), 0o700)
        for name in CHECKPOINT.FILES:
            with contextlib.closing(sqlite3.connect(fresh / name)) as db:
                rows = db.execute('SELECT id, body FROM receipts ORDER BY id').fetchall()
                expected = [('original-id', 'synthetic-private-row')]
                if name == 'operational.sqlite':
                    expected.append(('pending-original-id', 'pending'))
                self.assertEqual(rows, expected)
            self.assertEqual(CHECKPOINT.schema_identity(fresh / name), original_schemas[name])
        self.assertFalse((self.data / 'lifecycle.json').exists())
        self.released()

    def test_changed_live_rows_and_schema_refused_without_receipt(self):
        self.wal_db.execute("INSERT INTO receipts VALUES ('changed-id', 'after-earlier-captures')")
        self.wal_db.commit()
        self.assert_hold(self.run_publish())
        self.assertTrue((self.output / 'fresh-capture' / 'manifest.json').exists())
        self.wal_db.execute('CREATE TABLE changed_schema (id INTEGER)')
        self.wal_db.commit()
        self.assert_hold(self.run_publish(output=self.base / 'schema-refusal'))

    def test_admitted_hash_and_raw_observations_and_target_binding_required(self):
        for change in ({'admitted': '0' * 64}, {'admitted': ''}):
            with self.subTest(change=change):
                self.assert_hold(self.run_publish(**change))
        self.packet['target']['destination'] = '0' * 64
        self.write_packet()
        self.assert_hold(self.run_publish())
        self.packet['target']['destination'] = self.expected
        self.write_packet()
        (self.evidence_dir / 'app-exclusion.json').write_text('changed independently reviewed artifact')
        self.assert_hold(self.run_publish())
        self.assertFalse(self.output.exists())

    def test_claims_without_original_artifact_bindings_fail_closed(self):
        self.packet['observations'] = {'app': 'stopped', 'lm-backfill': 'disabled'}
        self.write_packet()
        self.assert_hold(self.run_publish())
        self.packet['observations'] = {name: {'file': '../escape', 'sha256': 'a' * 64} for name in TOOL.ROLES}
        self.write_packet()
        self.assert_hold(self.run_publish())

    def test_both_earlier_manifests_and_actual_file_schema_identities_verified(self):
        path = self.captures / 'capture-2' / 'manifest.json'
        original = path.read_bytes()
        manifest = json.loads(original)
        manifest['release']['imageDigest'] = 'sha256:' + 'd' * 64
        path.write_text(json.dumps(manifest))
        self.assert_hold(self.run_publish())
        path.write_bytes(original)
        manifest = json.loads(original)
        manifest['files']['oauth.sqlite']['bytes'] += 1
        path.write_text(json.dumps(manifest))
        self.assert_hold(self.run_publish())
        path.write_bytes(original)
        with contextlib.closing(sqlite3.connect(self.captures / 'capture-2' / 'oauth.sqlite')) as db, db:
            db.execute("INSERT INTO receipts VALUES ('tampered', 'fixture')")
        self.assert_hold(self.run_publish())
        self.assertFalse(self.output.exists())

    def test_existing_and_dangling_receipts_refused_before_modification(self):
        for name in ('offline-cutover.json', 'lifecycle.json'):
            path = self.data / name
            for kind in ('regular', 'dangling'):
                if kind == 'regular':
                    path.write_text('existing-authority')
                else:
                    path.symlink_to(self.base / 'absent')
                with self.subTest(name=name, kind=kind), self.assertRaises(ValueError):
                    self.run_publish()
                self.assertFalse(self.output.exists())
                path.unlink()  # Own fixture only, never a production retry.

    def test_atomic_no_clobber_race_preserves_existing_receipt(self):
        original_link = os.link
        def competing_link(source, destination, **kwargs):
            self.fenced()
            destination.write_text('independent-existing-receipt')
            destination.chmod(0o600)
            return original_link(source, destination, **kwargs)
        with mock.patch.object(os, 'link', side_effect=competing_link):
            self.assert_hold(self.run_publish(), receipt=True)
        self.assertEqual((self.data / 'offline-cutover.json').read_text(), 'independent-existing-receipt')
        self.assertEqual(len(list(self.data.glob('.offline-cutover-*.tmp'))), 1)

    def test_late_signal_after_summary_holds_durable_receipt_and_no_retry(self):
        numbers = (signal.SIGTERM, signal.SIGINT, signal.SIGALRM)
        previous = {number: signal.getsignal(number) for number in numbers}
        timer = signal.getitimer(signal.ITIMER_REAL)
        original_emit = PROCEDURE.emit
        try:
            self.budget.install()
            def emit(value):
                self.fenced()
                original_emit(value)
                if value['status'] == 'published':
                    os.kill(os.getpid(), signal.SIGTERM)
            with mock.patch.object(PROCEDURE, 'emit', side_effect=emit):
                result = self.run_publish()
            self.assert_hold(result, receipt=True)
            self.assertEqual([value['status'] for value in result[1]], ['published', 'HOLD'])
            with self.assertRaises(ValueError):
                self.run_publish(output=self.base / 'retry', budget=PROCEDURE.Budget(30))
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            for number, handler in previous.items():
                signal.signal(number, handler)
            signal.setitimer(signal.ITIMER_REAL, *timer)

    def test_signal_after_final_check_still_nonzero_and_fenced_hold(self):
        numbers = (signal.SIGTERM, signal.SIGINT, signal.SIGALRM)
        previous = {number: signal.getsignal(number) for number in numbers}
        timer = signal.getitimer(signal.ITIMER_REAL)
        try:
            self.budget = PROCEDURE.Budget(30, exit_policy=True)
            self.budget.install()
            original_check = self.budget.check
            def check():
                original_check()
                if all(signal.getsignal(number) is signal.default_int_handler for number in numbers):
                    self.fenced()
                    os.kill(os.getpid(), signal.SIGINT)
            with mock.patch.object(self.budget, 'check', side_effect=check):
                self.assert_hold(self.run_publish(), receipt=True)
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            for number, handler in previous.items():
                signal.signal(number, handler)
            signal.setitimer(signal.ITIMER_REAL, *timer)

    def test_budget_expires_after_atomic_link_retains_uncertain_publication(self):
        original_link = os.link
        def link(*args, **kwargs):
            result = original_link(*args, **kwargs)
            self.budget.deadline = time.monotonic() - 1
            return result
        with mock.patch.object(os, 'link', side_effect=link):
            self.assert_hold(self.run_publish(), receipt=True)
        self.assertEqual(len(list(self.data.glob('.offline-cutover-*.tmp'))), 1)
        self.assertEqual((self.data / 'offline-cutover.json').stat().st_nlink, 2)

    def test_budget_or_signal_during_fresh_capture_does_not_publish(self):
        original = CHECKPOINT.capture
        def capture(*args, **kwargs):
            result = original(*args, **kwargs)
            self.budget.interrupt(signal.SIGTERM, None)
            return result
        with mock.patch.object(CHECKPOINT, 'capture', side_effect=capture):
            self.assert_hold(self.run_publish())
        self.assertTrue((self.output / 'fresh-capture' / 'manifest.json').exists())

    def test_paths_private_files_and_overlaps_refused(self):
        for change in ({'captures': self.data}, {'output': self.captures / 'new'},
                       {'output': self.evidence_dir / 'new'}, {'evidence': str(self.evidence) + '?mode=ro'}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.run_publish(**change)
        self.evidence.chmod(0o644)
        self.assert_hold(self.run_publish())
        self.evidence.chmod(0o600)
        path = self.evidence_dir / 'app-exclusion.json'
        saved = self.evidence_dir / 'saved'
        path.rename(saved)
        for kind in ('symlink', 'hardlink'):
            if kind == 'symlink':
                path.symlink_to(saved)
            else:
                os.link(saved, path)
            self.assert_hold(self.run_publish())
            path.unlink()
        saved.rename(path)
        self.assertFalse(self.output.exists())

    def test_noncooperating_live_row_change_after_fresh_capture_is_detected(self):
        original = CHECKPOINT.capture
        def capture(*args, **kwargs):
            result = original(*args, **kwargs)
            self.wal_db.execute("INSERT INTO receipts VALUES ('intruder-id', 'isolated-fixture')")
            self.wal_db.commit()
            return result
        with mock.patch.object(CHECKPOINT, 'capture', side_effect=capture):
            self.assert_hold(self.run_publish())
        self.assertTrue((self.output / 'fresh-capture' / 'manifest.json').exists())
        self.assertEqual(self.wal_db.execute("SELECT id FROM receipts WHERE id='intruder-id'").fetchone(), ('intruder-id',))

    def test_fsync_failure_after_publication_retains_receipt_for_reconciliation(self):
        original = TOOL.sync_directory
        def sync(path):
            if path == self.data:
                self.fenced()
                raise OSError('synthetic fsync failure')
            return original(path)
        with mock.patch.object(TOOL, 'sync_directory', side_effect=sync):
            self.assert_hold(self.run_publish(), receipt=True)
        self.assertEqual((self.data / 'offline-cutover.json').stat().st_nlink, 1)

    def test_stable_lock_inode_and_original_shm_extent_changes_hold(self):
        original = CHECKPOINT.capture
        shm = self.data / 'operational.sqlite-shm'
        def capture(*args, **kwargs):
            result = original(*args, **kwargs)
            with shm.open('ab') as stream:
                stream.write(bytes(32768))  # Synthetic append, never truncate live mapping.
            return result
        with mock.patch.object(CHECKPOINT, 'capture', side_effect=capture):
            self.assert_hold(self.run_publish())
        self.assertEqual(shm.stat().st_size, 65536)
        def changed_lock(*args, **kwargs):
            result = original(*args, **kwargs)
            (self.data / 'executor.lock').rename(self.data / 'fixture-old-lock')
            (self.data / 'executor.lock').write_text('fixture-replacement')
            return result
        with mock.patch.object(CHECKPOINT, 'capture', side_effect=changed_lock):
            self.assert_hold(self.run_publish(output=self.base / 'changed-lock'))

    def test_expired_budget_target_mismatch_and_real_production_guard(self):
        with self.assertRaises(ValueError):
            self.run_publish(expected='0' * 64)
        self.budget.deadline = time.monotonic() - 1
        with self.assertRaises(TimeoutError):
            self.run_publish()
        arguments = ['publisher', '--data', str(self.data), '--captures', str(self.captures),
                     '--evidence', str(self.evidence), '--admitted-evidence-sha256', self.admitted,
                     '--output', str(self.output), '--expected-fingerprint', self.expected,
                     '--release-source', SOURCE, '--platform-digest', IMAGE]
        try:
            TOOL.require_runtime()  # Actual identity, including native PID-1 fixtures.
        except PermissionError:
            with mock.patch.object(sys, 'argv', arguments), mock.patch.object(TOOL, 'load_procedure') as load:
                with self.assertRaises(PermissionError):
                    TOOL.main()
                load.assert_not_called()
        for field, wrong in (('getpid', 2), ('getuid', 0), ('geteuid', 0), ('getgid', 0), ('getegid', 0)):
            with contextlib.ExitStack() as stack:
                stack.enter_context(mock.patch.object(sys, 'platform', 'linux'))
                for name in ('getpid', 'getuid', 'geteuid', 'getgid', 'getegid'):
                    stack.enter_context(mock.patch.object(os, name, return_value=wrong if name == field else (1 if name == 'getpid' else 1000)))
                with self.subTest(field=field), self.assertRaises(PermissionError):
                    TOOL.require_runtime()
        self.assertFalse(self.output.exists())


if __name__ == '__main__':
    unittest.main()
