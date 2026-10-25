import contextlib
import pathlib
import sqlite3
import sys
import tempfile
import unittest
from datetime import datetime, timezone

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from prune_redundant_history import GUARD, prune

SCHEMA = """
CREATE TABLE jobs(id TEXT PRIMARY KEY, state TEXT NOT NULL, finished_at TEXT);
CREATE TABLE ui_events(id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES jobs(id), type TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE decisions(id TEXT PRIMARY KEY, proposal TEXT NOT NULL, forecast TEXT NOT NULL);
CREATE TABLE canonical_evidence_links(id TEXT PRIMARY KEY, reference_table TEXT, reference_id TEXT);
CREATE TABLE canonical_projection_revisions(id TEXT PRIMARY KEY, name TEXT NOT NULL, scope TEXT NOT NULL, calculation_version TEXT NOT NULL,
  evidence_ids TEXT NOT NULL, lineage_ids TEXT NOT NULL, coverage_ids TEXT NOT NULL, result TEXT NOT NULL, supersedes TEXT REFERENCES canonical_projection_revisions(id));
PRAGMA user_version=7;
"""
NOW = datetime(2026, 10, 25, 12, tzinfo=timezone.utc)
ROLLUP = 'native_failure_delivery_rollups'
CITED = 'b' * 64


class PruneRedundantHistoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = pathlib.Path(self.temp.name) / 'operational.sqlite'
        with contextlib.closing(sqlite3.connect(self.path)) as db:
            db.executescript(SCHEMA)
            db.execute(f"CREATE TRIGGER {GUARD} BEFORE DELETE ON canonical_projection_revisions BEGIN SELECT RAISE(ABORT,'Immutable canonical record'); END")
            for id_ in ('same0', 'same1', CITED, 'same3'):
                self.revision(db, id_, ROLLUP, 'all', '["r1","r2"]')
            self.revision(db, 'other-scope', ROLLUP, 'channel', '["r1","r2"]')
            self.revision(db, 'more-receipts', ROLLUP, 'all', '["r1","r2","r3"]')
            self.revision(db, 'empty', 'native_history_record_capture', 'w', '[]')
            self.revision(db, 'captured', 'native_history_record_capture', 'w2', '[]', evidence='["obs"]')
            db.execute("INSERT INTO jobs VALUES('old','completed','2026-10-23T00:00:00.000Z'),('new','failed','2026-10-25T11:00:00.000Z'),('live','running',NULL)")
            for job in ('old', 'new', 'live'):
                for n in range(3):
                    db.execute("INSERT INTO ui_events(job_id,type,data) VALUES(?,'text',?)", (job, '{"text":"%d"}' % n))
                db.execute("INSERT INTO ui_events(job_id,type,data) VALUES(?,'tool_result','{}')", (job,))
            db.commit()

    def tearDown(self):
        self.temp.cleanup()

    def revision(self, db, id_, name, scope, coverage, evidence='[]'):
        db.execute('INSERT INTO canonical_projection_revisions VALUES(?,?,?,?,?,?,?,?,NULL)', (id_, name, scope, 'v1', evidence, '[]', coverage, '{}'))

    def ids(self, sql):
        with contextlib.closing(sqlite3.connect(self.path)) as db:
            return {row[0] for row in db.execute(sql)}

    def test_dry_run_reports_without_changes(self):
        report = prune(self.path, now=NOW)
        self.assertEqual((report['rollupRevisionsRemoved'], report['emptyHistoryCaptureRevisionsRemoved'], report['uiTextFramesRemoved'], report['applied']), (3, 1, 2, False))
        self.assertEqual(len(self.ids('SELECT id FROM canonical_projection_revisions')), 8)

    def test_apply_keeps_first_selection_inputs_latest_text_and_restores_guard(self):
        self.assertTrue(prune(self.path, apply=True, now=NOW)['applied'])
        self.assertEqual(self.ids('SELECT id FROM canonical_projection_revisions'), {'same0', 'other-scope', 'more-receipts', 'captured'})
        self.assertEqual(self.ids("SELECT job_id||':'||data FROM ui_events WHERE type='text' AND job_id='old'"), {'old:{"text":"2"}'})
        self.assertEqual(len(self.ids('SELECT id FROM ui_events')), 10)
        with contextlib.closing(sqlite3.connect(self.path)) as db:
            with self.assertRaisesRegex(sqlite3.IntegrityError, 'Immutable'):
                db.execute("DELETE FROM canonical_projection_revisions WHERE id='same0'")

    def refused(self, statement):
        with contextlib.closing(sqlite3.connect(self.path)) as db:
            db.execute(statement)
            db.commit()
        revisions = self.ids('SELECT id FROM canonical_projection_revisions')
        with self.assertRaisesRegex(ValueError, 'Unexpected references'):
            prune(self.path, apply=True, now=NOW)
        self.assertEqual(self.ids('SELECT id FROM canonical_projection_revisions'), revisions)
        self.assertEqual(len(self.ids('SELECT id FROM ui_events')), 12)

    def test_evidence_link_to_a_redundant_revision_aborts(self):
        self.refused("INSERT INTO canonical_evidence_links VALUES('l','canonical_projection_revisions','same1')")

    def test_supersession_of_a_redundant_revision_aborts(self):
        self.refused("INSERT INTO canonical_projection_revisions VALUES('next','x','s','v1','[]','[]','[]','{}','empty')")

    def test_decision_citing_a_redundant_revision_aborts(self):
        self.refused("INSERT INTO decisions VALUES('d','{\"evidenceIds\":[\"%s\"]}','{}')" % CITED)

    def test_missing_guard_or_schema_refuses_apply(self):
        with contextlib.closing(sqlite3.connect(self.path)) as db:
            db.execute(f'DROP TRIGGER {GUARD}')
            db.commit()
        with self.assertRaisesRegex(ValueError, 'guard'):
            prune(self.path, apply=True, now=NOW)
        with contextlib.closing(sqlite3.connect(self.path)) as db:
            db.execute('PRAGMA user_version=8')
        with self.assertRaisesRegex(ValueError, 'schema 7'):
            prune(self.path, now=NOW)
        self.assertEqual(len(self.ids('SELECT id FROM canonical_projection_revisions')), 8)


if __name__ == '__main__':
    unittest.main()
