import importlib.util
import pathlib
import sys
import sqlite3
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).parents[1]))
spec = importlib.util.spec_from_file_location('checkpoint', pathlib.Path(__file__).parents[1] / 'checkpoint.py')
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)


class CheckpointTests(unittest.TestCase):
    def test_capture_holds_entrypoint_lock_and_rejects_active_writer(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            for name in c.FILES:
                db = sqlite3.connect(root / name)
                db.execute('CREATE TABLE state(id INTEGER)')
                db.close()
            calls = []
            def guard():
                with (root / 'executor.lock').open('a') as other:
                    with self.assertRaises(BlockingIOError):
                        c.fcntl.flock(other, c.fcntl.LOCK_EX | c.fcntl.LOCK_NB)
                calls.append(True)
            c.capture_locked(root, root / 'snapshot', guard)
            self.assertEqual(len(calls), 2)
            with (root / 'executor.lock').open('a') as writer:
                c.fcntl.flock(writer, c.fcntl.LOCK_EX | c.fcntl.LOCK_NB)
                with self.assertRaises(BlockingIOError):
                    c.capture_locked(root, root / 'rejected', guard)
            self.assertFalse((root / 'rejected').exists())

    def test_wal_checkpoint_restore_preserves_pending_and_private_durable_oauth(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            source = root / 'data'
            source.mkdir()
            connections = []
            try:
                for name in c.FILES:
                    db = sqlite3.connect(source / name)
                    db.executescript('PRAGMA journal_mode=WAL; PRAGMA user_version=3; CREATE TABLE receipts(id TEXT PRIMARY KEY,state TEXT);')
                    db.execute('INSERT INTO receipts VALUES(?,?)', ('intent' if name == 'operational.sqlite' else 'identity',
                                                                  'uncertain' if name == 'operational.sqlite' else 'private-state'))
                    db.commit()
                    connections.append(db)
                # The writer is idle, but its committed WAL pages are not closed.
                manifest = c.capture(source, root / 'checkpoint')
                c.restore(root / 'checkpoint', root / 'restored')
                for name in c.FILES:
                    restored = root / 'restored' / name
                    db = sqlite3.connect(restored)
                    self.assertEqual(db.execute('SELECT count(*) FROM receipts').fetchone()[0], 1)
                    self.assertEqual(db.execute('SELECT state FROM receipts').fetchone()[0],
                                     'uncertain' if name == 'operational.sqlite' else 'private-state')
                    db.close()
                    self.assertEqual(restored.stat().st_mode & 0o777, 0o600)
                self.assertEqual(set(manifest['files']), set(c.FILES))
                with self.assertRaises(FileExistsError):
                    c.restore(root / 'checkpoint', source)
                damaged = root / 'checkpoint' / 'durable.sqlite'
                damaged.write_bytes(damaged.read_bytes() + b'corruption')
                with self.assertRaises(ValueError):
                    c.verify(root / 'checkpoint')
            finally:
                for db in connections:
                    db.close()


if __name__ == '__main__':
    unittest.main()
