import importlib.util
import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).parents[1]))
spec = importlib.util.spec_from_file_location('competition', pathlib.Path(__file__).parents[1] / 'competition.py')
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)
PEER, OTHER, OWN = '02' + '1' * 64, '03' + '2' * 64, '02' + '3' * 64


def policy(ppm):
    return {'fee_base_msat': '0', 'fee_rate_milli_msat': ppm, 'min_htlc': '1000',
            'max_htlc_msat': '9007199254740993000', 'disabled': False, 'last_update': 1791492852}


class CompetitionTests(unittest.TestCase):
    def test_receiving_peer_uses_neighbors_outbound_policy_and_exact_scid(self):
        edge = {'channel_id': '1066880321721991171', 'node1_pub': PEER, 'node2_pub': OTHER,
                'node1_policy': policy('999'), 'node2_policy': policy('123'), 'capacity': '1000000'}
        raw = {'node': {'pub_key': PEER}, 'num_channels': 1, 'channels': [edge]}
        result = c.project_peer(raw, PEER, OWN)
        self.assertEqual(result['policies'][0]['ppm'], '123')
        self.assertEqual(result['policies'][0]['channelId'], '1066880321721991171')
        self.assertFalse(result['trafficKnown'])
        self.assertFalse(result['liquidityKnown'])
        edge['node1_pub'], edge['node2_pub'] = OTHER, PEER
        self.assertEqual(c.project_peer(raw, PEER, OWN)['policies'][0]['ppm'], '999')

    def test_missing_policy_is_unknown_and_incomplete_capture_not_zero(self):
        edge = {'channel_id': '12', 'node1_pub': PEER, 'node2_pub': OTHER,
                'node1_policy': policy('999'), 'node2_policy': None, 'capacity': '1000000'}
        raw = {'node': {'pub_key': PEER}, 'num_channels': 2, 'channels': [edge]}
        result = c.project_peer(raw, PEER, OWN)
        self.assertEqual(result['missingPolicies'], 1)
        self.assertFalse(result['captureComplete'])
        with self.assertRaises(ValueError):
            c.project_peer(dict(raw, channels=[edge, edge]), PEER, OWN)


if __name__ == '__main__':
    unittest.main()
