#!/bin/sh
set -eu

# The release image is the authority for these reviewed SQL contracts. Refuse
# to guess, regenerate, or simplify them in the App Store package.
set -- /app/lib/api-*/priv/sql
test "$#" -eq 1 && test -d "$1" || {
  echo 'expected exactly one /app/lib/api-*/priv/sql directory in the release image' >&2
  exit 1
}

source_dir=$1
umask 077
mkdir -p /release-sql
rm -f /release-sql/bootstrap_database_roles.sql /release-sql/verify_database_roles.sql /release-sql/.complete

for sql in bootstrap_database_roles.sql verify_database_roles.sql; do
  test -s "$source_dir/$sql" || { echo "missing reviewed release SQL: $sql" >&2; exit 1; }
  cp "$source_dir/$sql" "/release-sql/$sql"
  chmod 600 "/release-sql/$sql"
done

sha256sum /release-sql/bootstrap_database_roles.sql /release-sql/verify_database_roles.sql > /release-sql/SHA256SUMS
printf '%s\n' 'official ZapBot release SQL exported' > /release-sql/.complete
