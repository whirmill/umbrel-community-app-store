#!/usr/bin/env python3
"""One-time capture ONLY; stdin operator tool, never an app/host coordinator."""
import argparse
import contextlib
import fcntl
import importlib
import json
import math
import os
import pathlib
import re
import signal
import stat
import sys
import time


class Budget:
    """Cooperative Python signal/deadline checks, not an I/O kill guarantee."""
    def __init__(self, seconds, *, exit_policy=False):
        if not math.isfinite(seconds) or not 0 < seconds <= 300:
            raise ValueError('Deadline must be in (0, 300] seconds')
        self.deadline = time.monotonic() + seconds
        self.stopped = False
        self.exit_policy = exit_policy

    def interrupt(self, number, frame):
        # Latch only: asynchronous exceptions must not escape a failure emit
        # and unwind its owning fences. Explicit checks reject acceptance.
        self.stopped = True

    def check(self):
        if self.stopped:
            raise InterruptedError('Capture cancelled')
        if time.monotonic() >= self.deadline:
            raise TimeoutError('Capture deadline exceeded')

    def finalize(self):
        if self.exit_policy:
            # SQLite and reporting have settled. Raising handlers now ensure a
            # delivered late signal cannot leave a latched request and exit 0.
            for number in (signal.SIGTERM, signal.SIGINT, signal.SIGALRM):
                signal.signal(number, signal.default_int_handler)
            signal.setitimer(signal.ITIMER_REAL, 0)
        self.check()  # Observe every latch delivered during the full switch.

    def install(self):
        # Capture diagnostics use nonraising latches until fenced finalization.
        for number in (signal.SIGTERM, signal.SIGINT, signal.SIGALRM):
            signal.signal(number, self.interrupt)
        signal.setitimer(signal.ITIMER_REAL, max(.001, self.deadline - time.monotonic()))


def require_runtime():
    if (sys.platform != 'linux' or os.getpid() != 1
            or (os.getuid(), os.geteuid(), os.getgid(), os.getegid()) != (1000,) * 4):
        raise PermissionError('Requires real Linux PID 1 and UID/GID 1000')


def load_helpers(root):
    # Production fixes root=/app; no helper installation or app startup.
    sys.path.insert(0, str(root / 'scripts'))
    return tuple(importlib.import_module(name) for name in
                 ('checkpoint', 'app_launcher', 'maintenance_lock'))


def plain_path(value):
    text = os.fspath(value)
    if (not text.startswith('/') or any(part in ('.', '..') for part in text.split('/'))
            or any(char in text for char in ('?', '#', '%', '\x00', '\n', '\r'))):
        raise ValueError('Requires an absolute, non-URI, non-traversing path')
    return pathlib.Path(text)


def directory(path):
    # Do not resolve() away symlinks, even in an ancestor of a mount/path.
    for part in (*reversed(path.parents), path):
        if not stat.S_ISDIR(part.lstat().st_mode):
            raise ValueError('Directory/ancestor must be a real directory')


def regular(path, optional=False):
    try:
        info = path.lstat()
    except FileNotFoundError:
        if optional:
            return
        raise
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise ValueError('Requires a single-link regular file')


def source_guard(data, files):
    directory(data)
    for name in ('offline-cutover.json', 'lifecycle.json'):
        if os.path.lexists(data / name):
            raise ValueError('Existing receipt: not an unqualified legacy capture')
    for name in files:
        regular(data / name)
        for suffix in ('-wal', '-shm'):
            path = data / (name + suffix)
            regular(path, optional=True)
            if suffix == '-shm' and path.exists():
                size = path.stat().st_size
                if size < 32768 or size % 32768:
                    raise ValueError('Existing SHM must contain whole SQLite index blocks')
    for name in ('executor.lock', 'maintenance-admission.lock', 'maintenance.lock'):
        regular(data / name, optional=True)


def output_guard(output, data):
    directory(output.parent)
    parent = output.parent.stat()
    if parent.st_uid != os.geteuid() or parent.st_mode & 0o022:
        raise PermissionError('Output parent must be owned and not publicly writable')
    if os.path.lexists(output) or output == data or output in data.parents or data in output.parents:
        raise ValueError('Requires new output outside the data tree')


def emit(value):
    print(json.dumps(value, separators=(',', ':')), flush=True)


def capture_pair(data, output, root, expected, source, image, helpers, budget):
    """Direct function use is ONLY for isolated local fixtures, not production."""
    checkpoint, launcher, locks = helpers
    budget.check()
    if (not re.fullmatch(r'[0-9a-f]{64}', expected)
            or not re.fullmatch(r'[0-9a-f]{40}', source)
            or not re.fullmatch(r'sha256:[0-9a-f]{64}', image)):
        raise ValueError('Explicit exact target identities required')
    if launcher.fingerprint(root) != expected:
        raise ValueError('Target fingerprint mismatch')
    data, output = plain_path(data), plain_path(output)
    source_guard(data, checkpoint.FILES)
    output_guard(output, data)
    budget.check()
    # SAME process owns all locks and every SQLite connection. No child exists.
    with contextlib.ExitStack() as fence:
        try:
            held = []
            for name in ('executor.lock', 'maintenance-admission.lock', 'maintenance.lock'):
                budget.check()
                stream = fence.enter_context(locks.lock_file(data, name))
                locks.acquire(stream, fcntl.LOCK_EX,
                              timeout=min(15, max(0, budget.deadline - time.monotonic())))
                held.append((name, stream))
            existing_shm = {}
            for name in checkpoint.FILES:
                path = data / (name + '-shm')
                if path.exists():
                    info = path.lstat()
                    existing_shm[path] = (info.st_dev, info.st_ino, info.st_size)
            def guard():
                budget.check()
                source_guard(data, checkpoint.FILES)
                for name, stream in held:
                    info = (data / name).lstat()
                    owned = os.fstat(stream.fileno())
                    if (info.st_dev, info.st_ino) != (owned.st_dev, owned.st_ino):
                        raise ValueError('Stable fence inode changed')
                for path, identity in existing_shm.items():
                    info = path.lstat()
                    if (info.st_dev, info.st_ino, info.st_size) != identity:
                        raise ValueError('Existing SHM inode or extent changed')

            guard()
            output_guard(output, data)
            original = launcher.schemas(data)
            guard()
            output.mkdir(mode=0o700, exist_ok=False)
            parent_fd = os.open(output.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                os.fsync(parent_fd)
            finally:
                os.close(parent_fd)
            manifests = []
            for label in ('capture-1', 'capture-2'):
                guard()
                target = output / label
                manifest = checkpoint.capture(data, target, final_guard=guard,
                    release={'source': source, 'imageDigest': image, 'destination': expected})
                guard()
                directory(target)
                for name in (*checkpoint.FILES, 'manifest.json'):
                    regular(target / name)
                verified = checkpoint.verify(target)
                guard()
                identities = {name: entry['schemaIdentity'] for name, entry in verified['files'].items()}
                if verified != manifest or identities != original or launcher.schemas(data) != original:
                    raise ValueError('Capture/source schema identity changed')
                manifests.append(verified)
            if manifests[0]['files'] != manifests[1]['files']:
                raise ValueError('Repeated target-runtime capture differs')
            guard()
            # Summary is NOT offline-cutover.json; it attests no host/writer state.
            emit({'status': 'capture-only', 'hostQualification': 'HOLD',
                  'targetFingerprint': expected, 'targetSource': source, 'platformDigest': image,
                  'schemas': original, 'files': manifests[0]['files'], 'captures': 2})
            guard()  # Cancellation during/after serialization cannot authorize acceptance.
            budget.finalize()  # Still fenced; production late signals become nonzero exits.
            return 0
        except Exception as error:
            # Retain even partially acquired fences through failure diagnostics.
            emit({'status': 'HOLD', 'errorType': type(error).__name__})
            return 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--expected-fingerprint', required=True)
    parser.add_argument('--release-source', required=True)
    parser.add_argument('--platform-digest', required=True)
    parser.add_argument('--deadline-seconds', type=float, default=120)
    args = parser.parse_args()
    require_runtime()  # Before ANY data/output modification or helper loading.
    budget = Budget(args.deadline_seconds, exit_policy=True)
    budget.install()
    root = pathlib.Path('/app')
    result = capture_pair(args.data, args.output, root, args.expected_fingerprint,
                          args.release_source, args.platform_digest, load_helpers(root), budget)
    return result  # Successful finalization already occurred under the fences.


if __name__ == '__main__':
    try:
        sys.exit(main())
    except Exception as error:
        emit({'status': 'HOLD', 'errorType': type(error).__name__})
        sys.exit(1)
