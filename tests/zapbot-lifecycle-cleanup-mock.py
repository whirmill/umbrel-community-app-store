"""Pure regressions extracting the actual terminal lifecycle cleanup gate."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SOURCE = (Path(__file__).resolve().parent / 'zapbot-package-lifecycle.sh').read_text()
HELPERS = SOURCE.split('# CLEANUP_GATE_START:', 1)[1].split('# CLEANUP_GATE_END', 1)[0]
HELPERS = HELPERS[HELPERS.index('\ncleanup_docker()'):]
MOCK = r'''
set -eu
fixture_dir="$MOCK_DIR/fixture"
mkdir -p "$fixture_dir"
receipt="$MOCK_DIR/receipt"
project_base=owned
fresh_project=owned-fresh; source224_project=owned-source224
restore_project=owned-restore; ownerless234_project=owned-ownerless234
upgrade229_project=owned-upgrade229; upgrade241_project=owned-upgrade241
fresh_data=unused; source224_data=unused; restore_data=unused
ownerless234_data=unused; upgrade229_data=unused; upgrade241_data=unused
package_version=0.1.81; package_compose=unused; image=immutable
run_restore_224=1; keep_failure_fixture=0
assert_selftest=0; assert_schema_verifier_expansion=0
log() { printf '%s\n' "$*" >> "$receipt"; }
'''
DOCKER = r'''
cleanup_docker() {
  shift
  printf '%s\n' "$*" >> "$MOCK_DIR/commands"
  kind=$1; verb=$2
  shift 2
  case "$kind:$verb" in
    container:ls|network:ls|volume:ls)
      for last_arg do :; done
      case "$last_arg" in
        name=*)
          if [ -e "$MOCK_DIR/cleanup" ] && [ "$HELPER_LIST_FAIL" = 1 ]; then return 125; fi
          if [ "$PREEXISTING_HELPER" = 1 ]; then printf foreign-cleaner; fi
          if [ -e "$MOCK_DIR/cleaner" ]; then printf cleaner; fi
          return 0 ;;
      esac
      inventory_project=${last_arg#label=com.docker.compose.project=}
      if [ ! -e "$MOCK_DIR/cleanup" ] && [ "$INITIAL_FAIL" = "$kind" ]; then return 125; fi
      if [ -e "$MOCK_DIR/cleanup" ] && [ "$LIST_FAIL" = "$kind" ]; then return 125; fi
      if [ "$PREEXISTING" = "$kind" ] && [ "$inventory_project" = owned-fresh ]; then printf foreign; fi
      if [ -e "$MOCK_DIR/$inventory_project.$kind" ]; then printf '%s\n' "$inventory_project-$kind"; fi
      return 0 ;;
    compose:-p)
      cleanup_project=$1
      : > "$MOCK_DIR/cleanup"
      printf '%s\n' "$cleanup_project" >> "$MOCK_DIR/down"
      if [ "$DOWN_FAIL" = 1 ] && [ "$cleanup_project" = owned-fresh ]; then return 1; fi
      for kind in container network volume; do
        if [ "$RETAIN" != "$kind" ]; then rm -f "$MOCK_DIR/$cleanup_project.$kind"; fi
      done
      return 0 ;;
    run:--name)
      : > "$MOCK_DIR/cleaner"
      [ "$FIXTURE_FAIL" = 0 ] || return 125
      if [ "$RETAIN_FIXTURE" = 0 ]; then
        find "$fixture_dir" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
      fi
      return 0 ;;
    rm:-f)
      [ "$HELPER_RM_FAIL" = 0 ] || return 1
      if [ "$RETAIN_HELPER" = 0 ]; then rm -f "$MOCK_DIR/cleaner"; fi
      return 0 ;;
    *) printf 'unexpected mock Docker: %s:%s %s\n' "$kind" "$verb" "$*" >&2; return 64 ;;
  esac
}
'''
BODY = r'''
trap on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
guard_project_ownership
for suffix in fresh source224 restore ownerless234 upgrade229 upgrade241; do
  : > "$fixture_dir/owned-$suffix.override.yml"
  if [ "$NO_RESOURCES" = 0 ]; then
    for kind in container network volume; do : > "$MOCK_DIR/owned-$suffix.$kind"; done
  fi
done
if [ "$SIGNAL" != none ]; then kill -s "$SIGNAL" "$$"; fi
log 'package_lifecycle_body=pass'
exit "$BODY_EXIT"
'''


class LifecycleCleanup(unittest.TestCase):
    def run_case(self, expected=0, **overrides):
        with tempfile.TemporaryDirectory(prefix='zapbot-top-cleanup-mock-') as tmp:
            env = dict(os.environ, MOCK_DIR=tmp, BODY_EXIT='0', DOWN_FAIL='0', RETAIN='none',
                       LIST_FAIL='none', FIXTURE_FAIL='0', RETAIN_FIXTURE='0', HELPER_RM_FAIL='0',
                       RETAIN_HELPER='0', PREEXISTING='none', SIGNAL='none', NO_RESOURCES='0',
                       INITIAL_FAIL='none', PREEXISTING_HELPER='0', HELPER_LIST_FAIL='0')
            env.update({k: str(v) for k, v in overrides.items()})
            r = subprocess.run(['sh', '-c', MOCK + HELPERS + DOCKER + BODY], env=env,
                               capture_output=True, text=True, timeout=10)
            self.assertEqual(r.returncode, expected, r.stderr)
            log = (Path(tmp) / 'receipt').read_text()
            down = (Path(tmp) / 'down').read_text().splitlines() if (Path(tmp) / 'down').exists() else []
            commands = (Path(tmp) / 'commands').read_text()
            if expected == 0:
                self.assertIn('package_lifecycle=pass', log)
                self.assertIn('ownership=terminal_proven', log)
                self.assertFalse((Path(tmp) / 'fixture').exists())
                self.assertFalse((Path(tmp) / 'cleaner').exists())
                self.assertEqual(len(down), 6)
                self.assertLess(log.rindex('package_fixture_cleanup'), log.rindex('package_lifecycle=pass'))
            else:
                self.assertNotIn('package_lifecycle=pass', log)
                self.assertIn('package_lifecycle=failed', log)
            return log, commands, down

    def test_success_all_resources_terminal_before_pass(self):
        log, commands, _ = self.run_case()
        self.assertEqual(log.count('phase=initial'), 18)
        self.assertEqual(log.count('phase=final'), 18)
        self.assertIn('container ls --all', commands)

    def test_no_resources_still_proves_all_inventories(self):
        self.run_case(NO_RESOURCES=1)

    def test_down_failure_preserves_fixture_attempts_every_project(self):
        log, commands, down = self.run_case(1, DOWN_FAIL=1)
        self.assertEqual(len(down), 6)
        self.assertIn('down_exit=1', log)
        self.assertNotIn('run --name', commands)
        self.assertIn('fixture_exit=not_attempted', log)

    def test_each_retained_resource_prevents_fixture_deletion(self):
        for kind in ['container', 'network', 'volume']:
            with self.subTest(kind=kind):
                log, commands, down = self.run_case(1, RETAIN=kind)
                self.assertIn('state=PRESENT', log)
                self.assertEqual(len(down), 6)
                self.assertNotIn('run --name', commands)

    def test_each_unknown_inventory_prevents_fixture_deletion(self):
        for kind in ['container', 'network', 'volume']:
            with self.subTest(kind=kind):
                log, commands, down = self.run_case(1, LIST_FAIL=kind)
                self.assertIn('command_exit=125 state=UNKNOWN', log)
                self.assertEqual(len(down), 6)
                self.assertNotIn('run --name', commands)

    def test_fixture_delete_failure_cannot_pass(self):
        log, _, _ = self.run_case(1, FIXTURE_FAIL=1)
        self.assertIn('body_exit=125', log)
        self.assertIn('rmdir_exit=not_attempted', log)

    def test_fixture_rmdir_failure_cannot_pass(self):
        self.run_case(1, RETAIN_FIXTURE=1)

    def test_fixture_helper_removal_failure_or_retention_cannot_pass(self):
        self.run_case(1, HELPER_RM_FAIL=1)
        self.run_case(1, RETAIN_HELPER=1)

    def test_fixture_helper_unknown_inventory_cannot_pass(self):
        log, _, _ = self.run_case(1, HELPER_LIST_FAIL=1)
        self.assertIn('list_exit=125', log)
        self.assertIn('rmdir_exit=not_attempted', log)

    def test_actual_command_timeout_is_bounded_without_daemon(self):
        with tempfile.TemporaryDirectory(prefix='zapbot-cleanup-timeout-mock-') as tmp:
            docker = Path(tmp) / 'docker'
            docker.write_text('#!/usr/bin/env python3\nimport time\ntime.sleep(5)\n')
            docker.chmod(0o700)
            env = dict(os.environ, PATH=tmp + os.pathsep + os.environ['PATH'])
            result = subprocess.run(['sh', '-c', HELPERS + '\ncleanup_docker 1 version'],
                                    env=env, capture_output=True, text=True, timeout=3)
            self.assertEqual(result.returncode, 124)
            self.assertIn('timed out', result.stderr)

    def test_original_docker125_retained_with_successful_cleanup(self):
        log, _, down = self.run_case(125, BODY_EXIT=125)
        self.assertIn('body_exit=125 cleanup_exit=0 fixture_exit=0', log)
        self.assertEqual(len(down), 6)

    def test_original_docker125_retained_despite_cleanup_failure(self):
        log, _, down = self.run_case(125, BODY_EXIT=125, DOWN_FAIL=1)
        self.assertIn('body_exit=125 cleanup_exit=1', log)
        self.assertEqual(len(down), 6)

    def test_each_signal_preserves_original_code_and_tears_down(self):
        for sig, code in [('HUP', 129), ('INT', 130), ('TERM', 143)]:
            with self.subTest(signal=sig):
                log, _, down = self.run_case(code, SIGNAL=sig)
                self.assertIn(f'body_exit={code}', log)
                self.assertEqual(len(down), 6)

    def test_initial_unknown_inventory_refuses_ownership_and_teardown(self):
        for kind in ['container', 'network', 'volume']:
            with self.subTest(kind=kind):
                log, commands, down = self.run_case(1, INITIAL_FAIL=kind)
                self.assertIn('state=UNKNOWN', log)
                self.assertEqual(down, [])
                self.assertNotIn('run --name', commands)

    def test_preexisting_fixture_cleaner_is_never_removed(self):
        log, commands, down = self.run_case(1, PREEXISTING_HELPER=1)
        self.assertIn('package_fixture_cleaner_ownership=refused', log)
        self.assertEqual(down, [])
        self.assertNotIn('rm -f', commands)

    def test_each_unowned_preexisting_project_refuses_teardown(self):
        for kind in ['container', 'network', 'volume']:
            with self.subTest(kind=kind):
                log, commands, down = self.run_case(1, PREEXISTING=kind)
                self.assertIn('package_project_ownership=refused', log)
                self.assertEqual(down, [])
                self.assertNotIn('run --name', commands)


if __name__ == '__main__':
    unittest.main(verbosity=2)
