import importlib.util
import pathlib
import sys
import unittest
import datetime as dt
import json
import tempfile
from unittest.mock import patch, Mock

sys.path.insert(0, str(pathlib.Path(__file__).parents[1]))
spec = importlib.util.spec_from_file_location('lm_backfill', pathlib.Path(__file__).parents[1] / 'lm_backfill.py')
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)

OWN = '02' + '1' * 64
SINCE = dt.datetime(2026, 9, 25, tzinfo=dt.timezone.utc)


def payment():
    return {'status': 'SUCCEEDED', 'value_msat': '10000000', 'fee_msat': '1003',
            'payment_hash': 'a' * 64, 'payment_index': '42',
            'htlcs': [{'status': 'SUCCEEDED', 'resolve_time_ns': '1791453600000000000',
                       'route': {'total_fees_msat': '1003', 'total_amt_msat': '10001003',
                                 'hops': [{'chan_id': '1066880321721991171', 'pub_key': '03' + '2' * 64},
                                          {'chan_id': '1066752778500898816', 'pub_key': OWN}]}}]}


class BackfillTests(unittest.TestCase):
    def test_schema4_maintenance_preserves_guard(self):
        import tempfile
        import pathlib
        with tempfile.TemporaryDirectory() as directory:
            app = pathlib.Path(directory)
            (app / 'data').mkdir()
            db = b.sqlite3.connect(app / 'data/operational.sqlite')
            db.executescript('PRAGMA user_version=4; CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE operations(state TEXT);')
            db.close()
            with b.maintenance(app):
                db = b.sqlite3.connect(app / 'data/operational.sqlite')
                self.assertIsNotNone(db.execute("SELECT value FROM meta WHERE key='maintenanceClaim'").fetchone())
                db.close()
            db = b.sqlite3.connect(app / 'data/operational.sqlite')
            self.assertIsNone(db.execute("SELECT value FROM meta WHERE key='maintenanceClaim'").fetchone())
            db.close()

    def test_maintenance_claim_is_atomic_persistent_on_failure_and_recoverable(self):
        with tempfile.TemporaryDirectory() as directory:
            app = pathlib.Path(directory)
            (app / 'data').mkdir()
            db = b.sqlite3.connect(app / 'data/operational.sqlite')
            db.executescript('PRAGMA user_version=3; CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE operations(state TEXT);')
            db.execute("INSERT INTO operations VALUES('sending')")
            db.commit()
            with self.assertRaises(ValueError):
                with b.maintenance(app):
                    self.fail('Active operation cannot enter maintenance')
            db.execute('DELETE FROM operations');db.commit()
            with self.assertRaises(RuntimeError):
                with b.maintenance(app):
                    self.assertEqual(json.loads(db.execute("SELECT value FROM meta WHERE key='maintenanceClaim'").fetchone()[0])['owner'], 'lm-backfill')
                    raise RuntimeError('simulated restart failure')
            self.assertIsNotNone(db.execute("SELECT value FROM meta WHERE key='maintenanceClaim'").fetchone())
            with b.maintenance(app):
                pass
            self.assertIsNone(db.execute("SELECT value FROM meta WHERE key='maintenanceClaim'").fetchone())
            db.close()

    def test_projection_is_exact_and_excludes_personal_payments_and_preimages(self):
        p = payment()
        p['payment_preimage'] = 'secret'
        record = b.self_payment(p, OWN, SINCE)
        self.assertEqual(record['sourceId'], '970322x536x3')
        self.assertEqual(record['feeMsatExact'], 1003)
        self.assertEqual(record['feeSats'], 1.003)
        self.assertNotIn('payment_preimage', record)
        p['htlcs'][0]['route']['hops'][-1]['pub_key'] = '03' + '3' * 64
        self.assertIsNone(b.self_payment(p, OWN, SINCE))

    def test_conflicting_proofs_and_split_endpoints_fail_instead_of_guessing(self):
        p = payment()
        p['fee_msat'] = '1004'
        with self.assertRaises(ValueError):
            b.self_payment(p, OWN, SINCE)
        p = payment()
        import copy
        second = copy.deepcopy(p['htlcs'][0])
        second['route']['hops'][0]['chan_id'] = '1066880321721991169'
        p['htlcs'].append(second)
        with self.assertRaises(ValueError):
            b.self_payment(p, OWN, SINCE)

    def test_repeated_import_is_idempotent_and_existing_conflict_is_rejected(self):
        proof = b.self_payment(payment(), OWN, SINCE)
        records, first = b.merge([], [proof])
        again, second = b.merge(records, [proof])
        self.assertEqual(first['added'], 1)
        self.assertEqual(second['added'], 0)
        self.assertEqual(records, again)
        conflict = dict(proof, amountSats=9999)
        with self.assertRaises(ValueError):
            b.merge([conflict], [proof])
        with self.assertRaises(ValueError):
            b.merge([], [proof, proof])

    def test_native_ambiguity_preserves_records_and_does_not_duplicate(self):
        proof = b.self_payment(payment(), OWN, SINCE)
        native = {k: v for k, v in proof.items() if k not in ['paymentHash', 'paymentIndex']}
        records, result = b.merge([native], [proof])
        self.assertEqual(records, [native])
        self.assertEqual(result['added'], 0)
        self.assertEqual(result['unattributedNativeMatches'], 1)

    def test_controlled_merge_rereads_after_stop_and_restarts_without_financial_rpc(self):
        proof = b.self_payment(payment(), OWN, SINCE)
        concurrent = dict(proof, paymentHash='b' * 64, paymentIndex='43', at='2026-10-09T00:00:00.000Z')
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            app = root / 'app'
            (app / 'credentials').mkdir(parents=True)
            (app / 'credentials/node-pubkey').write_text(OWN)
            (app / 'data').mkdir()
            db = b.sqlite3.connect(app / 'data/operational.sqlite')
            db.executescript('PRAGMA user_version=3; CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE operations(state TEXT);')
            db.close()
            log = root / 'lightningmate/data/rebalances.json'
            log.parent.mkdir(parents=True)
            log.write_text('[]')
            running = [True]
            commands = []

            def command(args, **kwargs):
                commands.append(args)
                if args[1] == 'stop':
                    # A stock operation appended between preview and stop.
                    log.write_text(json.dumps([concurrent]))
                    running[0] = False
                elif args[1] == 'start':
                    running[0] = True
                return Mock()

            reader = Mock(pending=False)
            reader.proofs.return_value = [proof]
            with patch.object(b, 'Reader', return_value=reader), patch.object(b, 'running_version'), \
                    patch.object(b, 'idle_gate'), patch.object(b, 'verify_live_log'), \
                    patch.object(b, 'container_running', side_effect=lambda: running[0]), \
                    patch.object(b.subprocess, 'run', side_effect=command):
                result = b.execute(app, root, 'https://node:8080', SINCE, True)
            self.assertEqual(result['added'], 1)
            self.assertTrue(running[0])
            self.assertEqual(len(json.loads(log.read_text())), 2)
            self.assertEqual([c[1] for c in commands], ['stop', 'start'])
            self.assertEqual(json.loads((app / 'diagnostics/backfill/checkpoint.json').read_text())['phase'], 'completed_api_verified')
            # Crash after completion receipt but before claim cleanup must not
            # permanently block the executor on an unchanged subsequent run.
            db = b.sqlite3.connect(app / 'data/operational.sqlite')
            db.execute("INSERT INTO meta VALUES('maintenanceClaim',?)", (json.dumps({'owner': 'lm-backfill'}),))
            db.commit()
            with patch.object(b, 'Reader', return_value=reader), patch.object(b, 'running_version'), \
                    patch.object(b, 'verify_live_log'), patch.object(b, 'container_running', return_value=True), \
                    patch.object(b.subprocess, 'run') as run:
                recovered = b.execute(app, root, 'https://node:8080', SINCE, True)
            self.assertEqual(recovered['mode'], 'unchanged')
            self.assertIsNone(db.execute("SELECT value FROM meta WHERE key='maintenanceClaim'").fetchone())
            run.assert_not_called()
            db.close()

    def test_pending_payment_defers_restart(self):
        proof = b.self_payment(payment(), OWN, SINCE)
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            app = root / 'app'
            (app / 'credentials').mkdir(parents=True)
            (app / 'credentials/node-pubkey').write_text(OWN)
            log = root / 'lightningmate/data/rebalances.json'
            log.parent.mkdir(parents=True)
            log.write_text('[]')
            reader = Mock(pending=True)
            reader.proofs.return_value = [proof]
            with patch.object(b, 'Reader', return_value=reader), patch.object(b, 'running_version'), \
                    patch.object(b.subprocess, 'run') as run:
                with self.assertRaises(ValueError):
                    b.execute(app, root, 'https://node:8080', SINCE, True)
            run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
