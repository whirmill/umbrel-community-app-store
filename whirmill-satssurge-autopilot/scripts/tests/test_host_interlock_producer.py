import copy
import datetime as dt
import hashlib
import importlib.util
import pathlib
import sys
import time
import json
import unittest
import os
import tempfile
import shutil
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).parents[1]))
import protected_interlock as interlock
spec = importlib.util.spec_from_file_location('host_producer', pathlib.Path(__file__).parents[1] / 'host-interlock-producer.py')
producer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(producer)


def contract():
    return {'schema': 2, 'hostBootId': 'boot', 'generation': 4, 'appIds': producer.IDS,
            'producerHash': hashlib.sha256(pathlib.Path(producer.__file__).read_bytes()).hexdigest(),
            'runtimeBinding': {'containerId': '1' * 64, 'imageRef': 'ghcr.io/fixture/app@sha256:' + '2' * 64,
                               'imageId': 'sha256:' + '3' * 64}}


class Source:
    def __init__(self):
        self.registry_calls = 0
        self.lifecycle_calls = []
    def boot(self): return 'boot'
    def runtime(self): return copy.deepcopy(contract()['runtimeBinding'])
    def registry(self):
        self.registry_calls += 1
        return ['bitcoin', 'lightning', 'whirmill-satssurge-autopilot']
    def lifecycle(self, app):
        self.lifecycle_calls.append(app)
        return 'not-installed'
    def containers(self): return dict.fromkeys(producer.IDS, [])
    def automation(self): return {'unqualifiedAutomation': [], 'reviewDigest': 'b' * 64}
    def installed_facts(self, app): raise ValueError('Installed automation native qualification required')


class HostProducerTests(unittest.TestCase):
    def test_independent_durable_ids_and_finite_lifecycle_before_after(self):
        source = Source()
        at = dt.datetime.now(dt.timezone.utc).isoformat()
        result = producer.acquire(source, contract(), lambda: at)
        self.assertEqual(result['at'], at)
        self.assertEqual(source.registry_calls, 2)
        self.assertEqual(source.lifecycle_calls, producer.IDS * 2)
        self.assertEqual(result['before'], result['after'])
        self.assertEqual(result['runtimeBinding'], contract()['runtimeBinding'])
        self.assertNotIn('bitcoin', str(result))

    def test_generated_yaml_subset_missing_alias_duplicates_and_unknown_shapes(self):
        self.assertEqual(producer.installed_ids('user: synthetic-private\napps:\n  - lightning\n  - bitcoin\nsettings: {}'), ['bitcoin', 'lightning'])
        self.assertEqual(producer.installed_ids('apps: []\nsettings: {}'), [])
        for raw in ['appStore: []', 'apps:\nuser: x', 'apps: [lightning]', 'apps: *a', 'apps:\n  - lightning\n  - lightning', 'apps: []\n  - lightning', 'apps: []\napps: []', 'apps:\n    - lightning', 'apps:\n  - "lightning"']:
            with self.subTest(raw=raw), self.assertRaises(ValueError): producer.installed_ids(raw)

    def test_exact_digest_mismatch_even_when_all_digests_are_valid(self):
        for key in ['containerId', 'imageRef', 'imageId']:
            source = Source()
            actual = source.runtime()
            actual[key] = actual[key].replace('1', '4').replace('2', '5').replace('3', '6')
            source.runtime = lambda: actual
            with self.subTest(key=key), self.assertRaises(ValueError): producer.acquire(source, contract())
        changed = contract() | {'producerHash': 'a' * 64}
        with self.assertRaises(ValueError): producer.acquire(Source(), changed)

    def test_registry_container_lifecycle_and_standalone_changes_fail_closed(self):
        for kind in ['registry', 'containers', 'lifecycle', 'automation', 'boot', 'runtime']:
            source = Source()
            original = getattr(source, kind)
            calls = []
            def changing(*args, original=original, kind=kind):
                value = original(*args)
                calls.append(True)
                threshold = 4 if kind == 'lifecycle' else 1
                if len(calls) > threshold:
                    if kind == 'registry': return value + ['new-installed-app']
                    if kind == 'containers': return value | {'lndg': [{'name': 'lndg_web_1'}]}
                    if kind == 'lifecycle': return 'installing'
                    if kind == 'automation': return value | {'reviewDigest': 'c' * 64}
                    if kind == 'boot': return 'new-boot'
                    if kind == 'runtime': return value | {'imageId': 'sha256:' + '9' * 64}
                return value
            setattr(source, kind, changing)
            with self.subTest(kind=kind), self.assertRaises(ValueError): producer.acquire(source, contract())

    def test_installed_or_stopped_app_never_means_disabled(self):
        for app in producer.IDS:
            source = Source()
            source.registry = lambda: [app]
            source.lifecycle = lambda candidate: 'stopped' if candidate == app else 'not-installed'
            with self.subTest(app=app), self.assertRaisesRegex(ValueError, 'native qualification'): producer.acquire(source, contract())

    def test_missing_durable_id_does_not_hide_live_install(self):
        source = Source()
        source.lifecycle = lambda app: 'running'
        with self.assertRaisesRegex(ValueError, 'disagreement'): producer.acquire(source, contract())
        source = Source()
        source.containers = lambda: {app: [{'name': app + '_web_1'}] for app in producer.IDS}
        with self.assertRaisesRegex(ValueError, 'disagreement'): producer.acquire(source, contract())

    def test_bounded_command_caps_timeout_and_sanitizes_errors(self):
        self.assertEqual(producer.bounded_command([sys.executable, '-c', 'print("safe")']).strip(), 'safe')
        for program in ['import time;time.sleep(30)', 'print("SYNTHETIC_PRIVATE"*10000)', 'import sys;sys.stderr.write("SYNTHETIC_PRIVATE");sys.exit(1)']:
            started = time.monotonic()
            with self.assertRaisesRegex(ValueError, '^Host read unavailable$'):
                producer.bounded_command([sys.executable, '-c', program], timeout=.1, cap=1024)
            self.assertLess(time.monotonic() - started, 2)

    def test_binding_is_required_by_consumer_even_for_verified_absence(self):
        result = producer.acquire(Source(), contract())
        for key in ['producerHash', 'runtimeBinding']:
            invalid = copy.deepcopy(result)
            invalid.pop(key)
            with self.assertRaises(ValueError): interlock.project(invalid, 'boot', 4, contract())


    def test_child_environment_discards_loaders_and_remote_docker(self):
        inherited = {'NODE_OPTIONS': '--require /unreviewed.js', 'DOCKER_HOST': 'tcp://unreviewed:2375', 'HTTP_PROXY': 'http://unreviewed', 'PYTHONPATH': '/unreviewed', 'LD_PRELOAD': '/unreviewed.so'}
        with patch.dict(os.environ, inherited):
            value = json.loads(producer.bounded_command([sys.executable, '-c', 'import os,json;print(json.dumps(dict(os.environ)))']))
        self.assertFalse(set(inherited) & set(value))
        source = producer.HostSource(pathlib.Path('/reviewed'), '/usr/bin/umbreld', '/usr/bin/docker', contract(), pathlib.Path('/reviewed/config'))
        self.assertEqual(source.docker_argv, ['/usr/bin/docker', '--host=unix:///var/run/docker.sock', '--config=/var/empty'])

    def test_ancestor_symlink_refused_and_descriptors_released(self):
        with tempfile.TemporaryDirectory() as directory:
            # macOS /var is an OS alias: resolve only the test harness root, never the application read path.
            root = pathlib.Path(directory).resolve()
            (root / 'outside').mkdir()
            (root / 'outside/umbrel.yaml').write_text('apps: []')
            (root / 'data').symlink_to(root / 'outside', target_is_directory=True)
            source = producer.HostSource(root / 'data', '', '', contract(), root / 'review')
            for _ in range(30):
                with self.assertRaises(OSError): source.registry()
            self.assertEqual(producer.HostSource(root / 'outside', '', '', contract(), root / 'review').registry(), [])

    def test_current_installed_native_settings_supported_but_changed_or_enabled_rejected(self):
        source = Source()
        source.registry = lambda: ['lightningmate']
        source.lifecycle = lambda app: 'running' if app == 'lightningmate' else 'not-installed'
        facts = {'flags': dict.fromkeys(interlock.FLAGS[:10], False), 'settingsDigest': 'e'*64, 'runtimeBinding': contract()['runtimeBinding'], 'nodeId':'02'+'1'*64,'version':'fixture','sourceHash':'c'*64}
        qualified = contract() | {'expectedLndNodeId':facts['nodeId'], 'installedQualifications':{'lightningmate':{'runtimeBinding':facts['runtimeBinding'],'version':'fixture','hook':{'sourceHash':'c'*64}}}}
        source.installed_facts = lambda app: copy.deepcopy(facts)
        result = producer.acquire(source, qualified)
        self.assertTrue(result['before'][0]['durableInstalled'])
        facts['flags']['fee'] = True
        with self.assertRaises(ValueError): producer.acquire(source, contract())
        facts['flags']['fee'] = False
        calls = []
        def changed(app):
            calls.append(app)
            return {**facts, 'settingsDigest': ('e' if len(calls)==1 else 'f')*64}
        source.installed_facts = changed
        with self.assertRaises(ValueError): producer.acquire(source, contract())

    def test_actual_node_loader_inherited_environment_cannot_execute(self):
        node_path=shutil.which('node')
        if not node_path: self.skipTest('Node unavailable')
        node=pathlib.Path(node_path)
        with tempfile.TemporaryDirectory() as folder:
            root=pathlib.Path(folder).resolve();marker=root/'unreviewed-executed';module=root/'unreviewed.cjs'
            module.write_text("require('fs').writeFileSync("+json.dumps(str(marker))+",'synthetic')")
            with patch.dict(os.environ,{'NODE_OPTIONS':'--require '+str(module),'DOCKER_HOST':'tcp://unreviewed:2375'}):
                value=producer.bounded_command([str(node),'-e','console.log("safe")'])
            self.assertEqual(value.strip(),'safe');self.assertFalse(marker.exists())
