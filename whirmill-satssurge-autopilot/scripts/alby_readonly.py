"""Qualification adapter for an owner-supplied authenticated read-only transport.

No token minting, password, start/unlock, config write, or network construction.
The privileged caller binds the transport and image to a reviewed installation.
Only sanitized fields survive. In particular, autoswap destination may be a
DECRYPTED XPUB: discard it in memory before validation, checksum or receipt.
"""
import base64
import datetime as dt
import hashlib
import json
import re
import math

ROUTES = ('/api/info', '/api/node/connection-info', '/api/autoswap')
CONTRACT = 'albyhub-v1.24.0-native-read-v1'


def require_readonly(jwt, clock):
    try:
        if not isinstance(jwt, str) or len(jwt) > 8192 or not re.fullmatch(r'[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', jwt):
            raise ValueError()
        middle = jwt.split('.')[1]
        claims = json.loads(base64.urlsafe_b64decode(middle + '=' * (-len(middle) % 4)))
        if claims.get('permission') != 'readonly' or type(claims.get('exp')) not in [int, float] or not math.isfinite(claims['exp']) or claims['exp'] <= clock.timestamp():
            raise ValueError()
    except Exception:
        raise ValueError('Current read-only Alby credential required') from None
    # Local claims check limits credential scope. Server-authenticated successful
    # responses, not this unverified decode, establish signature validity.


def read_facts(read_get, jwt, qualification, clock=lambda: dt.datetime.now(dt.timezone.utc)):
    """read_get(route, jwt) returns a private dict after server auth, caps/deadline.

    Caller must reject redirects, protect TLS/local endpoint, cap bodies and erase
    raw transport buffers. This adapter does not claim live endpoint qualification.
    The runtime root producer continues to block installed Alby until that proof.
    """
    at = clock()
    require_readonly(jwt, at)
    safe = {}
    try:
        if qualification.get('contract') != CONTRACT or qualification.get('version') != '1.24.0-patch.1' or not re.fullmatch(r'[a-f0-9]{64}', qualification.get('sourceHash', '')) or not isinstance(qualification.get('apiVersion'), str) or not qualification['apiVersion']:
            raise ValueError()
        keys = (('backendType', 'version', 'running', 'setupCompleted'), ('pubkey',), ('enabled', 'type'))
        for route, allowed in zip(ROUTES, keys):
            require_readonly(jwt, clock())
            raw = read_get(route, jwt)
            if not isinstance(raw, dict):
                raise ValueError()
            try:
                safe[route] = {key: raw.get(key) for key in allowed}
            finally:
                # Drops xpub, OAuth/account fields, node addresses and any error
                # narrative before checksums/logs. Do not keep the input elsewhere.
                raw.clear()
        info, node, swap = (safe[route] for route in ROUTES)
        if info['version'] != qualification['apiVersion'] or info['running'] is not True or info['setupCompleted'] is not True or info['backendType'] not in ['LND', 'LDK'] or not re.fullmatch(r'(02|03)[a-f0-9]{64}', node['pubkey'] or '') or type(swap['enabled']) is not bool or swap['type'] != 'out':
            raise ValueError()
        require_readonly(jwt, clock())
        if not 0 <= (clock() - at).total_seconds() <= 30:
            raise ValueError()
        facts = {'contract': CONTRACT, 'version': qualification['version'], 'sourceHash': qualification['sourceHash'],
                 'at': at.isoformat(), 'backend': info['backendType'].lower(), 'nodeId': node['pubkey'],
                 'autoSwapOutEnabled': swap['enabled']}
        facts['checksum'] = hashlib.sha256(json.dumps(facts, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        return facts
    except Exception:
        raise ValueError('Alby native read-only qualification unavailable') from None
    finally:
        safe.clear()
