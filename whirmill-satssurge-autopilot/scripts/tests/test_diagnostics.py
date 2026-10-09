import importlib.util
import json
import pathlib
import sqlite3
import tempfile
import unittest
import hashlib

spec = importlib.util.spec_from_file_location('diagnostics', pathlib.Path(__file__).parents[1] / 'diagnostics.py')
d = importlib.util.module_from_spec(spec)
spec.loader.exec_module(d)


class DiagnosticTests(unittest.TestCase):
    def test_exact_units_timestamps_and_private_atomic_output(self):
        self.assertEqual(d.sat_text('9007199254740993.003'), '9007199254740993.003')
        self.assertEqual(d.utc('2026-10-09 01:00:00'), '2026-10-09T01:00:00.000Z')
        with self.assertRaises(ValueError):
            d.sat_text('0.0001')
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'projection/status.json'
            d.atomic_json(path, {'value': 1})
            d.atomic_json(path, {'value': 2})
            self.assertEqual(json.loads(path.read_text()), {'value': 2})
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(len(list(path.parent.iterdir())), 1)

    def test_lightningmate_projection_excludes_payment_identity_and_keeps_coverage_partial(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / 'htlc-telemetry.json').write_text(json.dumps({'startedAt': '2026-10-04T00:00:00Z', 'buckets': [{'day': '2026-10-08', 'outChannel': '970322x536x3', 'liquidityCount': 4, 'liquiditySats': 4000, 'otherCount': 2}]}))
            (root / 'rebalances.json').write_text(json.dumps([{'at': '2026-10-08T12:00:00Z', 'sourceId': '970322x536x3', 'targetId': '970322x536x1', 'amountSats': 1000, 'feeSats': 1.003, 'feeMsatExact': 1003, 'ok': True, 'paymentHash': 'private-hash', 'paymentIndex': '42'}]))
            result = d.read_lightningmate(root, '2026-10-01T00:00:00.000Z', '2026-10-09T00:00:00.000Z', '0.7.7')
            self.assertFalse(result['coverage']['complete'])
            self.assertEqual(result['failures'][0]['liquidityCount'], '4')
            self.assertEqual(result['rebalances'][0]['feeSats'], '1.003')
            self.assertNotIn('private-hash', json.dumps(result))
            self.assertEqual(result['rebalances'][0]['status'], 'succeeded')

    def test_sqlite_selected_capture_is_complete_readonly_and_rejects_other_shapes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / 'fixture.sqlite'
            c = sqlite3.connect(path)
            c.executescript('CREATE TABLE gui_forwards(id INTEGER,forward_date TEXT,chan_id_in TEXT,chan_id_out TEXT,amt_out_msat TEXT,fee TEXT); CREATE TABLE gui_failedhtlcs(id INTEGER,timestamp TEXT,chan_id_in TEXT,chan_id_out TEXT,amount TEXT,missed_fee TEXT,failure_detail INTEGER,wire_failure INTEGER); CREATE TABLE gui_histfailedhtlc(id INTEGER,date TEXT,chan_id_in TEXT,chan_id_out TEXT,htlc_count INTEGER,amount_sum TEXT,fee_sum TEXT); CREATE TABLE gui_rebalancer(id INTEGER,requested TEXT,status INTEGER,value TEXT,fees_paid TEXT);')
            c.execute('INSERT INTO gui_forwards VALUES(?,?,?,?,?,?)', (1, '2026-10-08 12:00:00', '10', '20', '10000', '0.003'))
            c.commit()
            shape = [[table, [[r[1], r[2].upper(), r[3], r[5]] for r in c.execute('PRAGMA table_info(' + table + ')')]] for table in d.TABLES]
            c.close()
            original = d.SHAPE
            self.assertEqual(d.read_lndg(path, '2026-10-01T00:00:00.000Z', '2026-10-09T00:00:00.000Z', '1.11.1')['status'], 'incompatible')
            try:
                d.SHAPE = hashlib.sha256(json.dumps(shape, separators=(',', ':')).encode()).hexdigest()
                before = path.read_bytes()
                result = d.read_lndg(path, '2026-10-01T00:00:00.000Z', '2026-10-09T00:00:00.000Z', '1.11.1')
                self.assertEqual(result['captureCounts']['forwards']['returned'], 1)
                self.assertEqual(result['forwards'][0]['fee'], '0.003')
                self.assertEqual(path.read_bytes(), before)
            finally:
                d.SHAPE = original


if __name__ == '__main__':
    unittest.main()
