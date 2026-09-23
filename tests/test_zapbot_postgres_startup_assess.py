import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("zapbot-postgres-startup-assess.py")
SPEC = importlib.util.spec_from_file_location("startup_assess", MODULE_PATH)
assert SPEC and SPEC.loader
assessor = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(assessor)


class StartupAssessmentTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.receipt = Path(self.temp.name)
        (self.receipt / "postgres-state.json").write_text(
            json.dumps({"restart": 0, "state": "running", "health": "healthy"})
        )
        (self.receipt / "resolved-config.json").write_text(
            json.dumps(
                {
                    "postgres_image": "pgvector/pgvector:18@sha256:" + "a" * 64,
                    "credential_image": "pgvector/pgvector:18@sha256:" + "a" * 64,
                    "tls_image": "pgvector/pgvector:18@sha256:" + "a" * 64,
                    "pgdata": "/var/lib/postgresql/data/pgdata",
                    "postgres_environment": {"POSTGRES_PASSWORD_FILE": "/run/zapbot-secret/password"},
                    "project": "zapbot-pg-probe-123",
                    "expected_named_volume": "zapbot-pg-probe-123-pgdata",
                    "postgres_mounts": [{"target": "/var/lib/postgresql/data", "type": "volume", "source": "pg_probe_data"}],
                    "credential_mounts": [{"target": "/data/postgres", "type": "volume", "source": "pg_probe_data"}],
                }
            )
        )
        (self.receipt / "postgres.log").write_text(
            "PGCTL_PROBE phase=start caller=999:999 pgdata=46:101 999:999 700\n"
            "database system is ready to accept connections\n"
            "PGCTL_PROBE phase=stop caller=999:999 pgdata=46:101 999:999 700\n"
        )
        (self.receipt / "ownership.txt").write_text(
            "view=credential_after t=now\n"
            "/data/postgres dev:inode=46:99 uid:gid=999:999 mode=700\n"
            "view=postgres_before t=now\n"
            "/var/lib/postgresql/data dev:inode=46:99 uid:gid=999:999 mode=700\n"
            "view=credential_final t=now\n"
            "/data/postgres/pgdata dev:inode=46:101 uid:gid=999:999 mode=700\n"
            "view=postgres_final t=now\n"
            "/var/lib/postgresql/data/pgdata dev:inode=46:101 uid:gid=999:999 mode=700\n"
            "actual_postgres_container caller=0:0 t=now\n"
            "/var/lib/postgresql/data/pgdata dev:inode=46:101 uid:gid=999:999 mode=700\n"
            "actual_postgres_container caller=999:999 t=now\n"
            "/var/lib/postgresql/data/pgdata dev:inode=46:101 uid:gid=999:999 mode=700\n"
        )

    def set_bind(self):
        path = self.receipt / "resolved-config.json"
        config = json.loads(path.read_text())
        config["expected_named_volume"] = None
        config["postgres_mounts"] = [{"target": "/var/lib/postgresql/data", "type": "bind", "source": "/fixture/app/data/postgres"}]
        config["credential_mounts"] = [{"target": "/data", "type": "bind", "source": "/fixture/app/data"}]
        path.write_text(json.dumps(config))

    def change_config(self, change):
        path = self.receipt / "resolved-config.json"
        config = json.loads(path.read_text())
        change(config)
        path.write_text(json.dumps(config))

    def test_healthy_and_coherent(self):
        result = assessor.assess(self.receipt, "named")
        self.assertEqual((result["startup"], result["ownership_coherence"]), ("pass", "pass"))

    def test_initial_fatal_fails_even_after_recovery(self):
        self.set_bind()
        path = self.receipt / "postgres.log"
        path.write_text(path.read_text() + "FATAL: data directory has wrong ownership\n")
        result = assessor.assess(self.receipt, "bind")
        self.assertEqual(result["startup"], "fail")

    def test_restart_fails_even_if_healthy(self):
        self.set_bind()
        (self.receipt / "postgres-state.json").write_text(
            json.dumps({"restart": 1, "state": "running", "health": "healthy"})
        )
        self.assertEqual(assessor.assess(self.receipt, "bind")["startup"], "fail")

    def test_same_inode_owner_flip_fails_coherence_only(self):
        self.set_bind()
        path = self.receipt / "ownership.txt"
        path.write_text(path.read_text().replace("caller=999:999 t=now\n/var/lib/postgresql/data/pgdata dev:inode=46:101 uid:gid=999:999", "caller=999:999 t=now\n/var/lib/postgresql/data/pgdata dev:inode=46:101 uid:gid=0:0"))
        result = assessor.assess(self.receipt, "bind")
        self.assertEqual(result["startup"], "pass")
        self.assertEqual(result["ownership_coherence"], "fail")

    def test_missing_stop_boundary_fails_closed(self):
        path = self.receipt / "postgres.log"
        path.write_text(path.read_text().split("PGCTL_PROBE phase=stop")[0])
        self.assertEqual(assessor.assess(self.receipt, "named")["startup"], "fail")

    def test_bind_mode_rejects_named_mounts(self):
        self.assertEqual(assessor.assess(self.receipt, "bind")["startup"], "fail")

    def test_bind_mode_rejects_mismatched_sources(self):
        self.set_bind()
        self.change_config(lambda config: config["postgres_mounts"][0].update(source="/other/postgres"))
        self.assertEqual(assessor.assess(self.receipt, "bind")["startup"], "fail")

    def test_named_mode_rejects_mismatched_volume(self):
        self.change_config(lambda config: config["credential_mounts"][0].update(source="wrong_volume"))
        self.assertEqual(assessor.assess(self.receipt, "named")["startup"], "fail")

    def test_named_mode_rejects_bind_type(self):
        self.change_config(lambda config: config["credential_mounts"][0].update(type="bind"))
        self.assertEqual(assessor.assess(self.receipt, "named")["startup"], "fail")

    def test_prestart_root_owner_fails_even_when_pgdata_later_coherent(self):
        path = self.receipt / "ownership.txt"
        path.write_text(path.read_text().replace("/data/postgres dev:inode=46:99 uid:gid=999:999", "/data/postgres dev:inode=46:99 uid:gid=0:0"))
        result = assessor.assess(self.receipt, "named")
        self.assertEqual(result["startup"], "pass")
        self.assertEqual(result["ownership_coherence"], "fail")

    def test_missing_prestart_observation_fails_coherence(self):
        path = self.receipt / "ownership.txt"
        path.write_text(path.read_text().replace("/var/lib/postgresql/data dev:inode=46:99 uid:gid=999:999 mode=700\n", ""))
        self.assertEqual(assessor.assess(self.receipt, "named")["ownership_coherence"], "fail")

    def test_prestart_parent_inodes_must_match(self):
        path = self.receipt / "ownership.txt"
        path.write_text(path.read_text().replace("/var/lib/postgresql/data dev:inode=46:99", "/var/lib/postgresql/data dev:inode=46:98"))
        self.assertEqual(assessor.assess(self.receipt, "named")["ownership_coherence"], "fail")


if __name__ == "__main__":
    unittest.main()
