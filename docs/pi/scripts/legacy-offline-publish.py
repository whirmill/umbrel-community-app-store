#!/usr/bin/env python3
"""One-time admitted legacy receipt publication; never a host coordinator."""
import argparse
import contextlib
import fcntl
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import stat
import sys
import time
import uuid


ROLES = frozenset(('legacy-image', 'target-image', 'app-exclusion',
                   'backfill-exclusion', 'writer-inventory', 'handoff-exclusion',
                   'catalogue-pin'))
LOCK_NAMES = ('executor.lock', 'maintenance-admission.lock', 'maintenance.lock')


def file_identity(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def require_runtime():
    if (sys.platform != 'linux' or os.getpid() != 1
            or (os.getuid(), os.geteuid(), os.getgid(), os.getegid()) != (1000,) * 4):
        raise PermissionError('Requires real Linux PID 1 and UID/GID 1000')


def load_procedure(path):
    # Production fixes this to a readonly operator mount, never product code.
    for ancestor in (*reversed(path.parents), path.parent):
        if not stat.S_ISDIR(ancestor.lstat().st_mode):
            raise ValueError('Procedure ancestors must be real directories')
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_mode & 0o022:
        raise ValueError('Procedure must be a single-link non-writable regular file')
    spec = importlib.util.spec_from_file_location('legacy_target_capture', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def sha(value, pattern=r'[0-9a-f]{64}'):
    if not isinstance(value, str) or not re.fullmatch(pattern, value):
        raise ValueError('Exact immutable identity required')
    return value


def private_directory(path, procedure):
    procedure.directory(path)
    info = path.stat()
    if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o077:
        raise PermissionError('Evidence/capture directory must be private and owned')


def read_private(path, procedure, budget, limit=1024 * 1024):
    procedure.directory(path.parent)
    procedure.regular(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        before = os.fstat(stream.fileno())
        if (before.st_uid != os.geteuid() or before.st_mode & 0o077
                or before.st_nlink != 1 or not stat.S_ISREG(before.st_mode)
                or before.st_size > limit):
            raise PermissionError('Input must be a bounded private owned regular file')
        chunks, size = [], 0
        while True:
            budget.check()
            chunk = stream.read(min(65536, limit + 1 - size))
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
            if size > limit:
                raise ValueError('Input exceeds bound')
        after = os.fstat(stream.fileno())
        named = path.lstat()
        identity = lambda item: (item.st_dev, item.st_ino, item.st_size, item.st_mtime_ns,
                                 item.st_ctime_ns, item.st_nlink, item.st_mode, item.st_uid)
        if identity(before) != identity(after) or identity(after) != identity(named):
            raise ValueError('Input changed during read')
        return b''.join(chunks)


def json_object(raw):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('Duplicate JSON field')
            result[key] = value
        return result
    value = json.loads(raw, object_pairs_hook=unique)
    if not isinstance(value, dict):
        raise ValueError('JSON object required')
    return value


def admit_evidence(path, admitted, target, procedure, budget):
    private_directory(path.parent, procedure)
    raw = read_private(path, procedure, budget)
    if hashlib.sha256(raw).hexdigest() != sha(admitted):
        raise ValueError('Independently admitted evidence SHA mismatch')
    packet = json_object(raw)
    if set(packet) != {'protocol', 'legacy', 'target', 'observations'} or type(packet['protocol']) is not int or packet['protocol'] != 1:
        raise ValueError('Evidence protocol incompatible')
    legacy = packet['legacy']
    if not isinstance(legacy, dict) or set(legacy) != {'source', 'imageDigest'}:
        raise ValueError('Legacy immutable identity missing')
    sha(legacy['source'], r'[0-9a-f]{40}')
    sha(legacy['imageDigest'], r'sha256:[0-9a-f]{64}')
    if packet['target'] != target:
        raise ValueError('Evidence target differs from reviewed runtime target')
    observations = packet['observations']
    if not isinstance(observations, dict) or set(observations) != ROLES:
        raise ValueError('Complete reviewed host evidence required')
    for entry in observations.values():
        if not isinstance(entry, dict) or set(entry) != {'file', 'sha256'}:
            raise ValueError('Raw observation artifact binding required')
        name = entry['file']
        if (not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', name)
                or name in ('.', '..') or name == path.name):
            raise ValueError('Local observation file required')
        content = read_private(path.parent / name, procedure, budget, 64 * 1024 * 1024)
        if not content or hashlib.sha256(content).hexdigest() != sha(entry['sha256']):
            raise ValueError('Reviewed observation checksum mismatch')
    # Packet integrity is not host-state discovery. Its exact admitted hash must
    # come from an independent review of original host observations and binding.
    return legacy


def verified_capture(path, target, helpers, procedure, budget):
    checkpoint, launcher, _ = helpers
    private_directory(path, procedure)
    raw = read_private(path / 'manifest.json', procedure, budget)
    manifest = json_object(raw)
    if manifest.get('release') != target or type(manifest.get('version')) is not int or manifest['version'] != 1:
        raise ValueError('Earlier capture target identity differs')
    files = manifest.get('files')
    if not isinstance(files, dict) or set(files) != set(checkpoint.FILES):
        raise ValueError('Complete three-database capture required')
    existing_shm, originals = {}, {}
    for name, entry in files.items():
        procedure.regular(path / name)
        info = (path / name).stat()
        originals[path / name] = file_identity(info)
        if (info.st_uid != os.geteuid() or info.st_mode & 0o077 or not isinstance(entry, dict)
                or set(entry) != {'sha256', 'schema', 'schemaIdentity', 'bytes'}
                or type(entry['bytes']) is not int or entry['bytes'] != info.st_size
                or type(entry['schema']) is not int):
            raise ValueError('Invalid private checkpoint file entry')
        sha(entry['sha256'])
        identity = entry['schemaIdentity']
        if (not isinstance(identity, dict) or set(identity) != {'userVersion', 'ddlSha256', 'durableVersion'}
                or type(identity['userVersion']) is not int or identity['userVersion'] != entry['schema']
                or (identity['durableVersion'] is not None and type(identity['durableVersion']) is not int)):
            raise ValueError('Explicit original schema identity required')
        sha(identity['ddlSha256'])
        # A readonly SQLite connection may create zero-byte WAL and SHM read
        # marks for a WAL-mode backup. Never admit pending checkpoint WAL rows.
        for suffix in ('-wal', '-shm'):
            adjacent = path / (name + suffix)
            procedure.regular(adjacent, optional=True)
            if adjacent.exists():
                sidecar = adjacent.stat()
                if suffix == '-wal' and sidecar.st_size != 0:
                    raise ValueError('Checkpoint has pending external WAL')
                if suffix == '-shm':
                    if sidecar.st_size < 32768 or sidecar.st_size % 32768:
                        raise ValueError('Checkpoint SHM extent invalid')
                    existing_shm[adjacent] = (sidecar.st_dev, sidecar.st_ino, sidecar.st_size)
    verified = checkpoint.verify(path)
    budget.check()
    for original, identity in originals.items():
        procedure.regular(original)
        if file_identity(original.lstat()) != identity:
            raise ValueError('Checkpoint database changed during verification')
    for adjacent, identity in existing_shm.items():
        info = adjacent.lstat()
        if (info.st_dev, info.st_ino, info.st_size) != identity:
            raise ValueError('Checkpoint SHM inode or extent changed')
    if (verified != manifest or read_private(path / 'manifest.json', procedure, budget) != raw
            or launcher.schemas(path) != {name: entry['schemaIdentity'] for name, entry in files.items()}):
        raise ValueError('Checkpoint verification/readback differs')
    budget.check()
    return verified


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def publish_no_clobber(data, value, guard):
    """Atomic link commits a fully fsynced receipt, never replaces an old path.

    Any failure leaves its private temporary and/or committed receipt for HOLD
    reconciliation. No automatic rollback or cleanup of uncertain publication.
    """
    guard()
    temporary = data / ('.offline-cutover-' + uuid.uuid4().hex + '.tmp')
    raw = (json.dumps(value, separators=(',', ':'), sort_keys=True) + '\n').encode()
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(raw)
        stream.flush()
        os.fsync(stream.fileno())
    guard()
    os.link(temporary, data / 'offline-cutover.json', follow_symlinks=False)
    # Once the link succeeds cancellation means HOLD, never removal/retry.
    guard(published=True)
    temporary.unlink()  # Only the successful publication's own staging alias.
    sync_directory(data)
    guard(published=True)
    return raw


def publish(data, captures, evidence, admitted, output, root, expected, source,
            image, helpers, procedure, budget):
    """Direct use is for isolated synthetic fixtures ONLY, not host authority."""
    checkpoint, launcher, locks = helpers
    budget.check()
    target = {'source': sha(source, r'[0-9a-f]{40}'),
              'imageDigest': sha(image, r'sha256:[0-9a-f]{64}'),
              'destination': sha(expected)}
    if launcher.fingerprint(root) != expected:
        raise ValueError('Target fingerprint mismatch')
    data, captures, evidence, output = map(procedure.plain_path, (data, captures, evidence, output))
    procedure.source_guard(data, checkpoint.FILES)
    procedure.output_guard(output, data)
    private_directory(captures, procedure)
    private_directory(evidence.parent, procedure)
    locations = (data, captures, evidence.parent, output)
    for index, path in enumerate(locations):
        if any(path == other or path in other.parents or other in path.parents for other in locations[index + 1:]):
            raise ValueError('Data, captures, evidence and output must not overlap')
    with contextlib.ExitStack() as fences:
        try:
            held = []
            for name in LOCK_NAMES:
                budget.check()
                stream = fences.enter_context(locks.lock_file(data, name))
                locks.acquire(stream, fcntl.LOCK_EX,
                              timeout=min(15, max(0, budget.deadline - time.monotonic())))
                held.append((name, stream))
            existing_shm, originals = {}, {}
            for name in checkpoint.FILES:
                for suffix in ('', '-wal'):
                    original = data / (name + suffix)
                    if original.exists():
                        originals[original] = file_identity(original.lstat())
                path = data / (name + '-shm')
                if path.exists():
                    info = path.lstat()
                    existing_shm[path] = (info.st_dev, info.st_ino, info.st_size)

            def guard(published=False):
                budget.check()
                if not published:
                    procedure.source_guard(data, checkpoint.FILES)
                else:
                    procedure.directory(data)
                    if os.path.lexists(data / 'lifecycle.json'):
                        raise ValueError('Lifecycle receipt appeared')
                    for name in checkpoint.FILES:
                        for suffix in ('', '-wal', '-shm'):
                            procedure.regular(data / (name + suffix), optional=bool(suffix))
                    info = (data / 'offline-cutover.json').lstat()
                    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
                        raise ValueError('Published receipt path changed')
                for name, stream in held:
                    info = (data / name).lstat()
                    owned = os.fstat(stream.fileno())
                    procedure.regular(data / name)
                    if (info.st_dev, info.st_ino) != (owned.st_dev, owned.st_ino):
                        raise ValueError('Stable fence inode changed')
                for path, identity in existing_shm.items():
                    info = path.lstat()
                    if (info.st_dev, info.st_ino, info.st_size) != identity:
                        raise ValueError('Existing SHM inode or extent changed')
                for original, identity in originals.items():
                    if file_identity(original.lstat()) != identity:
                        raise ValueError('Original database/WAL changed while fenced')
                for name in checkpoint.FILES:
                    wal = data / (name + '-wal')
                    if wal not in originals and wal.exists() and wal.stat().st_size:
                        raise ValueError('New database WAL appeared while fenced')

            guard()
            legacy = admit_evidence(evidence, admitted, target, procedure, budget)
            guard()
            earlier = [verified_capture(captures / label, target, helpers, procedure, budget)
                       for label in ('capture-1', 'capture-2')]
            guard()
            schemas = launcher.schemas(data)
            guard()
            if (earlier[0]['files'] != earlier[1]['files']
                    or schemas != {name: entry['schemaIdentity'] for name, entry in earlier[0]['files'].items()}):
                raise ValueError('Earlier captures or original schemas differ')
            procedure.output_guard(output, data)
            output.mkdir(mode=0o700, exist_ok=False)
            sync_directory(output.parent)
            fresh_path = output / 'fresh-capture'
            captured = checkpoint.capture(data, fresh_path, final_guard=guard, release=target)
            guard()
            fresh = verified_capture(fresh_path, target, helpers, procedure, budget)
            guard()
            if (fresh != captured or fresh['files'] != earlier[0]['files']
                    or launcher.schemas(data) != schemas):
                raise ValueError('Fresh checkpoint/live schemas differ from reviewed captures')
            guard()
            # Re-read the admitted packet/artifacts and both old captures before
            # committing, so replacing earlier evidence during capture fails closed.
            if admit_evidence(evidence, admitted, target, procedure, budget) != legacy:
                raise ValueError('Evidence changed')
            for index, label in enumerate(('capture-1', 'capture-2')):
                if verified_capture(captures / label, target, helpers, procedure, budget) != earlier[index]:
                    raise ValueError('Earlier checkpoint changed')
            guard()
            receipt = {'protocol': 1,
                       'source': 'git:' + legacy['source'] + '@' + legacy['imageDigest'],
                       'destination': expected, 'fence': 'offline-exclusive-v1',
                       'writers': {'app': 'stopped', 'lm-backfill': 'disabled'},
                       'schemas': schemas, 'files': fresh['files'],
                       'hostEvidenceSha256': admitted}
            raw = publish_no_clobber(data, receipt, guard)
            if read_private(data / 'offline-cutover.json', procedure, budget) != raw:
                raise ValueError('Published receipt readback differs')
            guard(published=True)
            procedure.emit({'status': 'published', 'evidenceSha256': admitted,
                            'targetFingerprint': expected, 'receiptSha256': hashlib.sha256(raw).hexdigest()})
            guard(published=True)
            budget.finalize()  # Still fenced; delivered late signals fail acceptance.
            return 0
        except (Exception, KeyboardInterrupt) as error:
            procedure.emit({'status': 'HOLD', 'errorType': type(error).__name__,
                            'reconcileRequired': os.path.lexists(data / 'offline-cutover.json')})
            return 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('data', 'captures', 'evidence', 'admitted-evidence-sha256', 'output',
                 'expected-fingerprint', 'release-source', 'platform-digest'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--deadline-seconds', type=float, default=120)
    args = parser.parse_args()
    # Runtime check BEFORE importing any operator procedure or target helpers.
    require_runtime()
    procedure = load_procedure(pathlib.Path('/procedure/legacy-target-capture.py'))
    budget = procedure.Budget(args.deadline_seconds, exit_policy=True)
    budget.install()
    root = pathlib.Path('/app')
    return publish(args.data, args.captures, args.evidence, args.admitted_evidence_sha256,
                   args.output, root, args.expected_fingerprint, args.release_source,
                   args.platform_digest, procedure.load_helpers(root), procedure, budget)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (Exception, KeyboardInterrupt) as error:
        print(json.dumps({'status': 'HOLD', 'errorType': type(error).__name__}), flush=True)
        sys.exit(1)
