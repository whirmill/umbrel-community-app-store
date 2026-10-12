#!/usr/bin/env python3
"""Exclusive finite IPC renderer supervisor; no app DB, credentials or network."""
import ctypes
import errno
import socket
import struct
import fcntl
import json
import os
import pathlib
import re
import shutil
import signal
import stat
import subprocess
import time

ROOT = pathlib.Path('/content-jobs')
STOP = False
CHILD = None


def stopping(number, frame):
    global STOP
    STOP = True
    if CHILD and CHILD.poll() is None:
        try:
            os.killpg(CHILD.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


def failure(job):
    payload = json.dumps({'protocol': 1, 'artifactId': job.name, 'code': 'render_rejected'}) + '\n'
    try:
        fd = os.open(job / 'failure.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        fd = os.open(job, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    except FileExistsError:
        pass


INERT_TUNNELS = frozenset(('tunl0','gre0','gretap0','erspan0','ip_vti0','ip6_vti0','sit0','ip6tnl0','ip6gre0'))

def validate_network_inventory(interfaces, ipv4_routes, ipv6_routes, ipv6_addresses):
    """Candidate equivalence: kernel fallback tunnels have no usable interface/address/route.
    Deployment must independently bind Docker NetworkMode=none and private netns.
    Never accept arbitrary DOWN ethernet/veth, UP tunnels, addresses or routes.
    """
    if 'lo' not in interfaces or len(interfaces)>10: raise ValueError('network isolation required')
    for name,value in interfaces.items():
        if name=='lo':
            if value['ipv4'] not in (None,'127.0.0.1') or not value['flags']&8: raise ValueError('network isolation required')
        elif name not in INERT_TUNNELS or value['operstate']!='down' or value['flags']&1 or value['ipv4'] is not None:
            raise ValueError('network isolation required')
    lines=ipv4_routes.splitlines()
    if not lines or lines[0].split()[:3]!=['Iface','Destination','Gateway']: raise ValueError('invalid network inventory')
    for line in lines[1:]:
        values=line.split()
        if len(values)!=11 or values[0]!='lo': raise ValueError('network isolation required')
    for line in ipv6_routes.splitlines():
        values=line.split()
        if len(values)!=10 or values[-1]!='lo': raise ValueError('network isolation required')
    for line in ipv6_addresses.splitlines():
        values=line.split()
        if len(values)!=6 or values[-1]!='lo' or values[0]!='00000000000000000000000000000001': raise ValueError('network isolation required')

def network_preflight():
    def bounded(path):
        with open(path,'r') as stream: value=stream.read(65537)
        if len(value)>65536: raise ValueError('network inventory limit')
        return value
    names=socket.if_nameindex()
    if len(names)>10 or len({name for _,name in names})!=len(names): raise ValueError('network isolation required')
    interfaces={}
    with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as probe:
        for _,name in names:
            if name!='lo' and name not in INERT_TUNNELS: raise ValueError('network isolation required')
            root=pathlib.Path('/sys/class/net')/name
            try: ipv4=socket.inet_ntoa(fcntl.ioctl(probe,0x8915,struct.pack('256s',name.encode()))[20:24])
            except OSError as error:
                if error.errno!=errno.EADDRNOTAVAIL: raise ValueError('network address unavailable') from None
                ipv4=None
            interfaces[name]={'flags':int(bounded(root/'flags'),16),'operstate':bounded(root/'operstate').strip(),'ipv4':ipv4}
    validate_network_inventory(interfaces,bounded('/proc/net/route'),bounded('/proc/net/ipv6_route'),bounded('/proc/net/if_inet6'))


def validate_mount_inventory(lines):
    kernel = {'/proc': 'proc', '/dev': 'tmpfs', '/dev/pts': 'devpts', '/dev/shm': 'tmpfs', '/dev/mqueue': 'mqueue', '/sys': 'sysfs', '/sys/fs/cgroup': 'cgroup2'}
    proc_readonly = {'/proc/bus', '/proc/fs', '/proc/irq', '/proc/sys', '/proc/sysrq-trigger'}
    masked = {'/proc/acpi', '/proc/scsi', '/proc/interrupts', '/proc/kcore', '/proc/keys', '/proc/timer_list', '/sys/firmware'}
    identity = {'/etc/hosts', '/etc/hostname', '/etc/resolv.conf'}
    disk = {'ext4', 'xfs', 'btrfs', 'zfs', 'overlay', 'virtiofs'}
    seen = set()
    for line in lines:
        _, target, kind, options, *_ = line.split()
        flags = set(options.split(','))
        if target in seen:
            raise ValueError('duplicate mount')
        seen.add(target)
        if target == '/':
            valid = kind in disk and 'ro' in flags
        elif target == '/content-jobs':
            valid = kind in disk
        elif target == '/tmp':
            sizes = [int(x[5:-1]) * 1024 for x in flags if x.startswith('size=') and x.endswith('k') and x[5:-1].isdigit()]
            valid = kind == 'tmpfs' and {'noexec', 'nosuid', 'nodev'} <= flags and len(sizes) == 1 and 0 < sizes[0] <= 192 * 1024 * 1024
        elif target == '/usr/sbin/docker-init' or target in identity:
            valid = kind in disk and 'ro' in flags
        elif target in kernel:
            valid = kind == kernel[target] and (target not in {'/sys', '/sys/fs/cgroup'} or 'ro' in flags)
        elif target in proc_readonly:
            valid = kind == 'proc' and 'ro' in flags
        elif target in masked:
            valid = kind == 'tmpfs'
        else:
            valid = False
        if not valid:
            raise ValueError('additional host mount forbidden')
    if not {'/', '/content-jobs', '/tmp', '/proc', '/dev', '/sys', '/sys/fs/cgroup'} <= seen:
        raise ValueError('missing isolation mount')


def preflight():
    if os.getuid() != 1000 or ROOT.is_symlink() or ROOT.resolve() != ROOT:
        raise ValueError('isolated deployment required')
    info = ROOT.stat()
    if info.st_uid != 1000 or stat.S_IMODE(info.st_mode) != 0o700:
        raise ValueError('IPC ownership required')
    status = pathlib.Path('/proc/self/status').read_text()
    if not re.search(r'^NoNewPrivs:\s+1$', status, re.M) or any(int(v, 16) for v in re.findall(r'^Cap(?:Inh|Prm|Eff|Bnd|Amb):\s+(\w+)$', status, re.M)):
        raise ValueError('capabilities forbidden')
    network_preflight()
    # Compose binds a read-only root, finite scratch and cgroup. Refuse a
    # deployment that omits those bounds instead of trusting a source comment.
    mounts = pathlib.Path('/proc/mounts').read_text().splitlines()
    if not any(x.split()[1] == '/' and 'ro' in x.split()[3].split(',') for x in mounts):
        raise ValueError('read-only root required')
    if not any(x.split()[1] == '/tmp' and x.split()[2] == 'tmpfs' for x in mounts):
        raise ValueError('finite scratch required')
    validate_mount_inventory(mounts)
    limits = pathlib.Path('/sys/fs/cgroup')
    if not 1 <= int((limits / 'pids.max').read_text()) <= 256 or not 1 <= int((limits / 'memory.max').read_text()) <= 805306368:
        raise ValueError('finite cgroup required')
    cpu = (limits / 'cpu.max').read_text().split()
    if cpu[0] == 'max' or int(cpu[0]) > int(cpu[1]):
        raise ValueError('finite CPU required')


def reap_owned_children():
    """Linux subreaper owns even Chromium's detached descendants. No shared PIDs.
    Wait for teardown before cleanup so a late descendant cannot recreate scratch.
    """
    deadline = time.monotonic() + 2
    while True:
        owned = []
        for path in pathlib.Path('/proc').glob('[0-9]*/stat'):
            try:
                fields = path.read_text().rsplit(')', 1)[1].split()
                if int(fields[1]) == os.getpid():
                    owned.append(int(path.parent.name))
            except (FileNotFoundError, ProcessLookupError):
                pass
        for pid in owned:
            try:
                group = os.getpgid(pid)
                if group != os.getpgrp():
                    os.killpg(group, signal.SIGKILL)
                else:
                    os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        while True:
            try:
                if os.waitpid(-1, os.WNOHANG)[0] == 0:
                    break
            except ChildProcessError:
                break
        if not owned:
            return
        if time.monotonic() >= deadline:
            raise ValueError('owned browser teardown unconfirmed')
        time.sleep(.02)


def main():
    global CHILD
    preflight()
    if ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) != 0:
        raise ValueError('Linux renderer subreaper required')
    for number in (signal.SIGTERM, signal.SIGINT):
        signal.signal(number, stopping)
    fd = os.open(ROOT / 'worker.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    if not stat.S_ISREG(os.fstat(fd).st_mode) or os.fstat(fd).st_nlink != 1:
        raise ValueError('lock file')
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    try:
        # At startup old scratch belongs to this exclusive renderer only. Crash
        # partial output is rejected; it never generates a replacement revision.
        for path in pathlib.Path('/tmp').glob('render-*'):
            if not path.is_symlink() and path.is_dir():
                shutil.rmtree(path)
        while not STOP:
            entries = list(ROOT.iterdir())
            if len(entries) > 129:
                raise ValueError('job capacity')
            jobs = []
            for job in entries:
                if job.name == 'worker.lock':
                    continue
                if not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}', job.name) or job.is_symlink() or not job.is_dir():
                    raise ValueError('unsafe job directory')
                if (job / 'request.json').exists() and not (job / 'manifest.json').exists() and not (job / 'failure.json').exists():
                    jobs.append(job)
            for job in sorted(jobs, key=lambda x: x.name):
                if STOP:
                    break
                # Intent remains durable. Restart/partial output cannot be silently replayed.
                if (job / 'worker-intent.json').exists() or (job / 'cancel.json').exists() or any(job.glob('artifact.*')):
                    failure(job)
                    continue
                intent = os.open(job / 'worker-intent.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                with os.fdopen(intent, 'w') as stream:
                    stream.write('{"protocol":1}\n')
                    stream.flush()
                    os.fsync(stream.fileno())
                CHILD = subprocess.Popen(['node', '/app/render.mjs', job.name], start_new_session=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env={'PATH': '/usr/local/bin:/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': '/tmp', 'TMPDIR': '/tmp'})
                deadline = time.monotonic() + 35
                while CHILD.poll() is None:
                    if STOP or time.monotonic() >= deadline or (job / 'cancel.json').exists():
                        try:
                            os.killpg(CHILD.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                        break
                    time.sleep(.05)
                result = CHILD.wait()
                try:
                    os.killpg(CHILD.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                CHILD = None
                reap_owned_children()
                if result or not (job / 'manifest.json').exists():
                    failure(job)
                for path in pathlib.Path('/tmp').glob('render-*'):
                    if not path.is_symlink() and path.is_dir():
                        shutil.rmtree(path)
            time.sleep(.1)
    finally:
        if CHILD is not None:
            stopping(signal.SIGTERM, None)
            CHILD.wait()
            CHILD = None
        reap_owned_children()
        os.close(fd)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('{"status":"renderer_rejected"}', flush=True)
        raise SystemExit(1)
