#!/usr/bin/env python3
"""Consume an owner-authorized safe projection; never read system tokens.

Privileged producer reads durable apps IDs, finite owner state queries and
matching container/settings evidence before and after. No catalog/member query
establishes absence. Missing evidence fails closed; original time is preserved.
"""
import datetime
import hashlib
import json
import os
import pathlib
import re
import tempfile

FLAGS = ['fee', 'rebalance', 'channel', 'sell', 'autoclose', 'relist', 'reprice',
         'size', 'maxHTLC', 'lsp', 'lndgAF', 'lndgAR', 'lndgAutopilot', 'loop']


def runtime_binding_matches(actual, expected):
    return isinstance(actual, dict) and isinstance(expected, dict) and bool(
        re.fullmatch(r'[a-f0-9]{64}', expected.get('containerId', '')) and
        re.fullmatch(r'[a-z0-9./:_-]+@sha256:[a-f0-9]{64}', expected.get('imageRef', '')) and
        re.fullmatch(r'sha256:[a-f0-9]{64}', expected.get('imageId', ''))) and all(
            actual.get(key) == expected[key] for key in ['containerId', 'imageRef', 'imageId'])


def project(source, boot_id, generation, contract=None):
    if source.get('schema') != 2 or source.get('ownerScope') != 'owner':
        raise ValueError('Owner inventory required')
    if source.get('hostBootId') != boot_id or source.get('generation') != generation:
        raise ValueError('Host/generation changed')
    if not isinstance(contract, dict) or not re.fullmatch(r'[a-f0-9]{64}', contract.get('producerHash', '')) or source.get('producerHash') != contract['producerHash'] or not runtime_binding_matches(source.get('runtimeBinding'), contract.get('runtimeBinding')):
        raise ValueError('Trusted producer/current runtime binding required')
    ids = source.get('appIds')
    before, after = source.get('before'), source.get('after')
    if not isinstance(ids, list) or not all(app in ids for app in ['lightningmate', 'lndg', 'lightning-terminal', 'albyhub']) or len(ids) > 32 or len(set(ids)) != len(ids):
        raise ValueError('Finite reviewed IDs required')
    if not isinstance(before, list) or before != after or len(before) != len(ids):
        raise ValueError('Inventory changed during acquisition')
    if not isinstance(source.get('registryBeforeHash'), str) or len(source['registryBeforeHash']) != 64 or source['registryBeforeHash'] != source.get('registryAfterHash'):
        raise ValueError('Durable registry changed or unavailable')
    for app_id, state in zip(ids, before):
        if state.get('id') != app_id or type(state.get('durableInstalled')) is not bool or not isinstance(state.get('containers'), list):
            raise ValueError('Inventory unavailable')
        if state['durableInstalled']:
            if state.get('lifecycle') not in ['running', 'stopped']:
                raise ValueError('Lifecycle unresolved')
            installed = (contract or {}).get('installedQualifications', {}).get(app_id)
            if not installed or not runtime_binding_matches(state.get('runtimeBinding'), installed.get('runtimeBinding')):
                raise ValueError('Installed image binding unavailable')
            if app_id == 'albyhub':
                # Route/runtime qualification is supplied only by the controlled owner producer.
                qualification = (contract or {}).get('albyQualification', {})
                facts = state.get('backendFacts', {})
                if not qualification or qualification.get('version') != '1.24.0-patch.1' or len(qualification.get('sourceHash', '')) != 64 or facts.get('contract') != 'albyhub-v1.24.0-native-read-v1' or facts.get('contract') != qualification.get('contract') or facts.get('version') != qualification.get('version') or facts.get('sourceHash') != qualification.get('sourceHash'):
                    raise ValueError('Alby runtime/backend source unqualified')
                if not re.fullmatch(r'(02|03)[a-f0-9]{64}', facts.get('nodeId', '')) or not re.fullmatch(r'(02|03)[a-f0-9]{64}', (contract or {}).get('expectedLndNodeId', '')) or not re.fullmatch(r'[a-f0-9]{64}', facts.get('checksum', '')):
                    raise ValueError('Alby native identity/checksum unavailable')
                age = (datetime.datetime.now(datetime.timezone.utc) - datetime.datetime.fromisoformat(facts['at'].replace('Z', '+00:00'))).total_seconds()
                if not 0 <= age <= 90:
                    raise ValueError('Alby backend evidence stale')
                if facts.get('backend') == 'lnd':
                    if facts['nodeId'] == contract['expectedLndNodeId'] and facts.get('autoSwapOutEnabled') is not False:
                        raise ValueError('Shared LND automatic swaps unknown or enabled')
                elif facts.get('backend') != 'ldk' or facts['nodeId'] == contract['expectedLndNodeId']:
                    raise ValueError('Alby backend unknown')
            elif app_id not in ['lightningmate', 'lndg', 'lightning-terminal']:
                raise ValueError('Installed adapter unqualified')
            else:
                facts = state.get('settingsFacts', {})
                if not re.fullmatch(r'[a-f0-9]{64}', installed.get('hook', {}).get('sourceHash', '')) or facts.get('sourceHash') != installed['hook']['sourceHash'] or not isinstance(installed.get('version'), str) or not installed['version'] or facts.get('version') != installed['version'] or not re.fullmatch(r'[a-f0-9]{64}', facts.get('settingsDigest', '')) or not re.fullmatch(r'(02|03)[a-f0-9]{64}', (contract or {}).get('expectedLndNodeId', '')) or facts.get('nodeId') != contract['expectedLndNodeId']:
                    raise ValueError('Installed native settings unqualified')
        elif state.get('lifecycle') != 'not-installed' or state['containers']:
            raise ValueError('Durable/lifecycle/container disagreement')
    if source.get('otherAutomationBefore') != [] or source.get('otherAutomationAfter') != []:
        raise ValueError('Unqualified standalone/community automation')
    if any(source.get('flags', {}).get(flag) is not False for flag in FLAGS):
        raise ValueError('Automation unknown or enabled')
    at = datetime.datetime.fromisoformat(source['at'].replace('Z', '+00:00'))
    age = (datetime.datetime.now(datetime.timezone.utc) - at).total_seconds()
    if not 0 <= age <= 90:
        raise ValueError('Original inventory acquisition stale')
    allowed_state = ['id', 'durableInstalled', 'lifecycle', 'containers']
    facts_keys = ['contract', 'version', 'sourceHash', 'checksum', 'at', 'backend', 'nodeId', 'autoSwapOutEnabled']
    sanitized = [{key: state[key] for key in allowed_state} | ({'runtimeBinding': {key: state['runtimeBinding'][key] for key in ['containerId', 'imageRef', 'imageId']}} if state['durableInstalled'] else {}) | ({'settingsFacts': {key: state['settingsFacts'][key] for key in ['settingsDigest', 'nodeId', 'sourceHash', 'version']}} if 'settingsFacts' in state else {}) | ({'backendFacts': {key: state['backendFacts'].get(key) for key in facts_keys}} if 'backendFacts' in state else {}) for state in before]
    source = {**source, 'before': sanitized, 'after': sanitized}
    return {key: source[key] for key in ['schema', 'at', 'ownerScope', 'hostBootId', 'generation', 'appIds', 'before', 'after', 'flags', 'registryBeforeHash', 'registryAfterHash', 'otherAutomationBefore', 'otherAutomationAfter', 'producerHash', 'runtimeBinding']} | {'sourceHash': hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest()}


def write_atomic(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(prefix='.interlock-', dir=path.parent)
    temporary = pathlib.Path(name)
    try:
        with os.fdopen(descriptor, 'w') as stream:
            json.dump(value, stream)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)
    descriptor = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
