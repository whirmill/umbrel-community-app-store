from pathlib import Path
import re
import unittest

ROOT = Path(__file__).parents[2]

class PackagingTests(unittest.TestCase):
    def test_voice_compose_is_offline_and_only_shares_private_spool(self):
        compose = (ROOT / 'voice/compose.candidate.yml').read_text()
        worker = compose.split('  voice:\n', 1)[1].split('\nvolumes:', 1)[0]
        for contract in ['network_mode: none', 'user: "1000:1000"', 'read_only: true', 'cap_drop: [ALL]', 'no-new-privileges:true', 'pids_limit: 64', 'cpus: 2', 'mem_limit: 768m', '/tmp:size=32m,mode=0700,uid=1000,gid=1000', 'SATSSURGE_VOICE_IMAGE:?']:
            self.assertIn(contract, worker)
        mounts = re.findall(r'^\s+- (.+)$', worker, re.MULTILINE)
        self.assertEqual(mounts, ['voice_private:/voice-spool'])
        self.assertNotIn('ports:', worker)
        self.assertNotIn('environment:', worker)
        self.assertIn('NOT READY', compose)
    def test_both_images_seed_same_private_volume_without_host_root_helper(self):
        seed = 'mkdir -p /voice-spool && chown 1000:1000 /voice-spool && chmod 0700 /voice-spool'
        for path in ['Dockerfile', 'voice/Dockerfile']:
            docker = (ROOT / path).read_text()
            self.assertIn(seed, docker)
            self.assertIn('USER 1000:1000', docker)
    def test_runtime_image_contains_no_fetcher_compiler_or_model_fallback(self):
        docker = (ROOT / 'voice/Dockerfile').read_text()
        runtime = docker.rsplit('FROM ', 1)[1]
        self.assertNotIn('fetch_asset.py', runtime)
        self.assertNotIn('apt-get', runtime)
        self.assertNotIn('curl', runtime)
        self.assertIn('-DGGML_NATIVE=OFF', docker)
        self.assertIn('-DGGML_AVX=OFF', docker)
        self.assertIn('-DGGML_CPU_ARM_ARCH=armv8-a', docker)
        self.assertIn('COPY --from=build /model/ggml-base.bin', runtime)
        self.assertIn('--disable-network', docker)

if __name__ == '__main__':
    unittest.main()
