#!/usr/bin/env python3
"""Private, version-gated self-payment backfill. Dry run unless --apply.

Only GET requests with the existing read macaroon. Never writes accounting or
initiates a payment. The stock LM log needs its sole writer stopped for merging.
"""
import argparse
from contextlib import contextmanager
import datetime as dt
import decimal
import fcntl
import hashlib
import json
import pathlib
import re
import ssl
import sqlite3
import subprocess
import urllib.request

from diagnostics import atomic_json, running_version, utc

UTC = dt.timezone.utc
MAX_SAFE = 2**53 - 1


def natural(value):
    if isinstance(value, bool) or not re.fullmatch(r'[0-9]+', str(value)):
        raise ValueError('Invalid integer')
    return int(value)


def scid(value):
    number = natural(value)
    if number <= 0 or number >= 2**64:
        raise ValueError('Invalid channel identifier')
    return f'{number >> 40}x{(number >> 16) & 0xffffff}x{number & 0xffff}'


def self_payment(payment, identity, since):
    if payment.get('status') != 'SUCCEEDED':
        return None
    attempts = [h for h in payment.get('htlcs', []) if h.get('status') == 'SUCCEEDED']
    if not attempts:
        raise ValueError('Settled payment has no successful route')
    routes = [h['route'] for h in attempts]
    # Personal payments never leave this transient reader.
    destinations = [r['hops'][-1]['pub_key'] for r in routes]
    if identity not in destinations:
        return None
    if any(d != identity for d in destinations):
        raise ValueError('Mixed self-payment destinations')
    ends = {(str(r['hops'][0]['chan_id']), str(r['hops'][-1]['chan_id'])) for r in routes}
    if len(ends) != 1:
        raise ValueError('Split endpoint self-payment requires separate attribution')
    source, target = ends.pop()
    if source == target:
        raise ValueError('Self-payment has identical endpoints')
    amount, fee = natural(payment['value_msat']), natural(payment['fee_msat'])
    if not amount or amount % 1000 or amount // 1000 > MAX_SAFE or fee > MAX_SAFE:
        raise ValueError('Amount cannot be represented by stock LM')
    if sum(natural(r['total_fees_msat']) for r in routes) != fee:
        raise ValueError('Route fees disagree with settled payment')
    if sum(natural(r['total_amt_msat']) - natural(r['total_fees_msat']) for r in routes) != amount:
        raise ValueError('Route amounts disagree with settled payment')
    settled_ns = max(natural(h['resolve_time_ns']) for h in attempts)
    at = dt.datetime.fromtimestamp(settled_ns // 1_000_000_000, UTC).replace(microsecond=(settled_ns % 1_000_000_000) // 1000)
    if at < since:
        return None
    payment_hash = payment['payment_hash']
    if not re.fullmatch(r'[0-9a-f]{64}', payment_hash):
        raise ValueError('Invalid self-payment identity')
    sats = amount // 1000
    ppm = (fee * 1000 + sats // 2) // sats if sats else 0
    return {'at': utc(at.isoformat()), 'via': 'manual', 'sourceId': scid(source), 'targetId': scid(target),
            'sourceAlias': scid(source), 'targetAlias': scid(target), 'sourceScid': source, 'targetScid': target,
            'amountSats': sats, 'feeSats': float(decimal.Decimal(fee) / 1000), 'feeMsatExact': fee,
            'costPpm': ppm, 'budgetPpm': ppm, 'ok': True, 'imported': True,
            'paymentHash': payment_hash, 'paymentIndex': str(natural(payment['payment_index'])),
            'origin': 'LND settled circular payment; SatsSurge verified backfill'}


def fingerprint(record):
    if type(record['ok']) is not bool or any(not re.fullmatch(r'[0-9]+x[0-9]+x[0-9]+', record[field])
                                            for field in ['sourceId', 'targetId']):
        raise ValueError('Stock endpoint or outcome mismatch')
    fee = decimal.Decimal(str(record['feeSats'])) * 1000
    if fee != fee.to_integral_value() or fee < 0:
        raise ValueError('Stock fee precision mismatch')
    if 'feeMsatExact' in record and natural(record['feeMsatExact']) != int(fee):
        raise ValueError('Stock exact fee mismatch')
    return (record['sourceId'], record['targetId'], natural(record['amountSats']), int(fee), record['ok'])


def merge(existing, proofs):
    if not isinstance(existing, list) or len(existing) > 200:
        raise ValueError('Stock log shape mismatch')
    by_hash = {}
    for record in existing:
        fingerprint(record)
        if record.get('paymentHash'):
            key = record['paymentHash']
            if key in by_hash:
                raise ValueError('Duplicate stock payment identity')
            by_hash[key] = record
    seen, additions, native_matches = set(), [], 0
    for proof in proofs:
        key = proof['paymentHash']
        if key in seen:
            raise ValueError('Duplicate proof identity')
        seen.add(key)
        if key in by_hash:
            if fingerprint(by_hash[key]) != fingerprint(proof):
                raise ValueError('Existing record conflicts with authoritative payment')
            continue
        matches = [r for r in existing if not r.get('paymentHash') and fingerprint(r) == fingerprint(proof)
                   and abs((dt.datetime.fromisoformat(utc(r['at']).replace('Z', '+00:00')) -
                            dt.datetime.fromisoformat(proof['at'].replace('Z', '+00:00'))).total_seconds()) <= 60]
        if matches:
            # A native log is not a unique authoritative receipt. Keep it intact
            # and report the ambiguity rather than duplicate or guess an identity.
            native_matches += 1
            continue
        additions.append(proof)
    records = sorted(existing + additions, key=lambda r: utc(r['at']), reverse=True)
    return records[:200], {'verifiedProofs': len(proofs), 'added': len(additions),
                           'unattributedNativeMatches': native_matches, 'evictedByStockCap': max(0, len(records) - 200)}


class Reader:
    def __init__(self, app, base):
        if not re.fullmatch(r'https://[A-Za-z0-9.:-]+', base):
            raise ValueError('LND must use a plain HTTPS origin')
        self.base = base
        self.context = ssl.create_default_context(cafile=str(app / 'credentials/tls.cert'))
        self.token = (app / 'credentials/read.macaroon').read_bytes().hex()

    def get(self, path):
        request = urllib.request.Request(self.base + path, headers={'Grpc-Metadata-macaroon': self.token})
        with urllib.request.urlopen(request, context=self.context, timeout=20) as response:
            data = response.read(32 * 1024 * 1024 + 1)
            if len(data) > 32 * 1024 * 1024:
                raise ValueError('LND response limit exceeded')
            return json.loads(data)

    def proofs(self, identity, since):
        if self.get('/v1/getinfo')['identity_pubkey'] != identity:
            raise ValueError('LND node binding mismatch')
        offset, proofs = 0, []
        self.pending = False
        for _ in range(1000):
            page = self.get(f'/v1/payments?include_incomplete=true&max_payments=1000&index_offset={offset}')
            payments = page.get('payments')
            if not isinstance(payments, list):
                raise ValueError('Incomplete LND payment page')
            for payment in payments:
                if payment.get('status') == 'IN_FLIGHT':
                    self.pending = True
                proof = self_payment(payment, identity, since)
                if proof:
                    proofs.append(proof)
            if len(payments) < 1000:
                return proofs
            next_offset = natural(page['last_index_offset'])
            if next_offset <= offset:
                raise ValueError('LND payment pagination stalled')
            offset = next_offset
        raise ValueError('LND payment history incomplete')


def container_running():
    result = subprocess.run(['docker', 'inspect', '--format', '{{.State.Running}}', 'lightningmate_web_1'],
                            capture_output=True, text=True, check=True, timeout=8)
    return result.stdout.strip() == 'true'


def verify_live_log():
    # The pinned app's own session issuer uses its existing environment inside
    # the container. No password/token crosses stdout or enters agent storage.
    code = '''import {issueToken} from "/app/server/dist/services/auth.js";
import {readFileSync} from "node:fs";
let response;for(let i=0;i<5;i++){try{response=await fetch("http://127.0.0.1:"+(process.env.PORT??3001)+"/api/rebalance/log",{headers:{Authorization:"Bearer "+issueToken()},signal:AbortSignal.timeout(2000)});if(response.ok)break;}catch{}await new Promise(r=>setTimeout(r,250));}
if(!response?.ok)throw new Error("Rebalance API unavailable");
const live=await response.json(),log=JSON.parse(readFileSync("/data/rebalances.json","utf8"));
if(JSON.stringify(live.records)!==JSON.stringify(log.slice(0,50))||live.summary.count!==log.filter(r=>r.ok).length||live.summary.failed!==log.filter(r=>!r.ok).length)throw new Error("In-memory rebalance log mismatch");
console.log(JSON.stringify({verified:true,records:log.length}));'''
    result = subprocess.run(['docker', 'exec', 'lightningmate_web_1', 'node', '--input-type=module', '-e', code],
                            check=True, capture_output=True, text=True, timeout=15)
    if json.loads(result.stdout).get('verified') is not True:
        raise ValueError('Live log verification missing')


def idle_gate(app):
    gate = json.loads((app / 'interlock/status.json').read_text())
    flags = ['fee', 'rebalance', 'channel', 'sell', 'autoclose', 'relist', 'reprice', 'size',
             'maxHTLC', 'lsp', 'lndgAF', 'lndgAR', 'lndgAutopilot', 'loop']
    age = (dt.datetime.now(UTC) - dt.datetime.fromisoformat(gate['at'].replace('Z', '+00:00'))).total_seconds()
    if gate.get('schema') != 1 or not 0 <= age <= 90 or any(gate.get(flag) is not False for flag in flags):
        raise ValueError('Other automation interlock not fresh and off')
    connection = sqlite3.connect('file:' + str(app / 'data/operational.sqlite') + '?mode=ro', uri=True)
    try:
        if connection.execute("SELECT count(*) FROM operations WHERE state IN ('reserved','preparing','sending','uncertain','in_flight')").fetchone()[0]:
            raise ValueError('Autopilot operation active; defer visibility restart')
    finally:
        connection.close()


@contextmanager
def maintenance(app):
    # Durable atomic exclusion with Store.reserve/final dispatch. No expiry:
    # interruption must recover LM before releasing the financial fence.
    connection = sqlite3.connect(app / 'data/operational.sqlite', timeout=5)
    try:
        connection.execute('BEGIN IMMEDIATE')
        if connection.execute('PRAGMA user_version').fetchone()[0] != 3:
            raise ValueError('Maintenance fencing requires qualified schema3 executor')
        row = connection.execute("SELECT value FROM meta WHERE key='maintenanceClaim'").fetchone()
        if row and json.loads(row[0]).get('owner') != 'lm-backfill':
            raise ValueError('Other maintenance owner')
        if connection.execute("SELECT count(*) FROM operations WHERE state IN ('reserved','preparing','sending','uncertain','in_flight')").fetchone()[0]:
            raise ValueError('Financial operation active')
        connection.execute("INSERT OR REPLACE INTO meta VALUES('maintenanceClaim',?)",
                           (json.dumps({'owner': 'lm-backfill', 'at': utc(dt.datetime.now(UTC).isoformat())}),))
        connection.commit()
        yield
        connection.execute('BEGIN IMMEDIATE')
        connection.execute("DELETE FROM meta WHERE key='maintenanceClaim'")
        connection.commit()
    finally:
        connection.close()


def execute(app, base, lnd, since, apply):
    private = app / 'diagnostics/backfill'
    private.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (private / 'writer.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        checkpoint = private / 'checkpoint.json'
        prior = json.loads(checkpoint.read_text()) if checkpoint.exists() else {}
        database = app / 'data/operational.sqlite'
        orphan_claim = False
        if database.exists():
            connection = sqlite3.connect('file:' + str(database) + '?mode=ro', uri=True)
            try:
                orphan_claim = connection.execute("SELECT value FROM meta WHERE key='maintenanceClaim'").fetchone() is not None
            finally:
                connection.close()
        if orphan_claim or prior.get('phase') in ['stop_intent', 'stopped', 'merged', 'restart_intent']:
            # Recover the only app we stopped; a restart never repeats a payment.
            if not apply:
                raise ValueError('Interrupted backfill requires controlled restart')
            with maintenance(app):
                if not container_running():
                    subprocess.run(['docker', 'start', 'lightningmate_web_1'], check=True, capture_output=True, timeout=30)
                running_version('lightningMate')
                verify_live_log()
                atomic_json(checkpoint, {**prior, 'phase': 'recovered_api_verified'})
        running_version('lightningMate')
        identity = (app / 'credentials/node-pubkey').read_text().strip()
        reader = Reader(app, lnd)
        proofs = reader.proofs(identity, since)
        path = base / 'lightningmate/data/rebalances.json'
        records, summary = merge(json.loads(path.read_text()), proofs)
        if not apply or not summary['added']:
            if apply:
                verify_live_log()
            return {'mode': 'preview' if not apply else 'unchanged', **summary, 'inMemoryApiVerified': apply}
        if reader.pending:
            raise ValueError('Payments pending; defer stock application restart')
        with maintenance(app):
            idle_gate(app)
            stamp = dt.datetime.now(UTC).strftime('%Y%m%dT%H%M%S%fZ')
            receipt = {'phase': 'stop_intent', 'at': utc(dt.datetime.now(UTC).isoformat()), 'stamp': stamp}
            atomic_json(checkpoint, receipt)
            try:
                subprocess.run(['docker', 'stop', '--time', '20', 'lightningmate_web_1'], check=True, capture_output=True, timeout=30)
                if container_running():
                    raise ValueError('Stock writer is still running')
                receipt['phase'] = 'stopped'
                atomic_json(checkpoint, receipt)
                # Read again AFTER stopping; preserve records appended during preview.
                original = json.loads(path.read_text())
                records, summary = merge(original, proofs)
                atomic_json(private / f'{stamp}-before.json', original)
                atomic_json(private / f'{stamp}-proofs.json', proofs)
                atomic_json(path, records)
                if json.loads(path.read_text()) != records:
                    raise ValueError('Stock log readback mismatch')
                receipt.update({'phase': 'merged', 'summary': summary,
                                'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
                atomic_json(checkpoint, receipt)
            finally:
                receipt['phase'] = 'restart_intent'
                atomic_json(checkpoint, receipt)
                subprocess.run(['docker', 'start', 'lightningmate_web_1'], check=True, capture_output=True, timeout=30)
            running_version('lightningMate')
            if json.loads(path.read_text()) != records:
                raise ValueError('Stock log changed after restart; reconcile before retry')
            verify_live_log()
            receipt['phase'] = 'completed_api_verified'
            atomic_json(checkpoint, receipt)
            atomic_json(private / f'{stamp}-receipt.json', receipt)
            return {'mode': 'applied', **summary, 'inMemoryApiVerified': True}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('app_directory', type=pathlib.Path)
    parser.add_argument('--base', type=pathlib.Path, default=pathlib.Path('/home/umbrel/umbrel/app-data'))
    parser.add_argument('--lnd', default='https://10.21.21.9:8080')
    parser.add_argument('--since', default='2026-09-25T00:36:45Z')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    try:
        result = execute(args.app_directory, args.base, args.lnd,
                         dt.datetime.fromisoformat(args.since.replace('Z', '+00:00')), args.apply)
        atomic_json(args.app_directory / 'diagnostics/backfill-status.json',
                    {'at': utc(dt.datetime.now(UTC).isoformat()), 'status': 'ok', **result})
        print(json.dumps(result))
    except Exception as error:
        # Errors must not print HTTP bodies, macaroon values or payment payloads.
        outcome = {'at': utc(dt.datetime.now(UTC).isoformat()), 'status': 'blocked', 'errorType': type(error).__name__}
        atomic_json(args.app_directory / 'diagnostics/backfill-status.json', outcome)
        print(json.dumps(outcome))
        raise SystemExit(1)
