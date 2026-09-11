#!/bin/sh
# Qualify an immutable ZapBot package image through the actual Compose graph.
# This creates only disposable local Docker projects and generated dummy data.
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
package_root=${ZAPBOT_PACKAGE_ROOT:-"$repo_root/whirmill-zapbot"}
package_compose="$package_root/docker-compose.yml"
rollback_compose="$package_root/docker-compose.rollback-0.1.46.yml"

: "${ZAPBOT_PACKAGE_IMAGE:?set ZAPBOT_PACKAGE_IMAGE to ghcr.io/...@sha256:<64 lowercase hex>}"
image=$ZAPBOT_PACKAGE_IMAGE
legacy_image='ghcr.io/whirmill/zapbot:umbrel-h4-policy-admission-m1c-b78caf4f292b1de6e7bccf0582616e37a5b928e1@sha256:35afe57a35f8ded8e8618ff6e6b7cabc7e17ca6c1867efd5125fdf78a222a68e'
case "$image" in
  *@sha256:*) ;;
  *) echo 'ZAPBOT_PACKAGE_IMAGE must be an immutable image digest reference' >&2; exit 64 ;;
esac
if ! printf '%s' "$image" | grep -Eq '@sha256:[0-9a-f]{64}$'; then
  echo 'ZAPBOT_PACKAGE_IMAGE must end in a lowercase sha256 digest' >&2
  exit 64
fi

test -f "$package_compose"
test -f "$rollback_compose"
test -x "$package_root/hooks/pre-start"
for script in export-release-sql.sh pre-bootstrap-normalize.sql runtime-env.sh recover-execution-economics-handoff.sh rollback-0.1.46.sh; do
  test -s "$package_root/scripts/$script"
done

package_version=${ZAPBOT_PACKAGE_VERSION:-$(awk -F'"' '/^version: / { print $2; exit }' "$package_root/umbrel-app.yml")}
test -n "$package_version"
expected_schema_migrations_count=230
expected_schema_migrations_latest_version=20260910100000
: "${ZAPBOT_PACKAGE_LIFECYCLE_RECEIPT:?set ZAPBOT_PACKAGE_LIFECYCLE_RECEIPT to a new absolute log path outside the disposable fixture}"
receipt=$ZAPBOT_PACKAGE_LIFECYCLE_RECEIPT
case "$receipt" in /*) ;; *) echo 'ZAPBOT_PACKAGE_LIFECYCLE_RECEIPT must be an absolute path' >&2; exit 64 ;; esac
if [ -e "$receipt" ]; then
  echo 'ZAPBOT_PACKAGE_LIFECYCLE_RECEIPT already exists; choose a new path' >&2
  exit 64
fi
mkdir -p "$(dirname "$receipt")"
: > "$receipt"
run_restore_224=${ZAPBOT_PACKAGE_TEST_RESTORE_224:-0}
case "$run_restore_224" in 0|1) ;; *) echo 'ZAPBOT_PACKAGE_TEST_RESTORE_224 must be 0 or 1' >&2; exit 64 ;; esac
keep_failure_fixture=${ZAPBOT_PACKAGE_LIFECYCLE_KEEP_FAILURE_FIXTURE:-0}
case "$keep_failure_fixture" in 0|1) ;; *) echo 'ZAPBOT_PACKAGE_LIFECYCLE_KEEP_FAILURE_FIXTURE must be 0 or 1' >&2; exit 64 ;; esac
assert_selftest=${ZAPBOT_PACKAGE_LIFECYCLE_ASSERT_SELFTEST:-0}
case "$assert_selftest" in 0|1) ;; *) echo 'ZAPBOT_PACKAGE_LIFECYCLE_ASSERT_SELFTEST must be 0 or 1' >&2; exit 64 ;; esac
fenced_services='whirmill-zapbot-web producer-lnmarkets-candles producer-coinbase-candles producer-lnmarkets-funding producer-risk-authority-snapshot'

# Docker Desktop can treat an otherwise equivalent doubled slash in a bind source
# as a distinct shared path. Normalize the macOS TMPDIR trailing slash before
# Compose derives its parent and child bind mounts, then resolve symlinks once.
tmp_root=${TMPDIR:-/tmp}
tmp_root=${tmp_root%/}
fixture_dir=$(mktemp -d "$tmp_root/zapbot-package-lifecycle.XXXXXX")
fixture_dir=$(CDPATH= cd -- "$fixture_dir" && pwd -P)
project_base="zapbot-package-lifecycle-$$"
fresh_project="${project_base}-fresh"
source224_project="${project_base}-source224"
restore_project="${project_base}-restore"
upgrade229_project="${project_base}-upgrade229"
fresh_data="$fixture_dir/fresh-app"
source224_data="$fixture_dir/source224-app"
restore_data="$fixture_dir/restore-app"
upgrade229_data="$fixture_dir/upgrade229-app"

log() {
  printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$receipt"
}

compose() {
  project=$1
  data_dir=$2
  shift 2
  APP_DATA_DIR="$data_dir" APP_VERSION="$package_version" \
    APP_SEED='zapbot-package-lifecycle-dummy-seed-not-a-secret-0001' \
    docker compose -p "$project" \
      -f "$package_compose" \
      -f "$fixture_dir/$project.override.yml" "$@"
}

compose_rollback() {
  project=$1
  data_dir=$2
  shift 2
  APP_DATA_DIR="$data_dir" APP_VERSION="$package_version" \
    APP_SEED='zapbot-package-lifecycle-dummy-seed-not-a-secret-0001' \
    docker compose -p "$project" \
      -f "$package_compose" \
      -f "$rollback_compose" \
      -f "$fixture_dir/$project.override.yml" "$@"
}

compose_legacy_migrate() {
  project=$1
  data_dir=$2
  shift 2
  APP_DATA_DIR="$data_dir" APP_VERSION="$package_version" \
    APP_SEED='zapbot-package-lifecycle-dummy-seed-not-a-secret-0001' \
    docker compose -p "$project" \
      -f "$package_compose" \
      -f "$fixture_dir/$project.override.yml" \
      -f "$fixture_dir/legacy-migrate.override.yml" "$@"
}

write_override() {
  project=$1
  cat > "$fixture_dir/$project.override.yml" <<YAML
services:
  app_proxy:
    image: alpine:3.22
  whirmill-zapbot-postgres:
    container_name: ${project}-postgres
  whirmill-zapbot-web:
    container_name: ${project}-web
YAML
}

write_legacy_migrate_override() {
  cat > "$fixture_dir/legacy-migrate.override.yml" <<YAML
services:
  migrate:
    image: ${legacy_image}
YAML
}

assert_package_image_pins() {
  project=$1
  data_dir=$2
  config_json=$(COMPOSE_PROFILES='trusted-v2-ops,execution-economics-ops' compose "$project" "$data_dir" config --format json)
  for service in \
    release-sql-export migrate whirmill-zapbot-web \
    producer-lnmarkets-candles producer-coinbase-candles producer-lnmarkets-funding producer-risk-authority-snapshot \
    trusted-v2-sealer trusted-v2-attestor trusted-v2-report-writer \
    execution-coverage-acquirer execution-economics-producer
  do
    configured_image=$(printf '%s' "$config_json" | jq -r --arg service "$service" '.services[$service].image // empty')
    test "$configured_image" = "$image"
  done
  attestor_command=$(printf '%s' "$config_json" | jq -r '.services["trusted-v2-attestor"].command | join(" ")')
  expected_digest=${image##*@}
  printf '%s\n' "$attestor_command" | grep -F "ZAPBOT_RELEASE_IMAGE_DIGEST=$expected_digest" >/dev/null
}

assert_rollback_image_split() {
  project=$1
  data_dir=$2
  config_json=$(COMPOSE_PROFILES='trusted-v2-ops,execution-economics-ops' compose_rollback "$project" "$data_dir" config --format json)
  for service in whirmill-zapbot-web producer-lnmarkets-candles producer-coinbase-candles producer-lnmarkets-funding producer-risk-authority-snapshot; do
    configured_image=$(printf '%s' "$config_json" | jq -r --arg service "$service" '.services[$service].image // empty')
    test "$configured_image" = "$legacy_image"
  done
  for service in release-sql-export migrate trusted-v2-sealer trusted-v2-attestor trusted-v2-report-writer execution-coverage-acquirer execution-economics-producer; do
    configured_image=$(printf '%s' "$config_json" | jq -r --arg service "$service" '.services[$service].image // empty')
    test "$configured_image" = "$image"
  done
}

assert_canonical_fixture_binds() {
  project=$1
  data_dir=$2
  config_json=$(compose "$project" "$data_dir" config --format json)
  printf '%s' "$config_json" | jq -r --arg fixture "$fixture_dir" '
    .services[]?.volumes[]? | select(.type == "bind") | .source // empty |
    select(startswith($fixture + "/"))
  ' | while IFS= read -r source; do
    case "$source" in
      *'//'*) echo "non-canonical fixture bind source: $source" >&2; exit 1 ;;
      "$fixture_dir"/*) ;;
      *) echo "fixture bind escapes canonical root: $source" >&2; exit 1 ;;
    esac
  done

  credential_source=$(printf '%s' "$config_json" | jq -r '.services["credential-init"].volumes[] | select(.target == "/data") | .source')
  postgres_secret_source=$(printf '%s' "$config_json" | jq -r '.services["whirmill-zapbot-postgres"].volumes[] | select(.target == "/run/zapbot-secret") | .source')
  test "$credential_source" = "$restore_data/data"
  test "$postgres_secret_source" = "$restore_data/data/secrets/postgres"
}

prepare_scripts() {
  data_dir=$1
  mkdir -p "$data_dir"
  APP_DATA_DIR="$data_dir" APP_VERSION="$package_version" \
    SCRIPT_APP_REPO_DIR="$package_root" "$package_root/hooks/pre-start"
  test "$(cat "$data_dir/scripts/.package-version")" = "$package_version"
  for script in export-release-sql.sh pre-bootstrap-normalize.sql runtime-env.sh recover-execution-economics-handoff.sh rollback-0.1.46.sh; do
    cmp "$package_root/scripts/$script" "$data_dir/scripts/$script"
  done
}

cleanup_project() {
  project=$1
  data_dir=$2
  compose "$project" "$data_dir" down --volumes --remove-orphans >/dev/null 2>&1 || true
}

capture_project_failure() {
  project=$1
  data_dir=$2
  {
    printf '\n--- failure project=%s compose status ---\n' "$project"
    compose "$project" "$data_dir" ps -a || true
    printf '\n--- failure project=%s compose logs ---\n' "$project"
    compose "$project" "$data_dir" logs --no-color || true
    for service in credential-init whirmill-zapbot-postgres; do
      container_id=$(one_shot_id "$project" "$data_dir" "$service" 2>/dev/null || true)
      test -n "$container_id" || continue
      printf '\n--- failure project=%s service=%s bind mounts ---\n' "$project" "$service"
      docker inspect -f '{{range .Mounts}}{{printf "%s <- %s rw=%v\n" .Destination .Source .RW}}{{end}}' "$container_id" || true
    done
    printf '\n--- failure project=%s generated credential paths ---\n' "$project"
    docker run --rm --network none -v "$data_dir/data:/data:ro" alpine:3.22 \
      /bin/sh -c 'ls -ld /data /data/secrets /data/secrets/postgres 2>&1; test -s /data/secrets/postgres/password; ls -li /data/secrets/postgres/password' || true
  } >>"$receipt" 2>&1
}

cleanup_projects() {
  cleanup_project "$fresh_project" "$fresh_data"
  cleanup_project "$source224_project" "$source224_data"
  cleanup_project "$restore_project" "$restore_data"
  cleanup_project "$upgrade229_project" "$upgrade229_data"
}

remove_fixture() {
  # credential-init assigns container UIDs to the generated files. This removes
  # only the fixture directory created above, including any synthetic dump.
  docker run --rm --network none -v "$fixture_dir:/fixture" alpine:3.22 \
    /bin/sh -eu -c 'find /fixture -mindepth 1 -maxdepth 1 -exec rm -rf {} +' \
    >/dev/null 2>&1 || true
  rmdir "$fixture_dir" >/dev/null 2>&1 || true
}

on_exit() {
  exit_status=$?
  trap - EXIT HUP INT TERM
  if [ "$exit_status" -ne 0 ]; then
    log "package_lifecycle=failed exit_status=$exit_status image=$image"
    capture_project_failure "$fresh_project" "$fresh_data"
    capture_project_failure "$source224_project" "$source224_data"
    capture_project_failure "$restore_project" "$restore_data"
    capture_project_failure "$upgrade229_project" "$upgrade229_data"
  fi
  cleanup_projects
  if [ "$exit_status" -eq 0 ] || [ "$keep_failure_fixture" = 0 ]; then
    remove_fixture
  else
    log "package_lifecycle_fixture_retained=$fixture_dir"
  fi
  exit "$exit_status"
}
trap on_exit EXIT
trap 'exit 130' HUP INT TERM

pg_query() {
  project=$1
  data_dir=$2
  sql=$3
  compose "$project" "$data_dir" exec -T whirmill-zapbot-postgres \
    /bin/sh -ec 'export PGPASSWORD="$(cat /run/zapbot-secret/password)"; exec psql -X -qAt -v ON_ERROR_STOP=1 -U postgres -d zapbot -c "$1"' \
    /bin/sh "$sql"
}

pg_exec() {
  project=$1
  data_dir=$2
  sql=$3
  compose "$project" "$data_dir" exec -T whirmill-zapbot-postgres \
    /bin/sh -ec 'export PGPASSWORD="$(cat /run/zapbot-secret/password)"; exec psql -X -v ON_ERROR_STOP=1 -U postgres -d zapbot -c "$1"' \
    /bin/sh "$sql" >/dev/null
}

assert_export_matches_image() {
  data_dir=$1
  # The initializer owns these paths as UID 1000 with restrictive modes.
  # Validate them as that user inside the supplied offline release image rather
  # than relying on host filesystem permissions.
  docker run --rm --network none --user 1000:1000 \
    -v "$data_dir/data/release-sql:/release-sql:ro" \
    --entrypoint /bin/sh "$image" -ec '
      set -- /app/lib/api-*/priv/sql
      test "$#" -eq 1 && test -d "$1"
      test -s /release-sql/.complete
      sha256sum -c /release-sql/SHA256SUMS
      for sql in provision_migration_roles.sql bootstrap_database_roles.sql verify_database_roles.sql; do
        test -s "$1/$sql"
        cmp "$1/$sql" "/release-sql/$sql"
      done
    '
}

assert_fenced_services() {
  project=$1
  data_dir=$2
  if ! web_fence=$(compose "$project" "$data_dir" exec -T whirmill-zapbot-web /bin/sh -ec '
    state_access=missing
    test -d /state && test -r /state && test -x /state && state_access=ready
    app_enabled=absent
    test -e /state/app-enabled && app_enabled=present
    marker_count="$(find /state -maxdepth 1 -type f -name "*enabled" | wc -l | tr -d " ")"
    processes="$(ps -o comm | tr "\n" "," | sed "s/,$//")"
    printf "state_access=%s app_enabled=%s marker_count=%s processes=%s\n" "$state_access" "$app_enabled" "$marker_count" "$processes"
    test "$state_access" = ready
    test "$app_enabled" = absent
    test "$marker_count" = 0
    printf "%s\n" "$processes" | tr "," "\n" | grep -Fx tail >/dev/null
    ! printf "%s\n" "$processes" | tr "," "\n" | grep -Eq "^(beam|beam.smp|elixir)$"
  '); then
    printf 'assert_final_state failed assertion=fenced_web expected=state_access=ready,app_enabled=absent,marker_count=0,tail_without_beam actual=%s\n' "$web_fence" >&2
    return 1
  fi
  if ! compose "$project" "$data_dir" logs whirmill-zapbot-web | \
    grep -F 'ZapBot remains fenced: create data/state/app-enabled after reviewed cutover' >/dev/null; then
    printf 'assert_final_state failed assertion=fenced_web_log expected=fenced_startup_message actual=missing\n' >&2
    return 1
  fi
  for service in producer-lnmarkets-candles producer-coinbase-candles producer-lnmarkets-funding producer-risk-authority-snapshot; do
    running_service=$(compose "$project" "$data_dir" ps --services --filter status=running | grep -Fx "$service" || true)
    if [ "$running_service" != "$service" ]; then
      printf 'assert_final_state failed assertion=fenced_producer_running expected=%s actual=%s\n' "$service" "${running_service:-absent}" >&2
      return 1
    fi
    if ! producer_fence=$(compose "$project" "$data_dir" exec -T "$service" /bin/sh -ec '
      state_access=missing
      test -d /state && test -r /state && test -x /state && state_access=ready
      app_enabled=absent
      test -e /state/app-enabled && app_enabled=present
      marker_count="$(find /state -maxdepth 1 -type f -name "*enabled" | wc -l | tr -d " ")"
      processes="$(ps -o comm | tr "\n" "," | sed "s/,$//")"
      printf "state_access=%s app_enabled=%s marker_count=%s processes=%s\n" "$state_access" "$app_enabled" "$marker_count" "$processes"
      test "$state_access" = ready
      test "$app_enabled" = absent
      test "$marker_count" = 0
      printf "%s\n" "$processes" | tr "," "\n" | grep -Fx sh >/dev/null
      printf "%s\n" "$processes" | tr "," "\n" | grep -Fx sleep >/dev/null
      ! printf "%s\n" "$processes" | tr "," "\n" | grep -Eq "^(beam|beam.smp|elixir)$"
    '); then
      printf 'assert_final_state failed assertion=fenced_producer expected=%s:state_access=ready,app_enabled=absent,marker_count=0,sh_and_sleep_without_beam actual=%s\n' "$service" "$producer_fence" >&2
      return 1
    fi
  done
  if compose "$project" "$data_dir" ps -a --services | grep -Eq '^(trusted-v2-|execution-economics-|execution-coverage-)'; then
    echo 'an opt-in trusted-v2 or execution-economics profile service was created' >&2
    exit 1
  fi
}

assert_postgres_secret_readable() {
  project=$1
  data_dir=$2
  # Test the exact PostgreSQL mount namespace as its non-root UID without
  # reading or emitting the credential. A separate Docker Desktop bind mount
  # can expose different host UID mapping semantics.
  if ! secret_access=$(compose "$project" "$data_dir" exec -T --user 999:999 whirmill-zapbot-postgres \
    /bin/sh -ec '
      directory=not_searchable
      test -x /run/zapbot-secret && directory=searchable
      password=not_readable
      test -r /run/zapbot-secret/password && password=readable
      nonempty=false
      test -s /run/zapbot-secret/password && nonempty=true
      printf "directory=%s password=%s nonempty=%s\n" "$directory" "$password" "$nonempty"
      test "$directory" = searchable && test "$password" = readable && test "$nonempty" = true
    '); then
    printf 'assert_final_state failed assertion=postgres_secret_access expected=directory=searchable,password=readable,nonempty=true actual=%s\n' "$secret_access" >&2
    return 1
  fi
}

assert_final_value() {
  assertion=$1
  expected=$2
  actual=$3
  if [ "$actual" != "$expected" ]; then
    printf 'assert_final_state failed assertion=%s expected=%s actual=%s\n' "$assertion" "$expected" "$actual" >&2
    return 1
  fi
}

assert_final_state() {
  project=$1
  data_dir=$2
  if migration_count=$(pg_query "$project" "$data_dir" 'SELECT count(*) FROM public.schema_migrations'); then :; else
    printf 'assert_final_state failed assertion=schema_migrations_count expected=%s actual=query_error\n' "$expected_schema_migrations_count" >&2
    return 1
  fi
  assert_final_value schema_migrations_count "$expected_schema_migrations_count" "$migration_count" || return 1
  if migration_latest=$(pg_query "$project" "$data_dir" 'SELECT max(version) FROM public.schema_migrations'); then :; else
    printf 'assert_final_state failed assertion=schema_migrations_latest expected=%s actual=query_error\n' "$expected_schema_migrations_latest_version" >&2
    return 1
  fi
  assert_final_value schema_migrations_latest "$expected_schema_migrations_latest_version" "$migration_latest" || return 1
  if causal_attestation=$(pg_query "$project" "$data_dir" "SELECT (to_regprocedure('public.validate_forward_return_label_causal_attestation()') IS NOT NULL)::text || ':' || (EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'learning_forward_return_labels_v2_causal_attestation_guard'))::text"); then :; else
    printf 'assert_final_state failed assertion=causal_attestation_function_and_trigger expected=true:true actual=query_error\n' >&2
    return 1
  fi
  assert_final_value causal_attestation_function_and_trigger true:true "$causal_attestation" || return 1
  if ! compose "$project" "$data_dir" logs normalize-and-verify | grep -F 'verification_safe= t' >/dev/null; then
    printf 'assert_final_state failed assertion=normalize_and_verify expected=verification_safe=t actual=missing\n' >&2
    return 1
  fi
  if ! assert_export_matches_image "$data_dir"; then
    printf 'assert_final_state failed assertion=release_sql_export expected=image_embedded_sql_matches_export actual=verification_failed\n' >&2
    return 1
  fi
  assert_postgres_secret_readable "$project" "$data_dir" || return 1
  assert_fenced_services "$project" "$data_dir" || return 1
}

await_healthy_service() {
  project=$1
  data_dir=$2
  service=$3
  timeout_seconds=$4
  deadline=$(( $(date +%s) + timeout_seconds ))

  while :; do
    container_id=$(compose "$project" "$data_dir" ps -aq "$service" | tail -n 1)
    test -n "$container_id"
    state=$(docker inspect -f '{{.State.Status}}:{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container_id")

    case "$state" in
      running:healthy) return 0 ;;
      exited:*|dead:*|*:unhealthy)
        echo "service $service failed before becoming healthy: $state" >&2
        return 1
        ;;
    esac

    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "timed out waiting for $service health: $state" >&2
      return 1
    fi

    sleep 2
  done
}

await_fenced_web_log() {
  project=$1
  data_dir=$2
  timeout_seconds=$3
  deadline=$(( $(date +%s) + timeout_seconds ))

  while :; do
    if compose "$project" "$data_dir" logs whirmill-zapbot-web | \
      grep -F 'ZapBot remains fenced: create data/state/app-enabled after reviewed cutover' >/dev/null; then
      return 0
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      printf 'assert_final_state failed assertion=fenced_web_log expected=fenced_startup_message actual=missing_after_%ss\n' "$timeout_seconds" >&2
      return 1
    fi
    sleep 1
  done
}

await_lifecycle_ready() {
  project=$1
  data_dir=$2
  await_healthy_service "$project" "$data_dir" whirmill-zapbot-postgres 240
  await_healthy_service "$project" "$data_dir" whirmill-zapbot-web 240
}

start_full_package() {
  project=$1
  data_dir=$2
  compose_up_log="$fixture_dir/$project.compose-up.log"
  log "starting full fenced Compose lifecycle project=$project"
  if compose "$project" "$data_dir" up -d $fenced_services >"$compose_up_log" 2>&1; then
    compose_up_status=0
  else
    compose_up_status=$?
  fi
  log "compose_up_returned project=$project status=$compose_up_status"
  cat "$compose_up_log" >>"$receipt"
  if [ "$compose_up_status" -ne 0 ]; then
    log "compose_up_nonzero project=$project exit_status=$compose_up_status; validating converged final state"
  fi
  if ! await_lifecycle_ready "$project" "$data_dir"; then
    log "compose_up_final_state=failed project=$project exit_status=$compose_up_status phase=health"
    return 1
  fi
  log "compose_health=pass project=$project"
  # Fenced web health is intentionally immediate before its startup message is
  # necessarily visible to Compose logs. Wait for that observable fence proof.
  if ! await_fenced_web_log "$project" "$data_dir" 30; then
    log "compose_up_final_state=failed project=$project exit_status=$compose_up_status phase=fenced_web_log"
    return 1
  fi
  log "compose_fence_log=pass project=$project"
  if ! assert_final_state "$project" "$data_dir"; then
    log "compose_up_final_state=failed project=$project exit_status=$compose_up_status phase=assert_final_state"
    return 1
  fi
  log "compose_final_state=pass project=$project"
  if [ "$compose_up_status" -ne 0 ]; then
    log "compose_up_nonzero_final_state=pass project=$project exit_status=$compose_up_status"
  fi
}

start_compatibility_rollback() {
  project=$1
  data_dir=$2
  log "starting actual installed schema-230 compatibility rollback script project=$project"
  (
    unset APP_SEED
    APP_DATA_DIR="$data_dir" \
      ZAPBOT_PACKAGE_COMPOSE="$package_compose" \
      COMPOSE_PROJECT_NAME="$project" \
      "$data_dir/scripts/rollback-0.1.46.sh"
  ) >>"$receipt" 2>&1
  await_lifecycle_ready "$project" "$data_dir"
  assert_rollback_final_state "$project" "$data_dir"
  assert_rollback_image_split "$project" "$data_dir"
  for service in whirmill-zapbot-web producer-lnmarkets-candles producer-coinbase-candles producer-lnmarkets-funding producer-risk-authority-snapshot; do
    container_id=$(compose_rollback "$project" "$data_dir" ps -q "$service")
    test -n "$container_id"
    test "$(docker inspect -f '{{.Config.Image}}' "$container_id")" = "$legacy_image"
  done
  for service in release-sql-export migrate; do
    container_id=$(compose_rollback "$project" "$data_dir" ps -aq "$service" | tail -n 1)
    test -n "$container_id"
    test "$(docker inspect -f '{{.Config.Image}}' "$container_id")" = "$image"
  done
}

run_partial_legacy_split() {
  project=$1
  data_dir=$2
  log "creating intentional partial 0.1.46 split project=$project"
  compose_rollback "$project" "$data_dir" up -d --no-deps --force-recreate \
    whirmill-zapbot-web producer-lnmarkets-candles >>"$receipt" 2>&1
  for service in whirmill-zapbot-web producer-lnmarkets-candles; do
    container_id=$(compose_rollback "$project" "$data_dir" ps -q "$service")
    test "$(docker inspect -f '{{.Config.Image}}' "$container_id")" = "$legacy_image"
  done
  for service in producer-coinbase-candles producer-lnmarkets-funding producer-risk-authority-snapshot; do
    container_id=$(compose "$project" "$data_dir" ps -q "$service")
    test "$(docker inspect -f '{{.Config.Image}}' "$container_id")" = "$image"
  done
  log 'intentional_partial_legacy_split=pass'
}

assert_rollback_fenced_services() {
  project=$1
  data_dir=$2
  for service in whirmill-zapbot-web producer-lnmarkets-candles producer-coinbase-candles producer-lnmarkets-funding producer-risk-authority-snapshot; do
    container_id=$(compose_rollback "$project" "$data_dir" ps -q "$service")
    test -n "$container_id"
    test "$(docker inspect -f '{{.State.Status}}:{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container_id")" = 'running:healthy'
    case "$service" in
      whirmill-zapbot-web) expected_process=tail ;;
      *) expected_process=sleep ;;
    esac
    compose_rollback "$project" "$data_dir" exec -T "$service" /bin/sh -ec "
      ps -o comm | grep -Fx $expected_process >/dev/null
      ! ps -o comm | grep -Eq '^(beam|beam.smp|elixir)$'
    "
  done
}

assert_rollback_final_state() {
  project=$1
  data_dir=$2
  test "$(pg_query "$project" "$data_dir" 'SELECT count(*) FROM public.schema_migrations')" = "$expected_schema_migrations_count"
  test "$(pg_query "$project" "$data_dir" 'SELECT max(version) FROM public.schema_migrations')" = "$expected_schema_migrations_latest_version"
  compose "$project" "$data_dir" logs normalize-and-verify | grep -F 'verification_safe= t' >/dev/null
  assert_export_matches_image "$data_dir"
  assert_postgres_secret_readable "$project" "$data_dir"
  assert_rollback_fenced_services "$project" "$data_dir"
}

fixture_state_marker() {
  project=$1
  data_dir=$2
  action=$3
  marker=$4
  case "$marker" in
    app-enabled|producer-lnmarkets-candles-enabled|producer-coinbase-candles-enabled|producer-lnmarkets-funding-enabled|producer-risk-authority-snapshot-enabled) ;;
    *) echo "unexpected fixture state marker: $marker" >&2; exit 64 ;;
  esac
  # The app/producers mount state read-only. Use the same root-owned bootstrap
  # service that owns fixture data initialization, with an explicit nested bind
  # to the exact APP_DATA_DIR/data/state path consumed by rollback. This avoids
  # a Compose-run data-volume resolution from producing an unobserved marker.
  compose "$project" "$data_dir" run --rm --no-deps --user 0:0 \
    --volume "$data_dir/data/state:/data/state" \
    --entrypoint /bin/sh credential-init -ec "
    case \"$action\" in
      create) : > /data/state/$marker ;;
      remove) rm -f /data/state/$marker ;;
      *) exit 64 ;;
    esac
  " >>"$receipt" 2>&1

  log "fixture_marker_written action=$action marker=$marker; verifying runtime mount"
  web_id=$(compose "$project" "$data_dir" ps -q whirmill-zapbot-web)
  test -n "$web_id"
  mounted_state=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/state"}}{{.Source}}{{end}}{{end}}' "$web_id")
  # credential-init owns data/state as mode 0700, so derive the canonical
  # expected bind source from the accessible package root without traversing
  # the protected state directory on the host runner.
  canonical_data_dir=$(CDPATH= cd -- "$data_dir" && pwd -P)
  expected_state="$canonical_data_dir/data/state"
  test "$mounted_state" = "$expected_state"
  case "$action" in
    create)
      compose "$project" "$data_dir" exec -T whirmill-zapbot-web /bin/sh -ec "test -f /state/$marker"
      ;;
    remove)
      compose "$project" "$data_dir" exec -T whirmill-zapbot-web /bin/sh -ec "test ! -e /state/$marker"
      ;;
  esac
}

assert_marker_after_rollback_stays_fenced() {
  project=$1
  data_dir=$2
  for marker in app-enabled producer-lnmarkets-candles-enabled producer-coinbase-candles-enabled producer-lnmarkets-funding-enabled producer-risk-authority-snapshot-enabled; do
    fixture_state_marker "$project" "$data_dir" create "$marker"
  done
  sleep 2
  assert_rollback_fenced_services "$project" "$data_dir"
  for marker in app-enabled producer-lnmarkets-candles-enabled producer-coinbase-candles-enabled producer-lnmarkets-funding-enabled producer-risk-authority-snapshot-enabled; do
    fixture_state_marker "$project" "$data_dir" remove "$marker"
  done
  log 'rollback_marker_after_replacement_stays_fenced=pass'
}

assert_all_legacy_retry_is_verification_only() {
  project=$1
  data_dir=$2
  ids_file="$fixture_dir/$project.legacy-ids"
  : > "$ids_file"
  for service in whirmill-zapbot-web producer-lnmarkets-candles producer-coinbase-candles producer-lnmarkets-funding producer-risk-authority-snapshot; do
    printf '%s %s\n' "$service" "$(compose_rollback "$project" "$data_dir" ps -q "$service")" >>"$ids_file"
  done
  start_compatibility_rollback "$project" "$data_dir"
  while IFS=' ' read -r service before_id; do
    test "$(compose_rollback "$project" "$data_dir" ps -q "$service")" = "$before_id"
  done < "$ids_file"
  grep -F 'rollback_0_1_46_verification_only=pass' "$receipt" >/dev/null
  log 'all_legacy_retry_verification_only=pass'
}

assert_exited_target_retry_recovers() {
  project=$1
  data_dir=$2
  service=$3
  expected_image=$4
  label=$5
  if [ "$expected_image" = "$image" ]; then
    compose "$project" "$data_dir" up -d --no-deps --force-recreate "$service" >>"$receipt" 2>&1
  fi
  container_id=$(compose_rollback "$project" "$data_dir" ps -q "$service")
  test -n "$container_id"
  test "$(docker inspect -f '{{.Config.Image}}:{{.State.Status}}' "$container_id")" = "$expected_image:running"
  docker stop "$container_id" >>"$receipt" 2>&1
  test "$(docker inspect -f '{{.Config.Image}}:{{.State.Status}}' "$container_id")" = "$expected_image:exited"
  start_compatibility_rollback "$project" "$data_dir"
  assert_identity_contract "$project" "$data_dir"
  log "$label=pass"
}

canonical_immutable_image_reference() {
  reference=$1
  case "$reference" in *@sha256:*) ;; *) return 1 ;; esac
  digest=${reference##*@}
  image_name=${reference%@sha256:*}
  case "${image_name##*/}" in *:*) repository=${image_name%:*} ;; *) repository=$image_name ;; esac
  test -n "$repository"
  printf '%s@%s\n' "$repository" "$digest"
}

container_resolves_expected_image() {
  container_id=$1
  expected_canonical=$(canonical_immutable_image_reference "$image") || return 1
  configured_image=$(docker inspect -f '{{.Config.Image}}' "$container_id") || return 1
  if configured_canonical=$(canonical_immutable_image_reference "$configured_image"); then
    test "$configured_canonical" = "$expected_canonical" && return 0
  fi
  repo_digests=$(docker inspect -f '{{range .RepoDigests}}{{println .}}{{end}}' "$container_id") || return 1
  for resolved_image in $repo_digests; do
    if resolved_canonical=$(canonical_immutable_image_reference "$resolved_image"); then
      test "$resolved_canonical" = "$expected_canonical" && return 0
    fi
  done
  printf 'current_runtime_image_mismatch container=%s expected=%s configured=%s repo_digests=%s\n' \
    "$container_id" "$expected_canonical" "$configured_image" "${repo_digests:-none}" >&2
  return 1
}

assert_current_runtime_image_split() {
  project=$1
  data_dir=$2
  for service in whirmill-zapbot-web producer-lnmarkets-candles producer-coinbase-candles producer-lnmarkets-funding producer-risk-authority-snapshot; do
    container_id=$(compose "$project" "$data_dir" ps -q "$service")
    if [ -z "$container_id" ]; then
      printf 'current_runtime_service_missing service=%s\n' "$service" >&2
      return 1
    fi
    runtime_state=$(docker inspect -f '{{.State.Status}}' "$container_id")
    if [ "$runtime_state" != running ]; then
      printf 'current_runtime_service_state service=%s expected=running actual=%s container=%s\n' "$service" "$runtime_state" "$container_id" >&2
      return 1
    fi
    container_resolves_expected_image "$container_id" || return 1
  done
  for service in release-sql-export migrate normalize-and-verify; do
    container_id=$(compose "$project" "$data_dir" ps -aq "$service" | tail -n 1)
    if [ -z "$container_id" ]; then
      printf 'current_runtime_one_shot_missing service=%s\n' "$service" >&2
      return 1
    fi
    one_shot_state=$(docker inspect -f '{{.State.Status}}:{{.State.ExitCode}}' "$container_id")
    if [ "$one_shot_state" != 'exited:0' ]; then
      printf 'current_runtime_one_shot_state service=%s expected=exited:0 actual=%s container=%s\n' "$service" "$one_shot_state" "$container_id" >&2
      return 1
    fi
  done
}

assert_installed_rollback_refuses_enabled_marker() {
  project=$1
  data_dir=$2
  fixture_state_marker "$project" "$data_dir" create app-enabled
  if (
    unset APP_SEED
    APP_DATA_DIR="$data_dir" \
      ZAPBOT_PACKAGE_COMPOSE="$package_compose" \
      COMPOSE_PROJECT_NAME="$project" \
      "$data_dir/scripts/rollback-0.1.46.sh"
  ) >"$fixture_dir/marker-refusal.log" 2>&1; then
    echo 'installed rollback accepted an enabled app marker' >&2
    exit 1
  else
    marker_refusal_status=$?
  fi
  cat "$fixture_dir/marker-refusal.log" >>"$receipt"
  test "$marker_refusal_status" = 66
  grep -Fx 'refusing compatibility rollback while app-enabled is enabled' "$fixture_dir/marker-refusal.log" >/dev/null
  fixture_state_marker "$project" "$data_dir" remove app-enabled
  assert_current_runtime_image_split "$project" "$data_dir"
  log 'installed_rollback_enabled_marker_refusal=pass'
}

record_identity_observation() {
  project=$1
  data_dir=$2
  pg_exec "$project" "$data_dir" "
    DO \$\$
    BEGIN
      SET LOCAL ROLE zapbot_runtime;
      PERFORM * FROM public.record_lnmarkets_account_identity_observation(
        'default', '00000000-0000-4000-8000-000000000147', 'lifecycle-account-0147', 'ok', clock_timestamp()
      );
    END
    \$\$
  "
}

assert_identity_contract() {
  project=$1
  data_dir=$2
  test "$(pg_query "$project" "$data_dir" "
    SELECT
      (SELECT count(*) FROM public.lnmarkets_account_scope_bindings)::text || ':' ||
      (SELECT count(*) FROM public.lnmarkets_account_identity_observations)::text || ':' ||
      (SELECT status FROM public.lnmarkets_account_identity_status('default')) || ':' ||
      (SELECT account_id FROM public.lnmarkets_account_identity_status('default')) || ':' ||
      (SELECT count(*) FROM pg_trigger WHERE tgname IN ('lnmarkets_account_scope_bindings_immutable', 'lnmarkets_account_scope_bindings_truncate_guard', 'lnmarkets_account_identity_observations_immutable', 'lnmarkets_account_identity_observations_truncate_guard') AND tgenabled = 'A')::text
  ")" = '1:1:ok:lifecycle-account-0147:4'
  test "$(pg_query "$project" "$data_dir" "SELECT has_function_privilege('zapbot_runtime', 'public.record_lnmarkets_account_identity_observation(text,text,text,text,timestamp with time zone)', 'EXECUTE')::text || ':' || has_function_privilege('zapbot_runtime', 'public.lnmarkets_account_identity_status(text)', 'EXECUTE')::text")" = 'true:true'
}

one_shot_id() {
  project=$1
  data_dir=$2
  service=$3
  compose "$project" "$data_dir" ps -aq "$service" | tail -n 1
}

run_one_shot() {
  project=$1
  data_dir=$2
  service=$3
  log "starting one-shot Compose service=$service project=$project"
  compose "$project" "$data_dir" up -d "$service" >>"$receipt" 2>&1
  compose "$project" "$data_dir" wait "$service" >>"$receipt" 2>&1
  container_id=$(one_shot_id "$project" "$data_dir" "$service")
  test -n "$container_id"
  test "$(docker inspect -f '{{.State.Status}}:{{.State.ExitCode}}' "$container_id")" = 'exited:0'
}

repeat_package() {
  project=$1
  data_dir=$2
  before_file="$fixture_dir/$project.one-shot-before"
  : > "$before_file"
  for service in credential-init postgres-tls-init release-sql-export restore restore-ownership-normalize migration-role-provision migrate normalize-and-verify; do
    container_id=$(one_shot_id "$project" "$data_dir" "$service")
    test -n "$container_id"
    printf '%s %s\n' "$service" "$container_id" >> "$before_file"
  done
  log "repeating complete fenced Compose lifecycle project=$project"
  compose "$project" "$data_dir" up -d --force-recreate --always-recreate-deps $fenced_services >>"$receipt" 2>&1
  await_lifecycle_ready "$project" "$data_dir"
  while IFS=' ' read -r service previous_id; do
    current_id=$(one_shot_id "$project" "$data_dir" "$service")
    test -n "$current_id"
    test "$current_id" != "$previous_id"
    test "$(docker inspect -f '{{.State.Status}}:{{.State.ExitCode}}' "$current_id")" = 'exited:0'
  done < "$before_file"
  assert_final_state "$project" "$data_dir"
}

assert_restore_normalizer_rejects_tampered_freeze() {
  project=$1
  data_dir=$2
  freeze_signature='public.freeze_h4_canary_frozen_budget(text,text,bigint,text,jsonb)'

  pg_exec "$project" "$data_dir" "ALTER FUNCTION $freeze_signature SET search_path TO pg_catalog"
  if compose "$project" "$data_dir" run --rm --no-deps restore-ownership-normalize >>"$receipt" 2>&1; then
    echo 'restore normalizer accepted the freeze function with an altered search_path' >&2
    exit 1
  fi

  pg_exec "$project" "$data_dir" "ALTER FUNCTION $freeze_signature SET search_path TO pg_catalog, public"
  pg_exec "$project" "$data_dir" '
    CREATE OR REPLACE FUNCTION public.freeze_h4_canary_frozen_budget(
      p_account_id text, p_budget_epoch text, p_frozen_capital_sats bigint,
      p_idempotency_key text, p_baseline_evidence jsonb
    ) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $freeze$
    BEGIN
      RETURN NULL;
    END
    $freeze$
  '
  if compose "$project" "$data_dir" run --rm --no-deps restore-ownership-normalize >>"$receipt" 2>&1; then
    echo 'restore normalizer accepted the freeze function with an altered body' >&2
    exit 1
  fi

  log 'restore_normalizer_freeze_tamper_rejection=pass'
}

migrate_source_to_224() {
  project=$1
  data_dir=$2
  log "migrating clean package source only to schema ledger 20260901121000"
  compose "$project" "$data_dir" run --rm --no-deps migrate /bin/sh -ec '
    runtime_password="$(cat /run/zapbot-runtime-secret/password)"
    migrator_password="$(cat /run/zapbot-migrator-secret/password)"
    export DATABASE_URL="postgresql://zapbot_runtime:${runtime_password}@whirmill-zapbot-postgres:5432/zapbot"
    export MIGRATION_DATABASE_URL="postgresql://zapbot_migrator:${migrator_password}@whirmill-zapbot-postgres:5432/zapbot"
    export SECRET_KEY_BASE="$(cat /run/zapbot-migrator-secret/secret-key-base)"
    export SIGNING_SALT="$(cat /run/zapbot-migrator-secret/signing-salt)"
    export AUTH_TOKEN_SALT="$(cat /run/zapbot-migrator-secret/auth-token-salt)"
    exec bin/zapbot eval '\''Application.load(:api); role = Zapbot.Release.DatabaseRoleAfterConnect.release_role!(System.get_env()); {:ok, _, _} = Ecto.Migrator.with_repo(Zapbot.MigrationRepo, fn repo -> Zapbot.Release.DatabaseRoleAfterConnect.run_migration!(repo, :up, [to: 20_260_901_121_000, prefix: "public"], role) end)'\''
  ' >>"$receipt" 2>&1
}

migrate_source_to_229() {
  project=$1
  data_dir=$2
  log 'migrating clean package source only to schema ledger 20260909100000 with the immutable 0.1.46 image'
  compose_legacy_migrate "$project" "$data_dir" run --rm --no-deps migrate >>"$receipt" 2>&1
}

run_assert_final_state_negative_selftests() {
  selftest_case=ok
  expected_canonical=$(canonical_immutable_image_reference "$image")
  expected_digest=${image##*@}
  expected_repository=${expected_canonical%@*}
  test "$(canonical_immutable_image_reference "$image")" = "$expected_canonical"
  test "$(canonical_immutable_image_reference "$expected_repository@$expected_digest")" = "$expected_canonical"
  if canonical_immutable_image_reference "${image%@sha256:*}" >/dev/null; then
    echo 'runtime image reference selftest accepted a mutable tag' >&2
    return 1
  fi
  test "$(canonical_immutable_image_reference "$expected_repository@sha256:0000000000000000000000000000000000000000000000000000000000000000")" != "$expected_canonical"
  log 'runtime_image_reference_selftest=pass'

  pg_query() {
    case "$3" in
      *'count(*) FROM public.schema_migrations'*)
        case "$selftest_case" in migration_count) printf '229\n' ;; *) printf '%s\n' "$expected_schema_migrations_count" ;; esac
        ;;
      *'max(version) FROM public.schema_migrations'*)
        case "$selftest_case" in migration_latest) printf '20260909100000\n' ;; *) printf '%s\n' "$expected_schema_migrations_latest_version" ;; esac
        ;;
      *'to_regprocedure'*)
        case "$selftest_case" in causal_attestation) printf 'false:true\n' ;; *) printf 'true:true\n' ;; esac
        ;;
      *) return 64 ;;
    esac
  }
  compose() {
    project=$1
    data_dir=$2
    shift 2
    case "$1" in
      up) printf 'selftest compose up\n' ;;
      ps) printf 'selftest-container\n' ;;
      logs) printf 'verification_safe= t\nZapBot remains fenced: create data/state/app-enabled after reviewed cutover\n' ;;
      *) return 64 ;;
    esac
  }
  docker() {
    case "$1" in inspect) printf 'running:healthy\n' ;; *) command docker "$@" ;; esac
  }
  assert_export_matches_image() { return 0; }
  assert_postgres_secret_readable() {
    case "$selftest_case" in postgres_secret) return 1 ;; *) return 0 ;; esac
  }
  assert_fenced_services() { return 0; }

  for selftest_case in migration_count migration_latest causal_attestation postgres_secret; do
    if assert_final_state selftest "$fixture_dir/selftest"; then
      printf 'assert_final_state negative selftest unexpectedly passed case=%s\n' "$selftest_case" >&2
      return 1
    fi
    log "assert_final_state_negative_case=$selftest_case result=nonzero"
  done

  selftest_case=migration_count
  if start_full_package selftest "$fixture_dir/selftest"; then
    echo 'start_full_package negative selftest unexpectedly passed' >&2
    return 1
  fi
  if ! grep -F 'compose_up_final_state=failed project=selftest exit_status=0 phase=assert_final_state' "$receipt" >/dev/null; then
    echo 'start_full_package negative selftest did not record assert_final_state phase' >&2
    return 1
  fi
  log 'assert_final_state_negative_selftests=pass'
}

if [ "$assert_selftest" = 1 ]; then
  run_assert_final_state_negative_selftests
  cat "$receipt"
  exit 0
fi

for project in "$fresh_project" "$source224_project" "$restore_project" "$upgrade229_project"; do
  write_override "$project"
done
write_legacy_migrate_override
assert_package_image_pins "$fresh_project" "$fresh_data"
assert_rollback_image_split "$upgrade229_project" "$upgrade229_data"
assert_canonical_fixture_binds "$restore_project" "$restore_data"

# Pull exactly the supplied digest before creating any containers. A mutable tag
# is rejected above and the image is used for exporter, migration, and web.
log "pulling immutable image=$image"
docker pull "$image" >>"$receipt" 2>&1

prepare_scripts "$fresh_data"
start_full_package "$fresh_project" "$fresh_data"
pg_exec "$fresh_project" "$fresh_data" "INSERT INTO public.internal_settings (key, value, inserted_at, updated_at) VALUES ('package_lifecycle_sentinel', 'enabled', clock_timestamp(), clock_timestamp()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at"
repeat_package "$fresh_project" "$fresh_data"
test "$(pg_query "$fresh_project" "$fresh_data" "SELECT value FROM public.internal_settings WHERE key = 'package_lifecycle_sentinel'")" = 'enabled'
assert_restore_normalizer_rejects_tampered_freeze "$fresh_project" "$fresh_data"

# This is an upgrade without any restore dump: create schema 229 using the
# immutable 0.1.46 release, advance it with 0.1.49, write an identity receipt
# through the runtime grant, then run only the old long-lived services.
prepare_scripts "$upgrade229_data"
log 'starting current release/bootstrap chain before the 229-to-230 compatibility upgrade'
run_one_shot "$upgrade229_project" "$upgrade229_data" migration-role-provision
migrate_source_to_229 "$upgrade229_project" "$upgrade229_data"
test "$(pg_query "$upgrade229_project" "$upgrade229_data" 'SELECT count(*) FROM public.schema_migrations')" = '229'
test "$(pg_query "$upgrade229_project" "$upgrade229_data" 'SELECT max(version) FROM public.schema_migrations')" = '20260909100000'
log 'advancing the populated 229 schema to 230 with the immutable 0.1.49 migration image'
compose "$upgrade229_project" "$upgrade229_data" run --rm --no-deps migrate >>"$receipt" 2>&1
test "$(pg_query "$upgrade229_project" "$upgrade229_data" 'SELECT count(*) FROM public.schema_migrations')" = "$expected_schema_migrations_count"
test "$(pg_query "$upgrade229_project" "$upgrade229_data" 'SELECT max(version) FROM public.schema_migrations')" = "$expected_schema_migrations_latest_version"
run_one_shot "$upgrade229_project" "$upgrade229_data" normalize-and-verify
record_identity_observation "$upgrade229_project" "$upgrade229_data"
assert_identity_contract "$upgrade229_project" "$upgrade229_data"
start_full_package "$upgrade229_project" "$upgrade229_data"
assert_current_runtime_image_split "$upgrade229_project" "$upgrade229_data"
log current_runtime_image_split=pass
assert_installed_rollback_refuses_enabled_marker "$upgrade229_project" "$upgrade229_data"
run_partial_legacy_split "$upgrade229_project" "$upgrade229_data"
start_compatibility_rollback "$upgrade229_project" "$upgrade229_data"
assert_identity_contract "$upgrade229_project" "$upgrade229_data"
assert_marker_after_rollback_stays_fenced "$upgrade229_project" "$upgrade229_data"
assert_all_legacy_retry_is_verification_only "$upgrade229_project" "$upgrade229_data"
assert_exited_target_retry_recovers "$upgrade229_project" "$upgrade229_data" producer-coinbase-candles "$image" exited_current_target_retry_recovers
assert_exited_target_retry_recovers "$upgrade229_project" "$upgrade229_data" whirmill-zapbot-web "$legacy_image" exited_legacy_target_retry_recovers
log 'schema_230_populated_identity_0_1_46_compatibility_rollback=pass'

if [ "$run_restore_224" = 1 ]; then
  prepare_scripts "$source224_data"
  log "starting package graph through migration-role provisioning for faithful 224 source"
  run_one_shot "$source224_project" "$source224_data" migration-role-provision
  migrate_source_to_224 "$source224_project" "$source224_data"
  test "$(pg_query "$source224_project" "$source224_data" 'SELECT max(version) FROM public.schema_migrations')" = '20260901121000'
  test "$(pg_query "$source224_project" "$source224_data" "SELECT (to_regprocedure('public.validate_forward_return_label_causal_attestation()') IS NULL)::text || ':' || (NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'learning_forward_return_labels_v2_causal_attestation_guard'))::text")" = 'true:true'
  pg_exec "$source224_project" "$source224_data" "INSERT INTO public.internal_settings (key, value, inserted_at, updated_at) VALUES ('package_restore_224_sentinel', 'enabled', clock_timestamp(), clock_timestamp()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at"
  dump_path="$fixture_dir/zapbot-224.dump"
  compose "$source224_project" "$source224_data" exec -T whirmill-zapbot-postgres \
    /bin/sh -ec 'export PGPASSWORD="$(cat /run/zapbot-secret/password)"; exec pg_dump -U postgres -d zapbot -Fc' \
    >"$dump_path"
  test -s "$dump_path"

  prepare_scripts "$restore_data"
  mkdir -p "$restore_data/data/import"
  cp "$dump_path" "$restore_data/data/import/zapbot.dump"
  log 'starting full default package graph with faithful 224 custom dump'
  start_full_package "$restore_project" "$restore_data"
  test "$(pg_query "$restore_project" "$restore_data" "SELECT value FROM public.internal_settings WHERE key = 'package_restore_224_sentinel'")" = 'enabled'
  repeat_package "$restore_project" "$restore_data"
  test "$(pg_query "$restore_project" "$restore_data" "SELECT value FROM public.internal_settings WHERE key = 'package_restore_224_sentinel'")" = 'enabled'
fi

log "package_lifecycle=pass image=$image version=$package_version restore_224=$run_restore_224"
# Leave the full receipt available for the caller before trap cleanup removes
# only generated local containers, temporary data, and synthetic dump.
cat "$receipt"
