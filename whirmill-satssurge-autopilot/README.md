# SatsSurge Autopilot

A Lightning routing agent for an Umbrel LND node. You talk to it on Telegram:
it analyses forwards, liquidity and fees, answers questions about the node, and
when autonomy is on it makes bounded fee changes and circular rebalances on its
own. The model runs on a ChatGPT/Codex subscription. Accounting, evidence and
every financial intent are kept in private SQLite databases on the node.

Current version, update and rollback steps, known issues and roadmap:
[status page](../docs/work/satssurge-status.md).

## Safety rules (mandate v1)

These limits are built into the app and cannot be changed from chat.

- **Allowed actions:** `fee_change` and `rebalance` only. No channel opens or
  closes, no on-chain sends.
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
- **Fee changes** are bounded experiments. They keep the base fee and HTLC
  parameters and are observed for at least 48 hours.
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

3. **Install the host timers**, as `umbrel`:

   ```sh
   APP=/home/umbrel/umbrel/app-data/whirmill-satssurge-autopilot
   sh scripts/install-lnd-cert-sync.sh
   sh scripts/install-interlock.sh "$APP"
   sh scripts/install-diagnostics.sh "$APP"
   ```

4. **Optional history import.** Copy receipt files (`expenses.json`,
   reconciliation JSON) into `$APP/history/`. The import is repeatable and stops
   on conflicting amounts.
5. **Sign in** to the web UI from the Umbrel dashboard with the password in
   `data/owner.secret`. Complete the ChatGPT OAuth login there and pick a model.
   Never paste credentials into the chat.
6. **Connect Telegram.** In the web settings, enter the bot token and generate a
   pairing code, then send `/start <code>` to the bot within five minutes. Only
   the paired owner can talk to it.

## Using it

Ask the bot questions in plain text ("stato del nodo?"). It replies with live
data and buttons for follow-ups. Analysis never changes anything.

| Command | Effect |
|---|---|
| `/status` | Autonomy, node readiness and pending requests |
| `/analyze` | Full node analysis |
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
