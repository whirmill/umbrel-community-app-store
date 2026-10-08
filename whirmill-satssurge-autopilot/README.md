# SatsSurge Autopilot

M1 mainnet POC using Pi Durable 1.1.0 and subscription-only ChatGPT OAuth. No regtest, paid API fallback, shell tool, unrestricted RPC, channel opening, close, swap or Magma transaction is exposed to the agent.

## Mandate v1

- 30,000 sat cumulative expenses, including imported history; 1,500 sat daily rebalance fees in Europe/Rome; exploratory fees are a subset capped at 750 sat/day; 100 sat per attempt.
- A decision/corridor/evidence fingerprint retains its original aggregate cap across renamed strategies and at most three attempts. Successful exploration cannot be repeated with the same evidence. Pending reservations consume budgets across midnight.
- Protect 500,000 sat confirmed on-chain plus declared pending on-chain obligations. M1 cannot create such obligations itself.
- Ordinary rebalances require 48 observed liquid/same-price hours on two days, ten external forwards, and independently computed incremental benefit at least twice maximum cost. Conservative volume uses the smaller 7/30-day rate with a 50% haircut and finite liquidity; competing corridors reduce benefit.
- Pricing changes are bounded exploratory experiments, preserve base fee and HTLC parameters, and have a minimum 48-hour observation window.
- A settled payment with an invariant violation is accounted and permanently blocks autonomy pending audited operator reconciliation. Auth/quota failures stop AI decisions, not reconciliation or collectors.

## Architecture

`operational.sqlite` (WAL, FULL): ledger, raw events, snapshots, coverage, evidence index, decisions, experiments, reservations and immutable mandate receipts. `durable.sqlite`: Pi conversation/tasks, with unsafe execution tool replay disabled. `oauth.sqlite`: isolated provider credential storage, no tools can read it. `owner.secret`: installation owner password, never put it in chat. All reside in the private persistent data directory. Evidence content is stored privately in SQLite with source/content checksums; historical authority is never inherited. Technical detail expires after 90 days unless linked to a decision. Accounting, decisions and linked evidence never expire automatically. Aggregates retain calculation version and loss-of-detail annotation.

Only one process owns the app databases (`flock`). Dispatch and reconciliation share an async ownership guard. The application writes an irreversible send intent and payment hash before SendPaymentV2. A timeout is uncertain, not failed; TrackPaymentV2 resolves it without retrying. An unused invoice from a crash before send is not a payment. MPP endpoint inconsistencies retain actual settled costs. Parallel destination channels to the same peer are unsupported in M1 and rejected before sending.

## Installation/bootstrap

1. Install from the community store; provision from the Umbrel host as `umbrel`:
   `sh scripts/provision.sh /home/umbrel/umbrel/app-data/whirmill-satssurge-autopilot`
   This bakes two URI-restricted macaroons and copies the public TLS certificate. The container never mounts the admin macaroon, seed or Docker socket.
2. Copy selected historical receipt JSON and narrative Markdown into the app's private `history/` directory. Required: `expenses.json`. `reconciliation-20261005.json` imports gross RoboSats premium separately from its already-booked fees. Personal payment details are excluded. Original documents remain unchanged; manifest checksums and dated claims are retained. Import is repeatable; conflicting ledger amounts stop initialization.
3. Run `scripts/interlock.py <app-data-path>` every 30 seconds on the host. It reads current Lightning Mate config and LNDg switches, and observes Loop container absence. Missing/changed formats fail closed. When Lightning Mate settings.json is absent, only the reviewed exact settings module checksum establishes its default LSP-off state; upgrades require requalification. It never changes another application's settings. The application rejects gate data older than 90 seconds.
4. Open port 5238 through Umbrel's authenticated proxy. Read `data/owner.secret` locally to sign in, then complete ChatGPT OAuth in the UI. Do not paste credentials into agent chat. Select an available subscription model. Autonomy starts immediately when auth, historical reconciliation, reserve, sync and interlocks pass. There is no mandatory shadow day.

Owner authentication also protects the backend when accessed directly by a peer container; Origin and CSRF are additional controls, not substitutes for authentication. The health endpoint alone is public and returns no node data. The backend has no host port published directly.

## Accounting and interpretation

All monetary storage uses decimal strings representing integer msat/sat. Display uses Italian thousands/decimal separators. Capital transfers, personal and mining activity are not routing revenue. Imported receipts and LND reconciliations are idempotent; exact historical payment IDs/hashes and fees must match. Unknown costs keep P&L explicitly partial. Subscription expenditure is not inferred from token counts and remains unclassified until an operator supplies an allocation.

Historic costly tests retain the user's recorded intention/authorization/derogation and observed outcome. They are not training targets or proof of poor judgment. Historical claims remain dated, uninterpreted evidence; later interpretations do not overwrite them. Ordinary corridor contribution after execution is explicitly noncausal; execution success and economic profit are separate. Fee experiments require M2's richer comparable before/after evaluation before a causal profitability claim.

## Pause, manual interventions and recovery

Pause blocks new writes; collection and existing operation reconciliation continue. Manual policy/payment changes create affected-channel holds, an immutable manual event, and confounded experiment outcomes. Stable reconciled state clears the local hold, permitting replanning; the old policy is never automatically restored. Strategies with negative or inconclusive evaluation are suspended by canonical corridor and evidence fingerprint; new evidence is required. Insufficient experiments observe at most seven days without automatic additional financing.

Backup all three SQLite files and private evidence using a consistent SQLite backup/snapshot, including WAL state. Never copy only a live database file. Updates preserve `/data`; rollback refuses a newer database version and never resets completed operation receipts. Before an audited correction, pause, export consistent databases, compare LND terminal payment and exact receipt, append a linked correction record, then reconcile and explicitly clear the persistent integrity blocker. Do not delete an operation to retry it.

## Verification and roadmap

`npm ci --ignore-scripts && npm test` uses local mocks, not regtest. Tests cover budget contention, crossing midnight, no duplicate demand, timeout-after-success, crash before send, reconciliation during invoice creation, manual policy changes, MPP invariant/accounting, capped repeated attempts, strategy suspension, repeated historical import and pinned retention. Release CI builds linux/amd64 and linux/arm64. Store compose pins the published OCI index digest after release.

M1: autonomous fee/rebalance POC, private history/accounting, collector, web chat and owner/OAuth access. M2: LNDg/Lightning Mate richer diagnostic adapters and rebalance visibility, prediction calibration and 7/30-day comparison preserving original predictions. M3: explicitly enabled channel/Magma operations and HODL obligations. M4: Telegram interface sharing the same durable memory, owner-only access and aggregated notifications. No M3/M4 operation is implicitly authorized by an M1 agent chat or historical evidence.
