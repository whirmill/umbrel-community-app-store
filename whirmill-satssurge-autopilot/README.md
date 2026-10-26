# SatsSurge Autopilot

A Lightning routing agent for an Umbrel LND node. You talk to it on Telegram:
it analyses forwards, liquidity and fees, answers questions about the node, and
when autonomy is on it makes bounded fee changes and circular rebalances on its
own. The model runs on a ChatGPT/Codex subscription. Accounting, evidence and
every financial intent are kept in private SQLite databases on the node.

Current version, update and rollback steps, known issues and roadmap:
[status page](../docs/work/satssurge-status.md).

## Safety rules (mandate v1)

Nothing in chat, Telegram or the web app can change these rules. The numbers are
defaults: the owner can change them in the [configuration file](#configuration).

- **Allowed actions:** `fee_change` and `rebalance` on its own. Channel opens and
  cooperative closes only after the owner taps Approva on each one. No other
  on-chain sends.
- **Spending caps:**
  - 30,000 sats cumulative spend, including imported history;
  - 1,500 sats of rebalance fees per day (Europe/Rome), of which at most 750 on
    exploratory attempts;
  - 100 sats per attempt;
  - at most three attempts per decision.
- **On-chain reserve:** 500,000 confirmed on-chain sats are always protected.
  Below that, nothing is dispatched.
- **Rebalances** need evidence: 48 observed hours over two days, ten external
  forwards, and an expected benefit of at least twice the maximum cost.
- **Fee changes** are bounded experiments: at most 20% (minimum 5 ppm) per
  step. They keep the base fee and HTLC parameters and are observed for at
  least 48 hours.
- **No other fee/rebalance automation at the same time.** A host timer checks
  every 30 seconds that LightningMate (fee, rebalance, sell, LSP), LNDg
  (AF, AR, autopilot) and Loop/Lightning Terminal are off. If the check is
  missing, stale or positive, financial dispatch stops.
- **Payment safety:**
  - every payment writes its intent and payment hash before it is sent;
  - a timeout is treated as uncertain and resolved with TrackPaymentV2, never
    retried blindly;
  - a payment that breaks an accounting invariant stops autonomy until you
    review it.

## Configuration

Limits and timings live in an optional JSON file on the node. Without the file
every value is the default below.

- **Location:** `~/umbrel/app-data/whirmill-satssurge-autopilot/config/satssurge.json`.
  The app sees it at `/config/satssurge.json`, read-only: neither the agent nor
  Telegram nor the web app can change it.
- **Format:** write only the values you change. For example,
  `{"mandate": {"attemptSat": 500}}` raises the per-attempt cost to 500 sats and
  keeps everything else.
- **Applying a change:** the file is read when the app starts. After editing it,
  restart the app (stop and start).
- **After the restart:**
  - Telegram reports what changed, for example "costo massimo per tentativo
    (sat) 100 → 500";
  - `node_state` shows the values in force;
  - every decision records the configuration digest.
- **Mistakes:** a value outside its bounds, an unknown key or broken JSON
  applies nothing. Financial operations stay blocked and Telegram names the
  problem; chat keeps working with the defaults.

| Key | Default | Bounds | Meaning |
|---|---|---|---|
| `mandate.attemptSat` | 100 | 1–2,000 | max cost of one rebalance attempt |
| `mandate.dailySat` | 1,500 | 1–10,000 | rebalance fees per day |
| `mandate.exploratoryDailySat` | 750 | 0–daily | of which exploratory |
| `mandate.totalSat` | 30,000 | 0–100,000 | cumulative spend |
| `mandate.reserveSat` | 500,000 | 100,000–10,000,000 | protected on-chain sats |
| `mandate.maxAttempts` | 3 | 1–5 | attempts per decision |
| `mandate.feeStepPercent` / `feeStepMinPpm` | 20 / 5 | 1–50 / 1–100 | fee change step |
| `mandate.feeWindowHours` | 48 | 6–720 | wait between fee changes on a channel |
| `mandate.ordinaryBenefitRatio` | 2 | 1–10 | benefit required for an ordinary rebalance, × cost |
| `channels.onchainMonthlyFeeSat` | 20,000 | 0–50,000 | on-chain fees for channel operations per month |
| `channels.minOpenSat` / `maxOpenSat` | 500,000 / 2,000,000 | 100,000–5,000,000 | channel open size |
| `channels.maxSatPerVbyte` | 50 | 1–200 | on-chain fee rate |
| `telegram.proposalMinutes` | 5 | 1–30 | how long Approva stays valid |
| `telegram.quietStartHour` / `quietEndHour` | 22 / 8 | 0–23 | quiet hours (equal values: none) |
| `telegram.digestHour` | 9 | 0–23 | daily digest |
| `telegram.lndAlertMinutes`, `lndSyncAlertMinutes`, `providerAlertMinutes`, `uncertainAlertMinutes` | 10 | 1–60 | delay before a critical alert |
| `agent.softSeconds` / `economicSoftSeconds` / `hardSeconds` | 120 / 60 / 180 | 30–600 / 30–600 / 60–900 | turn duration; hard ≥ soft + 30 |
| `agent.readOnlyResearchCalls` / `coordinatorResearchCalls` | 12 / 16 | 4–40 | tool calls per turn |
| `agent.automaticReviewsPerDay` | 4 | 0–24 | automatic reviews per scope |
| `agent.htlcFailureTrigger` / `htlcFailureSettleSeconds` | 3 / 120 | 1–100 / 10–3,600 | failed forwards that start a review |
| `lnd.callSeconds` | 20 | 5–60 | wait for one LND call |
| `lnd.paymentWaitSeconds` / `paymentTimeoutSeconds` | 120 / 30 | 60–600 / 10–300 | payment wait; timeout ≤ wait − 30 |

## How it works

- **App container** (`whirmill-satssurge-autopilot_server_1`, port 5238 behind
  the Umbrel proxy). It runs the agent, the Telegram bot, the web settings and
  the LND collectors. It reaches LND over gRPC/TLS with two restricted
  macaroons: it never sees the admin macaroon, the seed or the Docker socket.
- **Data** lives in `~/umbrel/app-data/whirmill-satssurge-autopilot/data`:
  - `operational.sqlite`: accounting, events, snapshots, decisions,
    reservations, evidence;
  - `durable.sqlite`: agent conversations and tasks;
  - `oauth.sqlite`: model provider login;
  - `owner.secret` and `telegram.secret`.
- **Host timers** run as the `umbrel` user (`systemctl --user list-timers`):
  - `satssurge-autopilot-interlock`: the automation check above, every 30 s;
  - `satssurge-autopilot-diagnostics` and `-competition`: read-only
    LNDg/LightningMate data and peer fee comparison;
  - `satssurge-autopilot-lnd-cert`: keeps the public LND TLS certificate copy
    current.

## Installation

1. **Install** the app from this community app store.
2. **Provision LND credentials once**, as `umbrel` on the host. Do not rerun
   this for certificate renewals.

   ```sh
   sh scripts/provision.sh /home/umbrel/umbrel/app-data/whirmill-satssurge-autopilot
   ```

   Optional, with the owner's approval: `scripts/provision-channels.sh` (same
   argument) bakes a separate channel macaroon. Without it, channel open/close
   proposals stay unavailable and everything else works unchanged. With it,
   each open or cooperative close still runs only after the owner approves it.

3. **Install the host timers**, as `umbrel`:

   ```sh
   APP=/home/umbrel/umbrel/app-data/whirmill-satssurge-autopilot
   sh scripts/install-lnd-cert-sync.sh
   sh scripts/install-interlock.sh "$APP"
   sh scripts/install-diagnostics.sh "$APP"
   ```

4. **Sign in** to the web UI from the Umbrel dashboard with the password in
   `data/owner.secret`. Complete the ChatGPT OAuth login there and pick a model.
   Never paste credentials into the chat.
5. **Connect Telegram.** In the web settings, enter the bot token and generate a
   pairing code, then send `/start <code>` to the bot within five minutes. Only
   the paired owner can talk to it.

## Using it

Ask the bot questions in plain text ("stato del nodo?"). It replies with live
data and buttons for follow-ups. Analysis never changes anything.

| Command | Effect |
|---|---|
| `/status` | Autonomy, node readiness and pending requests |
| `/analyze` | Full node analysis |
| `/grafico` | Charts as images: channel balance, balance history, forwards and fees, fees vs costs, payback of a rebalance, fee and traffic of one channel |
| `/proposals` | Proposals waiting for your approval |
| `/pause` | Stop autonomy; collection and reconciliation keep running |
| `/resume` | Show a summary and resume autonomy after you confirm |
| `/stop` | Interrupt the current answer |
| `/queue`, `/recover` | Future and earlier requests |
| `/menu`, `/help` | Menu and help |

If you change fees or move liquidity by hand, the app puts a hold on the
affected channels and records a manual event. It never restores the old policy
on its own. The web UI shows configuration, budgets, history and diagnostics.

## Updates and backups

Use the supported Umbrel update. Before updating, stop the app and copy
`app-data/whirmill-satssurge-autopilot`. The [status page](../docs/work/satssurge-status.md)
has the exact steps and the rollback procedure. The launcher takes its own
database checkpoint only when a release changes the database schema
(`scripts/schema-targets.json`).

## Development

Node 24+. Rules for contributors and agents are in [AGENTS.md](AGENTS.md).

```sh
npm ci && npm run typecheck && npm test
python3 -m unittest discover -s scripts/tests
```

Tests use local mocks, never regtest or real payments. Pushing a
`satssurge-autopilot-v<version>` tag builds and publishes the amd64/arm64
image. A separate catalogue PR then pins its digest in `docker-compose.yml`.
