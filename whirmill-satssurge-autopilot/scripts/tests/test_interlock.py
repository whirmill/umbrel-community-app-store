import json
import os
import pathlib
import sqlite3
import subprocess
import sys
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / 'interlock.py'
FLAGS = ('fee', 'rebalance', 'channel', 'sell', 'autoclose', 'relist', 'reprice', 'size', 'maxHTLC', 'lsp', 'lndgAF', 'lndgAR', 'lndgAutopilot', 'loop')


class InterlockTests(unittest.TestCase):
    """interlock.py with a fake docker on PATH and a temporary app-data base."""

    def run_interlock(self, containers, lightningmate=None, lndg=None, docker_fails=False):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            base, app, bin_dir = root / 'app-data', root / 'satssurge', root / 'bin'
            for path in (base, app, bin_dir):
                path.mkdir()
            docker = bin_dir / 'docker'
            names = '\n'.join(containers)
            docker.write_text('#!/bin/sh\n' + ('exit 1\n' if docker_fails else f"printf '%s\\n' '{names}'\n"))
            docker.chmod(0o755)
            if lightningmate is not None:
                data = base / 'lightningmate/data'
                data.mkdir(parents=True)
                (data / 'autopilot.json').write_text(json.dumps({'config': lightningmate}))
                (data / 'settings.json').write_text(json.dumps({'lspModeEnabled': False}))
            if lndg is not None:
                db_dir = base / 'lndg/data/db'
                db_dir.mkdir(parents=True)
                db = sqlite3.connect(db_dir / 'db.sqlite3')
                db.execute('CREATE TABLE gui_localsettings(key TEXT, value TEXT)')
                db.executemany('INSERT INTO gui_localsettings VALUES(?,?)', lndg.items())
                db.commit()
                db.close()
            env = {**os.environ, 'PATH': f'{bin_dir}:{os.environ["PATH"]}', 'SATSSURGE_APP_DATA_BASE': str(base)}
            subprocess.run([sys.executable, str(SCRIPT), str(app)], check=True, env=env, timeout=20)
            return json.loads((app / 'interlock/status.json').read_text())

    def test_uninstalled_apps_count_as_absent_automation(self):
        status = self.run_interlock(['bitcoin_app_1', 'whirmill-satssurge-autopilot_server_1'])
        self.assertEqual(status['installed'], [])
        self.assertNotIn('error', status)
        self.assertTrue(all(status[flag] is False for flag in FLAGS), status)

    def test_installed_apps_are_still_read(self):
        off = {k: False for k in ('enabled', 'rebalanceEnabled', 'channelEnabled', 'sellEnabled', 'sellAutoClose', 'sellAutoRelist', 'sellAutoReprice', 'sellAutoSize', 'maxHtlcEnabled')}
        status = self.run_interlock(['lightningmate_web_1', 'lndg_web_1'], lightningmate=off, lndg={'AF-Enabled': '0', 'AR-Enabled': '1', 'AR-Autopilot': '0'})
        self.assertEqual(status['installed'], ['lightningmate', 'lndg'])
        self.assertIs(status['rebalance'], False)
        self.assertIs(status['lndgAR'], True, 'an enabled LNDg auto-rebalancer still holds finance')

    def test_installed_but_unreadable_app_fails_closed(self):
        status = self.run_interlock(['lightningmate_web_1'])
        self.assertEqual(status['error'], 'Live automation format/read mismatch')
        self.assertNotIn('fee', status)

    def test_docker_failure_fails_closed(self):
        status = self.run_interlock([], docker_fails=True)
        self.assertIn('error', status)
        self.assertFalse(any(status.get(flag) is False for flag in FLAGS))


if __name__ == '__main__':
    unittest.main()
