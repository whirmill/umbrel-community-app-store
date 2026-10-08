#!/bin/sh
set -eu
APP_DIR=${1:?Supply installed app data path}
mkdir -p "$HOME/.config/systemd/user" "$APP_DIR/scripts"
cp "$(dirname "$0")/interlock.py" "$APP_DIR/scripts/interlock.py"
cat > "$HOME/.config/systemd/user/satssurge-autopilot-interlock.service" <<UNIT
[Unit]
Description=SatsSurge read-only financial executor interlock
[Service]
Type=oneshot
ExecStart=/usr/bin/python3 $APP_DIR/scripts/interlock.py $APP_DIR
UNIT
cat > "$HOME/.config/systemd/user/satssurge-autopilot-interlock.timer" <<'UNIT'
[Unit]
Description=Refresh SatsSurge live automation interlock
[Timer]
OnBootSec=10
OnUnitActiveSec=30
AccuracySec=1
[Install]
WantedBy=timers.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now satssurge-autopilot-interlock.timer
systemctl --user start satssurge-autopilot-interlock.service
