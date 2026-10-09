# SatsSurge Autopilot

Current accepted version `0.3.3` includes M2.1. M1.1/M1.2/M2 were introduced in version `0.2.3` on the M1 mainnet POC using Pi Durable 1.1.0 and subscription-only ChatGPT OAuth. Reasoning effort is explicitly `high`, visible in the model section and applied to every agent run. No regtest, paid API fallback, shell tool, unrestricted RPC, channel opening, close, swap or Magma transaction is exposed to the agent.

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

**M1 — Foundation: deployed, qualified and autonomous; economic validation ongoing.** The M1 acceptance baseline was version 0.2.3; Pi Durable uses GPT-6.1 Sol/high with subscription OAuth. Private historical import/accounting, LND collector, guarded fee/rebalance executor, web chat, pause/resume, restricted credentials, persistent host interlock and immutable multiarchitecture images are in place. Current CI passed 58 Node / 14 Python tests, including simulated financial crash/recovery and real Pi Durable registry/storage behavior. Real authenticated AI runs succeeded; the first high run completed without a financial operation. This proves AI/read execution, not real-node financial recovery or profitability. Accounting coverage remains partial.

**M1.1 — Persistent request queue: installed; authenticated concurrent execution and browser acceptance qualified.** A SQLite queue now accepts chat, scheduled analysis and aggregated Lightning events instead of rejecting busy requests. Jobs retain request IDs, type, priority, channel/corridor scope, snapshot version, state, result, attempts and timestamps. Claim work atomically before any asynchronous boundary; recover leases after crashes without replaying uncertain financial sends. Show accepted/queued/running/waiting/completed/failed/cancelled states in the UI. Bound backlog and rate; coalesce duplicate event bursts and stale periodic analyses. Pause and deterministic reconciliation bypass AI backlog. Prefer owner requests while preventing maintenance starvation. Existing financial intents/reservations remain the authoritative execution record, not a fresh send on job retry.

Acceptance: simultaneous chat/scheduler/event requests are neither lost nor double-run; restart retains queued jobs/results; duplicate IDs are idempotent; paused/auth-unavailable jobs behave explicitly; uncertain sends reconcile before new work. Measure wait time, queue age and failure/recovery counts.

**M1.2 — Bounded analyst pool: installed; one coordinator and two analysts executed concurrently, browser acceptance qualified.** The persistent queue runs one coordinator and one financial executor, with at most two concurrent read-only analyst workers; each task has a separate Pi Durable conversation linked to shared provenance/accounting. Workers read, estimate and propose; only the coordinator submits guarded decisions. Central budget, liquidity reservations and demand-benefit claims prevent parallel forecasts using the same future revenue. Revalidate snapshot freshness before execution. Configure concurrency limits and record model/quota usage; authentication/quota exhaustion suspends new AI work while deterministic collection/reconciliation continues. GPT-6.1 Sol/high remains the requested model configuration; no silent substitution.

Acceptance: chat stays responsive during corridor analysis; worker crashes cannot resend money; stale/conflicting proposals replan; bounded quota/resource use and latency are measured before expanding the pool.

**M2 — Diagnostics and economic validation: installed and qualified; autonomy resumed. Economic observation windows are ongoing.** Qualified, version-aware LNDg/Lightning Mate adapters provide failed-forward classification and visibility/backfill of external and agent rebalances. Maintain explicit freshness, pagination and coverage; unknown data never becomes zero. Evaluate corridor flows, inventory depletion, observed returns, source opportunity cost, alternative actions and fee competitiveness. Preserve original forecasts and calculation versions while calibrating estimators. Immutable 7/30-day evaluation windows retain predictions and observed outcomes; the 48-hour fee observation window remains enforced. Distinguish manual/confounded interventions, inconclusive experiments and strategy-specific suspension. Report reconciled operating net profit separately from capital, mining, commerce and unclassified costs.

Acceptance: attributable operations/costs reconcile to LND and receipts, adapters fail visibly on incompatible schemas, forecast errors are measurable, and profitability claims identify coverage and causal limits. Technical success, predictive quality and economic result remain separate.

**M2.1 — Responsive web UI/UX: installed and accepted in 0.3.3 on 2026-10-09.** Migrate the vanilla frontend to React + TypeScript + Vite + shadcn/ui. Retain Pi Durable, subscription OAuth, the durable queue and single guarded financial executor. Design mobile/tablet/desktop chat, activity, node state, budgets, accounting, decisions, experiments and pause/resume, with accessible navigation/focus, Italian monetary formatting, Markdown/code rendering and explicit loading/empty/error/offline states. This milestone does not change financial authority or the mandate.

Preferred chat candidate: **assistant-ui**, to qualify with an integration spike against actual Pi Durable events. Its custom runtimes accept an existing backend: assess ExternalStoreRuntime/AssistantTransport for durable jobs and structured agent state, or a custom adapter/data stream for message deltas. **Vercel AI Elements** is the alternative shadcn-based component set, including Conversation, Reasoning and Tool. Keep Pi as the agent backend; a UI library does not require adopting a second agent framework. Official sources checked 2026-10-09: [custom runtimes](https://www.assistant-ui.com/docs/runtimes/custom/overview), [stream protocol](https://www.assistant-ui.com/docs/runtimes/custom/data-stream), [Assistant Transport](https://www.assistant-ui.com/docs/runtimes/custom/assistant-transport), [tool rendering](https://www.assistant-ui.com/docs/tools/tool-ui), [AI Elements Reasoning](https://elements.ai-sdk.dev/components/reasoning), [AI Elements Tool](https://elements.ai-sdk.dev/components/tool). Pin compatible versions and verify licenses during the spike; documented support is not installed integration proof.

Expose authenticated SSE or a qualified equivalent over backend-owned durable events: text deltas, available explanatory progress/reasoning summaries, tool-call IDs/arguments/results, worker identity, decision receipts and accurate queued/running/waiting/completed/failed/cancelled states. Show expandable tool cards and linked evidence; separate model explanation from deterministic execution audit. Display only summaries actually exposed by the provider, never invented reasoning or hidden chain-of-thought. Bound/redact payloads, render untrusted content safely and retain credentials/provider access server-side. Preserve same-origin owner authentication; use authenticated fetch streaming rather than bearer tokens in SSE URLs.

Reconnect with durable event IDs/cursors, snapshot resynchronization, deduplication and explicit coverage gaps. Queue acceptance must not depend on keeping a stream open. Reloads, disconnects and repeated submissions must not repeat financial effects; disconnect is not payment cancellation. Explain queued-job cancellation separately from already-started operation reconciliation. Attribute concurrent coordinator/analyst work to its conversation. Fix the observed stale “In coda” status after completion and add follow-latest scrolling that respects reading older messages, with a new-message indicator.

Acceptance: visible browser checks on mobile/tablet/desktop, keyboard/screen-reader access, concurrent requests, long histories, streamed tool results, empty/failed/expired-auth states and accurate job transitions. Verify interrupted streams/reconnect/reload without missing or duplicate messages or effects, preserving conversation, OAuth, mandate and pending receipts through deployment. Use actual Pi read-only prompts for text/tool-event integration and gracefully handle providers without reasoning summaries. Release immutable amd64/arm64 images through the existing workflow; no financial send is required solely to test presentation.

**M3 — Channel lifecycle and Magma.** After explicit capability enablement, support channel qualification, batched openings, cooperative closures, inbound purchase and outbound liquidity sales. Represent contract duration, routing promises, HODL invoices, pending obligations and capital reservations in the same durable accounting/queue. Qualify current official APIs; do not inherit unsupported legacy Lightning Mate seller paths. Include opening/closing/lease costs, inventory opportunity cost and realistic demand in net forecasts. A buyer order does not become earned revenue before settlement/reconciliation. Force closures and unplanned swaps are not implied capabilities.

Acceptance: every contract/funding step has durable intent and receipt, crash/timeout recovery cannot create duplicate channels or payments, reserve and outstanding obligations remain covered, and contract terms survive updates.

**M4 — Outbound webhook notifications, Discord first.** Replaces the Telegram bot milestone by user instruction on 2026-10-09. The responsive web app remains the sole owner interaction/control interface. Deliver notifications to a configured Discord webhook first, with a versioned generic webhook payload as a later extension. No Discord bot, inbound webhook, slash command, reply handler, remote action button or financial/control capability is included. Receiving or replying to a notification cannot create a job, change a policy, pause/resume the app or execute an operation; links only navigate to the authenticated web app.

Notify significant completed operations, actionable failures, authentication/quota blockers, budget/reserve warnings and scheduled economic summaries. Allow owner-selected categories, severity, aggregation and quiet periods, with critical alerts handled explicitly. Send concise summaries and authenticated app links, not full chat, model reasoning, raw tool results, personal-payment details or credentials. Keep the webhook URL private server-side, redact it from logs and exports, and make configuration/test/disable available only through owner-authenticated settings. Network targets require validation against SSRF; a destination configured by the owner is not a URL the agent can rewrite.

Use a durable notification outbox with stable event IDs, bounded retry/backoff, rate-limit handling, delivery receipts and visible failed/uncertain delivery. Notification failures do not retry financial operations or stop deterministic reconciliation. Deduplicate event generation and aggregate bursts; do not promise exactly-once external delivery after an uncertain timeout. Generic webhook receivers can deduplicate by event ID; Discord retries need an explicit duplicate-risk policy. Acceptance: a mocked/test destination verifies payload redaction, category filters, quiet periods, crash recovery, rate limits and timeout behavior; owner-authorized live test verifies Discord delivery. Confirm there is no inbound control surface and a reply cannot reach the agent. No Telegram integration remains planned.

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

Host tests: `python3 -m unittest discover -s scripts/tests -v`. They cover selected-row readonly capture, source-format rejection, exact sat precision, atomic private replacement and exclusion of payment identities. Node tests independently qualify the projection, keep source semantics separate, and reject freshness/identity/version mismatches. The historical 0.2.3 CI suite passes 58 Node tests on Node24 and14Python tests. The delayed-completion overlap regression now clones a valid original proposal for its historical evaluation fixture. This corrects the Node 24 SQLite binding failure from the immutable `satssurge-autopilot-v0.2.0` CI run; that release failed before publication and produced no image. Version 0.2.3 has passed CI and is published/installed for amd64/arm64; installed acceptance is recorded below. These cover persistent queue/analyst coordination, schema migration and checkpoint capture, maintenance fencing, version-aware diagnostics and immutable evaluation windows. Live exporter proof remains separate from installed-app acceptance, historical completeness and profitability. M3/M4 are not implemented or enabled.


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

The economic result remains explicitly partial; exact private financial figures and runtime receipts are retained locally in `autopilot-m2-acceptance-20261009.json`, outside Git. Future7/30day evaluation observations have not matured; technical qualification does not certify profitability or historical completeness. M3 channels/Magma and M4 outbound webhook notifications remain separate future milestones; channel/Magma operations require explicit capability enablement. No regtest was used.

### M2.1 React workspace

The web client uses React 19, TypeScript, Vite and shadcn/ui conventions (Radix
Slot/CVA Button), with assistant-ui's ExternalStoreRuntime as the qualified primary
chat adapter. Pi Durable remains the sole runtime and backend tool authority;
GPT-6.1 Sol/high and subscription OAuth are unchanged. assistant-ui 0.15.25 is MIT.
AI Elements 1.9.0 (Apache-2.0) remains the alternative: its documented React 19,
Next.js/AI SDK setup has not been qualified against this standalone Vite/Pi
backend. See [assistant-ui external store](https://www.assistant-ui.com/docs/runtimes/custom/external-store)
and [AI Elements setup](https://elements.ai-sdk.dev/docs/setup).

Schema 4 adds a durable, sanitized UI event journal and immutable message entries.
Owner-authenticated same-origin fetch SSE carries numeric event cursors; history
loads 50 jobs per page. Reconnection replays missing IDs and deduplicates them;
refresh recovers canonical receipts without resubmitting accepted jobs. Only
provider-visible assistant text, actual progress and tool calls/results are
projected. Hidden thinking and raw provider errors are excluded; no reasoning
summary is invented. Tool payloads are bounded and credential fields redacted.
Markdown skips raw HTML, rejects executable links and suppresses remote images.
Queued or unsubmitted waiting jobs can be cancelled; submitted Pi work is not
advertised as cancellable. Terminal receipts determine completed state.

`npm test` builds both clients and runs simulated provider/HTTP/queue regressions.
`UI_FIXTURE_DIR=/tmp/isolated-dir node scripts/ui-fixture.mjs` serves the local-only
browser fixture on 127.0.0.1:19538 (password `fixture-only`); it is excluded from
production images and performs no financial operations. Installed acceptance and
immutable image receipts are recorded in the implementation handoff.

### Installed M2.1 acceptance — 2026-10-09

Previously qualified release **0.3.1** ran healthy on Umbrel amd64, pinned to OCI index
`sha256:1f3ac8c0481fae8ae98625bb7bc47d5936a01afdbb87f510d8b7c20aa5483915`,
source `719c20be7916440b2a9b6b8b565e9081a6c7e0f2`. [CI37900459290](https://github.com/whirmill/umbrel-community-app-store/actions/runs/37900459290)
passed70Node24/15Python; both architecture manifests/configs and all22layers were
verified by anonymous download and SHA256. The installed HTTP origin exposed
randomUUID's secure-context restriction in0.3.0;0.3.1 uses getRandomValues IDs and
retains durable retry identity. Neither immutable release was overwritten.

Visible installed browser acceptance covered owner login/session/logout, actual
concurrent coordinator/two analyst jobs with readonly node_state tools, terminal
states/cancellation, SSE reconnect/refresh and restart with queued original IDs,
long history, safe rendering, controls, keyboard focus/tool expansion and
390/768/1440px reflow. Three test jobs completed once with21/26/18text updates and
one tool call/result each. A20second slow SSE reader received428ordered events
without duplicates; console errors were absent. An independently admitted queued
owner test was preserved across update/restart and completed once.

Fresh stopped/flock-protected threeDB checkpoints pre030/pre031 were verified
remotely and privately on Mac; isolated restore migrated3→4. Original96ledger
rows/33terminaljobs,85historyfiles, model/mandate/owner credential remained exact.
OAuth remained connected and Sol/high unchanged. After zero active qualification
work/financial pending, only the owned financial fence was released; all four
host watcher timers and initial autonomy enabled were restored and read back.
There were zero financial tool calls or operations for this acceptance, and no
regtest. Private receipts/screenshots are outside Git.

Residuals: VoiceOver was not exercised; bundle approximately199KB gzip. Two
scheduled analyst jobs reached the existing bounded run deadline; they remain
terminal with their original receipts and no automatic replay. No public reasoning
summary was available in this Pi event projection; hidden thinking is excluded.
Accounting remains partial and M3/M4 remain outside this release.

La UI0.3.2 aggiunge colori semantici, distribuzione locale/remota della liquidità e barre per canale con filtro e ordinamento, ricavi/costi, budget, confronto delle commissioni e stati della coda. Dettagli tecnici e risultati dei tool restano apribili. I grafici usano dati osservati e importi esatti; copertura parziale e valori non disponibili sono espliciti.

La0.3.3 sostituisce il polling del journal SSE a500ms con un EventEmitter condiviso per Store, notifiche post-COMMIT e generatori asincroni con cursore SQLite autorevole. Il frontend consuma lo stream fuori da React con decodifica incrementale, replay e cleanup. Heartbeat15s, scadenza owner, backpressure limitata e refresh dello stato5s restano separati. Test Node24:84PASS; Python15PASS; qualifica installata completata per 0.3.3.

### Installed visual and reactive qualification — 0.3.3

Installed on Umbrel with immutable index `sha256:dea14693bda4ec9337216636c250ab81e09dab5d861ef9ccac3558f6f56c3af4`, source `1a0481580cfa9cc702558d982cabe7476ba1c4fa`. CI run 37906474987 passed 84 Node 24 and 15 Python tests. Both architectures and all 22 layers were verified.

The visible in-app browser qualified concurrent read-only Pi requests, incremental text and tools, refresh, restart and session invalidation, original receipt preservation, queued cancellation, long-history deduplication and responsive charts. No financial operation or regtest was used. A consistent three-database checkpoint was verified before the update. Original ledger rows, history, mandate, OAuth and owner credentials were preserved; initial autonomy and timers were restored.

Slow-client timeout and timed session expiration have simulated test coverage plus production source review; natural eight-hour expiration was not observed by waiting. Optional HTLC, page and Pi adapters, and massive exports, remain future candidates. Five-second status polling remains separate. Private screenshots and acceptance receipts are retained outside Git.

### 0.3.4 review remediation — published and installed accepted

Version 0.3.4 addresses the dispatch budget/reserve race and seven recovery,
retention, admission, presentation, authentication, shutdown and backfill
findings. Dispatch rechecks the active reservation exactly once, fresh
interlocks and protected on-chain obligations immediately before RPC. Queue
successors and recovering originals retain their request/conversation/submission
identities; expired event tombstones prevent duplicate aggregation. Oversized
drafts are editable before admission; uncertain admitted requests retain their
nonce, including legacy oversized drafts that may already have been admitted.
Recovery clears original coalescence keys without changing receipt identities.
The history cache retains at most 250 completed jobs plus all active receipts,
preserves the selected older page, and supports returning to recent history;
older server pages remain reachable. Bounded UI details preserve current
snapshots and authoritative receipts.
Logout revokes the server bearer, `flock --no-fork` forwards shutdown to Node,
and unchanged retained Lightning Mate projections avoid maintenance/restart.

Schema remains 4 and persistent data mounts are unchanged. Node 24 regression
suite passed 95 tests and Python passed 16 tests on the final 0.3.4 source.
A visible local 350-job fixture verified editable oversized input followed by
valid admission, seven older pages reaching the oldest entry, the bounded
250-job/500-message history window, and return to recent history with 100
messages, latest content visible and the limit notice released. Console errors
were absent. This is fixture proof; installed qualification is recorded below.

### Installed qualification — 0.3.4, 2026-10-09

Umbrel amd64 runs healthy 0.3.4 at immutable index
`sha256:f8eeca46bacdaa69b046530a2821886b818289ba962ec077193b3caffea42c32`,
source `a3fad86bad3ae86ebc3798ea34d17fb609012770`.
[CI 37912510129](https://github.com/whirmill/umbrel-community-app-store/actions/runs/37912510129)
passed 95 Node 24 and 16 Python tests. Anonymous index, both platform configs
and all 22 layers passed SHA-256/size checks; both configs use `flock --no-fork`.
All nine review findings and the additional bounded terminal-history cache are
addressed. Schema remains 4.

The stopped/flock-protected `pre-034-review-fixes-20261009` three-database
checkpoint passed host/Mac SHA, SQLite checks and isolated restore. All baseline
101 ledger rows, 71 terminal jobs and 85 history files were preserved by ID;
natural later revenue rows remain valid additions. Owner/password digest,
mandate, OAuth, model and Sol/high were preserved.

Three owned visible read-only Pi requests each completed once with one
submission and a node_state call; a fourth was cancelled while queued with zero
attempts/submissions. Refresh showed 166 messages with the original request
once; reconnect worked. Owner logout revoked a copied bearer (401), closed
idle SSE and retained Origin/CSRF rejection (403). Live 17000-character input
validation left the draft editable. Local 350-job fixture evidence separately
qualified older-page navigation, the 250-terminal-job/500-message window and
return to 100 recent messages. Installed 390/768/1440 layouts had no document
overflow; console errors/warnings were empty, re-login and keyboard Enter passed.

Synthetic active-job SIGTERM exited 0 with drained=true and an exclusive lock.
The real restart reached its bounded 25-second drain limit for three existing
background jobs: original request/conversation/submission receipts survived in
waiting recovery and were enabled for reconciliation. This does not prove all
live jobs drained. No uncertain operation was resubmitted for acceptance.

Fresh final preservation readback confirms all three previously submitted
background jobs completed after reconciliation with unchanged original request,
conversation and submission IDs: attempts advanced from 1 to 2 while submitted
remained 1. A fourth previously queued autonomy job naturally acquired its first
IDs; it was not replayed after restart. All 101 baseline ledger rows, 71 terminal
jobs, 85 history files, password, mandate, model and installedAt remained
preserved; financial operations remained zero, enabled=true and claim=null.
All four satssurge-autopilot backfill/diagnostics/interlock/competition timers
were active; the final 20-minute backend window had zero MaxListenersExceeded,
unhandledRejection or uncaughtException entries.

Umbrel retained the old host backfill script during update; the official
`install-backfill.sh` installed the corrected script (SHA-256
`4656b9de7c7a9d26b2ad8dac336fee056e63980f123143ef392505e57c53a1b3`).
Installer service exited successfully; all four initial timers were active.
Final readback: enabled=true, maintenanceClaim=null, bootstrapReady=true and
zero financial operations/pending financial operations. No financial tests,
regtest or M3/M4 expansion occurred.

Global journal retention and per-result byte limits remain future work;
tombstones do not rewrite old aggregates whose detail already expired.
VoiceOver was not tested; timed expiry has simulated coverage. Private receipts
are under `/Users/whirmill/.local/share/satssurge`; screenshots are in its
`screenshots/` directory: `034-umbrel-installed.jpg`, `034-pi-stream.jpg`,
`034-nodo-installed.jpg`, `034-nodo-mobile.jpg`. Current financial receipts must
be preserved during recovery; a checkpoint never authorizes replay or erasure.

### 0.3.5 source preparation — publication and installed qualification pending

The current accepted installed release is 0.3.4. Package and root lockfile
versions are 0.3.5; Umbrel manifest and compose remain on verified 0.3.4 until
new image verification, then will be published together.

The new source adds bounded immutable evidence views with explicit completeness,
persistent research/finalization budgets across submitted recovery, truthful
analysis origin/purpose and nonfinancial review-wait triggers. Public reasoning
includes only qualified provider summaries; raw thinking and signatures stay
private. Authenticated lazy details and full-answer pages preserve original
receipts. GFM tables, grouped disclosures, bounded virtual history and persistent
System/light/dark themes improve presentation without deleting private history.
Financial mandate/executor/receipt identity and schema 4 remain unchanged.

Independent review approved the stable source. Local Node 24 suite passed 112
and Python passed 16 tests; final build/typecheck passed. Visible heavy fixture
qualified 24 responsive cases, computed dark contrast, concurrent requests,
queued cancellation, reconnect, simulated expiry, refresh and process restart.
These are local fixture proofs, not installed 0.3.5 acceptance or comparative
performance savings. Native iOS keyboard/pinch behavior and VoiceOver remain
unverified. No financial tests, regtest or M3/M4 expansion were introduced.

Next: tested-source Git/tag handoff for `satssurge-autopilot-v0.3.5`, CI and
anonymous amd64/arm64 index/config/all-layer verification, combined manifest/
compose publication, fresh verified checkpoint, installed read-only Pi/browser
acceptance and original autonomy/timer restoration. Preserve current financial
receipts and pending operations; never restore old accounting to retry effects.

### 0.3.5 immutable publication verified — installed acceptance pending

Source `13f43facfc061d22db2b1c878aab4c4f1bef7905`, tag
`satssurge-autopilot-v0.3.5`, [CI 37929672372](https://github.com/whirmill/umbrel-community-app-store/actions/runs/37929672372)
passed 112 Node24 and 16 Python tests. Verified image:
`ghcr.io/whirmill/umbrel-satssurge-autopilot:0.3.5@sha256:b4c9d4e75c52ddccd2d22b05ff64308a5c72b3a37d51f9be8d1d1d983f6a7846`.
Anonymous index, both architecture configurations and all 22 layers passed
SHA-256 and size checks (218076698 compressed bytes). Both configs match source
and use `flock --no-fork`; package.json extracted from image layers confirms
0.3.5. Private receipt: `/Users/whirmill/.local/share/satssurge/image-035-receipt.json`.
Umbrel manifest and compose are now prepared together for this verified image.
Current accepted installed release remains 0.3.4: fresh checkpoint, installed
0.3.5 read-only Pi/browser qualification and operational reconciliation are
pending. Previous immutable releases remain intact; original receipts must be
preserved without financial replay.

### 0.3.6 terminal presentation patch — source ready, installed acceptance pending

Immutable 0.3.5 was published and installed. Actual browser qualification found
terminal failed jobs with no text still displaying active-wait/partial wording
and an expanded raw error. Its earlier publication checkpoints are historical;
0.3.5 is superseded as the delivery target by this 0.3.6 correction, whose
publication and installed acceptance are pending.

0.3.6 derives terminal wording from recorded job state and actual public text:
failed without text is “Non completata · nessun testo disponibile”; failed with
text is partial, and cancelled/completed empty responses retain their true
states. Terminal rows suppress stale progress/wait placeholders. Conversation
and Activity expose original sanitized errors only through collapsed lazy
“Dettaglio errore”, escaped as text. No cause is inferred from an error string;
private receipts and qualified public summaries remain unchanged.

Review approved the patch; Node24 tests/build/typecheck passed 113/113. Existing
Python16 checkpoint applies because Python is unchanged. Visible 320px terminal
fixture passed. Existing 0.3.5 improvements remain: scoped evidence, persisted
run budgets, virtual history, GFM, public summaries and themes, 16px mobile
focus controls, 320px overflow correction, safe areas and manual zoom permitted.
Desktop reduced-height focus checks do not prove native iOS keyboard/pinch
behavior, VoiceOver or heap savings. No financial tests/regtest/M3/M4 expansion.

Package/root lock versions are 0.3.6. Manifest/compose remain on immutable
0.3.5 until the new amd64/arm64 image is fully verified, then publish both
metadata files together. Primary owns verified checkpoint, installed read-only
Pi/browser acceptance and original autonomy/timer restoration. Preserve original
financial pending/completed receipts; do not replay effects or restore old
accounting over current state.

### 0.3.6 immutable publication verified — installed acceptance pending

Source `32a2d0feaa9313146864ba9e163227298548a688`, tag
`satssurge-autopilot-v0.3.6`, [CI 37932221537](https://github.com/whirmill/umbrel-community-app-store/actions/runs/37932221537)
passed 113 Node24 and 16 Python tests. Verified image:
`ghcr.io/whirmill/umbrel-satssurge-autopilot:0.3.6@sha256:4faff07dec9f6f8a794d8f33cd2c367b856e5c39549c21a7d25e401e8786c3ce`.
Anonymous index, both architecture configs and all 22 layers passed SHA-256 and
size checks (218087053 compressed bytes). Configs match source and use
`flock --no-fork`; extracted image package version is 0.3.6. Private receipt:
`/Users/whirmill/.local/share/satssurge/image-036-receipt.json`.
Manifest and compose are prepared together for this verified new patch.
Actual installed 0.3.6 Pi/browser qualification and final operational
reconciliation remain pending; the earlier installed 0.3.5 presentation defect
is corrected in source but is not yet claimed qualified on the installed patch.
Preserve original financial receipts and pending operations without replay.

### 0.3.7 lazy disclosure patch — source ready, installed acceptance pending

Immutable 0.3.6 is installed but not accepted as the final delivery: closed
Activity details still mounted 85 Markdown descendants (10028 DOM nodes).
0.3.7 supersedes that delivery target. Its shared lazy disclosure boundary mounts
Activity payload/Markdown/tools only while open and unmounts them when closed.
Indexed answer text avoids repeated whole-projection scans. Node “Fonte e
acquisizione” likewise gates its body, including previously opened nested JSON;
outer provider expansion persists across navigation and nested JSON remounts
closed. Original receipts, schema 4, mandate and financial executor are unchanged.

Review approved; local Node24 tests/build/typechecks passed 114/114. Python is
unchanged (preceding16/16 checkpoint). Visible 3006-job fixture: 50 closed
Activity rows had zero Markdown/payload/pre descendants and 635 DOM nodes;
opening rendered one Markdown body and Enter closing removed it. Node outer/
nested JSON with 80773 characters unmounted all hidden pre/nested JSON on Enter
closing. Console capture was empty; tab18 closed and fixture80755 exited130.
These are local mounting/DOM proofs, not comparative heap or latency savings.

Earlier actual 0.3.6 qualification completed three read-only Pi requests once
with two read tools each (29.815/32.577/30.094s), observed coordinator1/analysts2,
and public summary90/87 events on the first two (none on the third). Six natural
autonomy jobs completed in117–146s; zero financial operations. Baseline107ledger,
116 original terminal jobs,85history and mandate/owner were preserved. Actual
24 responsive cases at320/390/768/1440,16px fields,44px buttons, no overflow,
System/light/dark and empty console passed. This evidence does not qualify the
new installed0.3.7 lazy boundary. Native iOS,VoiceOver and heap remain unproven.
Original autonomy=true remains paused with ownedplan035claim and backfill stopped
until primary's final acceptance; no permission to release that fence is inferred.

Package/root lock versions are0.3.7; catalog manifest/compose remain0.3.6 until
new anonymous amd64/arm64 image verification, then publish metadata together.
Primary owns checkpoint, installed0.3.7 lazy/Pi/browser acceptance and final
original autonomy/timer restoration. No financial test/regtest/M3/M4 expansion.
