#!/usr/bin/env python3
"""Bounded privileged Umbrel 2.0 inventory acquisition, never catalog inventory.

Only root invokes this helper after independent review. It creates no timer,
changes no app, and never queries apps.list or prints command output. Installed
conflicting apps still need native settings/backend qualification; no disabled
state is inferred from stopped containers or from a supplied boolean.
"""
import argparse
import datetime as dt
import hashlib
import json
import os
import pathlib
import re
import resource
import signal
import subprocess
import tempfile
import sys
import time

# Supported root invocation is Python -I; use only the installed script directory.
sys.path.insert(0, str(pathlib.Path(__file__).absolute().parent))

import protected_interlock as interlock
import host_read_boundary
import host_qualification
import alby_transport
import standalone_automation_audit

IDS = ['lightningmate', 'lndg', 'lightning-terminal', 'albyhub']
APP_ID = re.compile(r'[a-z0-9-]{1,64}')
HEX = re.compile(r'[a-f0-9]{64}')


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def installed_ids(raw):
    """Conservative generated-YAML subset; unfamiliar shapes fail closed.

    Read only the independent durable apps key. Missing key, aliases, flow
    arrays other than [], duplicate IDs and malformed indentation are refused.
    Raw YAML stays in memory and is never hashed, logged or returned.
    """
    lines = raw.splitlines()
    positions = [i for i, line in enumerate(lines) if line.startswith('apps:')]
    if len(positions) != 1:
        raise ValueError('Durable apps key unavailable')
    index = positions[0]
    tail = lines[index][5:].strip()
    if tail not in ['', '[]']:
        raise ValueError('Durable apps shape unqualified')
    result = []
    for line in lines[index + 1:]:
        if line and not line[0].isspace() and not line.startswith('-') and not line.startswith('#'):
            break
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        match = re.fullmatch(r'(?:  )?- ([a-z0-9-]{1,64})', line)
        if not match or tail == '[]':
            raise ValueError('Durable apps shape unqualified')
        result.append(match[1])
    if (tail == '' and not result) or len(result) > 512 or len(set(result)) != len(result):
        raise ValueError('Durable apps identity conflict')
    return sorted(result)


def protected_path(path):
    for component in [path, *path.parents]:
        info = component.lstat()
        if info.st_uid != 0 or info.st_mode & 0o022 or component.is_symlink():
            raise ValueError('Privileged path ownership required')


def protected_json(path):
    return json.loads(host_read_boundary.read_bytes(path, protected=True))


CHILD_ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/var/empty', 'LANG': 'C', 'LC_ALL': 'C'}


def bounded_command(argv, timeout=5, cap=65536):
    """Private regular-file outputs are size capped and always removed/reaped."""
    def limits():
        resource.setrlimit(resource.RLIMIT_FSIZE, (cap, cap))
    with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as error:
        child = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=output, stderr=error,
                                 start_new_session=True, preexec_fn=limits, env=CHILD_ENV)
        try:
            child.wait(timeout=timeout)
            if child.returncode or output.tell() >= cap or error.tell() >= cap:
                raise ValueError('Host read unavailable')
            output.seek(0)
            return output.read(cap).decode('utf-8')
        except BaseException:
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGKILL)
            child.wait()
            raise ValueError('Host read unavailable') from None
        finally:
            # Descendants may survive a successful CLI exit. Release the owned group.
            try:
                os.killpg(child.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass


class HostSource:
    def __init__(self, data, cli, docker, contract, review):
        self.data, self.cli, self.docker, self.contract, self.review = data, cli, docker, contract, review
        self.docker_argv = [docker, '--host=unix:///var/run/docker.sock', '--config=/var/empty']

    def boot(self):
        return pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()

    def runtime(self):
        return self.container_binding(self.contract['runtimeBinding'])

    def container_binding(self, expected):
        container = expected['containerId']
        raw = bounded_command([*self.docker_argv, 'inspect', '--format',
            '{{json .Id}} {{json .Config.Image}} {{json .Image}} {{json .State.Running}} {{json .State.Restarting}}', container])
        fields = raw.strip().split()
        if len(fields) != 5:
            raise ValueError('Runtime identity unavailable')
        identifier, reference, image, running, restarting = map(json.loads, fields)
        if running is not True or restarting is not False:
            raise ValueError('Runtime not stable')
        actual = {'containerId': identifier, 'imageRef': reference, 'imageId': image}
        if not interlock.runtime_binding_matches(actual, expected):
            raise ValueError('Reviewed installed image changed')
        return actual

    def registry(self):
        return installed_ids(host_read_boundary.read_bytes(self.data / 'umbrel.yaml', 1048576).decode('utf-8'))

    def lifecycle(self, app):
        result = json.loads(bounded_command([self.cli, 'client', 'apps.state.query', '--appId', app], cap=4096))
        if set(result) != {'state', 'progress'} or type(result['progress']) not in [int, float] or not 0 <= result['progress'] <= 100:
            raise ValueError('Finite lifecycle query unavailable')
        return result['state']

    def containers(self):
        raw = bounded_command([*self.docker_argv, 'ps', '-a', '--format',
            '{{.ID}}\t{{.Names}}\t{{.Label "com.docker.compose.project"}}\t{{.State}}'])
        result = {app: [] for app in IDS}
        for line in raw.splitlines():
            fields = line.split('\t')
            if len(fields) != 4:
                raise ValueError('Container inventory malformed')
            identifier, name, project, state = fields
            candidates = [app for app in IDS if project == app or name.startswith(app + '_') or name.startswith(app + '-')]
            if len(candidates) > 1 or any(not re.fullmatch(r'[a-zA-Z0-9_.-]{1,128}', name) for _ in candidates):
                raise ValueError('Container identity ambiguous')
            for app in candidates:
                if not re.fullmatch(r'[a-f0-9]{12,64}', identifier) or state not in ['running', 'exited', 'created']:
                    raise ValueError('Container lifecycle unresolved')
                result[app].append({'id': identifier, 'name': name, 'state': state})
        return {app: sorted(rows, key=lambda row: row['id']) for app, rows in result.items()}

    def automation(self):
        if self.contract.get('ownerUid') != 1000:
            raise ValueError('Qualified Umbrel owner UID required')
        accounts = [line.split(':') for line in host_read_boundary.read_bytes(pathlib.Path('/etc/passwd'),65536).decode().splitlines() if line.split(':',1)[0] == 'umbrel']
        if len(accounts) != 1 or len(accounts[0]) != 7 or accounts[0][2] != '1000':
            raise ValueError('Current Umbrel owner identity changed')
        spec = self.contract.get('standaloneHook')
        if spec:
            return host_qualification.run_hook(spec, 'standalone', self.contract, bounded_command)
        config = self.contract.get('standaloneAudit')
        if not config:
            raise ValueError('Reviewed standalone audit configuration required')
        return standalone_automation_audit.audit(config)

    def installed_facts(self, app):
        qualification = self.contract.get('installedQualifications', {}).get(app)
        if not qualification:
            raise ValueError('Installed automation native qualification required')
        binding = self.container_binding(qualification['runtimeBinding'])
        if app == 'albyhub':
            expected = self.contract.get('albyQualification', {})
            transport = qualification['transport']
            if transport.get('scheme') == 'http':
                port_key = transport.get('containerPort')
                if not isinstance(port_key, str) or not re.fullmatch(r'[0-9]{1,5}/tcp', port_key):
                    raise ValueError('Qualified Alby port binding required')
                ports = json.loads(bounded_command([*self.docker_argv, 'inspect', '--format', '{{json .NetworkSettings.Ports}}', binding['containerId']], cap=16384))
                if not isinstance(ports, dict) or not any(row.get('HostIp') in ['127.0.0.1','::1','0.0.0.0','::'] and row.get('HostPort') == str(transport.get('port')) for row in (ports.get(port_key) or [])):
                    raise ValueError('Alby endpoint/container disagreement')
            facts = alby_transport.qualify(transport, expected)
            return {'backendFacts': facts, 'runtimeBinding': binding}
        if app not in ['lightningmate', 'lndg', 'lightning-terminal']:
            raise ValueError('Installed Terminal/Loop qualification unavailable')
        spec = qualification['hook']
        facts = host_qualification.run_hook(spec, app, self.contract, bounded_command)
        return {**facts, 'runtimeBinding': binding, 'sourceHash': spec['sourceHash'], 'version': qualification['version']}


def acquire(source, contract, clock=lambda: dt.datetime.now(dt.timezone.utc).isoformat()):
    """Entire acquisition has two separate durable/lifecycle/container boundaries."""
    if contract.get('appIds') != IDS or type(contract.get('generation')) is not int or contract['generation'] < 0:
        raise ValueError('Finite reviewed IDs/generation required')
    if contract.get('producerHash') != hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest():
        raise ValueError('Producer source changed')
    at = clock()
    deadline = time.monotonic() + 90
    def check_deadline():
        if time.monotonic() > deadline: raise ValueError('Host acquisition deadline')
    def boundary():
        check_deadline()
        boot, runtime = source.boot(), source.runtime()
        if boot != contract.get('hostBootId') or not interlock.runtime_binding_matches(runtime, contract.get('runtimeBinding')):
            raise ValueError('Current runtime binding changed')
        registry = source.registry()
        if not isinstance(registry, list) or len(registry) > 512 or len(set(registry)) != len(registry) or any(not isinstance(app, str) or not APP_ID.fullmatch(app) for app in registry):
            raise ValueError('Durable inventory unavailable')
        containers = source.containers()
        states = []
        for app in IDS:
            check_deadline()
            lifecycle = source.lifecycle(app)
            installed = app in registry
            rows = containers.get(app)
            if not isinstance(rows, list):
                raise ValueError('Container inventory unavailable')
            if not installed and (lifecycle != 'not-installed' or rows):
                raise ValueError('Durable/lifecycle/container disagreement')
            if installed and lifecycle not in ['running', 'stopped']:
                raise ValueError('Installed lifecycle unresolved')
            state = {'id': app, 'durableInstalled': installed, 'lifecycle': lifecycle, 'containers': [row['name'] for row in rows]}
            if installed:
                facts = source.installed_facts(app)
                if app == 'albyhub':
                    # Original acquisition time is preserved across both reads;
                    # compare exact native facts rather than two local read clocks.
                    backend = {**facts['backendFacts'], 'at': at}
                    backend['checksum'] = digest({k:v for k,v in backend.items() if k != 'checksum'})
                    state['backendFacts'] = backend
                else:
                    if any(facts.get('flags', {}).get(f) is not False for f in (interlock.FLAGS[:10] if app == 'lightningmate' else ['loop'] if app == 'lightning-terminal' else interlock.FLAGS[10:13])):
                        raise ValueError('Installed native flags unknown or enabled')
                    state['settingsFacts'] = {key: facts[key] for key in ['settingsDigest', 'nodeId', 'sourceHash', 'version']}
                state['runtimeBinding'] = facts['runtimeBinding']
            states.append(state)
        return {'boot': boot, 'runtime': runtime, 'registry': registry, 'containers': containers,
                'states': states, 'automation': source.automation()}
    before, after = boundary(), boundary()
    check_deadline()
    if before != after:
        raise ValueError('Inventory changed during acquisition')
    original = {'schema': 2, 'at': at, 'ownerScope': 'owner', 'hostBootId': before['boot'],
        'generation': contract['generation'], 'appIds': IDS, 'before': before['states'], 'after': after['states'],
        'flags': dict.fromkeys(interlock.FLAGS, False), 'registryBeforeHash': digest(before['registry']),
        'registryAfterHash': digest(after['registry']), 'otherAutomationBefore': [], 'otherAutomationAfter': [],
        'runtimeBinding': before['runtime'], 'producerHash': contract['producerHash']}
    return interlock.project(original, before['boot'], contract['generation'], contract)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data', type=pathlib.Path, required=True)
    parser.add_argument('--output', type=pathlib.Path, required=True)
    parser.add_argument('--contract', type=pathlib.Path, required=True)
    parser.add_argument('--cli', required=True)
    parser.add_argument('--docker', required=True)
    args = parser.parse_args()
    if os.geteuid() != 0:
        parser.exit(1, 'Privileged reviewed host acquisition required\n')
    try:
        protected_path(pathlib.Path(__file__))
        if not sys.flags.isolated:
            raise ValueError('Isolated privileged interpreter required')
        for module in [interlock, host_read_boundary, host_qualification, alby_transport, standalone_automation_audit]:
            path = pathlib.Path(module.__file__)
            protected_path(path)
        contract = protected_json(args.contract)
        for module in [host_read_boundary, host_qualification, alby_transport, standalone_automation_audit, alby_transport.alby_readonly]:
            path = pathlib.Path(module.__file__)
            protected_path(path)
            if hashlib.sha256(host_read_boundary.read_bytes(path, 1048576, protected=True)).hexdigest() != contract.get('moduleHashes', {}).get(path.name):
                raise ValueError('Native helper source changed')
        for command in [args.cli, args.docker]:
            protected_path(pathlib.Path(command))
            if hashlib.sha256(host_read_boundary.read_bytes(pathlib.Path(command), 64*1048576, protected=True)).hexdigest() != contract.get('commandHashes', {}).get(command):
                raise ValueError('Reviewed host command changed')
        protected_path(pathlib.Path('/var/empty'))
        empty_fd = host_read_boundary.parent_fd(pathlib.Path('/var/empty/.entry'), protected=True)
        try:
            if os.listdir(empty_fd): raise ValueError('Reviewed empty Docker config required')
        finally: os.close(empty_fd)
        protected_path(args.output.parent)
        if contract.get('sourceHash') != hashlib.sha256(pathlib.Path(interlock.__file__).read_bytes()).hexdigest():
            raise ValueError('Projection source changed')
        result = acquire(HostSource(args.data, args.cli, args.docker, contract, args.contract.parent / 'standalone-review.json'), contract)
    except Exception:
        result = {'schema': 2, 'at': dt.datetime.now(dt.timezone.utc).isoformat(), 'state': 'unknown',
                  'error': 'Privileged acquisition or installed automation qualification unavailable'}
    protected_path(args.output.parent)
    interlock.write_atomic(args.output, result)
    os.chmod(args.output, 0o644)


if __name__ == '__main__':
    main()
