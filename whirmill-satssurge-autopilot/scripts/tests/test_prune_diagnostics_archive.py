import contextlib
import json
import pathlib
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from prune_diagnostics_archive import prune

SCHEMA = """
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE canonical_original_archive(id TEXT PRIMARY KEY, original_table TEXT, original_id TEXT, source_instance TEXT, raw_row TEXT);
CREATE TABLE canonical_observations(id TEXT PRIMARY KEY, batch_id TEXT);
CREATE TABLE canonical_evidence_links(id TEXT PRIMARY KEY, observation_id TEXT NOT NULL REFERENCES canonical_observations(id), reference_table TEXT, reference_id TEXT);
CREATE TABLE canonical_projection_revisions(id TEXT PRIMARY KEY, evidence_ids TEXT);
"""
GUARDS = ('canonical_original_archive', 'canonical_observations', 'canonical_evidence_links')


class PruneDiagnosticsArchiveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = pathlib.Path(self.temp.name) / 'operational.sqlite'
        with contextlib.closing(sqlite3.connect(self.path)) as db:
            db.executescript(SCHEMA)
            for table in GUARDS:
                db.execute(f"CREATE TRIGGER {table}_immutable_delete BEFORE DELETE ON {table} BEGIN SELECT RAISE(ABORT,'Immutable canonical record'); END")
            db.execute("INSERT INTO meta VALUES('canonicalDiagnosticLookup:x','{}'),('enabled','false')")
            self.add(db, 'migration', 'satssurge-schema6-migration-originals', {'lndg': {'status': 'qualified'}})
            self.add(db, 'lm-qualified', 'satssurge-operational-originals', {'lightningMate': {'status': 'qualified'}, 'lndg': {'status': 'qualified'}})
            for n in range(5):
                self.add(db, f'dup{n}', 'satssurge-operational-originals', {'lndg': {'status': 'qualified'}, 'lightningMate': {'status': 'unavailable'}})
            db.commit()

    def tearDown(self):
        self.temp.cleanup()

    def add(self, db, name, source, value):
        raw = json.dumps({'key': 'diagnostics', 'value': ['text', json.dumps(value)]})
        db.execute('INSERT INTO canonical_original_archive VALUES(?,?,?,?,?)', (name, 'meta', 'diagnostics', source, raw))
        db.execute('INSERT INTO canonical_observations VALUES(?,?)', ('obs-' + name, 'archive:' + name))
        db.execute('INSERT INTO canonical_evidence_links VALUES(?,?,?,?)', ('link-' + name, 'obs-' + name, 'canonical_original_archive', name))

    def ids(self, table):
        with contextlib.closing(sqlite3.connect(self.path)) as db:
            return {row[0] for row in db.execute(f'SELECT id FROM {table}')}

    def test_dry_run_reports_without_changes(self):
        report = prune(self.path)
        self.assertEqual((report['archiveRowsRemoved'], report['archiveRowsKept'], report['applied']), (3, 4, False))
        self.assertEqual(len(self.ids('canonical_original_archive')), 7)

    def test_apply_keeps_newest_and_last_qualified_per_provider_and_restores_guards(self):
        report = prune(self.path, apply=True, vacuum=True)
        self.assertEqual((report['observationsRemoved'], report['linksRemoved'], report['vacuumed']), (3, 3, True))
        self.assertEqual(self.ids('canonical_original_archive'), {'migration', 'lm-qualified', 'dup3', 'dup4'})
        self.assertEqual(self.ids('canonical_observations'), {'obs-migration', 'obs-lm-qualified', 'obs-dup3', 'obs-dup4'})
        with contextlib.closing(sqlite3.connect(self.path)) as db:
            self.assertEqual([row[0] for row in db.execute('SELECT key FROM meta')], ['enabled'])
            with self.assertRaisesRegex(sqlite3.IntegrityError, 'Immutable'):
                db.execute("DELETE FROM canonical_original_archive WHERE id='dup4'")

    def test_projection_reference_aborts_before_any_change(self):
        with contextlib.closing(sqlite3.connect(self.path)) as db:
            db.execute("INSERT INTO canonical_projection_revisions VALUES('p', json_array('obs-dup0'))")
            db.commit()
        with self.assertRaisesRegex(ValueError, 'Unexpected references'):
            prune(self.path, apply=True)
        self.assertEqual(len(self.ids('canonical_original_archive')), 7)


if __name__ == '__main__':
    unittest.main()
