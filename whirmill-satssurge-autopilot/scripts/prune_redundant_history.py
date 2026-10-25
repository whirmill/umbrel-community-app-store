#!/usr/bin/env python3
"""One-off removal of redundant derived rows written by releases up to 0.5.20.

- Failure-rollup revisions repeated for an identical receipt selection: every
  status read forked a revision when unrelated coverage moved the range end.
  The earliest revision per selection is kept.
- Native-history capture revisions without any input observation (empty
  minute windows). Their coverage receipts are kept.
- Streaming text frames of jobs finished more than a day ago, except the latest
  text of each job (the same rule the app now applies itself).

Observations, links, coverage, original archives and every financial table stay
untouched. Run with the app stopped: the executor lock is taken exclusively.
Dry-run by default.
"""
import argparse
import fcntl
import json
import pathlib
import re
import sqlite3
from datetime import datetime, timedelta, timezone

from maintenance_lock import lock_file

GUARD = 'canonical_projection_revisions_immutable_delete'
UI_TEXT_FRAME_RETENTION = timedelta(days=1)
# Records that may cite a canonical identifier; a citation of a doomed revision aborts the prune.
CITING = {'decisions': ('proposal', 'forecast'), 'operations': ('details',), 'evaluations': ('result',),
          'evaluation_windows': ('result',), 'ledger': ('details',), 'ledger_annotations': ('reason',),
          'claims': ('content',), 'evidence': ('content',), 'owner_proposals': ('content', 'result')}
DIGEST = re.compile(r'[0-9a-f]{64}')


def cited(db, doomed):
    found = set()
    tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    for table, columns in CITING.items():
        if table not in tables:
            continue
        for row in db.execute(f"SELECT {','.join(columns)} FROM {table}"):
            for text in row:
                if isinstance(text, str):
                    found.update(DIGEST.findall(text))
    return found & doomed


def plan(db, now):
    db.execute('CREATE TEMP TABLE doomed_revision(id TEXT PRIMARY KEY, kind TEXT NOT NULL)')
    # Same scope, calculation and exact receipt ids select the same inputs; only range metadata differed.
    db.execute("INSERT INTO doomed_revision SELECT id,'rollup' FROM canonical_projection_revisions p "
               "WHERE name='native_failure_delivery_rollups' AND EXISTS(SELECT 1 FROM canonical_projection_revisions k "
               "WHERE k.name=p.name AND k.scope=p.scope AND k.calculation_version=p.calculation_version "
               "AND k.coverage_ids=p.coverage_ids AND k.rowid<p.rowid)")
    db.execute("INSERT INTO doomed_revision SELECT id,'empty_history_capture' FROM canonical_projection_revisions "
               "WHERE name='native_history_record_capture' AND evidence_ids='[]' AND lineage_ids='[]' AND coverage_ids='[]'")
    cutoff = (now - UI_TEXT_FRAME_RETENTION).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    db.execute('CREATE TEMP TABLE doomed_frame(id INTEGER PRIMARY KEY)')
    db.execute("INSERT INTO doomed_frame SELECT e.id FROM ui_events e JOIN jobs j ON j.id=e.job_id WHERE e.type='text' "
               "AND j.state IN ('completed','failed','cancelled') AND j.finished_at<? "
               "AND EXISTS(SELECT 1 FROM ui_events n WHERE n.job_id=e.job_id AND n.type='text' AND n.id>e.id)", (cutoff,))
    counts = dict(db.execute('SELECT kind,count(*) FROM doomed_revision GROUP BY kind').fetchall())
    report = {'rollupRevisionsRemoved': counts.get('rollup', 0),
              'emptyHistoryCaptureRevisionsRemoved': counts.get('empty_history_capture', 0),
              'revisionBytesRemoved': db.execute('SELECT coalesce(sum(length(CAST(result AS BLOB))+length(CAST(evidence_ids AS BLOB))'
                                                 '+length(CAST(lineage_ids AS BLOB))+length(CAST(coverage_ids AS BLOB))),0) '
                                                 'FROM canonical_projection_revisions WHERE id IN (SELECT id FROM doomed_revision)').fetchone()[0],
              'uiTextFramesRemoved': db.execute('SELECT count(*) FROM doomed_frame').fetchone()[0],
              'uiTextBytesRemoved': db.execute('SELECT coalesce(sum(length(CAST(data AS BLOB))),0) FROM ui_events '
                                               'WHERE id IN (SELECT id FROM doomed_frame)').fetchone()[0],
              'applied': False}
    references = {
        'supersededBy': db.execute('SELECT count(*) FROM canonical_projection_revisions WHERE supersedes IN (SELECT id FROM doomed_revision)').fetchone()[0],
        'links': db.execute("SELECT count(*) FROM canonical_evidence_links WHERE reference_table='canonical_projection_revisions' "
                            'AND reference_id IN (SELECT id FROM doomed_revision)').fetchone()[0],
        'records': len(cited(db, {row[0] for row in db.execute('SELECT id FROM doomed_revision')})),
    }
    return report, references


def prune(path, apply=False, vacuum=False, now=None):
    db = sqlite3.connect(path, isolation_level=None)
    try:
        # References are refused before any delete; per-row enforcement would scan the unindexed
        # supersedes column once per deleted revision. The full check runs before commit.
        db.execute('PRAGMA foreign_keys=OFF' if apply else 'PRAGMA foreign_keys=ON')
        # Plan, refusal checks and deletes share one write transaction: nothing can change in between.
        db.execute('BEGIN IMMEDIATE' if apply else 'BEGIN')
        try:
            if db.execute('PRAGMA user_version').fetchone()[0] != 7:
                raise ValueError('Canonical schema 7 required')
            report, references = plan(db, now or datetime.now(timezone.utc))
            if any(references.values()):
                raise ValueError('Unexpected references to redundant revisions: ' + json.dumps({**report, **references}))
            if not apply:
                db.execute('ROLLBACK')
                return report
            trigger = db.execute("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?", (GUARD,)).fetchone()
            if trigger is None:
                raise ValueError('Immutable delete guard not found')
            db.execute('DROP TRIGGER ' + GUARD)
            db.execute('DELETE FROM canonical_projection_revisions WHERE id IN (SELECT id FROM doomed_revision)')
            db.execute(trigger[0])
            db.execute('DELETE FROM ui_events WHERE id IN (SELECT id FROM doomed_frame)')
            if db.execute('PRAGMA foreign_key_check').fetchone() is not None:
                raise ValueError('Foreign key check failed')
            db.execute('COMMIT')
        except BaseException:
            if db.in_transaction:
                db.execute('ROLLBACK')
            raise
        report['applied'] = True
        if vacuum:
            db.execute('VACUUM')
            report['vacuumed'] = True
        return report
    finally:
        db.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('data', type=pathlib.Path, help='app data directory containing operational.sqlite')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--vacuum', action='store_true')
    args = parser.parse_args()
    with lock_file(args.data, 'executor.lock') as executor:
        # Non-blocking: a running app holds this lock and must be stopped first.
        fcntl.flock(executor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        print(json.dumps(prune(args.data / 'operational.sqlite', args.apply, args.vacuum)))
