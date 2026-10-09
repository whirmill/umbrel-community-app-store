#!/bin/sh
set -eu
APP_DIR=${1:?Supply installed app data path}
mkdir -p "$HOME/.config/systemd/user" "$APP_DIR/scripts" "$APP_DIR/diagnostics"
if ! cmp -s "$(dirname "$0")/diagnostics.py" "$APP_DIR/scripts/diagnostics.py"; then
  cp "$(dirname "$0")/diagnostics.py" "$APP_DIR/scripts/diagnostics.py"
fi
if ! cmp -s "$(dirname "$0")/competition.py" "$APP_DIR/scripts/competition.py"; then
  cp "$(dirname "$0")/competition.py" "$APP_DIR/scripts/competition.py"
fi
cat > "$HOME/.config/systemd/user/satssurge-autopilot-diagnostics.service" <<UNIT
[Unit]
Description=SatsSurge version-aware read-only diagnostic projection
[Service]
Type=oneshot
ExecStart=/usr/bin/python3 $APP_DIR/scripts/diagnostics.py $APP_DIR
TimeoutStartSec=25
UNIT
cat > "$HOME/.config/systemd/user/satssurge-autopilot-diagnostics.timer" <<'UNIT'
[Unit]
Description=Refresh SatsSurge diagnostics
[Timer]
OnBootSec=10
OnUnitActiveSec=30
AccuracySec=1
[Install]
WantedBy=timers.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now satssurge-autopilot-diagnostics.timer
systemctl --user start satssurge-autopilot-diagnostics.service
cat > "$HOME/.config/systemd/user/satssurge-autopilot-competition.service" <<UNIT
[Unit]
Description=SatsSurge read-only public peer policy comparison
[Service]
Type=oneshot
ExecStart=/usr/bin/python3 $APP_DIR/scripts/competition.py $APP_DIR
TimeoutStartSec=150
UNIT
cat > "$HOME/.config/systemd/user/satssurge-autopilot-competition.timer" <<'UNIT'
[Unit]
Description=Refresh public peer policy comparison
[Timer]
OnBootSec=15
OnUnitActiveSec=180
AccuracySec=5
[Install]
WantedBy=timers.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now satssurge-autopilot-competition.timer
systemctl --user start satssurge-autopilot-competition.service
