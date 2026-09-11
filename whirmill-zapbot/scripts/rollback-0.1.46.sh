#!/bin/sh
# Run only after reviewing a 0.1.51 rollback. This is a compatibility rollback:
# it retains schema 230 and all account-identity evidence, and never downgrades
# the database or changes persisted authority settings. It requires the fenced
# 0.1.51 package graph to have completed first; it never initializes credentials
# or starts bootstrap dependencies.
set -eu

package_version=0.1.51
legacy_image='ghcr.io/whirmill/zapbot:umbrel-h4-policy-admission-m1c-b78caf4f292b1de6e7bccf0582616e37a5b928e1@sha256:35afe57a35f8ded8e8618ff6e6b7cabc7e17ca6c1867efd5125fdf78a222a68e'
current_image='ghcr.io/whirmill/zapbot:umbrel-comparison-cursor-f9c217a4016c695b46998b69a5905b2c12579596@sha256:5af8e5a919ca11a4d2b0b1545cf6655bdcffcb71f4c475555063e56953f630b7'

: "${APP_DATA_DIR:?APP_DATA_DIR is required}"
: "${ZAPBOT_PACKAGE_COMPOSE:?ZAPBOT_PACKAGE_COMPOSE must name the installed docker-compose.yml}"

case "$APP_DATA_DIR" in /*) ;; *) echo 'APP_DATA_DIR must be absolute' >&2; exit 64 ;; esac
case "$ZAPBOT_PACKAGE_COMPOSE" in /*) ;; *) echo 'ZAPBOT_PACKAGE_COMPOSE must be absolute' >&2; exit 64 ;; esac

package_dir=$(CDPATH= cd -- "$(dirname -- "$ZAPBOT_PACKAGE_COMPOSE")" && pwd)
rollback_compose="$package_dir/docker-compose.rollback-0.1.46.yml"
version_file="$APP_DATA_DIR/scripts/.package-version"
compose_validation_override=$(mktemp "${TMPDIR:-/tmp}/zapbot-rollback-compose.XXXXXX")
trap 'rm -f "$compose_validation_override"' EXIT HUP INT TERM

# Umbrel injects app_proxy when it starts the package. The standalone rollback
# targets no proxy service, but Compose still validates every declared service.
# Supply only a transient image declaration so the installed base compose can be
# parsed without starting or changing app_proxy.
cat > "$compose_validation_override" <<'YAML'
services:
  app_proxy:
    image: alpine:3.22
YAML

test -f "$ZAPBOT_PACKAGE_COMPOSE"
test -f "$rollback_compose"
test "$(cat "$version_file" 2>/dev/null || true)" = "$package_version" || {
  echo "ZapBot rollback requires installed package scripts $package_version" >&2
  exit 65
}

# Inspect the exact bind as root: a host user unable to traverse a
# mode-0700 state directory must never mistake an enabled marker for absence.
# --mount refuses a missing source; the isolated check starts no application.
docker run --rm --network none --read-only --user 0:0 \
  --mount "type=bind,src=$APP_DATA_DIR/data/state,dst=/state,readonly" \
  --entrypoint /bin/sh "$current_image" -ec '
    test -d /state && test -r /state && test -x /state || {
      echo "rollback state directory is not accessible" >&2
      exit 66
    }
    for marker in app-enabled producer-lnmarkets-candles-enabled producer-coinbase-candles-enabled producer-lnmarkets-funding-enabled producer-risk-authority-snapshot-enabled; do
      test ! -e "/state/$marker" || {
        echo "refusing compatibility rollback while $marker is enabled" >&2
        exit 66
      }
    done
  '

compose() {
  # Define the unused interpolation as empty so Compose does not request a
  # seed. If a future change accidentally starts credential-init, its own
  # minimum-length guard fails rather than deriving replacement credentials.
  APP_SEED= APP_VERSION="$package_version" docker compose \
    -f "$ZAPBOT_PACKAGE_COMPOSE" \
    -f "$rollback_compose" \
    -f "$compose_validation_override" "$@"
}

verify_schema() {
  compose exec -T whirmill-zapbot-postgres /bin/sh -ec '
    export PGPASSWORD="$(cat /run/zapbot-secret/password)"
    psql -X -qAt -v ON_ERROR_STOP=1 -U postgres -d zapbot -c "
      SELECT CASE WHEN
        (SELECT count(*) FROM public.schema_migrations) = 230
        AND (SELECT max(version) FROM public.schema_migrations) = 20260910100000
        AND to_regclass(\$\$public.lnmarkets_account_scope_bindings\$\$) IS NOT NULL
        AND to_regclass(\$\$public.lnmarkets_account_identity_observations\$\$) IS NOT NULL
        AND to_regprocedure(\$\$public.record_lnmarkets_account_identity_observation(text,text,text,text,timestamp with time zone)\$\$) IS NOT NULL
        AND to_regprocedure(\$\$public.lnmarkets_account_identity_status(text)\$\$) IS NOT NULL
        AND (SELECT count(*) FROM pg_trigger WHERE tgname IN (\$\$lnmarkets_account_scope_bindings_immutable\$\$, \$\$lnmarkets_account_scope_bindings_truncate_guard\$\$, \$\$lnmarkets_account_identity_observations_immutable\$\$, \$\$lnmarkets_account_identity_observations_truncate_guard\$\$) AND tgenabled = \$\$A\$\$) = 4
      THEN \$\$rollback_schema_contract=pass\$\$ ELSE \$\$rollback_schema_contract=fail\$\$ END"
  ' | grep -Fx rollback_schema_contract=pass
}

verify_images() {
  for service in whirmill-zapbot-web producer-lnmarkets-candles producer-coinbase-candles producer-lnmarkets-funding producer-risk-authority-snapshot; do
    image=$(compose ps -q "$service" | xargs docker inspect -f '{{.Config.Image}}')
    test "$image" = "$legacy_image" || { echo "unexpected rollback image for $service" >&2; exit 67; }
  done

  for service in release-sql-export migrate; do
    image=$(compose ps -aq "$service" | tail -n 1 | xargs docker inspect -f '{{.Config.Image}}')
    test "$image" = "$current_image" || { echo "unexpected 0.1.51 release image for $service" >&2; exit 67; }
  done
}

replacement_services=''

legacy_service_is_fenced() {
  service=$1
  expected_process=$2
  compose exec -T "$service" /bin/sh -ec "
    ps -o comm | grep -Fx $expected_process >/dev/null
    ! ps -o comm | grep -Eq '^(beam|beam.smp|elixir)$'
  "
}

classify_runtime() {
  for service in whirmill-zapbot-web producer-lnmarkets-candles producer-coinbase-candles producer-lnmarkets-funding producer-risk-authority-snapshot; do
    # Inspect exited containers too: a partial failure may leave the correct
    # immutable image present but stopped, and a retry must re-fence it.
    service_id=$(compose ps -aq "$service" | tail -n 1)
    test -n "$service_id" || { echo "missing rollback target service: $service" >&2; exit 67; }
    image=$(docker inspect -f '{{.Config.Image}}' "$service_id")
    state=$(docker inspect -f '{{.State.Status}}' "$service_id")
    case "$service" in
      whirmill-zapbot-web) expected_process=tail ;;
      *) expected_process=sleep ;;
    esac
    case "$image" in
      "$current_image") replacement_services="$replacement_services $service" ;;
      "$legacy_image")
        # Preserve a prior successful rollback only when it is still running
        # the package's idle process. Any exited or unsafe legacy container is
        # an interrupted rollback and is recreated from the fenced overlay.
        if [ "$state" != running ] || ! legacy_service_is_fenced "$service" "$expected_process"; then
          replacement_services="$replacement_services $service"
        fi
        ;;
      *)
        echo "rollback rejects unrecognized target image for $service: $image" >&2
        exit 67
        ;;
    esac
  done

  for service in release-sql-export migrate normalize-and-verify; do
    service_id=$(compose ps -aq "$service" | tail -n 1)
    test -n "$service_id" || { echo "missing completed 0.1.51 bootstrap service: $service" >&2; exit 67; }
    test "$(docker inspect -f '{{.State.Status}}:{{.State.ExitCode}}' "$service_id")" = 'exited:0' || {
      echo "rollback requires completed 0.1.51 bootstrap service: $service" >&2
      exit 67
    }
  done

  for service in release-sql-export migrate; do
    service_id=$(compose ps -aq "$service" | tail -n 1)
    test "$(docker inspect -f '{{.Config.Image}}' "$service_id")" = "$current_image" || {
      echo "rollback requires current 0.1.51 release image for $service" >&2
      exit 67
    }
  done
}

await_fenced_health() {
  service=$1
  service_id=$(compose ps -q "$service")
  test -n "$service_id"
  health_deadline=$(( $(date +%s) + 120 ))
  while :; do
    service_state=$(docker inspect -f '{{.State.Status}}:{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$service_id")
    case "$service_state" in
      running:healthy) break ;;
      exited:*|dead:*|*:unhealthy)
        echo "rollback service failed before health check: $service=$service_state" >&2
        exit 68
        ;;
    esac
    if [ "$(date +%s)" -ge "$health_deadline" ]; then
      echo "rollback service did not become healthy: $service=$service_state" >&2
      exit 68
    fi
    sleep 2
  done
}

verify_fenced_services() {
  await_fenced_health whirmill-zapbot-web
  compose exec -T whirmill-zapbot-web /bin/sh -ec '
    ps -o comm | grep -Fx tail >/dev/null
    ! ps -o comm | grep -Eq "^(beam|beam.smp|elixir)$"
  '

  for service in producer-lnmarkets-candles producer-coinbase-candles producer-lnmarkets-funding producer-risk-authority-snapshot; do
    await_fenced_health "$service"
    compose exec -T "$service" /bin/sh -ec '
      ps -o comm | grep -Fx sleep >/dev/null
      ! ps -o comm | grep -Eq "^(beam|beam.smp|elixir)$"
    '
  done
}

case "${1:-}" in
  --dry-run)
    compose config --quiet
    printf '%s\n' 'rollback_0_1_46_dry_run=pass'
    ;;
  '')
    compose config --quiet
    classify_runtime
    # The current package's bootstrap chain owns credentials and schema setup.
    # Recreate only targets that remain current or unsafe legacy containers.
    # --no-deps prevents a rollback from invoking credential-init or requiring
    # APP_SEED; an already-fenced all-legacy state is verification-only.
    if [ -n "$replacement_services" ]; then
      compose up -d --no-deps --force-recreate $replacement_services
    else
      printf '%s\n' 'rollback_0_1_46_verification_only=pass'
    fi
    verify_schema
    verify_images
    verify_fenced_services
    compose logs --no-color normalize-and-verify | grep -F 'verification_safe= t' >/dev/null
    printf '%s\n' 'rollback_0_1_46_compatibility=pass'
    ;;
  *)
    echo 'usage: rollback-0.1.46.sh [--dry-run]' >&2
    exit 64
    ;;
esac
