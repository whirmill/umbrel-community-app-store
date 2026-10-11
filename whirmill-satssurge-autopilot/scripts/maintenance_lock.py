"""Cooperative stable-inode protocol; never unlink these lock files."""
import contextlib
import fcntl
import os
import pathlib
import stat
import time


def acquire(stream, mode, timeout=15):
    deadline = time.monotonic() + timeout
    while True:
        try:
            fcntl.flock(stream, mode | fcntl.LOCK_NB)
            return
        except BlockingIOError:
            if time.monotonic() >= deadline:
                raise TimeoutError('Maintenance lock deadline exceeded')
            time.sleep(0.025)


def lock_file(directory, name):
    directory = pathlib.Path(directory)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(directory / name, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    if not stat.S_ISREG(os.fstat(fd).st_mode):
        os.close(fd)
        raise ValueError('Maintenance lock must be a regular file')
    return os.fdopen(fd, 'a+')


@contextlib.contextmanager
def writer_lock(directory, timeout=15):
    # Admission turnstile qualifies EX -> SH conversion without a competing
    # checkpoint entering the conversion's non-atomic flock gap on Linux.
    with lock_file(directory, 'maintenance-admission.lock') as admission:
        acquire(admission, fcntl.LOCK_EX, timeout)
        with lock_file(directory, 'maintenance.lock') as maintenance:
            acquire(maintenance, fcntl.LOCK_SH, timeout)
            fcntl.flock(admission, fcntl.LOCK_UN)
            yield maintenance
