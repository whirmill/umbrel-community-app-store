"""Pinned read boundary for privileged configuration and Umbrel-owned data.

Every ancestor opens through a directory descriptor with NOFOLLOW. Data trees
may legitimately belong to Umbrel; protected configuration additionally requires
root ownership and no group/other writes throughout the descriptor chain.
"""
import os
import pathlib
import stat


def parent_fd(path, protected=False):
    path = pathlib.Path(path)
    if not path.is_absolute() or '..' in path.parts or os.path.normpath(str(path)) != str(path):
        raise ValueError('Canonical absolute read path required')
    descriptor = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in path.parts[1:-1]:
            current = os.fstat(descriptor)
            if protected and (current.st_uid != 0 or current.st_mode & 0o022):
                raise ValueError('Protected ancestor required')
            following = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = following
        current = os.fstat(descriptor)
        if protected and (current.st_uid != 0 or current.st_mode & 0o022):
            raise ValueError('Protected parent required')
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def read_bytes(path, limit=65536, protected=False, private=False):
    path = pathlib.Path(path)
    parent = parent_fd(path, protected)
    descriptor = None
    try:
        descriptor = os.open(path.name, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=parent)
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > limit:
            raise ValueError('Bounded regular input required')
        if protected and (before.st_uid != 0 or before.st_mode & 0o022):
            raise ValueError('Protected input required')
        if private and before.st_mode & 0o077:
            raise ValueError('Private input required')
        data = bytearray()
        while len(data) <= limit:
            block = os.read(descriptor, min(65536, limit + 1 - len(data)))
            if not block: break
            data.extend(block)
        after = os.fstat(descriptor)
        selected = os.stat(path.name, dir_fd=parent, follow_symlinks=False)
        keys = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        if len(data) > limit or keys(before) != keys(after) or keys(after) != keys(selected):
            raise ValueError('Input changed during acquisition')
        return bytes(data)
    finally:
        if descriptor is not None: os.close(descriptor)
        os.close(parent)
