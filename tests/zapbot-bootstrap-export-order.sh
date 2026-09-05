#!/bin/sh
# Exercise the real Compose initializer/exporter with a previously absent data
# tree. No PostgreSQL server, application, external network, or live secret runs.
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
fixture_dir=$(mktemp -d "${TMPDIR:-/tmp}/zapbot-export-order.XXXXXX")
fixture_project="zapbot-export-order-$$"
export APP_DATA_DIR="$fixture_dir/app"
export APP_VERSION=export-order-fixture
export APP_SEED=export-order-fixture-only-not-a-real-secret

compose() {
  docker compose -p "$fixture_project" \
    -f "$repo_root/whirmill-zapbot/docker-compose.yml" \
    -f "$fixture_dir/compose.yml" "$@"
}

cleanup() {
  compose down --remove-orphans >/dev/null 2>&1 || true
  # The real initializer assigns 0700 directories to container UIDs. Remove
  # only this disposable fixture through the same filesystem ownership model.
  docker run --rm --network none -v "$fixture_dir:/fixture" alpine:3.22 \
    /bin/sh -eu -c 'find /fixture -mindepth 1 -maxdepth 1 -exec rm -rf {} +' \
    >/dev/null 2>&1
  rmdir "$fixture_dir"
}
trap cleanup EXIT HUP INT TERM

mkdir -p "$APP_DATA_DIR/scripts" "$fixture_dir/sql"
cp "$repo_root/whirmill-zapbot/scripts/export-release-sql.sh" "$APP_DATA_DIR/scripts/"
printf '%s\n' "$APP_VERSION" > "$APP_DATA_DIR/scripts/.package-version"
for sql in provision_migration_roles.sql bootstrap_database_roles.sql verify_database_roles.sql; do
  printf 'SELECT 1; -- %s\n' "$sql" > "$fixture_dir/sql/$sql"
done

cat > "$fixture_dir/compose.yml" <<YAML
services:
  app_proxy:
    image: alpine:3.22
  credential-init:
    network_mode: none
  release-sql-export:
    image: alpine:3.22
    network_mode: none
    volumes:
      - $fixture_dir/sql:/app/lib/api-fixture/priv/sql:ro
YAML

test ! -e "$APP_DATA_DIR/data"
# Model the previous startup race without starting the initializer. Docker
# creates the missing bind directory; the unprivileged exporter must fail.
if compose run --rm --no-deps release-sql-export >"$fixture_dir/race.log" 2>&1; then
  echo 'uninitialized exporter unexpectedly succeeded' >&2
  exit 1
fi
grep -F 'Permission denied' "$fixture_dir/race.log" >/dev/null
test ! -f "$APP_DATA_DIR/data/release-sql/.complete"

# The package dependency now runs the real initializer first, and succeeds
# against the same directory left by the failed early start.
compose run --rm release-sql-export
docker run --rm --network none --user 1000:1000 \
  -v "$APP_DATA_DIR/data/release-sql:/release-sql:ro" alpine:3.22 /bin/sh -eu -c '
    test -s /release-sql/.complete
    test "$(wc -l < /release-sql/SHA256SUMS)" -eq 3
    sha256sum -c /release-sql/SHA256SUMS
  '
compose run --rm release-sql-export
docker run --rm --network none --user 1000:1000 \
  -v "$APP_DATA_DIR/data/release-sql:/release-sql:ro" alpine:3.22 \
  test -s /release-sql/.complete
printf '%s\n' 'bootstrap_export_order_fresh_and_repeat=pass'
