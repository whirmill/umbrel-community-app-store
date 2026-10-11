#!/bin/sh
# Version-gated visibility maintenance; no payment, invoice or policy RPC.
set -eu
umask 077
APP_DIR=${1:?Supply installed app data path}
MODE=${2:-install}
case "$MODE" in install|--helpers-only) ;; *) exit 2 ;; esac
mkdir -p "$APP_DIR/scripts"
for file in diagnostics.py lm_backfill.py checkpoint.py maintenance_lock.py; do
  if ! cmp -s "$(dirname "$0")/$file" "$APP_DIR/scripts/$file"; then
    cp "$(dirname "$0")/$file" "$APP_DIR/scripts/$file"
  fi
done
# Offline helper deployment must not create/enable/start any unit.
if [ "$MODE" = --helpers-only ]; then exit 0; fi
mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/satssurge-autopilot-backfill.service" <<UNIT
[Unit]
Description=SatsSurge verified rebalance visibility in Lightning Mate
[Service]
Type=oneshot
ExecStart=/usr/bin/python3 $APP_DIR/scripts/lm_backfill.py $APP_DIR --apply
TimeoutStartSec=120
UNIT
cat > "$HOME/.config/systemd/user/satssurge-autopilot-backfill.timer" <<'UNIT'
[Unit]
Description=Reconcile Lightning Mate rebalance visibility
[Timer]
OnBootSec=60
OnUnitActiveSec=300
AccuracySec=5
[Install]
WantedBy=timers.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now satssurge-autopilot-backfill.timer
systemctl --user start satssurge-autopilot-backfill.service
