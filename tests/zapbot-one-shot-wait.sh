#!/bin/sh
# Test the lifecycle's actual wait helper with already-terminal Docker jobs.
set -eu
repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
image=$(awk '/image: ghcr.io\/whirmill\/zapbot:/ {print $2; exit}' "$repo_root/whirmill-zapbot/docker-compose.yml")
fixture=$(mktemp -d "${TMPDIR:-/tmp}/zapbot-wait.XXXXXX")
project="zapbot-wait-$$"
receipt="$fixture/receipt.log"
cleanup() {
  docker compose -p "$project" -f "$fixture/compose.yml" down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$fixture"
}
trap cleanup EXIT HUP INT TERM
cat > "$fixture/compose.yml" <<YAML
services:
  success:
    image: $image
    network_mode: none
    entrypoint: [/bin/sh, -c, "exit 0"]
  failure:
    image: $image
    network_mode: none
    entrypoint: [/bin/sh, -c, "exit 7"]
YAML
awk '/^wait_one_shot\(\) \{/ {copy=1} copy {print} copy && /^\}/ {exit}' \
  "$repo_root/tests/zapbot-package-lifecycle.sh" > "$fixture/helper.sh"
test -s "$fixture/helper.sh"
. "$fixture/helper.sh"
awk '/^run_one_shot\(\) \{/ {copy=1} copy {print} copy && /^\}/ {exit}' \
  "$repo_root/tests/zapbot-package-lifecycle.sh" > "$fixture/run-one-shot.sh"
test -s "$fixture/run-one-shot.sh"
. "$fixture/run-one-shot.sh"
compose() {
  shift 2
  docker compose -p "$project" -f "$fixture/compose.yml" "$@"
}
compose "$project" "$fixture" up -d success failure
success_id=$(compose "$project" "$fixture" ps -aq success)
failure_id=$(compose "$project" "$fixture" ps -aq failure)
# Complete both before entering the helper, deterministically covering the race.
test "$(docker wait "$success_id")" = 0
test "$(docker wait "$failure_id")" = 7
wait_one_shot "$project" "$fixture" success
printf '%s\n' already_exited_zero=pass
if wait_one_shot "$project" "$fixture" failure; then
  echo 'helper accepted container exit 7' >&2; exit 1
fi
printf '%s\n' already_exited_nonzero_rejected=pass
# Return malformed/ambiguous selectors while retaining the real Docker wait.
compose() { printf '%s\n' "$selected_ids"; }
selected_ids='not-a-container-id'
if wait_one_shot "$project" "$fixture" ignored; then exit 1; else test "$?" -eq 64; fi
selected_ids="$success_id
$failure_id"
if wait_one_shot "$project" "$fixture" ignored; then exit 1; else test "$?" -eq 64; fi
selected_ids=''
if wait_one_shot "$project" "$fixture" ignored; then exit 1; else test "$?" -eq 64; fi
printf '%s\n' invalid_empty_multiple_ids_rejected=pass
# A syntactically valid but absent ID must propagate Docker's CLI failure.
selected_ids=$(printf '%064d' 0)
if wait_one_shot "$project" "$fixture" ignored; then exit 1; fi
printf '%s\n' missing_container_cli_error_rejected=pass
# A conditional caller disables implicit set-e inside functions. An up failure
# must retain its status and never accept a previous successful container.
log() { :; }
compose() {
  shift 2
  case "$1" in
    up) return 17 ;;
    ps) : > "$fixture/unexpected-wait"; printf '%s\n' "$success_id" ;;
    *) return 64 ;;
  esac
}
if run_one_shot "$project" "$fixture" success; then
  echo 'conditional run_one_shot masked compose up failure' >&2; exit 1
else
  test "$?" -eq 17
fi
test ! -e "$fixture/unexpected-wait"
printf '%s\n' conditional_startup_failure_preserved_without_wait=pass
cat "$receipt"
printf '%s\n' one_shot_wait_contract=pass
