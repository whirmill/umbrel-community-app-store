#!/bin/sh
# Qualify an immutable ZapBot package image through the actual Compose graph.
# This creates only disposable local Docker projects and generated dummy data.
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
package_root=${ZAPBOT_PACKAGE_ROOT:-"$repo_root/whirmill-zapbot"}
package_compose="$package_root/docker-compose.yml"

: "${ZAPBOT_PACKAGE_IMAGE:?set ZAPBOT_PACKAGE_IMAGE to ghcr.io/...@sha256:<64 lowercase hex>}"
image=$ZAPBOT_PACKAGE_IMAGE
case "$image" in
  *@sha256:*) ;;
  *) echo 'ZAPBOT_PACKAGE_IMAGE must be an immutable image digest reference' >&2; exit 64 ;;
esac
if ! printf '%s' "$image" | grep -Eq '@sha256:[0-9a-f]{64}$'; then
  echo 'ZAPBOT_PACKAGE_IMAGE must end in a lowercase sha256 digest' >&2
  exit 64
fi

test -f "$package_compose"
test -x "$package_root/hooks/pre-start"
for script in export-release-sql.sh pre-bootstrap-normalize.sql runtime-env.sh recover-execution-economics-handoff.sh; do
  test -s "$package_root/scripts/$script"
done

package_version=${ZAPBOT_PACKAGE_VERSION:-$(awk -F'"' '/^version: / { print $2; exit }' "$package_root/umbrel-app.yml")}
test -n "$package_version"
: "${ZAPBOT_PACKAGE_LIFECYCLE_RECEIPT:?set ZAPBOT_PACKAGE_LIFECYCLE_RECEIPT to a new absolute log path outside the disposable fixture}"
receipt=$ZAPBOT_PACKAGE_LIFECYCLE_RECEIPT
case "$receipt" in /*) ;; *) echo 'ZAPBOT_PACKAGE_LIFECYCLE_RECEIPT must be an absolute path' >&2; exit 64 ;; esac
if [ -e "$receipt" ]; then
  echo 'ZAPBOT_PACKAGE_LIFECYCLE_RECEIPT already exists; choose a new path' >&2
  exit 64
fi
mkdir -p "$(dirname "$receipt")"
: > "$receipt"
run_restore_224=${ZAPBOT_PACKAGE_TEST_RESTORE_224:-1}
case "$run_restore_224" in 0|1) ;; *) echo 'ZAPBOT_PACKAGE_TEST_RESTORE_224 must be 0 or 1' >&2; exit 64 ;; esac
keep_failure_fixture=${ZAPBOT_PACKAGE_LIFECYCLE_KEEP_FAILURE_FIXTURE:-0}
case "$keep_failure_fixture" in 0|1) ;; *) echo 'ZAPBOT_PACKAGE_LIFECYCLE_KEEP_FAILURE_FIXTURE must be 0 or 1' >&2; exit 64 ;; esac
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
fresh_data="$fixture_dir/fresh-app"
source224_data="$fixture_dir/source224-app"
restore_data="$fixture_dir/restore-app"

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
  for script in export-release-sql.sh pre-bootstrap-normalize.sql runtime-env.sh recover-execution-economics-handoff.sh; do
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
  compose "$project" "$data_dir" exec -T whirmill-zapbot-web /bin/sh -ec '
    test -d /state && test -r /state && test -x /state
    test ! -e /state/app-enabled
    marker_count="$(find /state -maxdepth 1 -type f -name "*enabled" | wc -l | tr -d " ")"
    test "$marker_count" = 0
    ps -o comm | grep -Fx tail >/dev/null
    ! ps -o comm | grep -Eq "^(beam|beam.smp|elixir)$"
  '
  compose "$project" "$data_dir" logs whirmill-zapbot-web | \
    grep -F 'ZapBot remains fenced: create data/state/app-enabled after reviewed cutover' >/dev/null
  for service in producer-lnmarkets-candles producer-coinbase-candles producer-lnmarkets-funding producer-risk-authority-snapshot; do
    test "$(compose "$project" "$data_dir" ps --services --filter status=running | grep -Fx "$service")" = "$service"
    compose "$project" "$data_dir" exec -T "$service" /bin/sh -ec '
      test -d /state && test -r /state && test -x /state
      test ! -e /state/app-enabled
      marker_count="$(find /state -maxdepth 1 -type f -name "*enabled" | wc -l | tr -d " ")"
      test "$marker_count" = 0
      ps -o comm | grep -Fx sh >/dev/null
      ps -o comm | grep -Fx sleep >/dev/null
      ! ps -o comm | grep -Eq "^(beam|beam.smp|elixir)$"
    '
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
  compose "$project" "$data_dir" exec -T --user 999:999 whirmill-zapbot-postgres \
    /bin/sh -ec 'test -x /run/zapbot-secret && test -r /run/zapbot-secret/password && test -s /run/zapbot-secret/password'
}

assert_final_state() {
  project=$1
  data_dir=$2
  test "$(pg_query "$project" "$data_dir" 'SELECT count(*) FROM public.schema_migrations')" = '227'
  test "$(pg_query "$project" "$data_dir" "SELECT (to_regprocedure('public.validate_forward_return_label_causal_attestation()') IS NOT NULL)::text || ':' || (EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'learning_forward_return_labels_v2_causal_attestation_guard'))::text")" = 'true:true'
  compose "$project" "$data_dir" logs normalize-and-verify | grep -F 'verification_safe= t' >/dev/null
  assert_export_matches_image "$data_dir"
  assert_postgres_secret_readable "$project" "$data_dir"
  assert_fenced_services "$project" "$data_dir"
}

start_full_package() {
  project=$1
  data_dir=$2
  log "starting full fenced Compose lifecycle project=$project"
  compose "$project" "$data_dir" up --wait --wait-timeout 240 $fenced_services >>"$receipt" 2>&1
  assert_final_state "$project" "$data_dir"
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
  compose "$project" "$data_dir" up --wait --wait-timeout 240 --force-recreate --always-recreate-deps $fenced_services >>"$receipt" 2>&1
  while IFS=' ' read -r service previous_id; do
    current_id=$(one_shot_id "$project" "$data_dir" "$service")
    test -n "$current_id"
    test "$current_id" != "$previous_id"
    test "$(docker inspect -f '{{.State.Status}}:{{.State.ExitCode}}' "$current_id")" = 'exited:0'
  done < "$before_file"
  assert_final_state "$project" "$data_dir"
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

for project in "$fresh_project" "$source224_project" "$restore_project"; do
  write_override "$project"
done
assert_package_image_pins "$fresh_project" "$fresh_data"
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
