import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).parents[1] / "app" / "cloudflare_ddns.py"
SPEC = importlib.util.spec_from_file_location("cloudflare_ddns", MODULE_PATH)
ddns = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = ddns
SPEC.loader.exec_module(ddns)


class FakeCloudflareClient:
    def __init__(self, records):
        self.records = records
        self.verified = False
        self.zone_lookups = []
        self.record_lookups = []
        self.updates = []

    def verify_token(self):
        self.verified = True

    def find_zone(self, name):
        self.zone_lookups.append(name)
        return f"zone:{name}"

    def find_a_record(self, zone_id, name):
        self.record_lookups.append((zone_id, name))
        return dict(self.records[(zone_id, name)])

    def update_a_record(self, zone_id, record, ip):
        self.updates.append((zone_id, record["name"], ip))


class ConfigValidationTests(unittest.TestCase):
    def test_legacy_single_zone_config_is_migrated(self):
        config = ddns.validate_config(
            {
                "zone": "Example.COM.",
                "records": ["Home.Example.com."],
                "interval_seconds": 300,
            }
        )

        self.assertEqual(config["zones"], ["example.com"])
        self.assertNotIn("zone", config)
        self.assertEqual(config["records"], ["home.example.com"])

    def test_multiple_zones_accept_records_from_each_zone(self):
        config = ddns.validate_config(
            {
                "zones": ["example.com", "example.net"],
                "records": ["home.example.com", "vpn.example.net"],
                "interval_seconds": 600,
            }
        )

        self.assertEqual(config["zones"], ["example.com", "example.net"])

    def test_record_outside_configured_zones_is_rejected(self):
        with self.assertRaisesRegex(ddns.DDNSError, "nessuna zona configurata"):
            ddns.validate_config(
                {
                    "zones": ["example.com"],
                    "records": ["vpn.example.net"],
                    "interval_seconds": 300,
                }
            )

    def test_most_specific_zone_wins_for_delegated_subzone(self):
        zone = ddns.zone_for_record(
            "api.dev.example.com",
            ["example.com", "dev.example.com"],
        )

        self.assertEqual(zone, "dev.example.com")

    def test_service_loads_legacy_config_without_rewriting_it(self):
        with tempfile.TemporaryDirectory() as temporary_dir:
            data_dir = Path(temporary_dir)
            legacy = {
                "zone": "example.com",
                "records": ["home.example.com"],
                "interval_seconds": 300,
            }
            (data_dir / "config.json").write_text(json.dumps(legacy), encoding="utf-8")

            service = ddns.DDNSService(data_dir)

            self.assertEqual(service.public_status()["zones"], ["example.com"])
            self.assertEqual(json.loads((data_dir / "config.json").read_text()), legacy)


class CloudflareRoutingTests(unittest.TestCase):
    def setUp(self):
        self.config = {
            "zones": ["example.com", "example.net"],
            "records": ["home.example.com", "vpn.example.net"],
            "interval_seconds": 300,
        }
        self.records = {
            ("zone:example.com", "home.example.com"): {
                "id": "record-1",
                "type": "A",
                "name": "home.example.com",
                "content": "198.51.100.10",
                "proxied": False,
                "ttl": 1,
            },
            ("zone:example.net", "vpn.example.net"): {
                "id": "record-2",
                "type": "A",
                "name": "vpn.example.net",
                "content": "203.0.113.20",
                "proxied": True,
                "ttl": 120,
            },
        }

    def test_validation_checks_each_zone_and_record(self):
        client = FakeCloudflareClient(self.records)

        ddns.validate_cloudflare_config(
            self.config,
            "test-token",
            client_factory=lambda _token: client,
        )

        self.assertTrue(client.verified)
        self.assertEqual(client.zone_lookups, ["example.com", "example.net"])
        self.assertEqual(
            client.record_lookups,
            [
                ("zone:example.com", "home.example.com"),
                ("zone:example.net", "vpn.example.net"),
            ],
        )

    def test_update_routes_records_to_their_own_zones(self):
        client = FakeCloudflareClient(self.records)

        result = ddns.perform_update(
            self.config,
            token="test-token",
            client_factory=lambda _token: client,
            ip_detector=lambda: "198.51.100.10",
        )

        self.assertEqual(result.unchanged, ("home.example.com",))
        self.assertEqual(result.updated, ("vpn.example.net",))
        self.assertEqual(
            client.updates,
            [("zone:example.net", "vpn.example.net", "198.51.100.10")],
        )


if __name__ == "__main__":
    unittest.main()
