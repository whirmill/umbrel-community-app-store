#!/bin/sh
set -eu

project=whirmill-zapbot
for service in execution-coverage-acquirer execution-economics-producer; do
  running="$(docker ps --quiet \
    --filter "label=com.docker.compose.project=$project" \
    --filter "label=com.docker.compose.service=$service" \
    --filter status=running)"
  if [ -n "$running" ]; then
    echo "refusing FIFO recovery while $service is running" >&2
    exit 1
  fi
done

script_dir="$(unset CDPATH; cd -- "$(dirname -- "$0")" && pwd)"
app_data_dir="$(unset CDPATH; cd -- "$script_dir/.." && pwd)"
handoff_dir="$app_data_dir/data/handoff/execution-economics"

for fifo in "$handoff_dir/artifact.pipe" "$handoff_dir/ack.pipe"; do
  [ -e "$fifo" ] || continue
  [ -p "$fifo" ] || { echo "refusing non-FIFO handoff path: $fifo" >&2; exit 1; }
  metadata="$(stat -c '%u:%a' "$fifo")"
  [ "$metadata" = "1000:600" ] || {
    echo "refusing FIFO with unexpected owner or mode: $fifo" >&2
    exit 1
  }
done

rm -f "$handoff_dir/artifact.pipe" "$handoff_dir/ack.pipe"
echo "execution-economics stale FIFO handoff cleared"
