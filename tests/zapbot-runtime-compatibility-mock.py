"""Pure mocks of the exact lifecycle boot function; no Docker subprocesses."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parent.parent
SOURCE = (ROOT / "tests/zapbot-package-lifecycle.sh").read_text()
FUNCTION = SOURCE.split("assert_isolated_runtime_boot() (", 1)[1].split("\n)\n", 1)[0]
FUNCTION = "assert_isolated_runtime_boot() (" + FUNCTION + "\n)\n"
MOCK = r'''
set -eu
project_base=owned
receipt="$MOCK_DIR/receipt"
repo_root=/unused
log() { printf '%s\n' "$*" >> "$receipt"; }
assert_fenced_services() { :; }
prepared_intent_row_fingerprint() { printf stable; }
verify_retained_consumption_fixture() { :; }
compose() { printf postgres-id; }
docker() {
  case "$1:$2" in
    container:ls)
      if [ -e "$MOCK_DIR/cleanup" ] && [ "$INVENTORY_FAIL" = 1 ]; then return 125; fi
      if [ -e "$MOCK_DIR/container" ]; then printf 'owned-test-compat-boot\n'; fi
      return 0 ;;
    network:ls)
      if [ -e "$MOCK_DIR/cleanup" ] && [ "$INVENTORY_FAIL" = 1 ]; then return 125; fi
      if [ -e "$MOCK_DIR/network" ]; then printf 'owned-test-compat-internal\n'; fi
      return 0 ;;
    network:create) : > "$MOCK_DIR/network"; return 0 ;;
    network:connect) : > "$MOCK_DIR/connected"; return 0 ;;
    network:inspect) printf true; return 0 ;;
    network:disconnect)
      : > "$MOCK_DIR/cleanup"
      [ "$DISCONNECT_FAIL" = 0 ] || return 1
      rm -f "$MOCK_DIR/connected"; return 0 ;;
    network:rm)
      : > "$MOCK_DIR/cleanup"
      [ "$NETWORK_RM_FAIL" = 0 ] || return 1
      if [ "$RETAIN_NETWORK" = 0 ]; then rm -f "$MOCK_DIR/network"; fi
      return 0 ;;
    rm:-f)
      : > "$MOCK_DIR/cleanup"
      [ "$CONTAINER_RM_FAIL" = 0 ] || return 1
      if [ "$RETAIN_CONTAINER" = 0 ]; then rm -f "$MOCK_DIR/container"; fi
      return 0 ;;
    run:--name) : > "$MOCK_DIR/container"; return "$BODY_EXIT" ;;
    inspect:-f) printf 0; return 0 ;;
    *) printf 'unexpected mock Docker invocation %s\n' "$*" >&2; return 64 ;;
  esac
}
'''


class RuntimeCompatibilityCleanup(unittest.TestCase):
    def run_case(self, expected_exit=0, **changes):
        with tempfile.TemporaryDirectory(prefix="zapbot-runtime-mock-") as tmp:
            env = dict(os.environ, MOCK_DIR=tmp, BODY_EXIT="0", CONTAINER_RM_FAIL="0",
                       DISCONNECT_FAIL="0", NETWORK_RM_FAIL="0", RETAIN_CONTAINER="0",
                       RETAIN_NETWORK="0", INVENTORY_FAIL="0")
            env.update({k: str(v) for k, v in changes.items()})
            result = subprocess.run(["sh", "-c", MOCK + FUNCTION +
                                     'assert_isolated_runtime_boot owned-test /unused image new243\n'],
                                    env=env, capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, expected_exit, result.stderr)
            log = (Path(tmp) / "receipt").read_text()
            if expected_exit == 0:
                self.assertIn("ownership=terminal_proven", log)
                self.assertIn("schema_243_actual_runtime_boot=pass", log)
                self.assertFalse((Path(tmp) / "container").exists())
                self.assertFalse((Path(tmp) / "network").exists())
            else:
                self.assertNotIn("schema_243_actual_runtime_boot=pass", log)
            return log

    def test_success_and_terminal_removal(self):
        self.run_case()

    def test_each_cleanup_command_failure_is_nonzero(self):
        for key, marker in [("CONTAINER_RM_FAIL", "rm_exit=1"),
                            ("DISCONNECT_FAIL", "disconnect_exit=1"),
                            ("NETWORK_RM_FAIL", "network_rm_exit=1")]:
            with self.subTest(key=key):
                log = self.run_case(1, **{key: 1})
                self.assertIn(marker, log)
                self.assertIn("ownership=terminal_unproven", log)
                self.assertIn("container=owned-test-compat-boot", log)
                self.assertIn("network=owned-test-compat-internal", log)

    def test_docker125_and_failed_cleanup_preserve_both_outcomes(self):
        log = self.run_case(125, BODY_EXIT=125, CONTAINER_RM_FAIL=1,
                            DISCONNECT_FAIL=1, NETWORK_RM_FAIL=1)
        self.assertIn("body_exit=125", log)
        self.assertIn("container_state=retained", log)
        self.assertIn("network_state=retained", log)
        self.assertIn("ownership=terminal_unproven", log)

    def test_failed_body_and_successful_cleanup_do_not_pass(self):
        log = self.run_case(125, BODY_EXIT=125)
        self.assertIn("schema_243_boot_cleanup=pass body_exit=125", log)

    def test_zero_exit_with_resource_retained_is_not_terminal(self):
        for key, state in [("RETAIN_CONTAINER", "container_state=retained"),
                           ("RETAIN_NETWORK", "network_state=retained")]:
            with self.subTest(key=key):
                log = self.run_case(1, **{key: 1})
                self.assertIn(state, log)
                self.assertIn("ownership=terminal_unproven", log)

    def test_missing_inventory_leaves_ownership_unknown(self):
        log = self.run_case(1, INVENTORY_FAIL=1)
        self.assertIn("container_state=unknown", log)
        self.assertIn("network_state=unknown", log)
        self.assertIn("ownership=terminal_unproven", log)


FIXTURE_FUNCTION = SOURCE.split("with_disposable_consumption_database() (", 1)[1].split("\nverify_retained_consumption_fixture()", 1)[0]
FIXTURE_FUNCTION = "with_disposable_consumption_database() (" + FIXTURE_FUNCTION
FIXTURE_MOCK = r"""
set -eu
project_base=owned
upgrade241_project=owned-upgrade241
fixture_dir="$MOCK_DIR/fixture"
repo_root="$ACTUAL_ROOT"
receipt="$MOCK_DIR/receipt"
image=immutable
fenced_services='web producer'
mkdir -p "$fixture_dir/consumption-baselines/owned-upgrade241" "$fixture_dir/app/data/secrets/postgres"
printf original > "$fixture_dir/consumption-baselines/owned-upgrade241/whole-rows.json"
log() { printf '%s\n' "$*" >> "$receipt"; }
assert_canonical_fixture_binds() { :; }
assert_fenced_services() { :; }
assert_rollback_fenced_services() { :; }
compose() {
 shift 2
 case "$1" in
  ps)
   case "$*" in *whirmill-zapbot-postgres*) printf postgres ;; *web*|*producer*) [ "$ACTIVE_BOUNDARY" = 0 ] || printf active ;; *) if [ "$FENCE" != boundary ]; then printf job; fi ;; esac
   ;;
  exec)
   last=''; for arg do last=$arg; done
   case "$last" in
    'SELECT oid FROM pg_database'*) printf '123\n' ;;
    'SELECT count(*)'*) printf '0\n' ;;
    'ALTER DATABASE'*) : ;;
    *) cat > "$MOCK_DIR/seed.sql" ;;
   esac ;;
  *) return 65 ;;
 esac
}
docker() {
 case "$1" in
  inspect) case "$*" in *State.Running*) printf true ;; *) printf exited ;; esac ;;
  run) printf '%s\n' "$*" > "$MOCK_DIR/eval-args" ;;
  *) return 65 ;;
 esac
}
"""


class VenueFixtureActions(unittest.TestCase):
    def run_fixture(self, action, capture, fence="current", old241=0, old242=0, active=0):
        with tempfile.TemporaryDirectory(prefix="zapbot-fixture-action-mock-") as tmp:
            env = dict(os.environ, MOCK_DIR=tmp, ACTUAL_ROOT=str(ROOT), FENCE=fence,
                       ACTIVE_BOUNDARY=str(active), fixture_old241=str(old241), fixture_old242=str(old242))
            command = f'with_disposable_consumption_database owned-upgrade241 "$fixture_dir/app" {action} "$fixture_dir/consumption-baselines/owned-upgrade241" {capture} {fence}\n'
            result = subprocess.run(["sh", "-c", FIXTURE_MOCK + FIXTURE_FUNCTION + command],
                                    env=env, capture_output=True, text=True, timeout=10)
            seed = Path(tmp, "seed.sql").read_text() if Path(tmp, "seed.sql").exists() else ""
            args = Path(tmp, "eval-args").read_text() if Path(tmp, "eval-args").exists() else ""
            return result, seed, args

    def test_242_boundary_seeds_only_unchanged_three_rows(self):
        result, seed, args = self.run_fixture("venue", 1, "boundary", old242=1)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("INSERT INTO public.lnm_prepared_intent_venue_bindings", seed)
        self.assertNotIn("INSERT INTO public.lnm_prepared_intent_venue_consumptions", seed)
        self.assertNotIn("INSERT INTO public.lnm_prepared_intent_contexts", seed)
        self.assertIn("ZAPBOT_OLD_242_SEED=1", args)

    def test_243_additive_action_seeds_only_new_claim_and_reads_baselines(self):
        result, seed, args = self.run_fixture("consumption", 0)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("INSERT INTO public.lnm_prepared_intent_venue_consumptions", seed)
        self.assertNotIn("INSERT INTO public.lnm_prepared_intent_venue_bindings", seed)
        self.assertNotIn("INSERT INTO public.lnm_prepared_intent_contexts", seed)
        self.assertIn("ZAPBOT_CONSUMPTION_CAPTURE_BASELINE=0", args)
        self.assertIn("/package-venue-consumption-checker.exs", args)

    def test_boundary_refuses_active_service_before_any_seed(self):
        result, seed, args = self.run_fixture("venue", 1, "boundary", old242=1, active=1)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(seed, "")
        self.assertEqual(args, "")

    def test_consumption_cannot_overwrite_original_baselines(self):
        result, seed, args = self.run_fixture("consumption", 1)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(seed, "")
        self.assertEqual(args, "")


if __name__ == "__main__":
    unittest.main(verbosity=2)
