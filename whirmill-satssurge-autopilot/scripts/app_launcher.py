#!/usr/bin/env python3
"""Mandatory UID-1000 pre-bootstrap checkpoint/migration gate. No Docker access."""
import fcntl
import hashlib
import json
import os
import pathlib
import signal
import subprocess
import sys
import time
import uuid

from checkpoint import FILES, capture, check, verify, schema_identity
from diagnostics import atomic_json
from maintenance_lock import acquire, lock_file


def fingerprint(root):
    digest = hashlib.sha256()
    paths = [root / 'package.json', root / 'package-lock.json', *sorted((root / 'dist').rglob('*.js')),
             *sorted((root / 'scripts').glob('*.py')),
             *sorted((root / 'node_modules/@earendil-works').rglob('*.js'))]
    for path in paths:
        digest.update(str(path.relative_to(root)).encode() + b'\0')
        digest.update(path.read_bytes())
    return digest.hexdigest()


def schemas(data):
    return {name: schema_identity(data / name) for name in FILES}


def sync_databases(data):
    for name in FILES:
        for suffix in ('', '-wal'):
            path = data / (name + suffix)
            if path.exists():
                with path.open('rb') as stream:
                    os.fsync(stream.fileno())
    fd = os.open(data, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def transition(data, root, release, migrate):
    state_path = data / 'lifecycle.json'
    state = json.loads(state_path.read_text()) if state_path.exists() else None
    present = [name for name in FILES if (data / name).exists()]
    if not state and not present:
        own_locks = {'executor.lock', 'maintenance-admission.lock', 'maintenance.lock'}
        if any(path.name not in own_locks for path in data.iterdir()):
            raise ValueError('Nonempty legacy directory without databases requires offline qualification')
    if state and state.get('protocol') != 1:
        raise ValueError('Unsupported lifecycle protocol')
    if state and state.get('phase') == 'ready' and state.get('destination') == release:
        if schemas(data) != state['resultSchemas']:
            raise ValueError('Installed schema identity changed')
        return state
    if state and state.get('phase') != 'ready':
        if state.get('destination') != release:
            raise ValueError('Interrupted transition belongs to a different release')
        # Never recapture partially migrated live files as the source baseline.
        if state.get('phase') not in ('checkpointed', 'migrating'):
            raise ValueError('Incomplete baseline capture requires offline qualification')
        if state['baseline']:
            manifest = verify(data / state['baseline'])
            if manifest['files'] != state.get('baselineFiles'):
                raise ValueError('Transition baseline identity changed')
    else:
        source = state.get('destination') if state else None
        if present and len(present) != len(FILES):
            raise ValueError('Partial database set requires offline qualification')
        qualification = None
        if present and not state:
            qualification = json.loads((data / 'offline-cutover.json').read_text())
            if (qualification.get('protocol') != 1 or qualification.get('destination') != release
                    or qualification.get('fence') != 'offline-exclusive-v1'
                    or qualification.get('writers') != {'app': 'stopped', 'lm-backfill': 'disabled'}
                    or not isinstance(qualification.get('source'), str)
                    or not qualification['source']):
                raise ValueError('Legacy writer fencing is not qualified')
            source = qualification['source']
        transition_id = uuid.uuid4().hex
        baseline = 'checkpoints/' + transition_id if present else None
        state = {'protocol': 1, 'transitionId': transition_id, 'source': source, 'destination': release,
                 'sourceSchemas': schemas(data) if present else {},
                 'baseline': baseline, 'phase': 'capturing'}
        if qualification and state['sourceSchemas'] != qualification.get('schemas'):
            raise ValueError('Legacy schema baseline changed')
        atomic_json(state_path, state)
        if baseline:
            manifest = capture(data, data / baseline, release={'source': source, 'destination': release})
            verify(data / baseline)
            if qualification and manifest['files'] != qualification.get('files'):
                raise ValueError('Legacy database baseline changed')
            state['baselineFiles'] = manifest['files']
        state['phase'] = 'checkpointed'
        atomic_json(state_path, state)
    state['phase'] = 'migrating'
    atomic_json(state_path, state)
    migrate()
    state['resultSchemas'] = schemas(data)
    sync_databases(data)
    state['phase'] = 'ready'
    atomic_json(state_path, state)
    return state


class ChildSupervisor:
    """Install handlers before spawn; retain deadlines and reap on every path."""
    def __init__(self):
        self.child = None
        self.stop_signal = None
        self.stop_deadline = None
        self.signal_grace = 5
        self.previous = {}

    def __enter__(self):
        for number in (signal.SIGTERM, signal.SIGINT):
            self.previous[number] = signal.signal(number, self.forward)
        return self

    def forward(self, number, frame):
        if self.stop_signal is None:
            self.stop_signal = number
            self.stop_deadline = time.monotonic() + self.signal_grace
        if self.child is not None and self.child.poll() is None:
            try:
                self.child.send_signal(number)
            except ProcessLookupError:
                pass

    def run(self, command, *, env=None, pass_fds=(), timeout=None, signal_grace=5, check=False):
        if self.stop_signal is not None:
            raise InterruptedError('Launcher stopping before child admission')
        self.signal_grace = signal_grace
        deadline = time.monotonic() + timeout if timeout is not None else None
        # A signal during Popen is queued by forward and delivered after child
        # registration. The handler never raises before we can reap the child.
        child = subprocess.Popen(command, env=env, pass_fds=pass_fds)
        self.child = child
        if self.stop_signal is not None:
            self.forward(self.stop_signal, None)
        timed_out = False
        try:
            while child.poll() is None:
                now = time.monotonic()
                if (deadline is not None and now >= deadline) or (self.stop_deadline is not None and now >= self.stop_deadline):
                    timed_out = self.stop_signal is None
                    child.kill()
                    break
                try:
                    child.wait(timeout=.05)
                except subprocess.TimeoutExpired:
                    pass
            result = child.wait()
        finally:
            if child.poll() is None:
                child.kill()
            child.wait()
            self.child = None
        if timed_out:
            raise subprocess.TimeoutExpired(command, timeout)
        if self.stop_signal is not None:
            raise InterruptedError('Launcher child stopped and reaped')
        if check and result:
            raise subprocess.CalledProcessError(result, command)
        return result

    def __exit__(self, *exception):
        for number, previous in self.previous.items():
            signal.signal(number, previous)


def main():
    if os.getuid() != 1000:
        raise PermissionError('Application launcher requires UID 1000')
    root = pathlib.Path(__file__).resolve().parent.parent
    data = pathlib.Path(os.environ.get('DATA_DIR', '/data')).resolve()
    release = fingerprint(root)
    with ChildSupervisor() as supervisor:
        with lock_file(data, 'executor.lock') as executor:
            acquire(executor, fcntl.LOCK_EX)
            with lock_file(data, 'maintenance-admission.lock') as admission:
                acquire(admission, fcntl.LOCK_EX)
                with lock_file(data, 'maintenance.lock') as maintenance:
                    acquire(maintenance, fcntl.LOCK_EX)
                    env = {**os.environ, 'DATA_DIR': str(data), 'SATSSURGE_GATE_FD': str(maintenance.fileno()),
                           'SATSSURGE_EXECUTOR_FD': str(executor.fileno()), 'SATSSURGE_GATE_PHASE': 'migration'}
                    descriptors = (maintenance.fileno(), executor.fileno())
                    transition(data, root, release, lambda: supervisor.run(
                        ['node', str(root / 'dist/lifecycle-migrate.js')], env=env,
                        pass_fds=descriptors, check=True, timeout=60, signal_grace=5))
                    acquire(maintenance, fcntl.LOCK_SH)
                    fcntl.flock(admission, fcntl.LOCK_UN)
                    env['SATSSURGE_GATE_PHASE'] = 'runtime'
                    arguments = sys.argv[1:]
                    if arguments and arguments[0] != '--import':
                        raise ValueError('Unsupported launcher mode')
                    command = ['node', str(root / ('dist/import-cli.js' if arguments else 'dist/server.js'))]
                    if arguments:
                        command.extend(arguments[1:])
                    # Runtime has time for the existing 25-second drain within
                    # Compose's 60-second grace; both owning descriptions stay
                    # alive until the child is actually reaped.
                    return supervisor.run(command, env=env, pass_fds=descriptors, signal_grace=35)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        print(json.dumps({'status': 'bootstrap_rejected', 'errorType': type(error).__name__}), file=sys.stderr)
        sys.exit(1)
