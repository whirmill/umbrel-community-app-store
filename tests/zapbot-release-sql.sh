#!/bin/sh
# Run the actual package exporter in an isolated filesystem, without a database.
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
docker run --rm --network none \
  -v "$repo_root/whirmill-zapbot/scripts/export-release-sql.sh:/export-release-sql.sh:ro" \
  alpine:3.22 /bin/sh -eu -c '
    source_dir=/app/lib/api-fixture/priv/sql
    mkdir -p "$source_dir"
    for sql in provision_migration_roles.sql bootstrap_database_roles.sql verify_database_roles.sql; do
      printf "SELECT 1; -- %s\n" "$sql" > "$source_dir/$sql"
    done

    /bin/sh /export-release-sql.sh
    test -s /release-sql/.complete
    test "$(wc -l < /release-sql/SHA256SUMS)" -eq 3
    sha256sum -c /release-sql/SHA256SUMS
    for sql in provision_migration_roles.sql bootstrap_database_roles.sql verify_database_roles.sql; do
      cmp "$source_dir/$sql" "/release-sql/$sql"
      test "$(stat -c %a "/release-sql/$sql")" = 600
    done

    # A restart replaces stale SQL and creates a matching new manifest.
    printf "SELECT 2;\n" > "$source_dir/provision_migration_roles.sql"
    /bin/sh /export-release-sql.sh
    cmp "$source_dir/provision_migration_roles.sql" /release-sql/provision_migration_roles.sql
    sha256sum -c /release-sql/SHA256SUMS

    # A consumer must reject altered material even when a marker exists.
    printf "SELECT 3;\n" >> /release-sql/bootstrap_database_roles.sql
    if sha256sum -c /release-sql/SHA256SUMS >/dev/null 2>&1; then
      echo "altered SQL passed checksum verification" >&2
      exit 1
    fi

    # A missing contract after a successful export must invalidate its marker.
    rm "$source_dir/provision_migration_roles.sql"
    if /bin/sh /export-release-sql.sh >/dev/null 2>&1; then
      echo "missing migration provisioner accepted" >&2
      exit 1
    fi
    test ! -e /release-sql/.complete
    test ! -e /release-sql/SHA256SUMS

    # Ambiguous release roots must also invalidate any stale success marker.
    mkdir -p /app/lib/api-second/priv/sql
    touch /release-sql/.complete
    if /bin/sh /export-release-sql.sh >/dev/null 2>&1; then
      echo "ambiguous release roots accepted" >&2
      exit 1
    fi
    test ! -e /release-sql/.complete
    printf "%s\n" "release_sql_export_contract=pass"
  '
