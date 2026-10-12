import base64
import copy
import datetime as dt
import json
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).parents[1]))
import alby_readonly

AT = dt.datetime(2026, 10, 10, tzinfo=dt.timezone.utc)
QUALIFICATION = {'contract': alby_readonly.CONTRACT, 'version': '1.24.0-patch.1', 'apiVersion': 'v1.24.0', 'sourceHash': 'a' * 64}


def token(permission='readonly', expiration=AT.timestamp() + 60):
    segment = base64.urlsafe_b64encode(json.dumps({'permission': permission, 'exp': expiration}).encode()).decode().rstrip('=')
    return 'e30.' + segment + '.c2ln'


def responses():
    return {'/api/info': {'backendType': 'LND', 'version': 'v1.24.0', 'running': True, 'setupCompleted': True, 'user': 'SYNTHETIC_PRIVATE'},
            '/api/node/connection-info': {'pubkey': '02' + '1' * 64, 'address': 'SYNTHETIC_PRIVATE'},
            '/api/autoswap': {'type': 'out', 'enabled': False, 'destination': 'SYNTHETIC_DECRYPTED_XPUB'}}


class AlbyReadonlyTests(unittest.TestCase):
    def test_exact_three_gets_no_credentials_destination_or_raw_body_in_receipt(self):
        body = responses()
        calls = []
        def get(route, credential):
            calls.append(route)
            self.assertEqual(credential, token())
            return body[route]
        result = alby_readonly.read_facts(get, token(), QUALIFICATION, lambda: AT)
        self.assertEqual(calls, list(alby_readonly.ROUTES))
        self.assertEqual(result['backend'], 'lnd')
        self.assertIs(result['autoSwapOutEnabled'], False)
        self.assertEqual(body, dict.fromkeys(alby_readonly.ROUTES, {}))
        self.assertNotIn('SYNTHETIC', json.dumps(result))
        self.assertNotIn(token(), json.dumps(result))
        self.assertEqual(len(result['checksum']), 64)

    def test_full_legacy_expired_and_malformed_credentials_never_call_transport(self):
        def get(*args): self.fail('Transport must not be called')
        for credential in [token('full'), token(None), token(expiration=AT.timestamp()), 'SYNTHETIC_PRIVATE']:
            with self.subTest(credential=credential), self.assertRaisesRegex(ValueError, '^Current read-only Alby credential required$'):
                alby_readonly.read_facts(get, credential, QUALIFICATION, lambda: AT)

    def test_stale_binding_unknown_backend_or_missing_enabled_never_qualifies(self):
        for modify in [lambda p: p['/api/info'].update(version='unknown'), lambda p: p['/api/info'].update(backendType='unknown'), lambda p: p['/api/info'].update(running=False), lambda p: p['/api/node/connection-info'].update(pubkey='unknown'), lambda p: p['/api/autoswap'].pop('enabled'), lambda p: p['/api/autoswap'].update(enabled='false')]:
            body = responses()
            modify(body)
            with self.assertRaisesRegex(ValueError, '^Alby native read-only qualification unavailable$'):
                alby_readonly.read_facts(lambda route, credential: body[route], token(), QUALIFICATION, lambda: AT)
            self.assertNotIn('SYNTHETIC', json.dumps(body))

    def test_errors_are_sanitized_and_destination_is_discarded_on_failure(self):
        def get(*args): raise RuntimeError('SYNTHETIC_PRIVATE_RESPONSE')
        with self.assertRaisesRegex(ValueError, '^Alby native read-only qualification unavailable$'):
            alby_readonly.read_facts(get, token(), QUALIFICATION, lambda: AT)
        body = responses()
        body['/api/autoswap']['type'] = 'unknown'
        with self.assertRaises(ValueError): alby_readonly.read_facts(lambda route, credential: body[route], token(), QUALIFICATION, lambda: AT)
        self.assertEqual(body['/api/autoswap'], {})

    def test_expiry_between_gets_stops_remaining_reads(self):
        calls = []
        ticks = iter([AT, AT, AT + dt.timedelta(seconds=61)])
        def get(route, credential):
            calls.append(route)
            return responses()[route]
        with self.assertRaises(ValueError): alby_readonly.read_facts(get, token(), QUALIFICATION, lambda: next(ticks))
        self.assertEqual(calls, ['/api/info'])


    def test_nonfinite_or_nonactual_numeric_expiry_calls_no_transport(self):
        for expiry in [float('nan'), float('inf'), float('-inf'), True, '9999999999', None]:
            calls = []
            with self.assertRaises(ValueError):
                alby_readonly.read_facts(lambda *args: calls.append(args), token(expiration=expiry), QUALIFICATION, lambda: AT)
            self.assertEqual(calls, [])
