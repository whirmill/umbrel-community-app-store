#!/bin/sh
# Run repeatedly as umbrel; no sudo, credentials, RPC, DB, or LND restart.
set -eu
umask 077
APP_DIR=/home/umbrel/umbrel/app-data/whirmill-satssurge-autopilot
[ "$(id -u)" -ne 0 ] || { echo 'User ownership required'; exit 1; }
[ "$HOME" = /home/umbrel ] || { echo 'Umbrel user home required'; exit 1; }
[ -d "$APP_DIR/credentials" ] && [ ! -L "$APP_DIR/credentials" ]
mkdir -p "$HOME/.config/systemd/user" "$APP_DIR/scripts"
[ ! -L "$APP_DIR/scripts" ]
[ ! -L "$APP_DIR/scripts/sync-lnd-public-cert.py" ]
python3 - "$APP_DIR" "$HOME/.config/systemd/user" <<'PYCODE'
import os, pathlib, stat, sys
try:
    app, units = map(pathlib.Path, sys.argv[1:])
    for path in [app, app / 'credentials', app / 'scripts', units, units.parent, units.parent.parent]:
        info = path.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022:
            raise ValueError()
    for path in [app / 'scripts/sync-lnd-public-cert.py', units / 'satssurge-autopilot-lnd-cert.service', units / 'satssurge-autopilot-lnd-cert.timer']:
        if path.exists() or path.is_symlink():
            info = path.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022:
                raise ValueError()
except Exception:
    print('Certificate sync installation ownership/permissions invalid')
    raise SystemExit(1)
PYCODE
install -m 600 "$(dirname "$0")/sync-lnd-public-cert.py" "$APP_DIR/scripts/sync-lnd-public-cert.py"
cat > "$HOME/.config/systemd/user/satssurge-autopilot-lnd-cert.service" <<'UNIT'
[Unit]
Description=SatsSurge public LND TLS certificate synchronization
[Service]
Type=oneshot
UMask=0077
ExecStart=/usr/bin/python3 /home/umbrel/umbrel/app-data/whirmill-satssurge-autopilot/scripts/sync-lnd-public-cert.py
UNIT
cat > "$HOME/.config/systemd/user/satssurge-autopilot-lnd-cert.timer" <<'UNIT'
[Unit]
Description=Refresh SatsSurge public LND certificate copy
[Timer]
OnBootSec=15
OnUnitActiveSec=60
AccuracySec=5
[Install]
WantedBy=timers.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now satssurge-autopilot-lnd-cert.timer
systemctl --user start satssurge-autopilot-lnd-cert.service
