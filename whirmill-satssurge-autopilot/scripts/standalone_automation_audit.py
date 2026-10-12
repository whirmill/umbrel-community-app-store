"""Finite conservative proc/schedule audit, using an owner-reviewed allowlist.

No argv, environments, schedule text or credentials leave this helper. Unknown
processes/files, churn, inaccessible scopes or caps refuse qualification. An
allowlist must qualify commands AND their indirect scripts/configurations.
"""
import hashlib
import os
import pathlib
import stat
import time

import host_read_boundary

ROOTS = ('/etc/systemd/system', '/run/systemd/system', '/usr/lib/systemd/system',
         '/home/umbrel/.config/systemd/user', '/etc/cron.d', '/etc/cron.daily',
         '/etc/cron.hourly', '/etc/cron.weekly', '/etc/cron.monthly', '/var/spool/cron/crontabs',
         '/etc/systemd/user', '/run/systemd/user', '/usr/lib/systemd/user',
         '/run/systemd/transient', '/run/user/1000/systemd/user')


def sha(data): return hashlib.sha256(data).hexdigest()


def bounded_names(directory, predicate=lambda name: True):
    names = []
    with os.scandir(directory) as entries:
        for entry in entries:
            if predicate(entry.name):
                names.append(entry.name)
                if len(names) > 8192: raise ValueError('Inventory entry cap')
    return sorted(names)


def audit(config, proc=pathlib.Path('/proc'), roots=None, clock=time.monotonic):
    deadline = clock() + 8
    check = lambda: (_ for _ in ()).throw(ValueError('Audit deadline')) if clock() > deadline else None
    if config.get('scope') != 'linux-proc-and-system-user-schedules-v1': raise ValueError('Audit scope unqualified')
    process_rules = set(config['processCommandDigests'])
    schedule_rules = config['scheduleDigests']
    processes, schedules, aliases = [], [], []
    executable_cache = {}
    ids = bounded_names(proc, lambda name: name.isdigit() and int(name) != os.getpid())
    if len(ids) > 8192: raise ValueError('Process inventory cap')
    for pid in ids:
        check()
        # proc is a kernel virtual filesystem. Its small changing files are
        # explicitly outside regular-file read semantics, but remain byte capped.
        descriptor = os.open(proc / pid / 'cmdline', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try: raw = os.read(descriptor, 16385)
        finally: os.close(descriptor)
        if len(raw) > 16384: raise ValueError('Process command cap')
        # Empty kernel cmdlines still require exact allowlisted comm identity.
        kernel_command = not raw
        if not raw:
            descriptor = os.open(proc / pid / 'comm', os.O_RDONLY | os.O_NOFOLLOW)
            try: raw = b'kernel:' + os.read(descriptor, 129)
            finally: os.close(descriptor)
            if len(raw) > 135: raise ValueError('Kernel comm cap')
        fingerprint = sha(raw)
        raw = None
        if fingerprint not in process_rules: raise ValueError('Unqualified process command')
        try:
            executable = pathlib.Path(os.readlink(proc / pid / 'exe'))
        except FileNotFoundError:
            if not kernel_command or config['processExecutableDigests'].get(fingerprint) != 'kernel':
                raise ValueError('Process executable unavailable')
            executable_digest = 'kernel'
        else:
            if not executable.is_absolute(): raise ValueError('Process executable identity unqualified')
            # Read actual executable bytes through its canonical no-follow path,
            # never through proc's kernel symlink. Cache only unchanged metadata.
            parent = host_read_boundary.parent_fd(executable)
            try: metadata = os.stat(executable.name, dir_fd=parent, follow_symlinks=False)
            finally: os.close(parent)
            key = (str(executable),metadata.st_dev,metadata.st_ino,metadata.st_size,metadata.st_mtime_ns,metadata.st_ctime_ns)
            if key not in executable_cache:
                executable_cache[key] = sha(host_read_boundary.read_bytes(executable,64*1048576))
            executable_digest = executable_cache[key]
            if config['processExecutableDigests'].get(fingerprint) != executable_digest:
                raise ValueError('Process executable source changed')
        processes.append((pid, fingerprint, executable_digest))
    after = bounded_names(proc, lambda name: name.isdigit() and int(name) != os.getpid())
    if after != ids: raise ValueError('Process inventory changed')
    total = 0
    scopes = roots if roots is not None else [pathlib.Path(p) for p in ROOTS]
    for root in scopes:
        if str(root) in config.get('absentScheduleRoots', []):
            try: parent = host_read_boundary.parent_fd(root)
            except FileNotFoundError: continue  # verified missing real ancestor; aliases still raise
            try:
                try: os.stat(root.name, dir_fd=parent, follow_symlinks=False)
                except FileNotFoundError: continue
                raise ValueError('Expected absent scope now exists')
            finally: os.close(parent)
        pending = [root]
        while pending:
            check()
            directory = pending.pop()
            parent = host_read_boundary.parent_fd(directory / '.entry')
            try:
                names = bounded_names(parent)
                if len(names) + len(schedules) > 8192: raise ValueError('Schedule inventory cap')
                for name in names:
                    check()
                    path = directory / name
                    info = os.stat(name, dir_fd=parent, follow_symlinks=False)
                    if stat.S_ISDIR(info.st_mode): pending.append(path); continue
                    if stat.S_ISLNK(info.st_mode):
                        # Hash alias metadata only; never follow a scheduling alias.
                        if path.suffix not in ['.service','.timer','.socket','.path','.target','.mount','.automount','.swap','.slice','.scope','.device','.conf']:
                            raise ValueError('Schedule alias type unqualified')
                        link = os.readlink(name, dir_fd=parent)
                        destination = pathlib.Path(os.path.normpath(link if os.path.isabs(link) else str(path.parent / link)))
                        aliases.append(destination)
                        fingerprint = sha(('alias:' + link).encode())
                    elif stat.S_ISREG(info.st_mode):
                        raw = host_read_boundary.read_bytes(path, 1048576)
                        total += len(raw)
                        if total > 16 * 1048576: raise ValueError('Total schedule byte cap')
                        fingerprint = sha(raw)
                        raw = None
                    else: raise ValueError('Unknown schedule file')
                    if schedule_rules.get(str(path)) != fingerprint: raise ValueError('Unqualified scheduling source')
                    schedules.append((str(path), fingerprint))
                if bounded_names(parent) != names: raise ValueError('Scheduling inventory changed')
            finally: os.close(parent)
    if roots is None:
        crontab = pathlib.Path('/etc/crontab')
        if config.get('crontabAbsent') is True:
            parent = host_read_boundary.parent_fd(crontab)
            try:
                try: os.stat(crontab.name, dir_fd=parent, follow_symlinks=False)
                except FileNotFoundError: pass
                else: raise ValueError('Expected absent crontab now exists')
            finally: os.close(parent)
        else:
            raw = host_read_boundary.read_bytes(crontab, 1048576)
            fingerprint = sha(raw)
            if schedule_rules.get(str(crontab)) != fingerprint: raise ValueError('Unqualified system crontab')
            schedules.append((str(crontab),fingerprint))
    for destination in aliases:
        if str(destination) != '/dev/null' and str(destination) not in config['indirectSourceDigests'] and str(destination) not in {path for path,_ in schedules}:
            raise ValueError('Unqualified scheduling alias target')
    # No omitted reviewed scheduling file may quietly become absence evidence.
    if set(schedule_rules) != {path for path, _ in schedules}: raise ValueError('Schedule roster disagreement')
    # Include indirectly referenced scripts/config in root review; check them now.
    for path, expected in config['indirectSourceDigests'].items():
        check()
        if sha(host_read_boundary.read_bytes(pathlib.Path(path), 1048576)) != expected: raise ValueError('Indirect scheduling source changed')
        check()
    check()
    result = {'unqualifiedAutomation': [], 'processInventoryDigest': sha(repr(processes).encode()),
              'scheduleInventoryDigest': sha(repr(sorted(schedules)).encode())}
    check()
    return result
