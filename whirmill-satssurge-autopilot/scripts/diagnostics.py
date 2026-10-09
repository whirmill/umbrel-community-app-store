#!/usr/bin/env python3
"""Version-gated host reader. No credentials, personal payments, or financial RPCs.

App receives only an atomic, private projection. Never mount Docker or app databases
into the agent. Table counts prove capture completeness, not Lightning history.
"""
import argparse
import datetime as dt
import decimal
import hashlib
import json
import os
import pathlib
import sqlite3
import subprocess
import tempfile

UTC = dt.timezone.utc
SHAPE = 'f12ae61382e1eff131904419106c3ddb51d30f2443990443ed65c848de419682'
TABLES = ['gui_forwards', 'gui_failedhtlcs', 'gui_histfailedhtlc', 'gui_rebalancer']
IMAGES = {'lndg': ('lndg_web_1', 'ghcr.io/cryptosharks131/lndg:v1.11.1@sha256:e1589e1d5ec89a4abe59610e808a4c9664dbc84eb66c30d15ffa2dd87232729e', '1.11.1'),
          'lightningMate': ('lightningmate_web_1', 'ghcr.io/opensourceminers/lightningmate:v0.7.7@sha256:917fa062d9520ea5bf92fb94bbe12b2947ed025c2bd8b82b3dcd5435127392ce', '0.7.7')}


def utc(value):
    stamp = dt.datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    if stamp.tzinfo is None:
        stamp = stamp.replace(tzinfo=UTC)  # source TIME_ZONE=UTC is separately verified
    return stamp.astimezone(UTC).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def sat_text(value):
    amount = decimal.Decimal(str(value))
    if not amount.is_finite() or amount < 0 or amount * 1000 != (amount * 1000).to_integral_value():
        raise ValueError('Invalid sat precision')
    return format(amount, 'f')


def running_version(name):
    container, image, version = IMAGES[name]
    result = subprocess.run(['docker', 'inspect', '--format', '{{json .Config.Image}} {{json .State.Running}}', container],
                            capture_output=True, text=True, check=True, timeout=8)
    fields = result.stdout.strip().split()
    if len(fields) != 2 or json.loads(fields[0]) != image or fields[1] != 'true':
        raise ValueError('Unsupported or stopped source version')
    return version


def lndg_timezone():
    code = "import ast,pathlib,json;t=ast.parse(pathlib.Path('/app/lndg/settings.py').read_text());print(json.dumps({x.targets[0].id:ast.literal_eval(x.value) for x in t.body if isinstance(x,ast.Assign) and isinstance(x.targets[0],ast.Name) and x.targets[0].id in ['TIME_ZONE','USE_TZ']}))"
    result = subprocess.run(['docker', 'exec', 'lndg_web_1', 'python3', '-c', code],
                            check=True, capture_output=True, text=True, timeout=8)
    settings = json.loads(result.stdout)
    if settings.get('TIME_ZONE') != 'UTC' or type(settings.get('USE_TZ')) is not bool:
        raise ValueError('Source timezone not qualified')


def read_lndg(path, start, end, version):
    connection = sqlite3.connect('file:' + str(path) + '?mode=ro', uri=True, timeout=3)
    connection.row_factory = sqlite3.Row
    try:
        connection.execute('PRAGMA query_only=ON')
        connection.execute('BEGIN')
        shape = [[table, [[r[1], r[2].upper(), r[3], r[5]] for r in connection.execute('PRAGMA table_info(' + table + ')')]] for table in TABLES]
        fingerprint = hashlib.sha256(json.dumps(shape, separators=(',', ':')).encode()).hexdigest()
        if fingerprint != SHAPE:
            return {'status': 'incompatible', 'version': version, 'reason': 'Selected-table schema mismatch'}
        queries = {
            'forwards': ('gui_forwards', 'forward_date', 'id,forward_date as at,chan_id_in,chan_id_out,amt_out_msat,fee'),
            'failures': ('gui_failedhtlcs', 'timestamp', 'id,timestamp as at,chan_id_in,chan_id_out,amount,missed_fee,failure_detail,wire_failure'),
            'failureRollups': ('gui_histfailedhtlc', 'date', 'date as at,chan_id_in,chan_id_out,htlc_count,amount_sum,fee_sum'),
            'rebalances': ('gui_rebalancer', 'requested', 'id,status,value,fees_paid as fees'),
        }
        result = {'status': 'ok', 'version': version, 'schemaFingerprint': fingerprint,
                  'coverage': {'start': start, 'end': end, 'complete': False, 'source': 'LNDg selected diagnostic tables',
                               'note': 'Selected rows captured completely; failures are attempts, older failures are daily rollups. Upstream ingestion completeness is unknown.'},
                  'captureCounts': {}}
        # Django stores naive UTC values in this qualified version. Rollup dates use day boundaries.
        sql_start = dt.datetime.fromisoformat(start.replace('Z', '+00:00')).replace(tzinfo=None).isoformat(sep=' ')
        sql_end = dt.datetime.fromisoformat(end.replace('Z', '+00:00')).replace(tzinfo=None).isoformat(sep=' ')
        for key, (table, time_column, columns) in queries.items():
            lower = start[:10] if key == 'failureRollups' else sql_start
            upper = end[:10] + ' 23:59:59' if key == 'failureRollups' else sql_end
            where = ' WHERE ' + time_column + '>=? AND ' + time_column + '<?'
            expected = connection.execute('SELECT count(*) FROM ' + table + where, (lower, upper)).fetchone()[0]
            if expected > 100000:
                raise ValueError('Source capture exceeds bounded projection')
            records = [dict(r) for r in connection.execute('SELECT ' + columns + ' FROM ' + table + where + ' ORDER BY id', (lower, upper))]
            if len(records) != expected:
                raise ValueError('Source capture incomplete')
            for record in records:
                if 'at' in record:
                    record['at'] = utc(record['at'])
                for field in ['fee', 'missed_fee', 'fee_sum', 'fees']:
                    if field in record and record[field] is not None:
                        record[field] = sat_text(record[field])
                for field in ['chan_id_in', 'chan_id_out', 'amt_out_msat', 'amount', 'amount_sum', 'value']:
                    if field in record:
                        record[field] = str(record[field])
            result[key] = records
            result['captureCounts'][key] = {'selected': expected, 'returned': len(records), 'pagesComplete': True}
        return result
    finally:
        connection.close()


def read_lightningmate(directory, start, end, version):
    telemetry = json.loads((directory / 'htlc-telemetry.json').read_text())
    log = json.loads((directory / 'rebalances.json').read_text())
    if not isinstance(telemetry.get('buckets'), list) or not isinstance(log, list) or len(log) > 200:
        raise ValueError('Source record format mismatch')
    failures, rebalances = [], []
    for bucket in telemetry['buckets']:
        stamp = utc(bucket['day'])
        if start <= stamp < end:
            failures.append({'at': stamp, 'target': bucket['outChannel'],
                             'liquidityCount': str(bucket['liquidityCount']), 'liquiditySats': str(bucket['liquiditySats']),
                             'otherCount': str(bucket['otherCount'])})
    for record in log:
        stamp = utc(record['at'])
        if start <= stamp < end:
            if type(record['ok']) is not bool:
                raise ValueError('Unknown rebalance outcome')
            normalized = {'at': stamp, 'sourceId': record['sourceId'], 'targetId': record['targetId'],
                          'amountSats': str(record['amountSats']), 'feeSats': sat_text(record['feeSats']),
                          'status': 'succeeded' if record['ok'] else 'failed', 'imported': record.get('imported') is True}
            if record.get('feeMsatExact') is not None:
                normalized['feeMsatExact'] = str(record['feeMsatExact'])
            rebalances.append(normalized)
    return {'status': 'ok', 'version': version, 'failures': failures, 'rebalances': rebalances,
            'coverage': {'start': start, 'end': end, 'complete': False, 'source': 'Lightning Mate telemetry and rebalance log',
                         'note': 'Daily outgoing-channel buckets are not distinct payments. Stock log is capped at200; upstream completeness unknown.'},
            'captureCounts': {'failures': len(failures), 'rebalances': len(rebalances), 'stockLogCount': len(log)}}


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temp = tempfile.mkstemp(prefix='.' + path.name, dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            os.fchmod(stream.fileno(), 0o600)
            json.dump(value, stream, separators=(',', ':'))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
        parent_fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(parent_fd)
        finally:
            os.close(parent_fd)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def capture(app_directory, base):
    end = dt.datetime.now(UTC)
    end_text = utc(end.isoformat())
    start = utc((end - dt.timedelta(days=90)).isoformat())
    identity = (app_directory / 'credentials/node-pubkey').read_text().strip()
    if len(identity) != 66 or any(c not in '0123456789abcdef' for c in identity):
        raise ValueError('Node identity not qualified')
    providers = {}
    for name in IMAGES:
        try:
            version = running_version(name)
            if name == 'lndg':
                lndg_timezone()
                providers[name] = read_lndg(base / 'lndg/data/db/db.sqlite3', start, end_text, version)
            else:
                providers[name] = read_lightningmate(base / 'lightningmate/data', start, end_text, version)
        except ValueError:
            providers[name] = {'status': 'incompatible', 'reason': 'Source version, shape, timezone or amount precision is not qualified'}
        except Exception:
            providers[name] = {'status': 'unavailable', 'reason': 'Source version, shape, bounded capture or read is unavailable'}
    return {'schema': 1, 'identity': identity, 'capturedAt': end_text, 'providers': providers}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('app_directory', type=pathlib.Path)
    parser.add_argument('--base', type=pathlib.Path, default=pathlib.Path('/home/umbrel/umbrel/app-data'))
    args = parser.parse_args()
    projection = capture(args.app_directory, args.base)
    atomic_json(args.app_directory / 'diagnostics/status.json', projection)
    print(json.dumps({name: {'status': provider['status'], 'counts': provider.get('captureCounts')} for name, provider in projection['providers'].items()}))
