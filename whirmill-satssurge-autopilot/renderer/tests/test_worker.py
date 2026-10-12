import importlib.util
import pathlib
import unittest

spec = importlib.util.spec_from_file_location('content_worker', pathlib.Path(__file__).parent.parent / 'worker.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class NetworkInventory(unittest.TestCase):
    def setUp(self):
        self.interfaces = {'lo': {'ipv4': '127.0.0.1', 'flags': 9, 'operstate': 'unknown'}}
        self.routes = 'Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT\n'

    def validate(self, **overrides):
        worker.validate_network_inventory(overrides.get('interfaces', self.interfaces), overrides.get('ipv4_routes', self.routes), overrides.get('ipv6_routes', ''), overrides.get('ipv6_addresses', ''))

    def test_known_inert_tunnels_have_no_address_route_or_up_flag(self):
        for name in worker.INERT_TUNNELS:
            self.interfaces[name] = {'ipv4': None, 'flags': 128, 'operstate': 'down'}
        self.validate()
        for field, value in [('ipv4', '10.0.0.1'), ('flags', 129), ('operstate', 'up')]:
            bad = {**self.interfaces, 'tunl0': {**self.interfaces['tunl0'], field: value}}
            with self.assertRaises(ValueError):
                self.validate(interfaces=bad)

    def test_unknown_down_device_and_non_loopback_ipv6_fail_closed(self):
        with self.assertRaises(ValueError):
            self.validate(interfaces={**self.interfaces, 'eth0': {'ipv4': None, 'flags': 128, 'operstate': 'down'}})
        with self.assertRaises(ValueError):
            self.validate(ipv6_addresses='fe800000000000000000000000000001 01 40 20 80 tunl0\n')
        with self.assertRaises(ValueError):
            self.validate(ipv4_routes=self.routes + 'eth0 00000000 01000000 0003 0 0 0 00000000 0 0 0\n')


if __name__ == '__main__':
    unittest.main()

class MountInventory(unittest.TestCase):
    def test_unknown_disk_mount_under_kernel_prefix_is_not_an_exception(self):
        lines = ['overlay / overlay ro 0 0', '/dev/disk /content-jobs ext4 rw 0 0', 'tmpfs /tmp tmpfs rw,noexec,nosuid,nodev,size=196608k 0 0', 'proc /proc proc rw 0 0', 'tmpfs /dev tmpfs rw 0 0', 'sysfs /sys sysfs ro 0 0', 'cgroup /sys/fs/cgroup cgroup2 ro 0 0']
        worker.validate_mount_inventory(lines)
        for extra in ['/dev/disk /proc/private ext4 ro 0 0', '/dev/disk /dev/private ext4 ro 0 0', '/dev/disk /sys/private ext4 ro 0 0']:
            with self.assertRaises(ValueError):
                worker.validate_mount_inventory(lines + [extra])
