#!/bin/sh
set -eu

umask 077
mkdir -p /release-sql
rm -f /release-sql/.complete /release-sql/SHA256SUMS

# The release image is the authority for these reviewed SQL contracts. Refuse
# to guess, regenerate, or simplify them in the App Store package.
set -- /app/lib/api-*/priv/sql
test "$#" -eq 1 && test -d "$1" || {
  echo 'expected exactly one /app/lib/api-*/priv/sql directory in the release image' >&2
  exit 1
}

source_dir=$1

for sql in provision_migration_roles.sql bootstrap_database_roles.sql verify_database_roles.sql; do
  test -s "$source_dir/$sql" || { echo "missing reviewed release SQL: $sql" >&2; exit 1; }
  cp "$source_dir/$sql" "/release-sql/$sql"
  chmod 600 "/release-sql/$sql"
done

sha256sum /release-sql/provision_migration_roles.sql /release-sql/bootstrap_database_roles.sql /release-sql/verify_database_roles.sql > /release-sql/SHA256SUMS
sha256sum -c /release-sql/SHA256SUMS >/dev/null
printf '%s\n' 'official ZapBot release SQL exported' > /release-sql/.complete
