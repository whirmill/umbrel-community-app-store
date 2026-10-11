#!/usr/bin/env python3
"""User-owned public LND certificate synchronization. No RPC or database writes."""
import hashlib
import os
from pathlib import Path
import ssl
import stat
import tempfile
import time

SOURCE = Path('/home/umbrel/umbrel/app-data/lightning/data/lnd/tls.cert')
DESTINATION = Path('/home/umbrel/umbrel/app-data/whirmill-satssurge-autopilot/credentials/tls.cert')


def owned_regular(path, uid, limit=65536):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != uid or info.st_mode & 0o022 or info.st_size > limit:
        raise ValueError('certificate permissions invalid')
    with path.open('rb') as handle:
        opened = os.fstat(handle.fileno())
        if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
            raise ValueError('certificate changed during inspection')
        return handle.read(limit + 1)


def synchronize(source=SOURCE, destination=DESTINATION):
    uid = os.geteuid()
    if uid == 0:
        raise ValueError('user ownership required')
    return copy_public_cert(source, destination, uid)


def copy_public_cert(source, destination, uid):
    parent = destination.parent
    info = parent.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != uid or info.st_mode & 0o022:
        raise ValueError('destination permissions invalid')
    data = owned_regular(source, uid)
    # Decode exactly one bounded public PEM certificate. No subjects or SANs emitted.
    text = data.decode('ascii')
    if text.count('-----BEGIN CERTIFICATE-----') != 1 or text.count('-----END CERTIFICATE-----') != 1 or 'PRIVATE KEY' in text:
        raise ValueError('public certificate invalid')
    der = ssl.PEM_cert_to_DER_cert(text)
    candidate = None
    try:
        fd, candidate = tempfile.mkstemp(prefix='.tls-public-', dir=parent)
        with os.fdopen(fd, 'wb') as handle:
            os.fchmod(handle.fileno(), 0o600)
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        decoded = ssl._ssl._test_decode_cert(candidate)
        current = time.time()
        if not ssl.cert_time_to_seconds(decoded['notBefore']) <= current < ssl.cert_time_to_seconds(decoded['notAfter']):
            raise ValueError('public certificate validity invalid')
        if destination.exists() or destination.is_symlink():
            old = owned_regular(destination, uid)
            if destination.stat().st_mode & 0o777 != 0o600:
                raise ValueError('destination permissions invalid')
            try:
                if hashlib.sha256(ssl.PEM_cert_to_DER_cert(old.decode('ascii'))).digest() == hashlib.sha256(der).digest():
                    return 'unchanged'
            except (ValueError, UnicodeError):
                pass
        os.replace(candidate, destination)
        candidate = None
        directory_fd = os.open(parent, os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
        return 'updated'
    finally:
        if candidate:
            os.unlink(candidate)


if __name__ == '__main__':
    try:
        print('LND public certificate: ' + synchronize())
    except Exception:
        # Paths and parser diagnostics are deliberately excluded from output.
        print('LND public certificate synchronization failed; retained prior copy')
        raise SystemExit(1)
