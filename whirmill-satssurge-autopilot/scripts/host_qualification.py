"""Finite reviewed native settings/standalone hooks, not supplied status receipts.

The root contract pins source bytes, Python binary and root config. Hooks must
perform actual bounded native reads. No shell, arbitrary args, environment or
credential output is accepted. Unknown/incomplete results fail closed.
"""
import datetime as dt
import hashlib
import json
import pathlib
import re

import host_read_boundary


def run_hook(spec, scope, contract, run, clock=lambda: dt.datetime.now(dt.timezone.utc)):
    if scope not in ['standalone', 'lightningmate', 'lndg', 'lightning-terminal'] or spec.get('contract') != 'satssurge-native-host-hook-v1':
        raise ValueError('Native hook contract unavailable')
    source = host_read_boundary.read_bytes(pathlib.Path(spec['path']), 1048576, protected=True)
    if hashlib.sha256(source).hexdigest() != spec.get('sourceHash'):
        raise ValueError('Native hook source changed')
    interpreter = host_read_boundary.read_bytes(pathlib.Path(spec['python']), 64 * 1024 * 1024, protected=True)
    if hashlib.sha256(interpreter).hexdigest() != spec.get('pythonHash'):
        raise ValueError('Native hook interpreter changed')
    # Read root configuration through pinned fds before passing its path to the
    # reviewed helper. Only this fixed argv exists; never accept hook-supplied argv.
    configuration = host_read_boundary.read_bytes(pathlib.Path(spec['config']), 65536, protected=True)
    if hashlib.sha256(configuration).hexdigest() != spec.get('configHash'):
        raise ValueError('Native hook configuration changed')
    started = clock()
    value = json.loads(run([spec['python'], '-I', '-S', spec['path'], '--config', spec['config'], '--scope', scope], timeout=8, cap=16384))
    acquired = dt.datetime.fromisoformat(value['at'].replace('Z', '+00:00'))
    current = clock()
    if not started <= acquired <= current or not 0 <= (current - acquired).total_seconds() <= 15 or value.get('contract') != spec['contract'] or value.get('sourceHash') != spec['sourceHash'] or value.get('scope') != scope or value.get('hostBootId') != contract['hostBootId'] or value.get('generation') != contract['generation'] or value.get('complete') is not True:
        raise ValueError('Current native hook acquisition unavailable')
    if scope == 'standalone':
        if value.get('unqualifiedAutomation') != [] or not re.fullmatch(r'[a-f0-9]{64}', value.get('processInventoryDigest', '')) or not re.fullmatch(r'[a-f0-9]{64}', value.get('scheduleInventoryDigest', '')):
            raise ValueError('Standalone process/schedule qualification incomplete')
        return {key: value[key] for key in ['unqualifiedAutomation', 'processInventoryDigest', 'scheduleInventoryDigest']}
    expected = ['fee', 'rebalance', 'channel', 'sell', 'autoclose', 'relist', 'reprice', 'size', 'maxHTLC', 'lsp'] if scope == 'lightningmate' else ['loop'] if scope == 'lightning-terminal' else ['lndgAF', 'lndgAR', 'lndgAutopilot']
    if value.get('nodeId') != contract.get('expectedLndNodeId') or any(value.get('flags', {}).get(flag) is not False for flag in expected) or not re.fullmatch(r'[a-f0-9]{64}', value.get('settingsDigest', '')):
        raise ValueError('Native installed settings unknown or enabled')
    return {'flags': {flag: False for flag in expected}, 'settingsDigest': value['settingsDigest'], 'nodeId': value['nodeId']}
