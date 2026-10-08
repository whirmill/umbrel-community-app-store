#!/bin/sh
# Disposable, single-attempt PostgreSQL package startup probe. Never use app data.
set -eu

package_root=$(CDPATH= cd -- "$(dirname "$0")/../whirmill-zapbot" && pwd -P)
receipt_dir=${1:?pass a private receipt directory}
storage=${2:?pass bind or named}
case "$storage" in bind|named) ;; *) echo 'storage must be bind or named' >&2; exit 64 ;; esac
test "$#" -eq 2 || { echo 'expected exactly RECEIPT_DIR bind|named' >&2; exit 64; }
command -v docker >/dev/null
command -v jq >/dev/null
command -v python3 >/dev/null
test ! -e "$receipt_dir" || { echo 'receipt directory must be new' >&2; exit 64; }
mkdir -p "$receipt_dir"
receipt_dir=$(CDPATH= cd -- "$receipt_dir" && pwd -P)
fixture_dir=$(mktemp -d "${TMPDIR:-/tmp}/zapbot-pg-startup.XXXXXX")
fixture_dir=$(CDPATH= cd -- "$fixture_dir" && pwd -P)
project="zapbot-pg-probe-$$"
app_dir="$fixture_dir/app"
version=$(awk -F'"' '/^version: / { print $2; exit }' "$package_root/umbrel-app.yml")
export APP_DATA_DIR="$app_dir" APP_VERSION="$version"
APP_SEED='zapbot-package-lifecycle-dummy-seed-not-a-secret-0001'
export APP_SEED

compose() {
  docker compose -p "$project" -f "$package_root/docker-compose.yml" -f "$fixture_dir/override.yml" "$@"
}

cleanup() {
  result=$?
  trap - EXIT INT TERM
  compose logs --no-color credential-init postgres-tls-init whirmill-zapbot-postgres > "$receipt_dir/compose.log" 2>&1 || true
  compose ps -a > "$receipt_dir/compose-ps.txt" 2>&1 || true
  : > "$receipt_dir/volumes-used.txt"
  if [ "$storage" = named ]; then
    printf '%s\n' "${project}-pgdata" >> "$receipt_dir/volumes-used.txt"
  fi
  for service in credential-init postgres-tls-init whirmill-zapbot-postgres; do
    id=$(compose ps -aq "$service" | tail -n 1)
    test -n "$id" || continue
    docker inspect -f '{{.Name}} state={{.State.Status}} exit={{.State.ExitCode}} restart={{.RestartCount}} started={{.State.StartedAt}} finished={{.State.FinishedAt}}{{range .Mounts}}{{printf "\n%s <- %s type=%s rw=%v" .Destination .Source .Type .RW}}{{end}}' "$id" >> "$receipt_dir/inspect.txt" 2>&1 || true
    docker inspect -f '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}}{{"\n"}}{{end}}{{end}}' "$id" >> "$receipt_dir/volumes-used.txt" 2>> "$receipt_dir/cleanup.log" || true
  done
  if compose down --volumes --remove-orphans > "$receipt_dir/cleanup.log" 2>&1; then
    down_ok=1
  else
    down_ok=0
  fi
  if remaining_containers=$(docker ps -aq --filter "label=com.docker.compose.project=$project" 2>> "$receipt_dir/cleanup.log"); then
    container_check_ok=1
  else
    container_check_ok=0
  fi
  if all_volumes=$(docker volume ls -q 2>> "$receipt_dir/cleanup.log"); then
    volume_check_ok=1
    remaining_volume=''
    for used_volume in $(sort -u "$receipt_dir/volumes-used.txt"); do
      if printf '%s\n' "$all_volumes" | grep -Fx "$used_volume" >/dev/null; then
        remaining_volume="$remaining_volume $used_volume"
      fi
    done
  else
    volume_check_ok=0
    remaining_volume=unknown
  fi
  if [ "$down_ok" = 1 ] && [ "$container_check_ok" = 1 ] && [ "$volume_check_ok" = 1 ] && [ -z "$remaining_containers" ] && [ -z "$remaining_volume" ]; then
    printf 'cleanup=pass\n' >> "$receipt_dir/startup-probe.log"
  else
    printf 'cleanup=failed down_ok=%s container_check_ok=%s volume_check_ok=%s remaining_containers=%s remaining_volume=%s\n' "$down_ok" "$container_check_ok" "$volume_check_ok" "$remaining_containers" "$remaining_volume" >> "$receipt_dir/startup-probe.log"
    result=1
  fi
  if [ "$result" -eq 0 ]; then
    if ! docker run --rm --network none -v "$fixture_dir:/fixture" alpine:3.22 /bin/sh -ec 'rm -rf /fixture/*' >> "$receipt_dir/cleanup.log" 2>&1 || ! rmdir "$fixture_dir" >> "$receipt_dir/cleanup.log" 2>&1; then
      printf 'fixture_cleanup=failed fixture=%s\n' "$fixture_dir" >> "$receipt_dir/startup-probe.log"
      result=1
    fi
  else
    printf 'fixture_retained=%s\n' "$fixture_dir" >> "$receipt_dir/startup-probe.log"
  fi
  printf 'probe_exit=%s\n' "$result" >> "$receipt_dir/startup-probe.log"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

mkdir -p "$fixture_dir/probe-bin"
cat > "$fixture_dir/override.yml" <<YAML
services:
  app_proxy:
    image: alpine:3.22
  whirmill-zapbot-postgres:
    container_name: ${project}-postgres
    environment:
      PATH: /probe-bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/lib/postgresql/18/bin
    volumes:
      - ${fixture_dir}/probe-bin:/probe-bin:ro
YAML

if [ "$storage" = named ]; then
  cat >> "$fixture_dir/override.yml" <<YAML
      - pg_probe_data:/var/lib/postgresql/data
  credential-init:
    volumes:
      - pg_probe_data:/data/postgres
volumes:
  pg_probe_data:
    name: ${project}-pgdata
YAML
fi

cat > "$fixture_dir/probe-bin/pg_ctl" <<'SH'
#!/bin/sh
set -eu
phase=unknown
for argument do
  case "$argument" in start|stop) phase=$argument ;; esac
done
ownership=$(stat -c '%d:%i %u:%g %a' /var/lib/postgresql/data/pgdata)
set -- "$phase" "$ownership" "$@"
printf 'PGCTL_PROBE phase=%s caller=%s:%s pgdata=%s\n' "$1" "$(id -u)" "$(id -g)" "$2"
shift 2
exec /usr/lib/postgresql/18/bin/pg_ctl "$@"
SH
chmod 755 "$fixture_dir/probe-bin/pg_ctl"

printf 'project=%s fixture=%s storage=%s\n' "$project" "$fixture_dir" "$storage" > "$receipt_dir/startup-probe.log"
compose config --format json | jq -e --arg project "$project" '{project:$project, expected_named_volume:.volumes.pg_probe_data.name, postgres_image:.services["whirmill-zapbot-postgres"].image, credential_image:.services["credential-init"].image, tls_image:.services["postgres-tls-init"].image, pgdata:.services["whirmill-zapbot-postgres"].environment.PGDATA, postgres_environment:(.services["whirmill-zapbot-postgres"].environment | {POSTGRES_DB,POSTGRES_USER,POSTGRES_PASSWORD_FILE,PGDATA,PATH}), postgres_command:.services["whirmill-zapbot-postgres"].command, postgres_mounts:[.services["whirmill-zapbot-postgres"].volumes[] | {source,target,type}], credential_mounts:[.services["credential-init"].volumes[] | {source,target,type}]}' > "$receipt_dir/resolved-config.json"
image=$(jq -r '.postgres_image' "$receipt_dir/resolved-config.json")
printf '%s\n' "$image" | grep -Eq '@sha256:[0-9a-f]{64}$'
docker info --format 'server={{.ServerVersion}} operating_system={{.OperatingSystem}} architecture={{.Architecture}}' > "$receipt_dir/docker-engine.txt"
APP_DATA_DIR="$app_dir" APP_VERSION="$version" SCRIPT_APP_REPO_DIR="$package_root" "$package_root/hooks/pre-start" >> "$receipt_dir/startup-probe.log" 2>&1

snapshot() {
  view=$1
  service=$2
  shift 2
  printf '\nview=%s t=%s\n' "$view" "$(date -u +%FT%T.%NZ)" >> "$receipt_dir/ownership.txt"
  compose run --rm --no-deps --entrypoint /bin/sh "$service" -ec 'id; for path do stat -c "%n dev:inode=%d:%i uid:gid=%u:%g mode=%a" "$path" 2>&1 || true; done' sh "$@" >> "$receipt_dir/ownership.txt" 2>&1
}

snapshot credential_before credential-init /data /data/postgres /data/postgres/pgdata /data/secrets/postgres /data/secrets/postgres/password
compose up -d credential-init postgres-tls-init >> "$receipt_dir/startup-probe.log" 2>&1
compose wait credential-init postgres-tls-init >> "$receipt_dir/startup-probe.log" 2>&1
for service in credential-init postgres-tls-init; do
  id=$(compose ps -aq "$service" | tail -n 1)
  test -n "$id"
  test "$(docker inspect -f '{{.State.Status}}:{{.State.ExitCode}}' "$id")" = exited:0
done
snapshot credential_after credential-init /data /data/postgres /data/postgres/pgdata /data/secrets/postgres /data/secrets/postgres/password
snapshot postgres_before whirmill-zapbot-postgres /var/lib/postgresql/data /var/lib/postgresql/data/pgdata /run/zapbot-secret /run/zapbot-secret/password

compose up -d --no-deps whirmill-zapbot-postgres >> "$receipt_dir/startup-probe.log" 2>&1
id=$(compose ps -aq whirmill-zapbot-postgres | tail -n 1)
test -n "$id"
n=0
while [ "$n" -lt 360 ]; do
  docker inspect -f '{{.State.Status}} {{.State.Health.Status}} {{.RestartCount}} {{.State.StartedAt}} {{.State.FinishedAt}}' "$id" | awk -v t="$(date -u +%FT%T.%NZ)" '{print t, $0}' >> "$receipt_dir/timeline.txt"
  health=$(docker inspect -f '{{.State.Health.Status}}' "$id")
  test "$health" != healthy || break
  n=$((n + 1))
  sleep 0.25
done
snapshot credential_final credential-init /data/postgres /data/postgres/pgdata /data/secrets/postgres/password
snapshot postgres_final whirmill-zapbot-postgres /var/lib/postgresql/data /var/lib/postgresql/data/pgdata /run/zapbot-secret/password
for caller in 0:0 999:999; do
  printf '\nactual_postgres_container caller=%s t=%s\n' "$caller" "$(date -u +%FT%T.%NZ)" >> "$receipt_dir/ownership.txt"
  docker exec -u "$caller" "$id" /bin/sh -ec 'id; for path in /var/lib/postgresql/data /var/lib/postgresql/data/pgdata /run/zapbot-secret/password; do stat -c "%n dev:inode=%d:%i uid:gid=%u:%g mode=%a" "$path" 2>&1 || true; done' >> "$receipt_dir/ownership.txt" 2>&1
done
printf 'health=%s polls=%s\n' "$health" "$n" >> "$receipt_dir/startup-probe.log"
docker inspect -f '{"restart":{{.RestartCount}},"state":"{{.State.Status}}","health":"{{.State.Health.Status}}","image_id":"{{.Image}}"}' "$id" > "$receipt_dir/postgres-state.json"
compose logs --no-color whirmill-zapbot-postgres > "$receipt_dir/postgres.log"
python3 "$(dirname "$0")/zapbot-postgres-startup-assess.py" "$receipt_dir" "$storage"
