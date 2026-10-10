# SatsSurge Autopilot

Current installed and accepted release is `0.4.4` (schema 5), with dedicated owner login and visible session logout. The Telegram-first release is `0.4.5` (schema 6), with immutable publication verified; installed acceptance is recorded separately below. Original autonomy and all four watcher timers are restored after reconciliation. Earlier acceptance records below remain historical. Pi Durable 1.1.0 uses subscription-only ChatGPT OAuth. Model and supported reasoning effort are selectable through the unified composer and Settings, defaulting to GPT-6.1 Sol/high; submitted recovery retains its original configuration. No regtest, paid API fallback, unrestricted RPC, channel lifecycle or Magma transaction is exposed to the agent.

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

**M2.2 — Telegram as the daily owner interface.** Implemented in source; installation and live Telegram delivery are not qualified. The bot runs in the existing container using outbound `getUpdates` long polling; no inbound public endpoint is required. Web retains settings, budgets, permissions, detailed receipts and owner authentication. Configure the private token in web settings, generate a one-use five-minute code, send `/start CODE` in the bot's private chat, then confirm the identified numeric account in web. A single account is bound. Revocation invalidates binding, codes, buttons and pending proposals while existing effects keep their original reconciliation path. Discord is not implemented.

Natural chat and `/status`, `/analyze`, `/pause`, `/resume`, `/proposals`, `/help` share the existing agent, jobs and history. Plain Telegram chat is read-only; an explicit request for a proposal to review allows typed fee/rebalance proposal creation. Existing permitted scheduled autonomy remains autonomous. Telegram cannot change the mandate, budgets or configuration. Resume requires an explicit summary button and fresh guards. Proposals show endpoints, amount, maximum cost and reason; approval is shared with web, atomically consumed, expires after five minutes and is invalidated by changed conditions. Immutable intent and operation correlation precede RPC dispatch; uncertainty never causes automatic financial replay.

Durable inbound records commit before the polling offset advances. Stable outbox event IDs deduplicate capture of Telegram replies, operation outcomes and critical blockers. Notification outage leaves autonomy and deterministic reconciliation running. Ordinary results aggregate in the daily 09:00 Europe/Rome digest, with DST-aware day identity and recovery aggregation. Quiet time is 22:00–08:00 for unsolicited messages; critical blockers and owner-requested replies bypass it. Proposals delayed by quiet time require fresh validation before delivery, and their expiry starts on successful delivery. Rate-limit rejections retry with backoff, at most five attempts; timeout/interrupted sends remain visibly uncertain and are not automatically replayed. External delivery is not claimed exactly once. The adapter admits requests into the same Pi Durable 1.1.0 queue, conversations and native `satssurge` extension registry. `create_manual_proposal` is a guarded native tool; `execute_decision` remains autonomous-only. Coding-agent plugins such as pi-telegram/pi-chat target a different extension API and are not loaded into this Durable harness; no second agent session is created. Token stays in `telegram.secret` mode 0600, separate from SQLite and database exports; preserve it separately for full installation recovery.

**M3 — Independence from complementary apps: future, separate release.** Current LNDg/Lightning Mate adapters and interlock remain unchanged. Qualify direct LND collection, safety gates, coverage and accounting before allowing installation without those complementary apps. This Telegram release does not remove existing prerequisites.

**M4 — New channels and external liquidity: future, separate capabilities.** Channel qualification, batched openings, closures and contracts require separately reviewed authority and durable accounting. RoboSats, Amboss and Magma each require independent API, bond/contract, settlement, recovery and economics qualification. No channel, marketplace, swap, trading or lease action is enabled by this release. Include costs, obligations, reserves and inventory opportunity cost in forecasts; receipt of a buyer order does not establish earned revenue.

**Ongoing across milestones — Reliability and deployment.** Retain ordinary detailed data 90 days; preserve accounting, decisions, corrections and linked evidence indefinitely. Verify consistent SQLite backups and restore/migration paths, software rollback without operation replay, schema/version gates, bounded retention and immutable amd64/arm64 releases. Expand mocked crash/concurrency tests and bounded real-node qualification within the mandate; no regtest. Monitor authentication, quota, collector freshness, queue age, interlocks and manual interventions.

**Research backlog, outside currently enabled capabilities.** Preserve the historical RoboSats automation idea: compare net swap margins with routing/rebalance costs, investigate safe API/event integration, bonds, settlement and disputes, then propose a separately enabled capability if evidence justifies it. Do not launch trades, swaps or marketplace actions from this research backlog. Other liquidity mechanisms and topology changes remain alternatives to evaluate, not promised profitable operations.

No future M3/M4/research operation is implicitly authorized by an M1 agent chat or historical evidence.


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

### 0.3.8 immutable publication verified — installed acceptance pending

Source `566dfcd4c295becef8a7d68b42e57bdde149e47d`, tag
`satssurge-autopilot-v0.3.8`, [CI 37942146614](https://github.com/whirmill/umbrel-community-app-store/actions/runs/37942146614)
passed 139 Node24 and 16 Python tests. Verified image:
`ghcr.io/whirmill/umbrel-satssurge-autopilot:0.3.8@sha256:129d0cb546bc22d99088e42df5fa1b0c2c4b0376ebc89e3f31c066b5d6246cf7`.
Anonymous index, both configs and all 22 layers passed SHA-256/size checks
(218115925 compressed bytes). Configs match source and use `flock --no-fork`;
extracted image package version is 0.3.8. Private receipt:
`/Users/whirmill/.local/share/satssurge/image-038-receipt.json`.
Manifest and compose are prepared together for this verified release; immutable
0.3.7 remains published but skips installation. Actual installed 0.3.8 browser/
Pi/natural economic closure, checkpoint/reconciliation and original autonomy/
timer restoration remain primary-owned and pending. Current owned pause/fence
is preserved until acceptance; financial receipts must never be replayed.

### 0.3.9 immutable publication verified — installed acceptance pending

Source `ceabd7d9b1ddc4394e53b61a98daa2d3f08ce6a3`, tag
`satssurge-autopilot-v0.3.9`, [CI 37947859261](https://github.com/whirmill/umbrel-community-app-store/actions/runs/37947859261)
passed 146 Node24 and16Python tests. Verified image:
`ghcr.io/whirmill/umbrel-satssurge-autopilot:0.3.9@sha256:4a1d676d2c2b82db3a9e9a13fcdd6e82f2d79096ce0d79732b96d689e18d53dc`.
Anonymous index, both configs and all22layers passed SHA-256/size checks
(218127800 compressed bytes). Configs match source and use `flock --no-fork`;
extracted image package version is0.3.9. Private receipt:
`/Users/whirmill/.local/share/satssurge/image-039-receipt.json`.
Manifest and compose are prepared together for verified0.3.9. Final candidate
24/24 responsive checks/build/typecheck passed after the44px specificity fix;
actual installed0.3.9 Pi/natural economic completion/browser/reconciliation and
original autonomy/timer restoration remain pending. DefaultSol/high remains,
with supported user-selectable effort/model pinned per new admission and original
submitted recovery preserved. The existing owned pause/fence is not released
by publication; financial receipts must never be replayed.

### 0.4.0 immutable publication verified — installed acceptance pending

Source `50beed67ecfc9a3259173ff622bacea10ba0abfc`, tag
`satssurge-autopilot-v0.4.0`, [CI 37952913853](https://github.com/whirmill/umbrel-community-app-store/actions/runs/37952913853)
passed148Node24 and16Python tests. Verified image:
`ghcr.io/whirmill/umbrel-satssurge-autopilot:0.4.0@sha256:65053c9e00624efc274274143b15ad679f84eb05d3047bfa46fcc37d7de19fc3`.
Anonymous index, both configs and all22layers passed SHA-256/size checks
(218150048 compressed bytes). Configs match source and use `flock --no-fork`;
extracted package version is0.4.0. Private receipt:
`/Users/whirmill/.local/share/satssurge/image-040-receipt.json`.
Manifest and compose are prepared together. Currently installed0.3.9 remains
healthy under the owned qualification pause; actual installed0.4.0 official
composer/Pi/natural economic acceptance and original autonomy/timer restoration
remain pending. Native fixture proof is in `040-fixture-native-admission.json`:
exactly3original jobs (chat/chat/analysis), dropped post-COMMIT ACK recovered
without second submission,44→68→192px autosize,24 responsive cases passed.
Verifiedpre-040-20261009T153545Z checkpoint preserved111ledger/all original jobs,
85history/owner/mandate/operations; original naturally queued job remains
unsubmitted and provider cooldown respected. Publication does not clear the
owned pause/fence or authorize financial replay. Native iOS/VoiceOver unproven.

### Installed 0.4.0 acceptance complete — 2026-10-09

The official assistant-ui Composer.Root/Input/Send is installed and accepted.
Umbrel amd64 runs healthy at immutable index
`sha256:65053c9e00624efc274274143b15ad679f84eb05d3047bfa46fcc37d7de19fc3`,
config `sha256:debf11687edcedf5d2011380cb23d5c250321499aa837ca4e16cb002b3d19aac`,
source `50beed67ecfc9a3259173ff622bacea10ba0abfc`, package0.4.0 and
`flock --no-fork`. [CI 37952913853](https://github.com/whirmill/umbrel-community-app-store/actions/runs/37952913853)
passed148Node24 and16Python; anonymous both-platform configs and all22layers
passed SHA-256/size verification. Earlier pending checkpoints are superseded.

The fresh `pre-040-20261009T154406Z` three-database checkpoint passed host/Mac
verification and isolated restore: Store quick_check=ok, schema4,111ledger,
85history and owner checksum. All jobs/history/owner/operations/ledger were
unchanged through update. Controlled040restart preserved three queued read-only
requests and owned cancellation rows exactly. OAuth was unchanged; old owner
sessions invalidated and fresh private owner login succeeded. Browser refresh
retained UI/history with no repeated POST admission.

Actual native Enter read-only qualification completed once in28.016s and two
analysts completed in25.876/28.143s, with two node_state/state_page tools each.
All used high effort, attempts1/submitted1; three running jobs were observed
concurrently. Qualification is excluded from follow-up/economic feed. Owned
queued native Enter cancellation remained cancelled with attempts/submission0
and exact keyboard-selected receipt. Real qualified public reasoning was visible
(81events on original autonomy and a497-character summary on its successor);
hidden thinking was not exposed.

The original queued autonomy job completed once in130.660s with60s soft/180s
hard budget. Closure persisted at95.415s and final provider request used
`tool_choice:none` at95.430s, leaving49.340s at completion. A scheduler job already
queued before that closure completed once in121.858s, closure87.660s and final
none87.674s, leaving58.142s. Both preserve the same original wait deadline
2026-10-10T14:30Z. These are original and finite pre-existing pending work, not
proof of two independent15-minute cycles; normal coordinator cadence remains.
Previous039 successful natural receipts remain intact. Its provider stream-ended
failure remains failed without replay; the recorded cooldown was honored, not
reclassified as a new040 failure.

Actual04024responsive cases at320/390/768/1440 passed all pages with no overflow,
mobile16px fields/44px targets. Popup selects were16px/45px, unclipped with44
models/5efforts; Escape returned focus. Native input started44px, ShiftEnter grew
to140px with long text;192px cap was qualified in the fixture. Legacy oldest row0
and exact58.796875px reading anchor survived Node return. Closed tools mounted
zero JSON; group expansion showed two items and only the selected tool mounted
its parameter/result pre bodies. Real GFM tables rendered. Installed console
warnings/errors were zero. Origin/CSRF returned403, copied bearer after logout401
and idle SSE closed. Eight-hour wall-clock expiry was not waited; fake-clock
coverage remains separate.

Final reconciliation proved zero active jobs, all queue rows terminal and zero
pending financial operations. Original terminal receipts,111ledger,85history,
owner, OAuth, mandate and operations were preserved. Only the owned
plan-035-qualification claim was cleared after reconciliation. Initial enabled=true,
Sol/high and all four backfill/diagnostics/interlock/competition timers were
restored; foreign timers and mandate were untouched. Financial acceptance effects
and tests were zero; no regtest or M3/M4 expansion.

Private installed screenshots were viewed at
`/Users/whirmill/.local/share/satssurge/040-installed-desktop.jpg` and
`040-installed-mobile.jpg`; responsive/history/console/owner-security receipts
remain private under that evidence directory. Native iOS keyboard/VoiceOver and
comparative heap savings remain unverified. Catalog capacity272K is capacity
only; current context usage is unavailable. Upstream coverage/accounting gaps
remain explicit, with no profitability claim. Massive exports/additional iterable
adapters remain future candidates. Recovery must preserve current financial
receipts and never replay uncertain sends or restore older accounting over them.

### 0.4.3 immutable publication verified — installed acceptance pending

Source `4c40a17f688315977fcb192a5b979831231aae55`, tag
`satssurge-autopilot-v0.4.3`, [CI 37964740620](https://github.com/whirmill/umbrel-community-app-store/actions/runs/37964740620)
passed149Node24 and16Python tests. Verified image:
`ghcr.io/whirmill/umbrel-satssurge-autopilot:0.4.3@sha256:ba5d02de82e9d0e2568466ef47a0c1ac7a775d72e51843ff8119af4e36fbe1fb`.
Anonymous index, both configs and all22layers passed SHA-256/size checks
(222058018 compressed bytes). Configs match source and use `flock --no-fork`;
extracted package version is0.4.3. Platform manifest/config digests are retained
in private `/Users/whirmill/.local/share/satssurge/image-043-receipt.json`.
Manifest/compose are prepared together; actual installed owner-login/logout,
OAuth-preservation/browser/Pi and operational reconciliation remain pending.
Current accepted installation remains0.4.0. Final frozen candidate149/16,
24authenticated+8unauthenticated light/dark responsive cases passed, no shell
leak/overflow, password16px/logout44px and console0. Fixture35061 exited130,
its tab closed and viewport reset. Previous041/042 immutable artifacts remain
unchanged;042 skips installation. Native iOS/VoiceOver/heap savings unproven.

### Installed 0.4.3 acceptance complete — 2026-10-09

Actual Umbrel0.4.3 is healthy and accepted: source
`4c40a17f688315977fcb192a5b979831231aae55`, store4785a17, immutable index
`sha256:ba5d02de82e9d0e2568466ef47a0c1ac7a775d72e51843ff8119af4e36fbe1fb`,
amd64 config `sha256:de47ed99e63439c3a5adc22e1aba52b057d2b0f05e6568e619a81d7a6f6a3dd9`,
package0.4.3 and `flock --no-fork`. CI37964740620 passed149Node24/16Python;
anonymous both-platform configs/all22layers were verified. Earlier pending
publication checkpoints are historical; prior040 backend proofs are retained,
not claimed rerun in full for this UI acceptance.

Fresh pre-043-20261009T172011Z checkpoint passed host/Mac/isolated restore,
quick_check=ok/schema4/111ledger/85history/153original jobs. All original jobs,
operations/ledger/history/owner/mandate remained exact after installation.
Actual in-app browser standalone login, header/Settings logout, password/heading
focus, Origin/CSRF rejection, revoked copied bearer and idle SSE closure passed.
Initial/checking/expired-after-restart screens had no protected header/navigation.
All24 section/viewport cases at320/390/768/1440 had no overflow and44px logout.
At320px model popup was within17..305px, search16px,44models/5Sol efforts and
original logo viewed in light/dark.

One native medium-effort request completed once, truthfully reporting the
unavailable system_status tool requested by the operator; no tool execution is
claimed for it. Corrected native high request completed once with node_state,
progress/text and original tool call/result. Concurrent qualification chat and
analysis started together and completed once with one read tool each, real public
reasoning111/86events and progress/text. Refresh/logout/login recovered identical
jobs/states; section switches retained chat. Tool details mounted two JSON pre
bodies only on expansion, zero when closed. Five/six virtual messages were mounted
with long history and older history remained accessible. Scroll-anchor benchmark
is inconclusive because click-induced auto-scroll affected measurement.

Operational exception during final controlled restart: the primary's zero-active
assertion failed at one active background autonomy job, but a subsequent newline
shell command still restarted the app. The owned maintenance claim kept financial
execution blocked. Reconciliation retained original Pi conversation10821 and
submission10828; attempt2 recovered to completed with no error, new submission,
manual cancellation or financial effect. This was an operator sequencing exception,
not requested application behavior; preserve its original receipt.

Final all158jobs are terminal (cancelled6/completed91/failed61); all153original
jobs remain exact. Ledger/operations/85history/owner/mandate unchanged. Only the
owned plan-043-selector claim was cleared after reconciliation; initial enabled=true,
Sol/high and all four backfill/diagnostics/interlock/competition timers were
restored. Zero active jobs/pending financial operations and console warnings/errors.
No financial acceptance effects/tests, regtest or M3/M4 expansion.

Private viewed screenshots:043-installed-login-desktop.jpg,
043-installed-login-mobile.jpg,
043-installed-model-menu.jpg and043-installed-chat-desktop.jpg; chat screenshot
was captured during the paused qualification. Receipts/screenshots remain under
`/Users/whirmill/.local/share/satssurge`. Candidate server/tab/processes closed,
viewport reset. Catalog272K is capacity only, not actual context usage; native
iOS Safari/VoiceOver and comparative heap savings remain unverified. Upstream
coverage/accounting gaps and profitability limits remain explicit. Recovery must
preserve current financial receipts and never replay uncertain effects.

### 0.4.4 release candidate — local acceptance complete (schema 5)

This source candidate uses package version 0.4.4 and keeps the existing OAuth,
mandate, financial intent/hash reconciliation and frontend conventions. It has
not been deployed. Schema 5 is additive: monotonic ingestion metadata, automatic
scope generations/admissions, immutable derived views/progress, expired input
intervals and append-only ledger annotations. The original ledger, reservations,
receipts, conversations and submissions remain authoritative.

All automatic ingresses share one transactional gate. Coordinator scope is
`node`; analyst corridors use canonical SCIDs. Admission captures watermarks,
generation, quota receipt and queue job in the same transaction. Queued, running
and submitted waiting jobs retain ownership; newer facts remain pending. Owner
requests and deterministic collection/reconciliation bypass the automatic cap.
The limit is four automatic revisions per scope in a rolling 24 hours, including
failed revisions; read-only continuation segments do not consume another revision.
Only mature fixed due times, ten newly ingested external forwards in the exact
corridor, touching manual interventions or changed blockers admit successors.
Backfill, duplicates and expired tombstones never manufacture triggers. Migration
adopts old automatic receipts/pending jobs and resumes its atomic adoption step
using a durable marker if a process exits after DDL installation.

Economic research has a code-owned manifest: state/budget, channels, coverage,
scoped original forwards/failures, manual/policy events, both diagnostic providers,
competition, per-channel alternatives and a structured alternatives comparison;
a proposed forecast adds the trusted forecast receipt. An unavailable source is
an explicit gap, never zero. A completed queue job can have partial or blocked
research. New partial successors supersede older complete results. Narrow queries,
changed/expired views, repeated pages/errors and rewritten comparison prose do
not certify complete sections or new material evidence.

Views filter SQL before the acquisition cap, join nested decision scope explicitly,
freeze the revision interval and persist canonical query, semantic digest and
progress. Use `nextCall` with its full query/cursor/offset. A version without an
immutable cursor requires an explicit reopen. Summaries partition original LND
forwards, HTLC attempts and manual events; companion diagnostics and buckets are
separate. Failed/missed fees do not establish distinct recoverable demand. Derived
research/view IDs are never financial evidence IDs and cannot reset demand
fingerprints, retry/cost caps, suspended strategies or benefit claims.

Only measured advancement admits a fresh read-only analyst job/conversation/
submission, at most three total segments. Each segment retains the existing
60-second economic research / 180-second hard budgets, 12 analyst or 16
coordinator research calls and 24 absolute calls. Persisted counters, completed
elapsed time and allowlisted usage survive recovery; the chain is bounded by 72
absolute calls and 540 seconds. Original submissions recover separately; uncertain
financial effects reconcile by their persisted hash and never replay. Research
capability is persisted at admission, the analyst registry excludes finance, and
the coordinator executor entry checks the immutable capability before execution.

Forecast and initial/7/30-day qualification require authoritative acquisition
coverage and available original inputs, both synchronized/active/same-price/liquid
snapshot endpoints and at most two minutes between samples. Missing direct cost
is unknown; an explicit zero expense receipt is valid. Effective or uncertain
executed shared-channel interventions confound comparisons; an unexecuted proposal
does not. Expired forward/snapshot detail makes later revisions inconclusive and
nonreproducible. Direct-operation cost completeness is separate from global
historical accounting completeness. Manual MPP records cover every affected local
endpoint and book the payment cost once; absent settlement precision is explicit
and conservatively contaminates overlapping observation.

Accounting keeps original 30-day/cumulative totals and budget unchanged. Its exact
partition has sector (routing/swap/other/unknown) and receipt attribution
(verified/shared/unattributed). Spend category is separate from sector. Explicit,
versioned annotations classify receipts without rewriting ledger amounts. Unknown
or unallocated costs suppress routing contribution; subscription cost metadata
alone does not book an expense or clear partial accounting.

The local fixture accepts `FIXTURE_RESEARCH_REPAIR=1` to exercise completed-job /
partial-research recovery and sector accounting in the existing UI. This is
synthetic localhost evidence and does not qualify an installed release.

Recovery boundary: `scripts/checkpoint.py` captures only the three databases,
with schema/digest/size manifests and a proven stopped executor. Full install
recovery must also preserve `owner.secret` with its original permissions and all
mounted LND/provider credentials separately, without displaying their values.
Retain the immutable release image/source digest alongside the checkpoint.
Software rollback must respect schema compatibility (schema-4 software refuses
schema 5). Never restore an older checkpoint over newly created or uncertain
financial receipts; reconcile and preserve the newer receipt set first. No
rollback, live install or financial operation is authorized by this candidate.

Research progress is visible in both chat and activity cards: processed required
sections, known rows, recorded calls/time, frozen interval and segment1..3.
Follow-up state and next trigger remain visible for complete observation waits and
operational blocks, independently of the gap list. Economic eligibility and effect
outcome are separate from queue completion. Accounting sector/attribution figures
and exact reconciliation are readable without expanding JSON; unknown/shared
costs prevent a determined routing contribution. In the local research fixture,
examples are appended after history. `FIXTURE_OPERATIONAL_BLOCKED=1` exercises the
synthetic operational-block view. Local browser acceptance is complete; installed qualification remains a separate
activity after publication and explicit installation authority.

Research projection freshness uses a persisted semantic version separate from the
job lifecycle timestamp. Current blocker, progress and economic/outcome state survives
API refresh and historical SSE replay while terminal job receipts retain their
existing timestamp fence. Legacy jobs without a research receipt remain unknown.

### 0.4.4 publication preparation — 2026-10-09

Package and both root lockfile versions are `0.4.4`; the reserved next release tag
is `satssurge-autopilot-v0.4.4`. Remote main was verified at
`049a08b9d35d6e4731e86bd7fad719ffea9403a2`, with no matching 0.4.4 tag or release.
The existing tag-triggered workflow runs Node 24 build/tests and Python host
adapter tests before publishing `ghcr.io/whirmill/umbrel-satssurge-autopilot:0.4.4`
for linux/amd64 and linux/arm64. Store compose and manifest remain on the verified
0.4.3 image until Actions and the new immutable OCI index/configs/layers are verified.
The package is private; distribution is through GHCR and this Umbrel store.

The accepted local repair passed 172 Node 24 tests and 16 Python tests, backend
and frontend typechecks, fixture syntax and whitespace checks. Primary review and
visible synthetic desktop/mobile/tablet checks qualified partial/blocked research,
three-segment exhaustion, refresh/SSE replay, operational next triggers and exact
readable accounting. Source/scripts/web contain 115 files with SHA-256
`addc9fb5d3925f6313eaebcb4be93b330ca9e6354b121440cbbae7ce842d2578`.
These checks do not establish installed migration/provider acceptance or economic
profitability. Installed 0.4.3 remains the accepted baseline.

If publication or image verification fails, retain the 0.4.3 store digest and
do not advertise the candidate as available. Never overwrite an existing version
tag or image to repair a release. A future installation requires a stopped-executor
checkpoint of all three databases plus separately preserved owner secret and
mounted credentials, original permissions and image/source/schema metadata.
After schema-5 migration, returning to 0.4.3 requires schema-compatible recovery
that preserves every new or uncertain financial receipt; restoring a pre-upgrade
database over newer receipts is not a valid rollback. Publication alone does not
authorize installation, restoration or real financial effects.

### 0.4.4 immutable publication verified — installed acceptance separate

Source commit `77a48c25d7891aa595293319c36ae2444091cdd6`, immutable source tag
`satssurge-autopilot-v0.4.4`, [CI 37978839715](https://github.com/whirmill/umbrel-community-app-store/actions/runs/37978839715)
passed 172 Node 24 and 16 Python tests; build and publish jobs completed successfully.
Verified OCI index:
`ghcr.io/whirmill/umbrel-satssurge-autopilot:0.4.4@sha256:9bcd5e19bb1ee10e39cd5cb7399208b73bea09812cdb3e1c73270bdfdc7f305e`.

Anonymous linux/amd64 and linux/arm64 manifest/config downloads match SHA-256 and
sizes. Both configs identify the exact source, packaged version is 0.4.4, and
both commands retain `flock --no-fork`. All 22 unique layers (222,102,617 compressed
bytes) were downloaded anonymously and verified. Platform manifests are
amd64 `sha256:a9896cfb8e4fddfda5b11d618fcedd07a00ae23c199fe3b36fb868db5b8dbc6f`
and arm64 `sha256:ac970e180dd5c4ff46ff487d20f66f9a54d9416cb73325b4c8a98427065f201f`.
Detailed receipt is retained outside Git at
`/Users/whirmill/.local/share/satssurge/image-044-receipt.json`.

Compose now pins that immutable index and the manifest advertises 0.4.4; final
store metadata awaits its separate Git publication handoff. The source tag is
unchanged. The financial mandate, original receipts and partial-accounting limits
are preserved. Installed 0.4.3 remains the accepted running baseline; publication
includes no installed update, live migration, credential read or financial effect.
Schema-5 recovery requires the checkpoint/credential preservation and receipt
reconciliation boundary documented above; a direct 0.4.3 binary rollback fails
schema compatibility. Local fixture and image proof do not establish installed
provider acceptance, live migration acceptance or profitability.

[GitHub release 0.4.4](https://github.com/whirmill/umbrel-community-app-store/releases/tag/satssurge-autopilot-v0.4.4) was published and read back as a final,
non-prerelease release with the verified source, CI and immutable image receipt.

## Documentazione per sviluppatori

Prima di modificare harness, tool o recovery, consultare [la guida Pi e Pi Durable](../docs/pi/README.md) e [le istruzioni per gli agenti](AGENTS.md). Le fonti locali sono fissate alla versione 1.1.0 e verificabili offline.

### 0.4.5 Telegram-first publication preparation — 2026-10-10

Package and lockfile versions are `0.4.5`; the intended immutable source tag is
`satssurge-autopilot-v0.4.5`. The existing tag-triggered workflow tests on Node 24
and Python before publishing amd64/arm64 to
`ghcr.io/whirmill/umbrel-satssurge-autopilot:0.4.5`. Distribution is through GHCR
and the Umbrel store; the npm package remains private. Store manifest and compose
retain verified 0.4.4 metadata until the new index, platform configs and layers
are verified. No 0.4.5 image, source commit or CI receipt is claimed yet.

Telegram becomes the paired owner's daily interface: durable inbound chat,
read-only Pi requests, guarded pause/resume, explicit proposal review, a daily
accounting digest and critical blocker alerts. Web settings remain the secure
configuration and pairing surface. Telegram is disabled until the owner supplies
a bot token and confirms the numeric account; neither installation nor a bot
message expands the existing fee/rebalance mandate. Channel lifecycle and
RoboSats/Amboss/Magma remain separate future capabilities.

Additive schema 6 preserves existing jobs, conversations, Pi submissions, ledger,
mandate, reservations and financial receipts. Before updating, stop the executor,
verify a consistent checkpoint of all three databases, and separately preserve
`owner.secret`, `telegram.secret` when present, mounted credentials and their
original permissions. Older schema-5 software refuses schema 6. Keep the current
immutable image if publication fails. After migration, recovery must preserve all
new or uncertain financial and Telegram receipts; do not restore a pre-upgrade
checkpoint over newer effects, replay payments or automatically resend uncertain
Telegram deliveries. An already dispatched message may complete after revocation.

The user has now authorized publication and installation. Local acceptance is
192 Node tests, 16 Python tests, typecheck, independent security review and isolated
responsive browser checks. Installed schema-6 migration, live bot pairing/delivery
and provider acceptance still require separate readback; fixture proof does not
establish those outcomes or profitability.

### 0.4.5 immutable publication verified — installed acceptance separate

Source commit `3608a062ae09353059eba2dead54693032933c3b`, immutable signed source tag
`satssurge-autopilot-v0.4.5` (tag object
`8fbc7754a44b83f9f1735f25ee8e890ddfb184f4`) and [CI 38022783273](https://github.com/whirmill/umbrel-community-app-store/actions/runs/38022783273)
were verified. Build and publish passed; CI recorded 192 Node 24 and 16 Python
tests. Verified immutable OCI index:
`ghcr.io/whirmill/umbrel-satssurge-autopilot:0.4.5@sha256:e43728b55948888acf927ea61fbfa3f347440c66399a2ad559c59f44971d6073`.

Anonymous downloads verified SHA-256 and sizes for both linux/amd64 and linux/arm64
platform manifests/configs and all 22 unique layers
(222,120,344 compressed bytes). Both configs identify the
exact source SHA, both application package layers contain version 0.4.5, and both
commands retain `flock --no-fork`. Platform manifests: amd64
`sha256:ce7e918bc7d770effc4d886775fa64b057225504172956e91a12a8620bc930dc`
and arm64
`sha256:7d06e780a14b9453f626fe0b1c2fbff3bad31a68e39326d3e4ac1bc47ce945eb`.
Verification timestamp: `2026-10-10T04:09:38.345411+00:00`. Private full receipt:
`/Users/whirmill/.local/share/satssurge/image-045-receipt.json`; CI log:
`/Users/whirmill/.local/share/satssurge/ci-045-full.log`.

Store compose now pins that immutable index; manifest advertises 0.4.5 and
Telegram's configured-owner capabilities. These four metadata/documentation files
require their own typed git-operator commit/push; the source tag remains unchanged.
Installed 0.4.4/schema 5 remains the accepted baseline until explicit installed
readback. Publication does not prove live schema-6 migration, bot pairing/delivery,
provider acceptance or profitability. The user has authorized installation,
subject to a fresh stopped-executor three-database checkpoint, private secret and
credential preservation, receipt reconciliation and original autonomy/timer
restoration. Never restore an older checkpoint over newer/uncertain effects;
schema-5 software cannot open schema 6. Telegram starts disabled/unpaired until
the owner configures credentials and confirms the numeric account.

[GitHub release 0.4.5](https://github.com/whirmill/umbrel-community-app-store/releases/tag/satssurge-autopilot-v0.4.5) was created and read back as final,
non-prerelease, with exact source, CI and immutable image receipt. Metadata
publication is the primary's separate git-operator handoff. Installed acceptance
remains separate.
