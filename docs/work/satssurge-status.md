# SatsSurge Autopilot — status

Updated 2026-10-25. This page replaces the former implementation checkpoint
(`satssurge-autopilot-implementation.md`, about 4,700 lines), which is still
available in Git history and in closed PRs #106/#107.

## Installed

| | |
|---|---|
| Version | 0.5.20 (`ghcr.io/whirmill/umbrel-satssurge-autopilot:0.5.20@sha256:99705c77…`) |
| Installed | 2026-10-25 via the supported Umbrel update |
| Financial execution | active since 2026-10-25 10:42 (Rome) under mandate v1, after the owner's `/resume`. The first cycle chose observation only; no operations yet |
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
- **Startup costs.** The owner's manual startup operations of 3–8 October are annotated in `ledger_annotations`: 45 entries as `other` (channel opens and closes, funding, Magma liquidity, initial balancing) and 2 as `swap` (RoboSats fees). The budget still counts them, as mandate v1 requires. Since 0.5.20 the agent sees the 30-day partition. On 2026-10-25 it showed routing at +1,452.7 sat, other at −9,872.7 sat and swap at +1,834.5 sat.
- **Scoped mode (until 0.5.19).** The app-controls environment pointed at an unmounted `/app-controls`, and the persisted proof kept scoped mode alive. Together they held finance permanently. An orphan maintenance claim left by an agent on 2026-10-10 was released on 2026-10-25 with the app stopped and no operations active (#113, #114).

## Roadmap

Selected on 2026-10-25 from the former M2.3–M5 plan. The goal is a routing
agent that earns fees safely; everything else waits for a concrete need.

1. **Watch the first autonomous decisions.** Check that operations, budgets and
   accounting match LND after `/resume`. Fix only what real operations expose.
2. **Database growth:** measure over 24 h and bound the canonical tables (#112).
3. **Channel opens and closes proposed by the agent (#118).** The owner approves each one with a tap. On-chain fees are capped at 20,000 sat/month, new channels are 500k–2M sat, and closes are cooperative only.
4. **Native collection (former M3), trimmed.** It keeps running as it is. There
   is no project to retire LNDg/LightningMate and no further canonical-model work
   until there is a concrete reason.

Done: Telegram tables (#115) and one automatic retry after transient provider errors (#116), both in 0.5.20.

Dropped:
- runtime-improvement prompts sent by the bot (M2.4);
- HTML/PDF/XLSX export rendering (M4);
- RoboSats/Amboss/Magma integrations (M5).

The unwired M5 branch was deleted (last commits `e7446d0`, `e0d1932`). The
`voice-noise-guard` branch was deleted because its fix shipped in #98.
