# SatsSurge Autopilot — status

Updated 2026-10-25. This page replaces the former implementation checkpoint
(`satssurge-autopilot-implementation.md`, about 4,700 lines), which is still
available in Git history and in closed PRs #106/#107.

## Installed

| | |
|---|---|
| Version | 0.6.0 |
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
4. If the release changed a host script (`scripts/diagnostics.py`, `competition.py`, `interlock.py`, `sync-lnd-public-cert.py`), rerun its installer as `umbrel` from the node's store copy, e.g. `sh ~/umbrel/app-stores/whirmill-umbrel-community-app-store-github-*/whirmill-satssurge-autopilot/scripts/install-diagnostics.sh ~/umbrel/app-data/whirmill-satssurge-autopilot`. The Umbrel update replaces the image and compose, not these host copies.
5. Check:
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
  - `-competition`: every 3 minutes.

  The pre-app `satssurge-collect` daily report and the Lightning Mate backfill were retired on 2026-10-25. The collector's past reports remain in `~/.local/share/satssurge` (#126).
- **Startup costs.** The owner's manual startup operations of 3–8 October are annotated in `ledger_annotations`: 45 entries as `other` (channel opens and closes, funding, Magma liquidity, initial balancing) and 2 as `swap` (RoboSats fees). The budget still counts them, as mandate v1 requires. Since 0.5.20 the agent sees the 30-day partition. On 2026-10-25 it showed routing at +1,452.7 sat, other at −9,872.7 sat and swap at +1,834.5 sat.
- **LND alerts (0.5.21).** Transient LND call failures (deadline, cancelled, rpc_failure, unavailable, resource_limit, acquisition_failure) alert only after 10 minutes of outage, once per outage, with one recovery message after 5 minutes of continuous health. Certificate, endpoint and authentication problems alert immediately. Before 0.5.21 single hiccups had produced 158 alerts.
- **LND sync alerts (0.5.23, #128).** Right after a new block LND briefly reports `synced_to_chain=false`. Finance still stops at once, but Telegram alerts only after 10 minutes unsynchronized and sends one recovery message. On 2026-10-25 two blocks 29 s apart had produced a false "LND not synchronized" alert.
- **Chat and autopilot (0.5.24, #131).** The chat sees the latest autopilot review outcomes, so it can explain an observation-only day. Partial answers to the owner no longer start hidden background continuations; "Completa le lacune" continues on request. Before 0.5.24 there were 27 such jobs on 2026-10-25.
- **Model provider alerts (0.5.25, #134).** A dropped model stream or connection pauses requests for a minute. Telegram now alerts only after 10 minutes of repeated failures and sends one recovery message. Authentication, quota and configuration failures still alert immediately.
- **Pi Durable integration simplified (0.6.0, #137).** The app no longer patches Pi Durable's scheduler. Tools are registered once per capability instead of per slot. Job leases and heartbeats are removed. Durable's native generation retry replaces the app's own. At startup, interrupted agent runs are re-attached, or aborted natively when the gates would not admit them now, before Durable resumes; aborted runs are never replayed. Each financial operation now records the model tool call that started it. Design: `docs/work/satssurge-durable-simplification.md`.
- **Peer fee comparison (0.5.21).** It had been unavailable since LND left 0.21.3, because both sides pinned that exact version. It now accepts LND 0.21+ including release candidates.
- **Database growth (0.5.22, #112).** Per-minute redundant canonical writes stopped: unchanged policies, empty history windows, rollup republishing, snapshot mirror copies and streaming frames. Simulated growth went from about 180 to about 12 MB/day. The release also fixes a latent retention bug that would have blocked financial execution about 90 days after install. `scripts/prune_redundant_history.py` removes existing redundant rollups and frames offline.
- **Scoped mode (until 0.5.19).** The app-controls environment pointed at an unmounted `/app-controls`, and the persisted proof kept scoped mode alive. Together they held finance permanently. An orphan maintenance claim left by an agent on 2026-10-10 was released on 2026-10-25 with the app stopped and no operations active (#113, #114).

## Roadmap

Selected on 2026-10-25 from the former M2.3–M5 plan. The goal is a routing
agent that earns fees safely; everything else waits for a concrete need.

1. **Watch the first autonomous decisions.** Check that operations, budgets and
   accounting match LND after `/resume`. Fix only what real operations expose.
2. **Database growth (#112):** fixes shipped in 0.5.22. Confirm with a 24 h `dbstat` measurement on the node.
3. **Channel opens and closes (#118):** shipped in 0.5.22.
   - The agent measures channels (`channel_performance`) and candidates (`channel_candidate`, routes back to depleted channels) and proposes opens or cooperative closes.
   - Every operation runs only after the owner approves it with a tap.
   - Limits: on-chain fees ≤ 20,000 sat/month, new channels 500k–2M sat, and the 500,000 sat reserve stays protected.
   - It needs the separate channel macaroon from `scripts/provision-channels.sh`. Without it, channel features are unavailable.
4. **Native collection (former M3), trimmed.** It keeps running as it is. There
   is no project to retire LNDg/LightningMate and no further canonical-model work
   until there is a concrete reason.

Done: Telegram tables (#115, 0.5.20). The app-level retry after transient provider errors (#116, 0.5.20) was replaced by Pi Durable's native generation retry (3 retries, #137).

Dropped:
- runtime-improvement prompts sent by the bot (M2.4);
- HTML/PDF/XLSX export rendering (M4);
- RoboSats/Amboss/Magma integrations (M5).

The unwired M5 branch was deleted (last commits `e7446d0`, `e0d1932`). The
`voice-noise-guard` branch was deleted because its fix shipped in #98.
