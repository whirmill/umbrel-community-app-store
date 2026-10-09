#!/usr/bin/env python3
"""Bounded public-graph projection, host-only. No financial RPC or socket mount."""
import argparse
import concurrent.futures
import datetime as dt
import json
import pathlib
import re
import subprocess

from diagnostics import atomic_json, utc

IMAGE = 'lightninglabs/lnd:v0.21.3-beta@sha256:d29074335f3bffb2ac0e789b0d023c24fbb85ce67ecbfb7d677399842fe0535c'


def natural(value):
    if isinstance(value, bool) or not re.fullmatch(r'[0-9]+', str(value)):
        raise ValueError('Graph integer mismatch')
    return str(int(value))


def pubkey(value):
    if not isinstance(value, str) or not re.fullmatch(r'0[23][0-9a-f]{64}', value):
        raise ValueError('Graph identity mismatch')
    return value


def read(command):
    # Fixed command callers only; no model-supplied arguments or generic RPC.
    result = subprocess.run(['docker', 'exec', 'lightning_lnd_1', 'lncli', *command],
                            check=True, capture_output=True, text=True, timeout=15)
    if len(result.stdout) > 32 * 1024 * 1024:
        raise ValueError('Graph capture exceeds bound')
    return json.loads(result.stdout)


def project_peer(raw, peer, identity):
    if pubkey(raw['node']['pub_key']) != peer or not isinstance(raw.get('channels'), list):
        raise ValueError('Peer graph shape mismatch')
    channels = raw['channels']
    if len(channels) > 10000:
        raise ValueError('Peer graph exceeds bound')
    records, ids, missing = [], set(), 0
    for edge in channels:
        key = natural(edge['channel_id'])
        if key in ids:
            raise ValueError('Duplicate graph edge')
        ids.add(key)
        node1, node2 = pubkey(edge['node1_pub']), pubkey(edge['node2_pub'])
        if peer == node1:
            neighbor, policy = node2, edge.get('node2_policy')
        elif peer == node2:
            neighbor, policy = node1, edge.get('node1_policy')
        else:
            raise ValueError('Unrelated graph edge')
        if neighbor == identity:
            continue
        if policy is None:
            missing += 1
            continue
        if type(policy['disabled']) is not bool:
            raise ValueError('Graph disabled flag mismatch')
        records.append({'channelId': key, 'neighbor': neighbor, 'capacitySat': natural(edge['capacity']),
                        'baseMsat': natural(policy['fee_base_msat']), 'ppm': natural(policy['fee_rate_milli_msat']),
                        'minMsat': natural(policy['min_htlc']), 'maxMsat': natural(policy['max_htlc_msat']),
                        'disabled': policy['disabled'], 'lastUpdate': natural(policy['last_update'])})
    declared = natural(raw['num_channels'])
    return {'status': 'ok', 'peer': peer, 'policies': records, 'missingPolicies': missing,
            'declaredChannels': declared, 'capturedChannels': len(channels),
            'captureComplete': int(declared) == len(channels), 'liquidityKnown': False,
            'trafficKnown': False, 'direction': 'neighbor->peer; peer outbound policy is not the comparable price'}


def capture(app):
    result = subprocess.run(['docker', 'inspect', '--format', '{{json .Config.Image}} {{json .State.Running}}', 'lightning_lnd_1'],
                            check=True, capture_output=True, text=True, timeout=8)
    image, running = result.stdout.strip().split()
    if json.loads(image) != IMAGE or running != 'true':
        raise ValueError('LND image unqualified')
    expected = pubkey((app / 'credentials/node-pubkey').read_text().strip())
    info = read(['getinfo'])
    if info['identity_pubkey'] != expected or info['version'] != '0.21.3-beta commit=v0.21.3-beta' or info['synced_to_graph'] is not True:
        raise ValueError('Node binding, version or graph synchronization unqualified')
    channels = read(['listchannels'])['channels']
    if not isinstance(channels, list) or len(channels) > 100:
        raise ValueError('Own channel capture unqualified')
    peers = sorted({pubkey(c['remote_pubkey']) for c in channels if c['private'] is False})
    if len(peers) > 16:
        raise ValueError('Peer graph capture exceeds POC bound')
    reports = []

    def fetch(peer):
        try:
            projection = project_peer(read(['getnodeinfo', '--include_channels', '--pub_key', peer]), peer, expected)
            projection['capturedAt'] = utc(dt.datetime.now(dt.timezone.utc).isoformat())
            return projection
        except Exception:
            return {'status': 'unavailable', 'peer': peer, 'reason': 'Bounded public graph capture failed; unknown is not zero'}

    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        reports = list(pool.map(fetch, peers))
    return {'schema': 1, 'identity': expected, 'version': '0.21.3-beta',
            'capturedAt': utc(dt.datetime.now(dt.timezone.utc).isoformat()), 'peers': reports,
            'note': 'Public announced direct-to-peer policies only. No balances, executed rival routes or rival traffic inferred.'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('app_directory', type=pathlib.Path)
    args = parser.parse_args()
    try:
        projection = capture(args.app_directory)
    except Exception:
        projection = {'schema': 1, 'status': 'unavailable', 'capturedAt': utc(dt.datetime.now(dt.timezone.utc).isoformat()),
                      'reason': 'LND graph binding, version or capture unavailable'}
    atomic_json(args.app_directory / 'diagnostics/competition.json', projection)
    print(json.dumps({'status': projection.get('status', 'captured'), 'peers': len(projection.get('peers', [])),
                      'qualifiedPeers': sum(p['status'] == 'ok' for p in projection.get('peers', []))}))
