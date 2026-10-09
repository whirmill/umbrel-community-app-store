#!/usr/bin/env python3
"""Private three-database checkpoint. CLI capture requires stopped app container.

Restore is only into an empty, isolated directory: it never replaces live state
or treats software rollback as permission to restore older financial receipts.
"""
import argparse
import fcntl
import datetime as dt
import hashlib
import json
import os
import pathlib
import re
import shutil
import sqlite3
import subprocess

from diagnostics import atomic_json, utc

FILES = ('operational.sqlite', 'durable.sqlite', 'oauth.sqlite')


def check(path):
    connection = sqlite3.connect('file:' + str(path) + '?mode=ro', uri=True)
    try:
        connection.execute('PRAGMA query_only=ON')
        if connection.execute('PRAGMA quick_check').fetchall() != [('ok',)]:
            raise ValueError('Checkpoint integrity failure')
        if connection.execute('PRAGMA foreign_key_check').fetchone() is not None:
            raise ValueError('Checkpoint foreign key failure')
        return connection.execute('PRAGMA user_version').fetchone()[0]
    finally:
        connection.close()


def capture(source, target, final_guard=None, release=None):
    target.mkdir(parents=True, exist_ok=False, mode=0o700)
    manifest = {'version': 1, 'capturedAt': utc(dt.datetime.now(dt.timezone.utc).isoformat()), 'files': {},
                'scope': 'Three databases with stopped application; pending state preserved, not replayed',
                'recoveryScope': 'database checkpoint only',
                'release': release or {'source': 'unrecorded', 'imageDigest': 'unrecorded'},
                'fullInstallRecoveryRequires': ['owner.secret preserved separately with original permissions', 'mounted LND and provider credentials preserved separately', 'immutable release image and source manifest'],
                'rollbackPolicy': 'Never restore older financial receipts over new or uncertain effects; schema compatibility must be verified'}
    for name in FILES:
        path = source / name
        if not path.is_file():
            raise ValueError('Required database missing')
        reader = sqlite3.connect('file:' + str(path) + '?mode=ro', uri=True)
        output = target / name
        writer = sqlite3.connect(output)
        try:
            reader.backup(writer)
        finally:
            writer.close()
            reader.close()
        os.chmod(output, 0o600)
        with output.open('rb') as stream:
            os.fsync(stream.fileno())
        manifest['files'][name] = {'sha256': hashlib.sha256(output.read_bytes()).hexdigest(),
                                   'schema': check(output), 'bytes': output.stat().st_size}
    if final_guard is not None:
        final_guard()
    atomic_json(target / 'manifest.json', manifest)
    return manifest


def verify(directory):
    manifest = json.loads((directory / 'manifest.json').read_text())
    if manifest.get('version') != 1 or set(manifest.get('files', {})) != set(FILES):
        raise ValueError('Checkpoint manifest incompatible')
    for name in FILES:
        path = directory / name
        expected = manifest['files'][name]
        if path.is_symlink() or hashlib.sha256(path.read_bytes()).hexdigest() != expected['sha256']:
            raise ValueError('Checkpoint checksum mismatch')
        if check(path) != expected['schema']:
            raise ValueError('Checkpoint schema mismatch')
    return manifest


def restore(source, target):
    manifest = verify(source)
    target.mkdir(parents=True, exist_ok=False, mode=0o700)
    for name in FILES:
        shutil.copyfile(source / name, target / name)
        os.chmod(target / name, 0o600)
        with (target / name).open('rb') as stream:
            os.fsync(stream.fileno())
    atomic_json(target / 'manifest.json', manifest)
    verify(target)
    return manifest


def require_stopped():
    result = subprocess.run(['docker', 'inspect', '--format', '{{.State.Running}}',
                             'whirmill-satssurge-autopilot_server_1'],
                            check=True, capture_output=True, text=True, timeout=8)
    if result.stdout.strip() != 'false':
        raise ValueError('Application must be proven stopped for consistent capture')


def capture_locked(source, target, guard=require_stopped, release=None):
    with (source / 'executor.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        guard()
        return capture(source, target, final_guard=guard, release=release)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['capture', 'verify', 'restore'])
    parser.add_argument('source', type=pathlib.Path)
    parser.add_argument('target', type=pathlib.Path, nargs='?')
    parser.add_argument('--release-source')
    parser.add_argument('--release-image')
    args = parser.parse_args()
    try:
        if args.mode == 'capture':
            if args.target is None:
                raise ValueError('Destination required')
            # Same inode used by the container entrypoint: prevent a concurrent
            # start from writing between sequential database checkpoints.
            release = None
            if args.release_source or args.release_image:
                if not re.fullmatch(r'[0-9a-f]{40}', args.release_source or '') or not re.fullmatch(r'sha256:[0-9a-f]{64}', args.release_image or ''):
                    raise ValueError('Both exact release source and immutable image digest required')
                release = {'source': args.release_source, 'imageDigest': args.release_image}
            capture_locked(args.source, args.target, release=release)
        elif args.mode == 'restore':
            if args.target is None:
                raise ValueError('Isolated destination required')
            restore(args.source, args.target)
        else:
            verify(args.source)
        print(json.dumps({'status': 'verified', 'mode': args.mode, 'databases': len(FILES)}))
    except Exception as error:
        print(json.dumps({'status': 'rejected', 'errorType': type(error).__name__}))
        raise SystemExit(1)
