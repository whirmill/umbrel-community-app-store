# SatsSurge Autopilot

Version `0.2.3` implements M1.1/M1.2/M2 on the M1 mainnet POC using Pi Durable 1.1.0 and subscription-only ChatGPT OAuth. Reasoning effort is explicitly `high`, visible in the model section and applied to every agent run. No regtest, paid API fallback, shell tool, unrestricted RPC, channel opening, close, swap or Magma transaction is exposed to the agent.

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

Owner login issues an origin-scoped bearer session held in browser `sessionStorage`, with an eight-hour lifetime. Subscription OAuth remains separate and unchanged. HTTP access is qualified only on the trusted LAN; use HTTPS before access over an untrusted network.

Owner authentication also protects the backend when accessed directly by a peer container; Origin and CSRF are additional controls, not substitutes for authentication. The health endpoint alone is public and returns no node data. The backend has no host port published directly.

## Accounting and interpretation

All monetary storage uses decimal strings representing integer msat/sat. Display uses Italian thousands/decimal separators. Capital transfers, personal and mining activity are not routing revenue. Imported receipts and LND reconciliations are idempotent; exact historical payment IDs/hashes and fees must match. Unknown costs keep P&L explicitly partial. Subscription expenditure is not inferred from token counts and remains unclassified until an operator supplies an allocation.

Historic costly tests retain the user's recorded intention/authorization/derogation and observed outcome. They are not training targets or proof of poor judgment. Historical claims remain dated, uninterpreted evidence; later interpretations do not overwrite them. Ordinary corridor contribution after execution is explicitly noncausal; execution success and economic profit are separate. Fee experiments require M2's richer comparable before/after evaluation before a causal profitability claim.

## Pause, manual interventions and recovery

Pause blocks new writes; collection and existing operation reconciliation continue. Manual policy/payment changes create affected-channel holds, an immutable manual event, and confounded experiment outcomes. Stable reconciled state clears the local hold, permitting replanning; the old policy is never automatically restored. Strategies with negative or inconclusive evaluation are suspended by canonical corridor and evidence fingerprint; new evidence is required. Insufficient experiments observe at most seven days without automatic additional financing.

Use `scripts/checkpoint.py` with the application proven stopped. Capture acquires the same `/data/executor.lock` as the application entrypoint and produces consistent SQLite backups of all three databases, including WAL contents. Preserve private evidence alongside the checkpoint. Never copy only a live database file. An isolated schema 1→3 migration preserved all 86 source rows; this is migration-fixture proof, not installed-app migration acceptance. Schema 3 also provides an atomic durable maintenance claim that blocks financial execution during host backfill. The installed 0.2.2 executor supports that fence. Updates preserve `/data`; rollback refuses a newer database version and never resets completed operation receipts. Before an audited correction, pause, export consistent databases, compare LND terminal payment and exact receipt, append a linked correction record, then reconcile and explicitly clear the persistent integrity blocker. Do not delete an operation to retry it.

## Verification and roadmap

`npm ci --ignore-scripts && npm test` uses local mocks, not regtest. Tests cover budget contention, crossing midnight, no duplicate demand, timeout-after-success, crash before send, reconciliation during invoice creation, manual policy changes, MPP invariant/accounting, capped repeated attempts, strategy suspension, repeated historical import and pinned retention. Release CI builds linux/amd64 and linux/arm64. Store compose pins the published OCI index digest after release.

### Ordered roadmap — updated 2026-10-09

This order is user-approved. The roadmap does not broaden financial authority or mutate the mandate. Dates below are observation windows, not promised delivery dates.

**M1 — Foundation: deployed, qualified and autonomous; economic validation ongoing.** Version 0.2.3 is installed; Pi Durable uses GPT-6.1 Sol/high with subscription OAuth. Private historical import/accounting, LND collector, guarded fee/rebalance executor, web chat, pause/resume, restricted credentials, persistent host interlock and immutable multiarchitecture images are in place. Current CI passed 58 Node / 14 Python tests, including simulated financial crash/recovery and real Pi Durable registry/storage behavior. Real authenticated AI runs succeeded; the first high run completed without a financial operation. This proves AI/read execution, not real-node financial recovery or profitability. Accounting coverage remains partial.

**M1.1 — Persistent request queue: installed; authenticated concurrent execution and browser acceptance qualified.** A SQLite queue now accepts chat, scheduled analysis and aggregated Lightning events instead of rejecting busy requests. Jobs retain request IDs, type, priority, channel/corridor scope, snapshot version, state, result, attempts and timestamps. Claim work atomically before any asynchronous boundary; recover leases after crashes without replaying uncertain financial sends. Show accepted/queued/running/waiting/completed/failed/cancelled states in the UI. Bound backlog and rate; coalesce duplicate event bursts and stale periodic analyses. Pause and deterministic reconciliation bypass AI backlog. Prefer owner requests while preventing maintenance starvation. Existing financial intents/reservations remain the authoritative execution record, not a fresh send on job retry.

Acceptance: simultaneous chat/scheduler/event requests are neither lost nor double-run; restart retains queued jobs/results; duplicate IDs are idempotent; paused/auth-unavailable jobs behave explicitly; uncertain sends reconcile before new work. Measure wait time, queue age and failure/recovery counts.

**M1.2 — Bounded analyst pool: installed; one coordinator and two analysts executed concurrently, browser acceptance qualified.** The persistent queue runs one coordinator and one financial executor, with at most two concurrent read-only analyst workers; each task has a separate Pi Durable conversation linked to shared provenance/accounting. Workers read, estimate and propose; only the coordinator submits guarded decisions. Central budget, liquidity reservations and demand-benefit claims prevent parallel forecasts using the same future revenue. Revalidate snapshot freshness before execution. Configure concurrency limits and record model/quota usage; authentication/quota exhaustion suspends new AI work while deterministic collection/reconciliation continues. GPT-6.1 Sol/high remains the requested model configuration; no silent substitution.

Acceptance: chat stays responsive during corridor analysis; worker crashes cannot resend money; stale/conflicting proposals replan; bounded quota/resource use and latency are measured before expanding the pool.

**M2 — Diagnostics and economic validation: installed and qualified; autonomy resumed. Economic observation windows are ongoing.** Qualified, version-aware LNDg/Lightning Mate adapters provide failed-forward classification and visibility/backfill of external and agent rebalances. Maintain explicit freshness, pagination and coverage; unknown data never becomes zero. Evaluate corridor flows, inventory depletion, observed returns, source opportunity cost, alternative actions and fee competitiveness. Preserve original forecasts and calculation versions while calibrating estimators. Immutable 7/30-day evaluation windows retain predictions and observed outcomes; the 48-hour fee observation window remains enforced. Distinguish manual/confounded interventions, inconclusive experiments and strategy-specific suspension. Report reconciled operating net profit separately from capital, mining, commerce and unclassified costs.

Acceptance: attributable operations/costs reconcile to LND and receipts, adapters fail visibly on incompatible schemas, forecast errors are measurable, and profitability claims identify coverage and causal limits. Technical success, predictive quality and economic result remain separate.

**M3 — Channel lifecycle and Magma.** After explicit capability enablement, support channel qualification, batched openings, cooperative closures, inbound purchase and outbound liquidity sales. Represent contract duration, routing promises, HODL invoices, pending obligations and capital reservations in the same durable accounting/queue. Qualify current official APIs; do not inherit unsupported legacy Lightning Mate seller paths. Include opening/closing/lease costs, inventory opportunity cost and realistic demand in net forecasts. A buyer order does not become earned revenue before settlement/reconciliation. Force closures and unplanned swaps are not implied capabilities.

Acceptance: every contract/funding step has durable intent and receipt, crash/timeout recovery cannot create duplicate channels or payments, reserve and outstanding obligations remain covered, and contract terms survive updates.

**M4 — Telegram.** Add a second interface to the same request queue, decisions and durable memory, accessible only to the linked owner. Support chat, status, pause/resume, job progress and aggregated actionable notifications. Deduplicate notifications, configure quiet periods and preserve access checks; Telegram does not broaden financial limits.

Acceptance: concurrent web/Telegram requests share consistent state, unauthorized senders are rejected, and reconnects do not duplicate jobs or sensitive notifications.

**Ongoing across milestones — Reliability and deployment.** Retain ordinary detailed data 90 days; preserve accounting, decisions, corrections and linked evidence indefinitely. Verify consistent SQLite backups and restore/migration paths, software rollback without operation replay, schema/version gates, bounded retention and immutable amd64/arm64 releases. Expand mocked crash/concurrency tests and bounded real-node qualification within the mandate; no regtest. Monitor authentication, quota, collector freshness, queue age, interlocks and manual interventions.

**Research backlog, outside currently enabled capabilities.** Preserve the historical RoboSats automation idea: compare net swap margins with routing/rebalance costs, investigate safe API/event integration, bonds, settlement and disputes, then propose a separately enabled capability if evidence justifies it. Do not launch trades, swaps or marketplace actions from this research backlog. Other liquidity mechanisms and topology changes remain alternatives to evaluate, not promised profitable operations.

No M3/M4/research operation is implicitly authorized by an M1 agent chat or historical evidence.


### M2 host diagnostic projection and acceptance

The qualified Lightning Mate 0.7.7 backfill tool is `scripts/lm_backfill.py`. It uses
the existing restricted LND read macaroon, verifies successful circular-payment
routes and exact msat totals, and defaults to preview. `--apply` writes no ledger
and sends no payments: it stops only Lightning Mate, rereads its log after the
stock writer stops, preserves a private backup and proof receipt, atomically
merges unique payment hashes, then restarts and verifies persisted contents.
Pending LND payments defer the restart. Stock entries without unique payment
identities remain explicitly ambiguous; they are not duplicated or relabeled.
The stock 200-record cap and any eviction are reported. A host timer at 300-second
intervals was installed and verified: authenticated HTTP log and persisted log
matched at 34 entries. This proves that bounded host capture, not historical
completeness. The updated importer now requires the atomic durable maintenance
claim from the schema 3 executor, which is not deployed yet. Requalify that timer
and its restart/recovery behavior after the 0.2.1 migration before claiming
unattended acceptance of the new path.

Public fee comparison uses host-only `scripts/competition.py` and the qualified
LND 0.21.3 immutable image. The existing diagnostic installer also installs its
180-second timer. It reads GetInfo, ListChannels and GetNodeInfo via fixed host
commands, with three bounded readers and at most 16 peers; the agent receives only
`diagnostics/competition.json` through the existing read-only projection mount.
No extra macaroon, admin credential or Docker socket enters the app. Policies are
selected neighbor→peer, excluding our own edges. Exact base-plus-ppm distributions
at 10k/100k/500k sat use advertised HTLC/capacity/disabled constraints; missing
policies and incomplete/stale captures remain explicit. These prices reveal
neither remote balances nor rival traffic or executable routes. The agent and UI
receive the comparison; it never bypasses forecasts, budgets or observation gates.

`scripts/diagnostics.py` reads the qualified LNDg and Lightning Mate versions on the Umbrel host. It never sends financial RPCs, reads credentials other than the public node binding, or selects personal-payment tables. It opens LNDg SQLite in query-only/read-only mode with a consistent transaction, verifies the selected-table fingerprint and UTC source timezone, and compares selected/returned counts. Unsupported schemas and incomplete bounded captures remain unavailable or incompatible, never zero observations. Lightning Mate attempts/buckets and stock capped rebalance logs remain explicitly partial sources; neither is financial authority.

Install the host watcher with `sh scripts/install-diagnostics.sh /home/umbrel/umbrel/app-data/whirmill-satssurge-autopilot`. It refreshes an atomic mode-0600 `diagnostics/status.json` every 30 seconds using the existing user manager. Qualified source image digests are explicit in the adapter. A future source update must be qualified before changing these gates. App Compose mounts only the projection directory read-only; it does not mount the Docker socket or the source databases. Installed0.2.3 consumes fresh qualified projections; the temporary qualification fence was released after acceptance and autonomy resumed. Schema 3 migration and historical ledger preservation were verified.

Host tests: `python3 -m unittest discover -s scripts/tests -v`. They cover selected-row readonly capture, source-format rejection, exact sat precision, atomic private replacement and exclusion of payment identities. Node tests independently qualify the projection, keep source semantics separate, and reject freshness/identity/version mismatches. The current 0.2.3 CI suite passes 58 Node tests on Node24 and14Python tests. The delayed-completion overlap regression now clones a valid original proposal for its historical evaluation fixture. This corrects the Node 24 SQLite binding failure from the immutable `satssurge-autopilot-v0.2.0` CI run; that release failed before publication and produced no image. Version 0.2.3 has passed CI and is published/installed for amd64/arm64; installed acceptance is recorded below. These cover persistent queue/analyst coordination, schema migration and checkpoint capture, maintenance fencing, version-aware diagnostics and immutable evaluation windows. Live exporter proof remains separate from installed-app acceptance, historical completeness and profitability. M3/M4 are not implemented or enabled.


### Installed qualification — 2026-10-09

Version0.2.3 is installed healthy at immutable OCI index `sha256:8a079bfa201d528b6e2007d1652eba1a683bd3ef4dd67321685a7f8c1a1050e2`, source `66e3c3cd6a1fa99a1432efb729a18b840598864a`, [CI37890628266](https://github.com/whirmill/umbrel-community-app-store/actions/runs/37890628266). Anonymous manifest/config/layer checks qualify both amd64 and arm64. Actual Umbrel UI reports all apps up to date; owner-authenticated Autopilot renders current accounting, diagnostic/competition/evaluation panels and high reasoning without console errors.

A fresh stopped three-database checkpoint and an isolated restore/migration qualify recovery without rolling back live financial receipts. All96 historical ledger rows match the fresh pre0.2.3 checkpoint byte-for-byte through a canonical digest. Three authenticated jobs ran concurrently once with distinct Pi conversations/submissions. The0.2.3 analyst read compact current state, all10 channels/public-price summaries and the final diagnostic record201 with the same page version; upstream coverage remains explicitly partial. Another started run reached its180second deadline and remains terminal without automatic replay. No financial payment was sent merely for acceptance.

The0.2.1 proxy-cookie regression was fixed in0.2.2: relative API calls retain the Umbrel same-origin session while separate owner bearer/CSRF checks remain mandatory. Source0.2.3 adds bounded12KB/20row state pages instead of a large tool response clipped by Pi's50KB output window. Pages preserve acquisition version and unknown coverage; callers restart when the version changes. Oversized individual records fail explicitly; page reads remain subject to the bounded run's30calls/180seconds.

At06:04:57UTC final reconciliation proved zero active qualification jobs/financial pending, fresh bootstrap/proof/snapshot, all14 external operational flags OFF and the confirmed wallet above the500000sat protected reserve. Only the owned `runtime-qualification` claim was released. Owner API and rendered UI then read back autonomy enabled, GPT-6.1 Sol/high, subscription connected, one coordinator and at most two read-only analysts. Qualification changed no mandate and enabled no M3/M4 capabilities. New decisions remain governed by forecasts, shared-benefit claims, reservations and observation gates.

| Requirement through M2 | Verification |
|---|---|
|30k cumulative /1500daily /750exploration /100attempt /500k reserve; immutable mandate|`domain.ts`, atomic `Store.reserve`/dispatch guards; `core.test.ts` contention, daily/exploration/reserve/aggregate-cap tests; live daily/exploration0 and protected reserve UI|
|Prudent ordinary benefit,48h/two-day/ten-forward evidence, finite inventory and source opportunity|`economics.ts` forecast v2 and `executor.ts`; core/evaluation tests preserve exact predictions, shared demand and completion boundaries|
|One financial executor, fresh data, concurrent/manual changes|Async ownership plus process flock, same-inode host guards; invoice-await gate-change tests assert zero sends;14live external automation flags OFF|
|Crash/timeout/uncertain sends never replay money|Core crash/uncertain-send reconciliation tests; real Pi Durable SIGKILL unsafe-tool recovery preserves one effect/original submission; live terminal model error/deadline receipts preserved|
|Negative/inconclusive strategy suspension and48h fee windows|Strategy/evaluation/core tests require new conditions/hypotheses;7/30day windows preserve revisions, confounding and original forecasts|
|Durable SQLite queue and bounded analyst pool|Queue/scheduler tests cover duplicate IDs, leases, backpressure, priority aging, shutdown and concurrent pump; authenticated live one coordinator/two analyst overlap|
|Model unavailable continuity and subscription-only auth|Pi model-error receipt/cooldown tests and actual outage/recovery; collectors/interlocks/reconciliation continue; no paid-key fallback; model Sol/high verified|
|Historical accounting/provenance, private evidence, exact units, unknowns|82documents/47expense entries imported idempotently;96ledger rows preserved; exact msat/SCID and source-version tests; private evidence checksum manifests; partial result explicit|
|90day ordinary details; permanent accounting/decisions/evidence|`Store.retain`, pinned retention/aggregate tests; stored acquisition/event UTC and coverage/calculation versions|
|Qualified LNDg/Lightning Mate diagnostics and continuous rebalance visibility|14host tests plus Node adapter tests; live201LNDg attempt rows/34nativeLM log records; four persistent active watcher timers, unknown upstream coverage explicit|
|Public fee competitiveness without inferred rival demand|Competition tests and real analyst readall10 peers; ACINQ missing policies retained; graph-only prices never prove liquid routes or competitor volume|
|Immutable forecast/outcome evaluation7/30days|Evaluation tests cover maturity, original forecasts, corrections, manual/overlap confounding, liquid comparable observation and negative suspension; UI shows no window matured yet|
|Owner web chat/state/accounting/budget/decisions/experiments/pause|Shipped web-script tests plus installed authenticated rendering; queue job/result receipts and owner bearer/origin/CSRF boundaries verified|
|amd64/arm64 immutable publication, update preservation and recovery|CI58Node/14Python, both OCI platform configurations match exact source; installed digest/health, threeDB backup/isolated restore, ledger digest preservation|

The economic result remains explicitly partial; exact private financial figures and runtime receipts are retained locally in `autopilot-m2-acceptance-20261009.json`, outside Git. Future7/30day evaluation observations have not matured; technical qualification does not certify profitability or historical completeness. M3 channels/Magma and M4Telegram remain separate, explicitly enabled future milestones. No regtest was used.
