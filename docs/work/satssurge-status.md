# SatsSurge Autopilot — status

Updated 2026-10-25. This page replaces the former implementation checkpoint
(`satssurge-autopilot-implementation.md`, about 4,700 lines), which is still
available in Git history and in closed PRs #106/#107.

## Installed

| | |
|---|---|
| Version | 0.5.18 (`ghcr.io/whirmill/umbrel-satssurge-autopilot:0.5.18@sha256:58ec79cf…`) |
| Installed | 2026-10-25 via the supported Umbrel update |
| Financial execution | disabled (`enabled=false`, all interlock flags false) |
| LND | `lightninglabs/lnd:v0.21.5-beta.rc1`, gRPC TLS healthy |
| Databases | operational ≈ 1.16 GB after pruning; durable and oauth unchanged |

## How to update

1. Stop the app: `umbreld client apps.stop.mutate --appId whirmill-satssurge-autopilot` (as root) or use the dashboard.
2. Copy app-data:
   `cp -a ~/umbrel/app-data/whirmill-satssurge-autopilot ~/satssurge-backups/pre-<version>-<date>`.
   Compare the file count and total bytes of the copy with the original.
3. Update: `umbreld client apps.update.mutate --appId whirmill-satssurge-autopilot` or the dashboard button.
4. Check:
   - the container is `healthy` with no restarts;
   - `umbrel-app.yml` shows the new version;
   - `data/lifecycle.json` is in `phase: ready`;
   - `interlock/status.json` flags are all false;
   - `operational.sqlite` is being written;
   - a Telegram text message gets a reply.

The launcher takes a database checkpoint only when a release changes a schema
version (`scripts/schema-targets.json`). A release that changes only code
starts immediately.

## How to roll back

Umbrel has no native downgrade.

1. Stop the app.
2. Move the current app-data aside (do not delete it) and copy the backup back into place.
3. Start the app.

The backup restores both the data and the previous `docker-compose.yml`, which pins the old image digest. This was done successfully on 2026-10-25 after the failed 0.5.17 attempt.

## Known issues and history

- **0.5.17 never ran on the node.** Its launcher was OOM-killed (768 MB limit) while hashing a 3 GB checkpoint, and it is fixed in 0.5.18 (#108, #109). Do not install 0.5.17.
- **Diagnostics archive.** Before 0.5.18 every 30 s diagnostics refresh archived two ~257 KB copies; 7,170 duplicates (1.85 GB) were removed with `scripts/prune_diagnostics_archive.py`. 0.5.18 archives only content changes.
- **Host-level timers.** These run outside the Umbrel app as `umbrel` user systemd timers:
  - `satssurge-autopilot-{diagnostics,interlock,lnd-cert}`: about every 30–60 s;
  - `-competition`: every 3 minutes;
  - `satssurge-collect`: daily.
- **README.** `whirmill-satssurge-autopilot/README.md` is still a long historical log and should be rewritten as user documentation.

## Open decisions

- When and how to re-enable financial execution.
- Which parts of the former M3–M5 roadmap are still worth doing.
- What to do with the unmerged branches `codex/satssurge-m5-api-continuation` (optional integrations, wiring held) and `codex/satssurge-voice-noise-guard`.
