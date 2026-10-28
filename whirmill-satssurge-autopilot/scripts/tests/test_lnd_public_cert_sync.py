import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('cert_sync', Path(__file__).parents[1] / 'sync-lnd-public-cert.py')
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)

class PublicCertificateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / 'source.cert'
        self.directory = self.root / 'credentials'
        self.directory.mkdir(mode=0o700)
        self.destination = self.directory / 'tls.cert'
        self.uid = os.getuid()
        subprocess.run(['openssl', 'req', '-new', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(self.root / 'fixture.key'), '-out', str(self.source), '-days', '365', '-subj', '/CN=isolated-fixture'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.source.chmod(0o600)
    def tearDown(self):
        self.temp.cleanup()
    def copy(self):
        return sync.copy_public_cert(self.source, self.destination, self.uid)
    def test_atomic_private_copy_and_unchanged_does_not_replace_inode(self):
        self.assertEqual(self.copy(), 'updated')
        self.assertEqual(self.destination.read_bytes(), self.source.read_bytes())
        before = self.destination.stat()
        self.assertEqual(before.st_mode & 0o777, 0o600)
        self.assertEqual(self.copy(), 'unchanged')
        self.assertEqual(self.destination.stat().st_ino, before.st_ino)
        self.assertEqual(list(self.directory.iterdir()), [self.destination])
    def test_bad_expired_private_or_oversized_source_retains_prior_copy(self):
        self.copy()
        before = self.destination.read_bytes()
        expired = Path(__file__).parent / 'fixtures/lnd-expired.cert-fixture'
        for invalid in [b'invalid', expired.read_bytes(), self.source.read_bytes() + b'\n-----BEGIN PRIVATE KEY-----\ninvalid', b'x' * 65537]:
            self.source.write_bytes(invalid)
            with self.assertRaises((ValueError, Exception)):
                self.copy()
            self.assertEqual(self.destination.read_bytes(), before)
            self.assertEqual(list(self.directory.iterdir()), [self.destination])
    def test_symlink_and_unsafe_modes_or_wrong_owner_refuse_copy(self):
        self.source.chmod(0o666)
        with self.assertRaises(ValueError): self.copy()
        self.source.chmod(0o600)
        with self.assertRaises(ValueError): sync.copy_public_cert(self.source, self.destination, self.uid + 1)
        self.directory.chmod(0o777)
        with self.assertRaises(ValueError): self.copy()
        self.directory.chmod(0o700)
        self.copy()
        self.destination.chmod(0o644)
        with self.assertRaises(ValueError): self.copy()
        self.destination.unlink()
        self.destination.symlink_to(self.source)
        with self.assertRaises(ValueError): self.copy()
    def test_failed_atomic_replace_retains_previous_certificate_and_cleans_temp(self):
        self.copy()
        before = self.destination.read_bytes()
        subprocess.run(['openssl', 'req', '-new', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(self.root / 'other.key'), '-out', str(self.source), '-days', '365', '-subj', '/CN=other-isolated-fixture'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        with patch.object(sync.os, 'replace', side_effect=OSError('isolated failure')):
            with self.assertRaises(OSError): self.copy()
        self.assertEqual(self.destination.read_bytes(), before)
        self.assertEqual(list(self.directory.iterdir()), [self.destination])
    def test_entrypoint_refuses_root(self):
        with patch.object(sync.os, 'geteuid', return_value=0):
            with self.assertRaisesRegex(ValueError, 'user ownership'): sync.synchronize()
