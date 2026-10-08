# SatsSurge Autopilot

M1 mainnet POC using Pi Durable 1.1.0 and subscription-only ChatGPT OAuth. Reasoning effort is explicitly `high`, visible in the model section and applied to every agent run. No regtest, paid API fallback, shell tool, unrestricted RPC, channel opening, close, swap or Magma transaction is exposed to the agent.

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

### Ordered roadmap — updated 2026-10-08

This order is user-approved. The roadmap does not broaden financial authority or mutate the mandate. Dates below are observation windows, not promised delivery dates.

**M1 — Foundation: deployed, economic validation ongoing.** Version0.1.3 is installed; Pi Durable uses GPT-6.1 Sol/high with subscription OAuth. Private historical import/accounting, LND collector, guarded fee/rebalance executor, web chat, pause/resume, restricted credentials, persistent host interlock and immutable multiarchitecture images are in place. Fifteen local mocked tests pass. Real authenticated AI runs succeeded; the first high run completed without a financial operation. This proves AI/read execution, not real-node financial recovery or profitability. Accounting coverage remains partial.

**M1.1 — Persistent request queue: next priority.** Replace busy rejection with a SQLite queue shared by chat, scheduled analysis and aggregated Lightning events. Jobs retain request IDs, type, priority, channel/corridor scope, snapshot version, state, result, attempts and timestamps. Claim work atomically before any asynchronous boundary; recover leases after crashes without replaying uncertain financial sends. Show accepted/queued/running/waiting/completed/failed/cancelled states in the UI. Bound backlog and rate; coalesce duplicate event bursts and stale periodic analyses. Pause and deterministic reconciliation bypass AI backlog. Prefer owner requests while preventing maintenance starvation. Existing financial intents/reservations remain the authoritative execution record, not a fresh send on job retry.

Acceptance: simultaneous chat/scheduler/event requests are neither lost nor double-run; restart retains queued jobs/results; duplicate IDs are idempotent; paused/auth-unavailable jobs behave explicitly; uncertain sends reconcile before new work. Measure wait time, queue age and failure/recovery counts.

**M1.2 — Bounded analyst pool: after queue qualification.** Keep one coordinator and one financial executor. Start with at most two concurrent read-only analyst workers; each task has a separate Pi Durable conversation linked to shared provenance/accounting. Workers read, estimate and propose; only the coordinator submits guarded decisions. Central budget, liquidity reservations and demand-benefit claims prevent parallel forecasts using the same future revenue. Revalidate snapshot freshness before execution. Configure concurrency limits and record model/quota usage; authentication/quota exhaustion suspends new AI work while deterministic collection/reconciliation continues. GPT-6.1 Sol/high remains the requested model configuration; no silent substitution.

Acceptance: chat stays responsive during corridor analysis; worker crashes cannot resend money; stale/conflicting proposals replan; bounded quota/resource use and latency are measured before expanding the pool.

**M2 — Diagnostics and economic validation.** Add qualified, version-aware LNDg/Lightning Mate adapters, failed-forward classification and visibility/backfill of external and agent rebalances. Maintain explicit freshness, pagination and coverage; unknown data never becomes zero. Evaluate corridor flows, inventory depletion, observed returns, source opportunity cost, alternative actions and fee competitiveness. Preserve original forecasts and calculation versions while calibrating estimators. Compare predictions with outcomes at7/30days and enforce the48-hour fee observation window. Distinguish manual/confounded interventions, inconclusive experiments and strategy-specific suspension. Report reconciled operating net profit separately from capital, mining, commerce and unclassified costs.

Acceptance: attributable operations/costs reconcile to LND and receipts, adapters fail visibly on incompatible schemas, forecast errors are measurable, and profitability claims identify coverage and causal limits. Technical success, predictive quality and economic result remain separate.

**M3 — Channel lifecycle and Magma.** After explicit capability enablement, support channel qualification, batched openings, cooperative closures, inbound purchase and outbound liquidity sales. Represent contract duration, routing promises, HODL invoices, pending obligations and capital reservations in the same durable accounting/queue. Qualify current official APIs; do not inherit unsupported legacy Lightning Mate seller paths. Include opening/closing/lease costs, inventory opportunity cost and realistic demand in net forecasts. A buyer order does not become earned revenue before settlement/reconciliation. Force closures and unplanned swaps are not implied capabilities.

Acceptance: every contract/funding step has durable intent and receipt, crash/timeout recovery cannot create duplicate channels or payments, reserve and outstanding obligations remain covered, and contract terms survive updates.

**M4 — Telegram.** Add a second interface to the same request queue, decisions and durable memory, accessible only to the linked owner. Support chat, status, pause/resume, job progress and aggregated actionable notifications. Deduplicate notifications, configure quiet periods and preserve access checks; Telegram does not broaden financial limits.

Acceptance: concurrent web/Telegram requests share consistent state, unauthorized senders are rejected, and reconnects do not duplicate jobs or sensitive notifications.

**Ongoing across milestones — Reliability and deployment.** Retain ordinary detailed data90days; preserve accounting, decisions, corrections and linked evidence indefinitely. Verify consistent SQLite backups and restore/migration paths, software rollback without operation replay, schema/version gates, bounded retention and immutable amd64/arm64 releases. Expand mocked crash/concurrency tests and bounded real-node qualification within the mandate; no regtest. Monitor authentication, quota, collector freshness, queue age, interlocks and manual interventions.

**Research backlog, outside currently enabled capabilities.** Preserve the historical RoboSats automation idea: compare net swap margins with routing/rebalance costs, investigate safe API/event integration, bonds, settlement and disputes, then propose a separately enabled capability if evidence justifies it. Do not launch trades, swaps or marketplace actions from this research backlog. Other liquidity mechanisms and topology changes remain alternatives to evaluate, not promised profitable operations.

No M3/M4/research operation is implicitly authorized by an M1 agent chat or historical evidence.
