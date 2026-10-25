#!/usr/bin/env python3
"""One-off removal of duplicated diagnostics captures from the immutable archive.

Releases before 0.5.18 archived every 30-second diagnostics refresh although
consecutive captures differed only in timestamps. Run with the app stopped:
the executor lock is taken exclusively. Dry-run by default.
"""
import argparse
import fcntl
import json
import pathlib
import sqlite3

from maintenance_lock import lock_file

OPERATIONAL = 'satssurge-operational-originals'
PROVIDERS = ('lndg', 'lightningMate')
GUARDED = ('canonical_original_archive', 'canonical_observations', 'canonical_evidence_links')


def plan(db, keep):
    rows = db.execute("SELECT rowid, id, source_instance FROM canonical_original_archive "
                      "WHERE original_table='meta' AND original_id='diagnostics' ORDER BY rowid DESC").fetchall()
    operational = [row for row in rows if row[2] == OPERATIONAL]
    kept = {row[1] for row in rows if row[2] != OPERATIONAL} | {row[1] for row in operational[:keep]}
    # Retained lookups serve the newest qualified capture per provider when the current one is not qualified.
    missing = set(PROVIDERS)
    for _, archive_id, _ in operational:
        if not missing:
            break
        raw = json.loads(db.execute('SELECT raw_row FROM canonical_original_archive WHERE id=?', (archive_id,)).fetchone()[0])
        value = json.loads(raw['value'][1] if isinstance(raw['value'], list) else raw['value'])
        for provider in list(missing):
            if (value.get(provider) or {}).get('status') == 'qualified':
                kept.add(archive_id)
                missing.discard(provider)
    doomed = [row[1] for row in operational if row[1] not in kept]
    return doomed, len(rows) - len(doomed)


def prune(path, keep=2, apply=False, vacuum=False):
    db = sqlite3.connect(path, isolation_level=None)
    try:
        db.execute('PRAGMA foreign_keys=ON')
        db.execute('CREATE TEMP TABLE doomed_archive(id TEXT PRIMARY KEY)')
        doomed, kept = plan(db, keep)
        db.executemany('INSERT INTO doomed_archive VALUES(?)', [(archive_id,) for archive_id in doomed])
        db.execute("CREATE TEMP TABLE doomed_observation AS SELECT o.id FROM canonical_observations o "
                   "JOIN doomed_archive d ON o.batch_id='archive:'||d.id")
        db.execute('CREATE UNIQUE INDEX temp.doomed_observation_id ON doomed_observation(id)')
        observations = db.execute('SELECT count(*) FROM doomed_observation').fetchone()[0]
        links = db.execute("SELECT count(*) FROM canonical_evidence_links WHERE observation_id IN (SELECT id FROM doomed_observation) "
                           "OR (reference_table='canonical_original_archive' AND reference_id IN (SELECT id FROM doomed_archive))").fetchone()[0]
        foreign = db.execute("SELECT count(*) FROM canonical_evidence_links WHERE observation_id IN (SELECT id FROM doomed_observation) "
                             "AND NOT (reference_table='canonical_original_archive' AND reference_id IN (SELECT id FROM doomed_archive))").fetchone()[0]
        projected = db.execute("SELECT count(*) FROM canonical_projection_revisions p, json_each(p.evidence_ids) e "
                               "WHERE e.value IN (SELECT id FROM doomed_observation)").fetchone()[0]
        bytes_ = db.execute('SELECT coalesce(sum(length(CAST(raw_row AS BLOB))),0) FROM canonical_original_archive '
                            'WHERE id IN (SELECT id FROM doomed_archive)').fetchone()[0]
        report = {'archiveRowsRemoved': len(doomed), 'archiveRowsKept': kept, 'observationsRemoved': observations,
                  'linksRemoved': links, 'rawBytesRemoved': bytes_, 'applied': False}
        if foreign or projected or observations != len(doomed) or links != len(doomed):
            raise ValueError('Unexpected references to duplicated diagnostics: ' + json.dumps(
                {**report, 'foreignLinks': foreign, 'projectionReferences': projected}))
        if not apply:
            return report
        triggers = db.execute("SELECT name, sql FROM sqlite_master WHERE type='trigger' AND name IN (%s)"
                              % ','.join('?' * len(GUARDED)), [table + '_immutable_delete' for table in GUARDED]).fetchall()
        if len(triggers) != len(GUARDED):
            raise ValueError('Immutable delete guards not found')
        db.execute('BEGIN IMMEDIATE')
        try:
            for name, _ in triggers:
                db.execute('DROP TRIGGER ' + name)
            db.execute('DELETE FROM canonical_evidence_links WHERE observation_id IN (SELECT id FROM doomed_observation)')
            db.execute('DELETE FROM canonical_observations WHERE id IN (SELECT id FROM doomed_observation)')
            db.execute('DELETE FROM canonical_original_archive WHERE id IN (SELECT id FROM doomed_archive)')
            # Derived lookups only; consumers rebuild them from the remaining archive.
            db.execute("DELETE FROM meta WHERE key LIKE 'canonicalDiagnosticLookup:%'")
            for _, sql in triggers:
                db.execute(sql)
            if db.execute('PRAGMA foreign_key_check').fetchone() is not None:
                raise ValueError('Foreign key check failed')
            db.execute('COMMIT')
        except BaseException:
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
    parser.add_argument('--keep', type=int, default=2)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--vacuum', action='store_true')
    args = parser.parse_args()
    with lock_file(args.data, 'executor.lock') as executor:
        # Non-blocking: a running app holds this lock and must be stopped first.
        fcntl.flock(executor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        print(json.dumps(prune(args.data / 'operational.sqlite', args.keep, args.apply, args.vacuum)))
