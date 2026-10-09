# SatsSurge Autopilot — implementation checkpoint

## Next milestone — responsive web UI/UX, prioritized 2026-10-09

User requested M2.1 before M3/M4: React + TypeScript + Vite + shadcn/ui, polished responsive agent chat and authenticated streaming of text, available reasoning summaries, tool calls/results and durable job states. Preferred candidate assistant-ui with a custom Pi Durable adapter; AI Elements is the alternative. Full scope, official research links, reconnection/idempotency rules and browser acceptance are in the app README's ordered roadmap. Include fixes for the observed stale queued label and missing follow-latest chat scrolling. This is a roadmap update only: no frontend implementation, dependency installation, deployment or financial authority change. M3 channel/Magma and M4 outbound webhook notifications remain after M2.1.

2026-10-09 authoritative roadmap change: remove the Telegram bot and replace M4 with outbound-only webhook notifications, Discord first. The web UI is the sole owner control/chat surface. No Discord inbound commands, replies, bot or action handlers may reach the agent/executor. Plan a private configured webhook, filtered/aggregated notifications, durable outbox, bounded retries, delivery status and redacted payloads. Uncertain notification delivery is not proof of failure and never authorizes replay of a financial operation. Full acceptance and duplicate-risk semantics are in the README. Historical Telegram mentions below describe superseded plans, not current scope. No external webhook has been configured or notification sent by this documentation update.

## Current continuation checkpoint — 2026-10-09 AI data access

FINAL installed acceptance2026-10-09T06:04:57UTC: exact0.2.3index8a079bfa201d528b6e2007d1652eba1a683bd3ef4dd67321685a7f8c1a1050e2healthy; storecommitfe93ab4c695f9df6aacb847dbe2882766bb86ab1/liveclone match, UmbrelUIallapps up-to-date. Freshpre023stopped/sameexecutorlockthreeDBcheckpoint verifiedMac;96ledgerrows matchoriginalcheckpointdigest exactly. OwnerauthenticatedinstalledUIaccounting/diagnostics/competition/evaluation/highpanels and autonomyenabledrender qualified, noconsoleerrors. ActualPi analyst currentnode_state/state_page run completedattempt1: all10channels/all10prices and diagnosticfirstpage+offset200withsameversion (no claimintermediatepagesreadbyAI). Otherstartedanalysesdrained; one180stimeoutterminalFAILEDwithoutreplay; noqualificationfinancialRPC. Finaltransactionverifiedenabledfalse,zeroactivejobs/financialpending,freshbootstrap/proof/snapshot/all14externalflagsOFF/protectedreserveadequate, removedONLYownedruntime-qualificationclaim. APIresume/readback enabledtrue,bootstraptrue/blockers[],OAuthconnected/gpt6.1solHIGH, boundedcoordinator1/analysts2. No M3/M4. Private financial figures, job/conversation identifiers, checkpointdigest and screenshot are retained ONLY in /Users/whirmill/.local/share/satssurge/autopilot-m2-acceptance-20261009.json. Publicacceptancematrix inappREADME; accountingcoveragepartial andfuture7/30economicresults notyetmatured. Remainingdelivery: push finaldocs; do not replay priorfinancialoperation or restorelegacyfees.

0.2.3 source66e3c3cd6a1fa99a1432efb729a18b840598864a and tag31c8eedc8414601f018c34007a15e0486c3a7d71 published; CI37890628266 SUCCESS58Node14Python onNode24. Independent bounded review accepted: all201unique diagnosticrows recoverable/tail200, versionchangedrestart, missingdataunknown, samecallerfence/analystnofinance. Release specialist verified anonymousindex/config/alllayerHEAD200 and exactsource for amd64manifest64940e2f2631214875f65808b971766b496f590f9bfef35e56bede992929d59b and arm64manifest1b5aa9e03db808452f80601502715abba10fc89f6e657834c6edd522816b92f1. OCIindex8a079bfa201d528b6e2007d1652eba1a683bd3ef4dd67321685a7f8c1a1050e2 nowpinnedincompose; manifest0.2.3. Pendingstoremetadata push/install/actualAIpageacceptance/finalresume; no financialRPC. Sourceprojectionqualified but modelreadingcompletion remains pending. FullM2goalACTIVE.

Owner login is now verified in the installed external browser: login heading absent; status `In pausa`, coordinator available, analysts0/2, one financial executor. No further owner-login blocker for0.2.2.

Actual completed AI receipts exposed a remaining M2 gap: `node_state` returned the entire stats projection and Pi's50KB output window clipped later diagnostic/competition/accounting content. New `agent-state.ts` provides a compact summary and typed `state_page` for each coordinator/analyst, with<=12000byte/20row pages, section content versions, explicit acquisition-change restart, unavailable counts null and coverage retained. Competition summaries keep all10 peers/quotes; alternatives are a separate page with upstream truncation explicit. Diagnostic attempts and buckets remain distinct from payment counts. No new financial capability.

Live readonly verification of new local projection against installed owner API recovered all201LNDg failure rows, all10 channels and all10 competitive price rows. Summary3080bytes; full API response463203bytes (includes chat/jobs and is NOT the exact old node_state byte count). No financial pending, bootstrapReadytrue, enabledfalse. Local suite58Node/14Python passes, including actualPi analyst registry retrieval of the last peer. Bounded review/release pending. New code not installed yet; preserve owned runtime-qualification fence and pause until final acceptance. Next: review, immutable0.2.3 publish/install, actualAI state_page retrieval, audit and safely release only owned qualification claim/resume within original mandate. Do not claim M2 complete or economic profit yet.

User authority: implement consolidated plan, M1 real-node POC fee/rebalance autonomy using Pi Durable/Codex subscription, no regtest. M3 channel/Magma and M4 Telegram remain deferred. Mandate 30k cumulative incl history,1500 daily,750 exploration subset,100 attempt,500k onchain protected.

App: `whirmill-satssurge-autopilot/`. Root owns implementation. Never stage unrelated untracked docs/scripts. No mainnet financial RPC has been performed by this implementation turn.

Implemented: separate FULL-WAL operational SQLite and Pi Durable store, private OAuth credential store, unsafe financial tool recovery, single async execution owner and process flock, reservations and aggregate fingerprint caps, observed-data forecasts, strategy suspension, manual holds, historical importer, collector/HTLC coverage, owner-authenticated UI+CSRF, TLS/URI-macaroon bootstrap and host live interlock, amd64/arm64 release workflow.

Verification: 14 mocked tests passing, actual Pi Durable storage/root initialization opened, Node24 ARM Docker image built; anonymous backend status401/health200 verified. Historical import actual local files:47 costentries,10705169msat knownexpenses,1958000msat grossRoboSats premium, no importerrors, coverageincomplete. No personalpaymentdetails imported into tool evidence. Independent security-auditor review completed, fixes consumed: async invoice/reconciliationrace, canonical corridor/evidence grouping, MPPterminalcostnotlost, strict gate timestamps, exact historical fee check, persistent integrityblocker, backend ownerauthentication.

Published: main e407fe65976bb1dcfc63880fa7244e9f1a5f158a, annotated tag satssurge-autopilot-v0.1.0, CI https://github.com/whirmill/umbrel-community-app-store/actions/runs/37833585463 succeeded. OCI index ghcr.io/whirmill/umbrel-satssurge-autopilot:0.1.0@sha256:23dd5f6d0df009b903c2ea28a0c469052919ceb6ba8f84e5fe29003190859f56 contains amd64/arm64 and permits anonymous pulls. Compose pins this immutable index.

Umbrel bootstrap: restricted URI macaroons, TLS CA and node binding provisioned privately under app-data/whirmill-satssurge-autopilot/credentials; historical expenses/reconciliation and selected narratives copied privately; host user interlock timer refreshes every 30 seconds and all operational automation flags were verified false. No financial RPC performed. Catalog initially reports App not found despite updated repository files; investigate selected community-store lookup before claiming installation.

Installed on Umbrel after owner clicked Install. Running image matches the immutable digest and health is healthy. Live restricted-TLS reads verify sync, 10 channels/9 active, 502858 confirmed sat. Collector bootstrapReady true, blockers empty, live automation proof valid. Operational quick_check ok; import repeated with 82 documents/47 expense entries, no discrepancies, known cost10705169msat. Routing38 forwards plus gross RoboSats revenue produce provisional total revenue2307136msat/net−8398033msat; coverage remains incomplete. URI write scope verified exactly AddInvoice/SendPaymentV2/UpdateChannelPolicy. Anonymous backend401 and second-process flock rejection verified. User owner login completed; ChatGPT OAuth is in progress. No app financial operation yet.

Patch0.1.1: live LND requires peer_alias_lookup=true to return names; query verified readonly against all10 channels. UI coverage now summarizes provenance counts rather than dumping the full checksum manifest. Tests14 passed after adapter patch; frontend syntax checked.

ChatGPT OAuth completed through manual callback, never persisted as evidence. Selected subscription model gpt-6.1-sol; real Pi Durable run read state, searched historical receipts and completed an Italian explanation, recommending no financial action. No financial operation was needed or performed. Host user manager linger initially disabled caused stale gates after SSH logout; owner enabled linger explicitly, verification pending.

Patch0.1.2 adds a public answer projection: only final assistant text crosses chat API/UI, excluding internal thinking/provider metadata for both new and legacy messages; original durable evidence remains private. Regression test added. Do not claim realnode financial execution/economics tested before it is. Fee experiment evaluation is noncausal M1 contribution; richer comparable price evaluation belongs M2. Credentials/private history must never enter Git/tool outputs.

Final patch published: satssurge-autopilot-v0.1.2 at11601ee472f97af9065ca3ea33318c8dad30d9a2; CI https://github.com/whirmill/umbrel-community-app-store/actions/runs/37836258031 passed15tests, amd64/arm64. OCI index ghcr.io/whirmill/umbrel-satssurge-autopilot:0.1.2@sha256:b5c697d15e42f7e7c8c58fed9dd8442789f3613cbcda5f7d398fbaf6c1bb9bee verified anonymous, exact revision. Compose pinned. Linger=yes verified; gate remains fresh after logout, collector returns bootstrapReady true/no blockers. Pending open/closing/forceclose/waitingclose all0. No financial app operations recorded.

Final deployment verified 2026-10-08T20:10Z: Umbrel update completed through the existing app UI. Running image is exact0.1.2 OCI index b5c697d15e42f7e7c8c58fed9dd8442789f3613cbcda5f7d398fbaf6c1bb9bee, running/healthy. Operational, durable and OAuth databases quick_check=ok; restart retained82evidence documents,47 imported expense entries,2 completed chat runs, openai OAuth type and gpt-6.1-sol. Reimport produced no discrepancies/duplicated ledger entries. Collector bootstrapReady=true/blockers=[] and live interlock fresh after SSH logout with Linger=yes. Zero financial app operations. Consistent private checkpoints of all3 SQLite databases verified remotely, restricted0600.

Autonomy was deliberately paused before the update and remains paused pending owner web reauthentication. Backend restart invalidates only the in-memory owner web session; subscription OAuth is durable and requires no new login. User asked to reenter the existing password only inside the app. Remaining acceptance: owner UI reauthentication, final chat projection/aliases screenshot, restore autonomy and verify resumed persisted state. Do not imply autonomous mode is currently enabled before this readback.

User model request 2026-10-08: keep GPT-6.1 Sol and change reasoning from hardcoded medium to high. Patch applies high to every Pi Durable configure call, exposes effective effort through auth status/UI and records it in run metadata. Model remains gpt-6.1-sol; no mandate changes or financial operation authorized by this setting change. Publish immutable0.1.3 patch and verify installed runtime, retaining current pause until owner resumes.

0.1.3 high-reasoning release published: source fd6a990e77da3c021cbcf4070a9639fe95edac5a, tag satssurge-autopilot-v0.1.3, CI37837966267 success15tests. Anonymous verified amd64/arm64 OCI index561506d480b10b9a90d8af038f73a860cae45fdc24b0bd49c8229545d23a9a3d pinned; model catalog confirms gpt-6.1-sol reasoning=true/high maps to high. Installing existing app update; preserve paused state until owner login/resume.

0.1.3 installation completed and verified via Umbrel UI and Docker runtime: exact561506d480b10b9a90d8af038f73a860cae45fdc24b0bd49c8229545d23a9a3d image running/healthy; compiled configure uses THINKING_LEVEL=high, persisted model=gpt-6.1-sol. bootstrapReady=true/blockers=[], operational quick_check=ok, financialoperations0. Owner web session remains logged out and autonomy paused; no attempt to bypass owner authentication. User-facing screenshot saved outside Git. Subscription persists; owner login/resume remains the separate pending UI acceptance from0.1.2.

2026-10-08T20:37Z resume verified through owner-authenticated local app API after user confirmed owner login: enabled=true, bootstrapReady=true, blockers=[], subscription connected, gpt-6.1-sol/high. At20:38:33Z high run completed idle, financialoperations0. This supersedes prior paused notes, not financial/profitability qualification.

Roadmap reprioritized at user's request: M1.1 persistent SQLite request queue FIRST, M1.2 bounded read-only analyst pool SECOND; one coordinator/financialexecutor and centralized reservations remain mandatory. Full ordered roadmap and acceptance criteria now in app README; M2 diagnostic/economic validation, M3 explicitly enabled channel/Magma lifecycle, M4 owner Telegram, ongoing durability/restore/deployment checks and separate RoboSats research backlog retained. This is a documentation update, not implementation/activation of the queue/pool or a financial authority expansion.


2026-10-09 local M1.1/M1.2/M2 implementation checkpoint (NOT published/deployed): queue schema2 and durable job ownership, bounded scheduler, isolated Pi conversations and read-only analyst extensions remain under qualification. Browser chat now submits persistent IDs, acknowledges accepted jobs immediately and renders queued/running/waiting/terminal jobs and cancellable unsubmitted requests; ambiguous network acknowledgements retain original IDs. Added readonly analysis entry point and shared recent owner-memory tool across conversations. Scheduled backlog saturation is deferred rather than throwing; Lightning observation bursts coalesce behind a persistent event cursor. Owner-authenticated receipt lookup added; public queue projection omits lease/run ownership tokens. Analyst completion no longer overwrites coordinator idle/running status.

M2 diagnostic consumer added with explicit node identity, freshness90s, UTC timestamp, version and selected-table schema gates. Qualified LNDg1.11.1 amounts convert sat decimals to integer msat exactly; failedHTLC rows remain attempts and daily rollups remain aggregates. LM0.7.7 diagnostic contract checks source/target SCIDs using BigInt and exact fee consistency. Unknown/missing/incompatible providers return explicit statuses without zero counts. Consumer is exposed in state/coverage, but host producer/readonly mount are NOT yet implemented or installed. No diagnostic source becomes financial authority or duplicates the ledger.

Verification: npm test from the app directory passes27 tests, including browser-script network-ambiguity retry/queued admission, literal-text result rendering, backlog/event coalescing, provider incompatibility/freshness and exact units/SCIDs. This is mocked/local evidence, not rendered UI or deployed multiagent proof. Existing deployed0.1.3 unchanged by this checkpoint; no financial RPC, publication or deployment performed during this turn.

Remaining before M2 completion: qualify actual Pi crash/recovery and caller isolation, graceful shutdown and unavailable-model recovery; central cross-corridor benefit reservations; live host diagnostic exporter; version-gated LM visibility/backfill (stock LM loads logs into memory, so external concurrent file edits unsafe; stop only LM for controlled imports, preserve/restart/verify); immutable forecast evaluation at7/30days with confounding and coverage; economics/diagnostic UI; security/review, immutable multiarch release, backup-first install and live acceptance. Preserve full objective through M2 and M3/M4 disabled. Do not mark goal complete from the27 passing tests.


2026-10-09 M2 economic checkpoint (LOCAL, still not released): schema3 adds immutable evaluation_windows at7/30days and benefit_claims. Forecastv2 stores initial inventory, prices, 7/30hour rates, conservative demand and opportunity-cost baseline; original decision forecasts are never rewritten by estimator updates. Window comparisons retain coverage, original digest, event/expense references, inventory depletion hours, manual holds/events and prior30day overlapping strategies. Fee-specific sampling spans all incoming corridors to the target and qualifies only measured same-price active/liquid intervals with48hours/2days/10forwards and complete LND coverage. Noncausal labels retained; unqualified results stay inconclusive. Corrections append explicit revisions with reason/superseded ID. Conditional finite-inventory forecast errors are labeled model-dependent, not verified causal errors.

Future ordinary demand is centrally reserved; crossing source/target claims reduce uncommitted demand before forecast/reserve. Each measured forward consumes one claim FIFO, never two. Failed operations release availability; pending uncertainty holds financial execution. Verified completion timestamp is persisted by Executor and anchors both future-demand consumption and post-intervention windows; legacy successful expense timestamp provides conservative fallback. Local migration reconstructs old ordinary reservations exactly with BigInt, preserving pending intent/paused state. Queue permits owner chat while a financial send remains uncertain, but defers autonomy; executor still blocks all additional financial sends.

Independent readonly economics review identified missing channel holds, preceding strategy overlap and pre-settlement consumption; all three now have fixes and regressions. Latest npm test39PASS; frontend syntaxcheckPASS. Evaluation UI shows original assumptions/revisions/coverage and unknown amounts. Live readonly check2026-10-09T04:04UTC: installed operational schema1 unchanged, enabledtrue, gpt-6.1-sol, bootstrapReadytrue, blockers[], collectorok, financialoperations0. Local schema3 has NOT been executed on production, no store release/deploy or financial RPC in this turn.

Remaining M2 scope still includes live diagnostic producer+readonly mount, qualified controlled LM backfill, actual Pi restart/caller isolation, graceful shutdown/quota handling, corridor/fee competition diagnostics and complete rendered UI; then security/release audit, immutable multiarch publication and backup-first deploy/current runtime acceptance. Future7/30day calendar results are not claimed available today; implementation and deterministic horizon tests are distinct from economic results. Keep full goal active.

Economics review recheck found one residual boundary: prior overlapping windows were still selected by creation time. Root fixed intersection against other decisions' verified completion/expense fallback plus30days, with Sep1created/Sep3completed versus Oct2start regression. Final local npm test40PASS. Review lane terminal; no ongoing writer. Root accepted fixes based on current source and regressions, not a new independent final review. Full M2 remains incomplete and unreleased.


2026-10-09T04:17UTC diagnostic host integration checkpoint: new standard-library scripts/diagnostics.py and install-diagnostics.sh installed under app-data/scripts. Host user diagnostics.timer active30s, writes only atomic0600 diagnostics/status.json, no financial RPC or other app modifications. Actual pinned source images verified: LNDg1.11.1@sha256:e1589e1d5ec89a4abe59610e808a4c9664dbc84eb66c30d15ffa2dd87232729e; LM0.7.7@sha256:917fa062d9520ea5bf92fb94bbe12b2947ed025c2bd8b82b3dcd5435127392ce. Naive LNDg date conversion qualified against installed TIME_ZONE=UTC, USE_TZ=False. Four-table schema matches f12ae61382e1eff131904419106c3ddb51d30f2443990443ed65c848de419682. Readonly selected/returned counts:48forwards,198failedHTLCattempts,0historicalrollups,0LNDg rebalances; LM17bucketrecords/34rebalance logs. Counts span selected90daywindow, not experiment-only routing totals or upstream completeness.

Copied private projection to /Users/whirmill/.local/share/satssurge/m2-diagnostics-qualified-20261009.json and ran CURRENT local compiled consumer: both providers qualified with exact counts; this proves current producer/consumer contract against actual sources. No private projection committed. Initial image equality gate rejected digest-qualified Docker config names; corrected to the exact installed immutable image references before accepting provider data. Installer corrected same-file copy for idempotent execution.

Upcoming Compose adds only DIAGNOSTICS_FILE and readonly projection mount. Consumer now preserves source-declared incompatible status. New UI diagnostic panel keeps source counters separate, summarizes observed failure corridors and displays partial provenance. Public amount formatting uses BigInt rather than lossy Number conversion. CI adds host adapter tests; local Node41PASS and Python3PASS, frontend syntaxcheck passed. Installed app still0.1.3/schema1; diagnostic reader consumer and new UI are NOT deployed. Full M2 still pending controlled backfill, Pi recovery qualification, competition/route analysis, release/security audit and installed acceptance.

2026-10-09 controlled-backfill/shutdown checkpoint: scripts/lm_backfill.py installed on host, default preview; restricted read macaroon GET only, explicit node binding, complete paginated payment reader, exact successful circular-route amount/fee checks, personal/preimage exclusion, unique payment hashes. Apply path uses host flock, durable stop/restart checkpoints, stops only stock LM writer, rereads after stop, backs up private original/proofs, atomic merge, stock200 cap disclosure, restarts and persisted readback. Any IN_FLIGHT payment defers a required restart. Native entries without unique identity stay ambiguous without duplication. No unattended backfill timer yet; in-memory authenticated API qualification still separate. Actual preview AND apply returned unchanged:34verifiedProofs,0added,0native ambiguities,0evictions. No LM restart/file mutation/financial RPC occurred; existing34records match current LND proofs.

Local scheduler shutdown now rejects new claims even when stop races with async model availability, retains active leases while draining and preserves original submission receipts on timeout. Server SIGTERM/SIGINT closes admission, cancels timers/stream retry, aborts HTLC stream and waits bounded25s for scheduler/collector; it never labels unresolved sends failed. Existing Compose60s grace exceeds drain deadline. Added regressions for availability race/drain plus controlled LM reread/concurrent append and pending-payment refusal. Initial full test exposed nondeterministic same-millisecond fixture ordering, corrected explicit first-job age; final Node43PASS, Python9PASS. Installed0.1.3 is unchanged; shutdown/new UI/queue/schema3 not deployed. M2 not complete: still qualify real Pi recovery/caller isolation, model/quota errors, competition analysis, rendered UI, reviews/release and current installed acceptance.

2026-10-09 Pi Durable qualification checkpoint (LOCAL): new tests use CURRENT Agent/Queue/registry and installed Pi Durable1.1.0 SQLite runtime with only provider and financial effect simulated. Child is actually SIGKILLed after unsafe tool effect marker; reopened Agent reacquires original conversation/submission IDs and settles interrupted tool without executing it again (one effect). Analyst extension attempting execute_decision has no such tool and produces zero effects. A foreign/legacy conversation selecting coordinator extension while another job owns the coordinator is rejected by actual caller fencing ('Lost job ownership') and cannot borrow authority. Real Pi model error returns terminal unanswered/model_error, not a pending recoverable submission: original receipt retained, no automatic replay;30minute AI cooldown now persisted in operational metadata and survives new Agent construction. Provider error detail never enters public queue error. Collector/reconciliation unaffected. Harness/SQLite and OAuth connections close during fully drained shutdown. All these checks are simulated-provider tests, not authenticated production concurrency or financial execution. Node47PASS; Python9PASS remains applicable unchanged. First reasoning-level test initially checked wrong provider option; corrected to Pi's actual reasoning:'high' mapping and verified. Remaining scope: competition/corridor analysis, unattended LM integration/API readback, migration/restore acceptance, rendered UI, final reviews and immutable multiarch publish/deploy/current runtime acceptance. Goal stays active, installed0.1.3 unchanged, M3/M4 disabled.

2026-10-09T04:40UTC public fee competition checkpoint: host scripts/competition.py installed with user satssurge-autopilot-competition.timer180s and bounded service150s. LND exact Config.Image lightninglabs/lnd:v0.21.3-beta@sha256:d29074335f3bffb2ac0e789b0d023c24fbb85ce67ecbfb7d677399842fe0535c and GetInfo version/sync/node binding checked. Fixed readonly host GetNodeInfo calls (no generic model RPC), max3 workers/max16 peers, exact public graph projection atomic0600. No agent credentials expanded/no Docker socket mounted. Ten peer captures succeeded, declared/captured channel counts agree. ACINQ has7missing incoming policies retained explicitly; all other peer captures0missing. Directed comparison uses NEIGHBOR outbound toward peer, not peer reverse fee; own edges excluded. Public bounds/disable filters retain unknown liquidity/traffic. Current local consumer qualifies source and builds quote distributions at10k/100k/500k plus bounded alternatives; missing-policy peer is partial. Installed0.1.3 does NOT yet consume new COMPETITION_FILE or render comparison panel.

Private live contract evidence copied to /Users/whirmill/.local/share/satssurge/m2-competition-qualified-20261009.json, not Git. Initial actual local consumer ran successfully against all10actual channel snapshots/public graphs. Example100ksat LNMarkets local40sat versus180.2sat announced median of36eligible public edges; this is a dated public-price comparison, not traffic, executable liquidity or profitability proof. Source timestamps now per-peer; serviceResultsuccess/ExecMainStatus0/timeractive reverified after update. Local Node50PASS and Python11PASS, competition UI literal-text/unknown median regression added. Goal remains active, no financial RPC/fee changes this turn. Remaining: backfill regular integration/API readback, restore/migration/release audit, rendered UI and immutable multiarch publication/deployment/current runtime acceptance.

2026-10-09 dispatch/maintenance security qualification checkpoint (LOCAL, NOT released): independent read-only review reproduced a failed-interlock invoice-await race permitting send. Fixed shared synchronous Store.assertDispatchReady at atomic reservation and immediately before AddInvoice/UpdateFee/Send: enabled/bootstrap/proof.ok, finite nonfuture <=90s proof, integrity blocker and durable maintenance claim are all required. Regression mutates every gate during invoice await; zero sends, FAILED0 and released reservation. Actual deployed autonomy paused via authoritative meta enabled=false; pending operations0. Resume only after corrected release/live acceptance.

Three-DB checkpoint CLI now holds the same data/executor.lock flock as container entrypoint across both stopped checks and all SQLite backups; contention test proves startup writer excluded. LM backfill restart obtains BEGIN IMMEDIATE durable maintenanceClaim only on qualified schema3 and no pending operations; reservation/final dispatch observe it. Errors/crashes retain claim, and recovery detects orphan claims independently of checkpoint phase, verifies pinned running LM/native log API before release; unknown owners fail closed. Regression covers crash after completion receipt before cleanup, no repeated restart/payment. Current0.1.3 does not implement schema3 fence: newly revised backfill must not restart LM on that version; unchanged API verification remains supported.

CI packages:write moved from workflow/PR scope to separate tag-only publication job dependent on successful test/build. Conditional same-host cookie trust remains an explicit residual requiring authentication isolation qualification before final acceptance. Local test result Node51PASS/Python14PASS, UI JS syntax and git diff --check pass. Rendered task-owned IAB localhost5298 read-only fixture verified queue/analyst count, LNDg/LM source-separated diagnostics, ten peer fee comparisons and7/30 evaluation empty state; console warn/error empty. Fixture is dated evidence, not production UI/current economics.

Prior checkpoint isolated restore qualification copied three private databases from20261008T201109Z into Mac m2-restore-qualification-20261009; checksums/integrity and schema1->3 migration preserve86ledger rows and enabled/mandate/model/historyStart/installedAt metadata. This is isolated recovery evidence, not production restoration. Continuous backfill host timer last successful04:47:56UTC projected34 verified selfpayments, zero additions, native API records equal persisted file; no LM restart during that run. Latest corrected host scripts still await deployment together with schema3. Goal remains active: final review, auth isolation, requirement audit, immutable multiarch release/deploy and live concurrency/recovery qualification remain.

2026-10-09 scoped security followup accepted: independent reviewer tested normal send once and seven invoice-await guard mutations each zero sends/FAILED0; no remaining P1/P2 blocker in dispatch/checkpoint/maintenance corrections. Host/container lock inode and installed executor version remain live-deployment checks. Same-host cookie auth isolation remains separate outstanding scope.

2026-10-09 release0.2.0 preparation: owner authentication now explicit8h bearer session in origin-scoped sessionStorage, credentials:omit, strict parser and no cookie fallback. Sibling Umbrel ports cannot receive ambient session cookies; transport still requires trusted LAN or HTTPS. Independent review accepted isolation delta and found delayed401 could erase newer login; fixed per-request session comparison and regression. Node54PASS/Python14PASS, no provider auth/runtime secrets output. Actual host/container executor.lock device66308/inode70583 agree, and host nonblocking flock refuses while container runs, proving same active writer lock. Installed0.1.3 still healthy/paused/schema1/zero pending; host watchersactive. Newmetadata0.2.0 prepared; store manifest/Compose must not be published as an upgrade until new immutable image digest exists.

2026-10-09 source0.2.0 commit1470de0329ec2daa11684f922db43edb818a47e0 pushed; immutable annotated tag satssurge-autopilot-v0.2.0 created. CI37886721241 FAILED54test suite53PASS on Node24: delayed-overlap fixture inserted an incomplete historical proposal lacking demandKey; evaluating its inconclusive window attempted undefined SQLite bind, accepted asnull by localNode26 but rejected by Node24. No image published/publishjobskipped, store manifest/Compose stillheld, installedruntime unchangedpaused. Fixed fixture to clone valid original historical Proposal whilechanging source/target; true delayed completion overlap assertion retained. Full compiled suite now54PASS under npm-providedNode24 as well as priorNode26; no production economic calculation changed. Preserve0.2.0tag, release correctionas0.2.1; no retag/force.

2026-10-09 source0.2.1 correction9acf61d27a4fc17ce542115c84a183471b85a3c2 pushedmain; annotated tag satssurge-autopilot-v0.2.1 objectdf3f64b60a001c592ba43150e58c9aecbae915d9 peels exact. CI37887148608 QUEUED verified https://github.com/whirmill/umbrel-community-app-store/actions/runs/37887148608; release specialist monitoring samehandle. No image digest yet; heldCompose/manifest unchanged. Corrected hostcheckpoint/diagnostics/competition/backfill scripts staged privately at /home/umbrel/.local/share/satssurge/autopilot-release-20261009/scripts/, not installed/executed. Next: verify CI immutableamd64arm64index, pinheldmanifestCompose, stoppausedapp with0pending, runlocked3DBcapture+copyverify, updateexistingapp/hostwatchers, qualifyOAuth/schema3/mandate/history/diag/competition, actualread-onlyqueueconcurrency withfinancialmaintenancefence, backup/restoreandresume. Goal remainsactive untilcompleteinstalledacceptance; no financialRPC duringqualification.

2026-10-09 M2 completion audit BEFORE deployment (completion still unproven):
- Mandate/budget/reservations/future-demand exclusion/freshness/negative strategies: current Store/Executor/Economics and core/evaluation regressions54NodeCIgreen. Pending installedschema3 preservation/readback.
- Durable queue1coordinator2readonlyanalysts, IDs/leases/recovery/submissionfences, graceful shutdown, model cooldown/usage: Queue/Scheduler/Agent and actualPi crash/caller/provider tests qualified locally; pending authenticated installedconcurrency/read-onlylivequalification.
- Private3DB/history archives, UTCintegerprovenance, repeat import/discrepancies, retention/immutableforecasts7/30 windows: source+tests, isolated1->3migration86ledger rows preserved, linkedhistory82docs. Pending fresh stopped3DBcheckpoint/update preservation and current historical reconciliation. No real new7/30 observation window has matured yet.
- LND authoritative collector, versionawareLNDg/LMdiagnostics, failedattemptvsrollup semantics, publicdirectedfeecompetition: current adapters/tests and host service projections qualified; pending newappROmount/freshsourceconsumption/API+UIacceptance. Publicgraph doesnotreveal competitor traffic/liquidity.
- Continuous LM selfpaymentvisibility:34nativeAPI/file records verified, exact restrictedreadonlyLNDsource; atomicmaintenance/same-inodecheckpointlocks and interruptedclaimrecovery regressions14PythonCIgreen. Pending installedschema3hostmaintenancepath acceptance.
- Web chat/jobs/decisions/budget/evaluations/auth: renderedlocalhostreadonlyfixture+shippedscript tests; neworiginBearerstrict8h/cookie fallback rejected, stale401race fixed; pending installed ownerlogin/renderedview. LANHTTP retains trustednetworkboundary; HTTPSneeded on untrustedtransport.
- Publishamd64/arm64immutableimage/store/install: CI37887148608 build tests SUCCESS; publishjob113679668762 liveinprogress. Mustinspectindexdigest/platforms, pinstoreonlyafterpublished, preserveoldreceipts/mandate/pendingstate during update.
- Final resume autonomousfee/rebalance: intentionallydisabled duringsecurityqualification, pending controls/auth/reconciliation before reenable. M3/M4 notenabled; no financial RPC merely for tests. Objective remainsfullM1.1/M1.2/M2 and active until everypendingacceptanceabove is proven.

2026-10-09 release0.2.1 VERIFIED CI37887148608 build/publishSUCCESS54Node14Python, source9acf61d27a4fc17ce542115c84a183471b85a3c2. OCIindex7dcf8c66eaffe07a4893af29dfbd356747ea540cdf2b77a4e099cea58e1f7f4f; amd64manifest630231f2642038a96718fd04cee5bedd018ee9514b3031a012de98f35feed3ae, arm64manifest802fbc07fd4699d4a642414863ad19abe5393ec84b8b7aa29042cc0fe8be88cf. Release specialist verifiedanonymousindex/config/layersHTTP200 and exactsourcecommit botharchitectures. Compose nowpins0.2.1index and heldmanifest0.2.1 ready tocommitstoreupgrade. Installedruntime still0.1.3paused; nofinancialaction.

2026-10-09T05:21UTC live deployment acceptance in progress: store metadata commit7ad7e80587d2e075f2288c0d0d3e9fd09b8f69bf pushed/readback matching managedstore; existing unrelated .gitkeep deletion preserved. Actual apppaused/schema1/96ledgerrows/no pending verified before stop. Fresh same-executor-lock threeDB checkpoint captured at data/checkpoints/pre-021-20261009, copied privately to Mac /Users/whirmill/.local/share/satssurge/checkpoints/pre-021-20261009 and checksum/integrity verified. Authenticated Umbrel UI updated existing app0.2.1; exact OCIindex7dcf8c66eaffe07a4893af29dfbd356747ea540cdf2b77a4e099cea58e1f7f4f runninghealthy. RO history/interlock/diagnostics/credentials mounts verified; onlydataRW. Schema3 quickcheckok,96ledgerrows, originalinstalledAt/model/mandate preserved, OAuthconnected/bootstraptrue/no blockers. Corrected diagnostic/competition/backfill host installers succeeded. Hostproxy5238 redirects unauthenticated HTTP; qualified internalapp8080 via in-memory ownersecret and bearer (no secrets output).

Three actual authenticated jobs admitted whilepaused, retryoriginalanalystID returned samejobID. Atomic durable maintenanceClaim owner runtime-qualification obtained withzero pending before enablingqueue dispatch; ALL financialreservation/dispatch remainblocked. Three originalPi jobs actuallyrunning concurrently at05:21:26UTC: coordinator0b9ed336-913f-4ca3-9fac-9c2b5dc95362 conversation391/submission404; analystb4868819-fdc2-4010-aaba-ed8718c5b180 conversation379/submission398; analyste66f51a7-38e4-4c88-b931-17bfd71f36c9 conversation385/submission401. Attempts1each, pendingfinancial0. This proves actual concurrentstart, not completedanswers/recovery/profit. NEXT poll originaljobs, qualify completedreceipts/installedUI and diagnosticcoverage, preservefenceuntilacceptance; pause queue and clearONLYownedqualificationclaim safely before intendedautonomyresume. ScheduledAIjobs may alsoenqueue whileenabled butfinancialfence remainsmandatory. Do not markM2 complete yet.

2026-10-09T05:22:17UTC actual authenticated concurrency acceptance PASS: all three original coordinator/analyst jobs completed, attempts1each, originalconversation/submission IDs unchanged; wallclock39.769s/49.492s/50.942s, startswithin4ms, nofinancialpending. Newapp consumer qualifies freshLNDg1.11.1 (48forwards,201failedHTLCattempts) andLightningMate0.7.7 (34rebalance logs,18failurelogs) separately; competition10peersqualifiedpublicgraphonly. Continuousbackfill05:20statusok/unchanged/34proofs/zeroadded/nativeAPIverified. Queue dispatchpausedagain afteracceptance; ownedruntime-qualificationmaintenanceclaim RETAINEDuntilfinal UI/control acceptance. InstalledownerUIrequiresnewlogin with unchangedpassword; asyncuserlogin requested, OAuthalreadyconnected, no callbackrequired. Goalstillactive; subsequent schedulerjobs maycontinue readonlyrunningwhilepaused, financialguardsblocked.

2026-10-09 final additional livepreservation checks: exact96historicalledgerrows each unchanged versusfreshpreupdatecheckpoint, zeroadded/deletedrows. Fourhostinterlock/diagnostic/competition/backfilltimersactiveafterseparateSSHsession. FreshthreeDBcheckpoint restored ONLYisolatedMacdirectory pre-021-isolated-restore-20261009; actualcurrentStore migrates1->3withquickcheckok/96rows/model/mandate/pausedstate/zero pendingpreserved. Thisisrecoveryqualification, NOTrollback oflivefinancialstate. PendingownerUIlogin/renderandfinalaudit/resume; financialqualificationclaimretainedandautonomypaused. Do noteraseunknownclaimsorassertprofitabilityfromtechnicalacceptance.

2026-10-09 installed UI acceptance found real0.2.1regression: shippedfrontend credentials:omit prevents existingUmbrelapp_proxycookie authentication. Cookie-freehost5238/api/status returns302toUmbrel2000app-auth, browserFailedtofetchbeforeownerlogin. Internal8080APIacceptance didnotcoverexternalproxy. Proposed0.2.2credentials:same-origin ONLYrelative/api calls retains explicitBearerownerAuth/originscopedtoken/CSRF; server continuesrejectcookiefallback. Newshippedscriptregression asserts sameorigincookies/relativeAPI/bearer andunauthorizedclear. Securityreviewfollowupread-onlyactive; sourcepkg0.2.2preparednotpublished. Do NOTbypassproxy/reduceitsauthoroverwriteimmutable0.2.1.

One subsequent scheduled analyst actualPi submission endedterminalmodel_error (technicaldetailclassnetwork/502or503, notquota/auth) at05:23:44; originalreceiptpreserved/no replay, persisted30mincooldown05:53:44. Otheranalysis/eventscompleted. Deterministiccollectors/timerscontinuefresh, pendingfinancial0. Thisisrealprovider-unavailablecontinuityevidence, not proof ofrecoveryyet. Financialqualificationfence/pausedstate remain. PendingUIrequestneednotberepeateduntilcorrectedfrontenddeployed; taskcreatedapp tabclosedturnend, recreateandmarkhandoff whenneeded.

2026-10-09 release0.2.2VERIFIED: CI37888742953SUCCESS54Node14Python; sourcec7febdb982be086ee59981e162e09bb4d7ddfa92, tagobjectb511a0ce703a871494ed8c2800dde7f205301f6e exactpeel. Imageindex2943a606b55fb2c75d5a4059285f3cdfb96ae2f02dcf3c42902fd37c832b0154; amd64b4c72ee4d57a9d4f464ab794eaf943d23eb4b7b3f657eda24a8e1d73677c0c3f, arm64264cd4c68c6f7612a52d5d33cfd110944e05dac223c6ab35dae07fbd974f5b11. Anonymousindex/config/alllayerHEAD200/exactsource botharchitectures verifiedreleaseengineer. Composepinnednewindex/manifest0.2.2preparedstorepublication. Freshschema3checkpointpre-022-20261009 capturedwithstoppedappsameexecutorlock, copiedMacsamepathcheckpoints/verifiedthreeDB. Current0.2.1 restartedpaused/fenced:5completed1failed1queued jobs retained, persistedprovider cooldown retained, nofinancialpending andcollectorfresh. Storeupdate/UIproxyacceptance stillpending, goalactive.

2026-10-09 store0.2.2metadata8336c818365a05a4350c7dc90e605e9051e25630 committed/pushed/liveandmanagedcloneFFverified; unrelated.gitkeepdeletionpreserved. AuthenticatedUmbrelupdateclicked existing0.2.2software; visibleUpdating0% and oldcontainerremovedduringnormalupdate. Freshpre022checkpoint contains schema3/5completed1failed1queuedjobs/modelcooldown/qualificationfence/pausedstate preserved; copiedMacchecksumvalid. ExternalUIpostupdateacceptance stillpending; do not restartupdate fromtemporarilymissingcontainer.

2026-10-09T05:34UTC0.2.2installed exactindex2943a606...healthy. ActualexternalbrowserwithUmbrelcookies/noownerbearer nowrendersOwnerauthenticationrequired (backendJSON401), replacingFailedtofetch/proxy302; preservedproxyauthandstrictownerboundary qualified. Correctedtab14 visible/markedhandoff, userloginrequestedasync (no password/chat/OAuthneeded). Internalauthreadback200 confirmsOAuthconnected/selectedgpt6.1sol/high, bootstraptrue/noblockers, qualifiedLNDg/LM/competition,82historydocuments47importedexpenseentries, schema3,96historicalrows preserved. FreshautomationProofok05:34:50UTC, snapshot synced10channels502858confirmed; nointegrationblocker/nofinancialpending. PartialPnL2313194rev10705169costmsat net-8391975 remains declaredpartial; no profitabilityclaim. AllM2calendarwindowsnewandnotyetmatured (zeroevaluationWindows), implementation/testability noteconomicoutcomeguarantee. CurrentstatePAUSEDandownedqualificationfence retained; finalbrowserlogin/render/resume anddeliveryevidencedocs publicationpending.

2026-10-09 M2.1 implementation checkpoint (not yet published/installed): React19/TypeScript/Vite workspace with shadcn Button and assistant-ui0.15.25 ExternalStoreRuntime; AI Elements retained as unqualified alternative. Durable schema4 UI journal/message entries, authenticated SSE cursor replay, sanitized paginated history, canonical terminal receipts, nonce recovery and safe Markdown. Pi Durable/model/OAuth/executor authority unchanged. Independent backend review found no remaining concrete source blocker; installed proxy/restart/session/backpressure acceptance remains pending. Node24 69PASS and Python15PASS. Local visible browser verified login rejection/success, concurrent chat/readonly analysis, supported queued cancellation, pause/resume, reconnect and terminal badges, no console errors; history scroll anchoring still under final browser verification. Initial installed0.2.3 autonomy enabled, zero financial pending and no maintenance claim. User additionally authorized transient SSH owner-secret retrieval for autonomous login; never print or persist that secret. Unrelated docs/work and root scripts remain untouched. Publication and actual installed M2.1 acceptance are required before goal completion.

M2.1 prepublication verification update: final source version0.3.0, Node24 69PASS/Python15PASS/typecheckPASS/diffcheckPASS. Visible local browser additionally qualified mobile390x844/tablet768x1024/desktop1440x900 reflow, keyboard login/OAuth submit and navigation focus, session expiry back to login, OAuth simulated rejection/success, safe markup, refresh/reconnect and long paginated history. Fixed independent assistant-ui rendering timing with DOM-message observer before scroll height restoration; actual older-message prepend retains9229px anchor rather than jumping to0, no false new-message indicator. Production public assets are generated by Vite during Docker build and ignored in Git; obsolete vanilla assets removed. Source backend review signoff conditional on tests now satisfied. Pending: immutable CI publication, fresh consistent checkpoint, update installed app, real Pi/browser acceptance and restoration of initial autonomy.

M2.1 release0.3.0 published source d0c702a906378dd596f6ef23fcbe9335b167a306/tag satssurge-autopilot-v0.3.0. CI37899334538 SUCCESS69Node15Python; verified OCIindex e715940949cf859f4b739a69eb98220403ccda4a7eb34d7253535ee145c7772d, amd64manifest6e63847aac94d9b70dc896e31126f88ec2b8652276fd72566ce76411cb0bbc38, arm64manifest11e2baf7215f8b78ce6d5e62b1ccb89c9f316a345cc61f533ea3f70b5803a6f3. Bothplatformconfigsource/revision exact; anonymous22layers217733742bytes streamed/hashverified. GHrelease published. Compose/manifest pinned awaiting storecommit/update. Installedoldapp stoppedpaused with ownedm21-ui-qualificationfinancialfence, zerooperations/pending. Backfilltimer/service stopped temporarily from initialactive; other3watchersactive. Fresh consistent pre-030-20261009 threeDB checkpoint captured with stoppedchecks/sameexecutorflock, verifiedhostandMacprivatecopy; isolatedrestore migrates3->4 quickcheckOK96ledger33jobs/paused/fence retained. Baselineprivatepreservationreceipt includes96ledger,33jobIDs,85historyfiles/mandate/model/installedAt/ownerhash. No OAuth/owner/history replacement. NEXT storepublishandactualinstalledbrowser/Piacceptance, then reconcile/releaseonlyownedfence/restorebackfilltimerandinitialenabledtrue.

Installed0.3.0 acceptance found genuine HTTP-origin defect: crypto.randomUUID unavailable at http://umbrel.local (localhost mock is secure context), so admission threw before any job/operation. UI owner login/proxy/SSE worked, history132messages/zero stalequeued badges. Preserved ledger/jobs/meta/history85files/owner compare EXACT beforefirst UI mutation; image healthy/schema4. New0.3.1 corrects requestID using Crypto.getRandomValues128bitownerhex (works HTTP without randomUUID), retains persistentnonce/retryidentity; targeted regression added70NodePASS. Also follows assistant-ui DOM mutations for latest scrolling and opens conversation atlatest on navigation. 0.3.0 immutable tag/image retained, nooverwrite. Installedapp remains paused/fenced/no financialtests; checkpointpre030 also consistent0.3.1preimage (noacceptedjob/financialeffect sinceupdate). NEXT publish0.3.1andrepeatactualinstalledadmission/Pistream/restart/reconnect.

Release0.3.1 source719c20be7916440b2a9b6b8b565e9081a6c7e0f2 CI37900459290 SUCCESS70Node15Python; OCIindex1f3ac8c0481fae8ae98625bb7bc47d5936a01afdbb87f510d8b7c20aa5483915, amd64manifest67d32466d4725ceb149241ceed231f90e712f8506dda3be3bd4be5f0e1fea2cb, arm64e73167c59a85194a72d6ace246ba29ffbcc5db538b27d663f3d650933f23ba82. Anonymous22layers217738283bytes SHAverified, configs exactsource bothplatforms, GHreleasepublished;0.3.0untouched. Freshpre-031-20261009 checkpoint capturedstopped/sameflock andverifiedhost/Macprivatecopy. Compose/manifest0.3.1 awaitingmetadataGitandinstalledupdate. Remaining actualHTTPnonceadmission/concurrentPistream/cancel/restart/reconnect/responsive/console/finalresume acceptance.

2026-10-09 M2.1 INSTALLED ACCEPTANCE COMPLETE:0.3.1 healthyactualUmbrelamd64 imageindex1f3ac8c0481fae8ae98625bb7bc47d5936a01afdbb87f510d8b7c20aa5483915/configdc85013bb17acce700fc2be9b4b9d030b385185af7a9dd7847bfa5b2e4c3966c/source719c20be7916440b2a9b6b8b565e9081a6c7e0f2. Store52ed06b15e1633beb2ee7cc848a4b38b1e8d1990FFverified, unrelatedcloudflared.gitkeepdeletionpreserved. HTTPoriginnoncefixactuallyqualified. User/concurrenttest29ad920f-e11d-4869-9728-578c7370b5a6 was admitted independently during0.3.0acceptance; prior note 'nojobsadmitted' referred to failedownedprobe, not concurrentstate. Freshpre031checkpointcontains34jobsincludingthatqueuedrequest; original33terminaljobsexactpreserved. Nevercancelledorreplacedconcurrentrequest; itcompletedonceafterrestart.

OwnedPiA2377f1db-1c77-438b-9031-c238c71cdd70 conversation2638/submission2645; B719701a7-7ec3-4317-a1d6-377e0532a1ad2599/2618; Ce9af1498-0ac8-4132-8ee5-5c464f97e3152605/2621. Allcompletedattempts1, startsA07:49:51.974UTC/B07:49:46.318/C07:49:46.323 withoverlap and10.719/11.939/11.709s runtime. Actualreadonlynode_statetoolcall/resultoneeach, text21/26/18events; nofinancialtoolcalls/operations. Ownedcancelledanalystf9161a54-ca2c-4ead-b2a4-576fdd3b25e8 attempts0/noPisubmission. FourqueuedoriginalIDsretainedthroughactualcontainerrestart/reauth; refreshandexplicitstreamreconnectrecover150messageswithoutresubmit. Slowreader20seconds observed428SSEeventsordered/0duplicates (job/progress/text/toolcall/result), originalcursor6→624. Authenticatedvisiblebrowserproxyflush/progress/tools/resultsverified; nohiddenreasoningdisplay.

Installedbrowserlogin/logout/sessionexpiryafterrestart, settings/modelSol/high/OAuthpreservation, navigation/activity/node/diagnostics/competition/accounting/budgets/decisions/experiments/pause/resume verified. Mobile390x844/tablet768x1024/desktop1440x900reflowwithoutpageoverflow; keyboardlogin/toolsummaryexpansion/focus/fieldlabels; consoleerrors0. Local125jobfixturepagination/unsafeMarkdown/OAuthfailure+success/reconnect/sessionexpiryqualified separately. Node24 70PASS/Python15PASS; anonymousbothplatformalllayersproofandnativeCI37900459290complete. Pre030/pre031checkpointstopped/sameflock/host+Macverified; isolated3->4restoremigrationquickcheckOK96ledger. Canonicaloriginal96ledger/33terminaljobs/meta/model/mandate/history85files/ownerhashallEXACTunchangedaftertests. Private receipt /Users/whirmill/.local/share/satssurge/autopilot-m21-acceptance-20261009.json; image031/preservationreceipts andscreenshots sameprivatebaseoutsideGit.

Finalreconciliationzeroactivequalificationjobs/financialpending/operations/toolfinancialcalls. Onlyownm21-ui-qualificationclaimreleasedatomicallywhilepaused; backfillservice schema4 Resultsuccess/ExecMainStatus0; allfourhosttimersactive. Initialenabledtrue RESTORED viaownerUI, freshreadbackbootstraptrue/proofok/blockers[]/claimnull/Solhigh/OAuthconnected/healthy/schema4quickcheckOK/pending0. Previouslyscheduledautonomyqueuedwork preserved and resumednormally. Two scheduledanalysts hitexisting180s/30callboundandremainterminalaborted; originalreceiptsretainedwithoutautomaticreplay, notstuckqueued. ResidualVoiceOverunverified/bundle~199KBgzip/publicreasoningsummaryunavailable/accountingpartial; M3/M4notenabled, no financialUItest/regtest. Localfixtureprocess54331terminated/session66007exit0/port19538absent. Finaldeliverybrowser/screenshot/docpublicationremainingonly; goalmaycompleteafterfinalhandoffpush/readback.

2026-10-09 visual refinement0.3.2 prepared: semantic colors plus exact local/remote liquidity donut and per-channel stacked balances, active filter and sorting, revenue/cost comparisons, daily/exploration/cumulative budget gauges, public fee paired bars and persistent queue state distribution. Compact job/decision/evaluation evidence and chat tool groups use native disclosure. Accessible labels/exact bigint values/unknown counts preserved, no added financial/backend capability. Node75PASS; local visible390/768/1440 reflow/filter/sort and rich simulated accounting verified. Release/install acceptance pending.

2026-10-09 M2.1 reactive SSE implementation in progress: user-authorized scope replaces 500ms journal polling with post-persistence notifications and cursor-driven async generators; retains owner authentication, Umbrel same-origin cookies, CSRF, session expiry, heartbeats, bounded backpressure, five-second status refresh and canonical durable receipts. Frontend stream decoding/reconnect/abort cleanup extracted without changing charts or financial authority. Source 0.3.2 remains immutable; primary owns subsequent version/publication/install acceptance. HTLC streaming, paginated adapter generators and Pi watcher adapters are read-only future candidates until their completeness/recovery contracts show a bounded benefit; no scheduler/executor/regtest or financial tests are authorized here.

2026-10-09 M2.1 reactive SSE source proof: shared per-Store EventEmitter notifies only changed INSERTs after Store.tx COMMIT; callback Set coalesces transaction notifications, ROLLBACK discards them, observer failures cannot change committed action results. UiEvents.stream subscribes before initial read, uses version-checked waits and bounded 64-row batches (maximum 256), no notification payload queue; idle 15s heartbeat rechecks the journal and authorization. SSE drain waits consume no further batch, timeout destroys the socket, disconnect/shutdown abort and finally remove listeners. Browser ownerEventStream decodes incremental UTF8/CRLF, bounds frame buffering to 8Mi characters, preserves same-origin cookies/Bearer, handles journal cursor replay/409 history reset/401 expiration and cancels/releases readers; status polling remains 5s and chart markup unchanged. Simulated tests cover transaction/duplicate/rollback/observer failure, subscribe-read race, missed notifications, ordered replay, abort/consumer return, backpressure timeout/session expiry/disconnect, fragmented UTF8, replay dedup, resync, expiration and buffer bounds. Verified Node24.21.0 npm test: build/backend+frontend TypeScript+Vite and 84 Node tests PASS, git diff --check PASS. Vite retains bundle-size advisory (~203.55KB gzip); installed proxy/session/backpressure browser acceptance belongs to primary before delivery. No version/Git/release/deploy or financial/runtime writes by implementation lane. Future HTLC generator would need explicit overflow gaps and preserve finally coverage; page generators must retain all-pages-before-ledger/coverage transaction; Pi already has bounded watcher batches plus authoritative snapshot/final original receipts, so adapters deferred.

Additional future candidate: massive journal/accounting exports can use bounded async page generators with explicit snapshot/cursor contracts, cancellation and completeness receipts; never materialize an unbounded export array or change existing financial ingestion/coverage transactions. Final formatting uses pinned Prettier3.6.2 only on ui-events.ts, new ui-stream.ts, new ui-reactive.test.ts and App.tsx; Store/server retain surrounding style to keep their operational diffs narrow.

2026-10-09 reactive SSE review: no concrete source blocker. Local visible browser two concurrent simulatedjobs, disconnect/reconnect, refresh and persistent two toolgroups/no duplicates, expiry back to ownerlogin qualified; console0 before deliberate401. Fixture authorization now checks the current session per write/heartbeat like production (local only). Python15PASS. Version0.3.3prepared;0.3.2immutableCI37905318783SUCCESS retained but no032install or release metadata. Installed0.3.1healthy initialenabledtrue restored after brief pause; final033checkpoint/install/Piacceptance remainspending.

2026-10-09 release033VERIFIED: source1a0481580cfa9cc702558d982cabe7476ba1c4fa/tag immutable;CI37906474987SUCCESS84Node24/15Python. Indexdea14693bda4ec9337216636c250ab81e09dab5d861ef9ccac3558f6f56c3af4, amd64manifest74265969348ae780c66709ee2dff2ebb7a2e1055b8ff2fd90112dc45a76574eb, arm644e8e9d0eecae822ee9567c0ccf57525b157d4e10bd7af8f21dc2b009c2030a0a; anonymous22layers217762597bytesSHA/size verified,GHreleasepublished. Storemetadata000b492ea1e623a9e7777900b3622d0c516c630bFFmanagedcheckoutverifiedpreservingunrelated.gitkeepdeletion. Freshpre-033-reactive-20261009checkpointcapturedstopped/executorflock,3DBverifiedhostandMac; fullledger/jobs/meta/history/ownercompareexactaftercheckpointrestart. Initialenabledtrue nowpaused withownedm21-reactive-qualification-033fence andbackfilltimer/service temporarily stopped; other3usertimersactive.0activejobs/0financialpending beforeupdate. AuthorizedvisibleUmbrelUpdateclicked033;Updating0% andoldcontainerremoved normalupdate. NEXT actual033healthy/digest/browserPi/restart/projectionacceptance thenreconcileonlyownedfenceclear/backfillrestore/initialautonomytrue.

2026-10-09 M2.1 reactive/visual installed acceptance COMPLETE.

- Installed 0.3.3 is healthy on Umbrel amd64, index `dea14693bda4ec9337216636c250ab81e09dab5d861ef9ccac3558f6f56c3af4`, config `44c2088a1935d2d5d17d617033bf9a0674bb81a2eb088e445efd66ee89386d15`, source `1a0481580cfa9cc702558d982cabe7476ba1c4fa`. CI 37906474987 passed 84 Node 24 and 15 Python tests; both platforms and all 22 layers were verified.
- Real HTTP proxy owner login/logout, connection refresh and session invalidation after process restart passed. OAuth and Sol/high were preserved. Two concurrent owned Pi jobs completed once with one read-only node_state call each. A third used node_state/state_page: live partial text was observed while running after browser refresh, then it completed once. Supported queued cancellation was terminal. All four request/job/conversation/submission receipts were unchanged after graceful restart; completed jobs had no stale queued label.
- Browser history reached 180 messages with 180 unique IDs. Tool-group Enter expansion, scroll to latest, 390/768/1440 reflow, 9-of-10 active filtering and local-percentage sorting passed. Console errors/warnings: zero. Backend MaxListenersExceeded/unhandled/uncaught logs: zero. Simulated tests prove listener/reader cleanup, slow-client bounds and timed expiry; production per-write authorization was independently reviewed. Natural eight-hour expiry and deliberately slow clients were not tested by waiting in the installed browser.
- Final reconciliation: zero owned active jobs and financial pending operations. Only the owned m21-reactive-qualification-033 fence was cleared. Backfill service/timer and all four user timers were restored; initial autonomy enabled=true was restored. Original 96 ledger rows and 51 terminal job rows remain exact, as do mandate/model/installedAt, 85 history files and owner secret. No financial UI test, regtest or M3/M4 expansion occurred.
- Private acceptance/image/preservation receipts and screenshots are under `/Users/whirmill/.local/share/satssurge/`; the pre033 three-database checkpoint was verified on host and Mac. Fixture process 86249 ended with native exit130; port19538 has no listener. Fixture/store/reference tabs were closed, viewport reset, actual app retained. Future HTLC/page/Pi/export generators and separate 5s status polling remain documented. Vite's approximately 203.55KB gzip bundle advisory remains; no runtime blocker was found.

### 2026-10-09 Astra review remediation — source checkpoint before 0.3.4 publication

Implementation lane completed P1 + seven P2 + stale acceptance P3 without live application/financial operations or Git mutations. Immediately before the writable RPC, synchronous `assertReservedDispatch` checks current cumulative/daily/exploratory budget with the existing active reservation counted exactly once, current interlocks and snapshot freshness, and 500000 sat plus declared pending on-chain obligations. Mock invoice-await mutations prove all three budget overruns and increased obligations block send; unchanged admitted reservations still dispatch once.

Queue coalescence and its partial unique index now apply only to queued or unsubmitted waiting jobs. A running/original-submitted job can have one durable queued successor, further bursts coalesce into that successor, and the original conversation/submission receipt is untouched. `expired_events` stores only durable event identities: retention atomically tombstones before deleting raw detail; repeated imports and database reopen cannot aggregate the same identity again. This is additive within schema 4, preserves originals/pinned evidence, and does not reconstruct or silently amend historical aggregates whose raw detail has already expired.

Client validates UTF-8 JSON payload bytes before persisting a nonce; server independently reports explicit pre-admission oversized rejection. A rejected oversized message becomes editable; existing invalid oversized drafts retain their nonce until retry/recovery returns an authoritative receipt or explicit pre-admission rejection. Ambiguous admitted requests keep their original nonce/payload. UI projection retains latest cumulative text/progress/job snapshots, prioritizes current snapshots, limits detailed events to 10000 with a visible detail-limit annotation, uses reductions rather than argument spread, and keeps persistent history/final receipts authoritative. Owner logout requires existing bearer/Origin/CSRF protection and revokes that bearer; idle SSE stops at its next authorization/heartbeat check and releases listeners.

Docker entrypoint uses `flock --no-fork` so the lock holder execs Node and Tini forwards SIGTERM to its direct child. Synthetic subprocess SIGTERM with an active mocked Scheduler job proved completed receipt and drained shutdown. Local Docker daemon is unavailable; primary owns the isolated network-disabled Linux new-image init/flock signal proof before deployment. Lightning Mate merge counts only retained additions, reports actual final-content change, and takes maintenance/restart only for a changed final projection. Regression with 201 proofs repeated proves unchanged mode, no maintenance and no Docker calls. README/store no longer label accepted 0.3.3 pending.

Stable source verification: Node 24.21.0 `npm test` PASS 93/93 (backend/frontend TypeScript + Vite build); Python `python3 -B -m unittest discover -s scripts/tests -v` PASS 16/16; `npm run typecheck` PASS; `git diff --check` PASS. Existing HTTP fixture checks wrong Origin/CSRF cannot revoke, valid logout invalidates subsequent history/SSE access; SSE mock verifies already-open stream cleanup after revocation. Vite bundle-size advisory remains. Test-owned stores/temp directories/HTTP child/SIGTERM child/timers are closed. Release version bump, immutable multiarch image verification, host-script update, consistent checkpoint, installed-app/browser acceptance, and final operational reconciliation remain primary-owned; no publication/deploy is implied by this checkpoint.

Independent review caught and implementation fixed a new coalescence-index recovery collision before publication: `wait` and `recoverAfterRestart` clear the original coalesce key while preserving request/job/conversation/submission receipt identities. This lets an unsubmitted recovering original coexist with its already-persisted successor through `releaseWaiting`. Separate crash-before-submission and model-unavailable tests prove both jobs survive and become queued; final full Node24 suite is 93/93 PASS.

### 0.3.4 release preparation — source ready

Package, both root lockfile version fields and Umbrel manifest are now 0.3.4.
Target tag is `satssurge-autopilot-v0.3.4`; build destination is
`ghcr.io/whirmill/umbrel-satssurge-autopilot:0.3.4`. No tag/source SHA, Actions
run or new digest is claimed before the Git/publication handoff. Existing
workflow is unchanged and runs Node 24/Python tests before publishing both
linux/amd64 and linux/arm64 on matching tag push. Compose still pins verified
0.3.3, whose installed acceptance is complete.

Primary schedules narrow git-operator commit/push/tag of the tested source,
then release-engineer verifies Actions and anonymous index/config/layer
receipts before pinning the new compose digest and publishing release notes.
Fresh stopped/flock-protected three-database checkpoint, pending-receipt/data/
OAuth/mandate preservation, new-image shutdown proof, installed 0.3.4 browser
acceptance and final operational reconciliation remain required. Do not restore
an older financial checkpoint over current receipts or replay uncertain sends.


2026-10-09 final remediation compatibility checkpoint (0.3.4 source, publication still primary-owned): legacy 0.3.3 admission used scrubbed payload bytes, so raw oversized credential-like drafts may already have a valid original receipt. Removed the local size-only discard action. The server checks an existing request through Queue’s original scrubbed payload digest and returns its identical receipt before considering a raw-size rejection; uncertain nonce/payload remain immutable until explicit nonadmission. Actual HTTP regression recovers the same legacy job from 17000 raw characters reduced by redaction; a new 17000 ASCII payload receives definitive 413/admissionRejected without creating a job.

Frontend history cache now caps 250 terminal jobs plus active receipts, pins the current older history page across status refresh, bounds event details separately to 10000, and explicitly explains the window with “Torna ai recenti”. Arbitrarily older pages remain reachable by server row cursor; returning recent preserves active receipts. Resets preserving a stale active job retain the lower replay cursor (clamped to current server high-water), preventing completion outside the newest 50 history/40 status rows from remaining “running”. Regression traverses 600 jobs/12 pages, checks status refresh preserves selected older page, active submission identity, bounded cache, recent reset, and missed terminal-event replay. The local-only UI fixture accepts FIXTURE_HISTORY_COUNT=350 on a fresh private directory and implements session logout for primary’s visible browser acceptance.

Final stable checks after these compatibility/history corrections: Node24.21 npm test 95/95 PASS; Python16/16 PASS; backend/frontend typecheck PASS; fixture node --check PASS; git diff --check PASS. No child runtime/SSH/deploy/Git/financial writes. All implementation writes and test processes stopped at handoff. New-image isolated Linux SIGTERM/flock and actual installed/browser verification remain primary-owned.

Final 0.3.4 release-note readiness: independent review and final full suites
passed 95 Node24/16 Python; typecheck and diff whitespace checks passed. Visible
local 350-job fixture acceptance verified 17000-character pre-admission
validation leaves editable input, corrected valid admission, seven older pages
reaching oldest entry, a maximum 250-job/500-message retained history window,
and “Torna ai recenti” restoring 100 recent messages/latest visibility and
releasing the limit notice; console errors zero. Legacy oversized existing
nonces remain preserved until authoritative recovery or explicit nonadmission;
recovery coalescence-index collisions preserve both original and successor
receipts. This does not qualify the installed new version. Immutable 0.3.4
publication and actual installed acceptance remain pending; 0.3.3 acceptance
is complete. Release documentation writer stopped after scoped checks.

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

Final 0.3.4 publication/install acceptance supersedes the earlier source-ready
and pending checkpoints above. Documentation Git publication remains primary-owned.

Final follow-up evidence: `preservation-accepted034.json` confirms:

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

### Piano di risoluzione dei run — 2026-10-09, consultazioni Astra

Stato: piano preparato su richiesta dell'owner, non implementato né qualificato.
Tre lane Astra/high in sola lettura hanno verificato lifecycle/budget,
paginazione/selezione delle evidenze e UI/provenienza. Nessun runtime, mandato,
OAuth, database o receipt è stato modificato dalle consultazioni. La versione
installata rimane 0.3.4. Questa sezione integra il handoff esistente.

Evidenza live del primary: dalle 10:00 UTC, 13 job terminati, 6 completati e 7
falliti con `aborted` a circa 180 secondi; ultimo coordinatore con 32 tool call
e due errori oltre il limite 30. Chat: zero tabelle Markdown renderizzate,
168 paragrafi contenenti sintassi tabellare. Un coordinatore precedente ha
incluso due verifiche UI tra sei analisi; il feed corrente è cambiato nel tempo.
Operazioni e decisioni finanziarie risultavano zero alla lettura. Le cause
storiche specifiche di ogni abort non sono registrate: non retroattribuirle.

Ordine di attuazione, con review e verifica tra le fasi:

1. **Letture coerenti e mirate.** In `agent-state.ts`, `agent.ts` e un helper
   bounded di paginazione, aprire snapshot immutabili della sola collezione
   richiesta, filtrata per SCID/intervallo canonico. Cursore posseduto dal job,
   query e versione del contenuto; `capturedAt`, copertura e freschezza separati.
   L'hash attuale include sia `capturedAt` sia la finestra mobile di copertura:
   eliminarne soltanto uno non basta. Una continuazione usa la vista aperta,
   senza mescolare nuove acquisizioni. Scelta iniziale: cache derivata in memoria
   con limiti espliciti e TTL, non nuova tabella. Dopo restart, cursore scaduto e
   riapertura esplicita nella stessa submission. Mantenere compatibilità per le
   chiamate legacy `version/offset`. Ipotesi da dimensionare: tre viste per job,
   4 MiB per vista, 16 MiB globali, TTL cinque minuti; nessuna eviction silenziosa.
   Conservare envelope UTF-8 massimo 12 KB/20 righe e cleanup all'uscita.
   Riepiloghi deterministici BigInt per corridoio devono ridurre la necessità di
   leggere ogni record. Validare `captureCounts`; distinguere vista completa,
   cattura completa e storia upstream sconosciuta. Non attribuire a un corridoio
   bucket LM che identificano solo il target o record senza filtri supportati.
   Rendere espliciti limite/prosecuzione/copertura di `corridor_events` (oggi
   LIMIT 100) e delle proiezioni già limitate da `Store.stats()`.

2. **Budget e conclusione controllata.** Separare ownership, ricerca e fase di
   conclusione in `agent.ts`/helper di budget. Prompt e tool result espongono
   chiamate/tempo residui, copertura e motivo dell'esaurimento. Riservare spazio
   a stima/conclusione; esaurimento strutturato non deve generare un loop di
   errori. Ipotesi di prova: soft deadline 120 s, hard 180 s, ricerca 12 call
   analista/16 coordinatore, con riserva e limite assoluto 24–30. Sono parametri
   da qualificare, non promesse né valori definitivi. Aumentare a 210/300 s solo
   dopo misure sulle letture già circoscritte. Persistire budget/fase per non
   rinnovarli dopo recovery; registrare causa terminale, duration, usage e call
   anche nei fallimenti. Gestire l'esito asincrono dell'abort e cleanup.
   Bloccare nuove azioni finanziarie nella fase finale; un tool finanziario già
   entrato mantiene lease e segue receipt/reconciliation. Timeout non significa
   pagamento cancellato. Non segnare `completed` un frammento senza finale.
   Pi `whenBusy:steer` crea un'altra submission e `terminate` non produce una
   nuova risposta: nessuna API final-only presunta, nessuna steer nel primo fix
   senza test del vero Harness e lifecycle dei receipt di controllo.

3. **Provenienza e selezione.** Registrare server-side origin/purpose nei
   metadati dell'evento accepted, atomici con admission, in queue/server/scheduler;
   payload, digest e ID originali restano invariati. Distinguere owner economico,
   generale, scheduler e qualification. Prefissi request ID e testo non sono
   prova: legacy resta unknown, salvo annotazione append-only di ID auditati.
   `analyst_results` filtra purpose/scope e deduplica prima del limite; espone
   ultima analisi pertinente per scope con freshness, gap e receipt. Un risultato
   nuovo incompleto non deve essere nascosto da fallback silenzioso a uno vecchio.
   Descrittori bounded e dettaglio separato; owner economico resta eleggibile,
   qualification resta in cronologia ma fuori dal feed economico. La freschezza
   proviene dalle letture, non dal timestamp di accodamento.

4. **UI veritiera e leggibile.** Estrarre il renderer Markdown, aggiungere GFM
   con dipendenza esatta verificata e tabelle semantiche a scroll confinato.
   Mantenere skipHtml, immagini disabilitate, safeUrl e noopener; niente raw HTML.
   Link vietati diventano testo. Mostrare 'Tu' solo con origine verificata,
   titoli italiani per richieste automatiche e label neutra per legacy ambiguo.
   Distinguere risposta in corso, parziale, finale e annullata; `aborted` storico
   significa interruzione con causa non registrata. Nuovi timeout nominati solo
   quando documentati dal backend. Nessun retry automatico terminale. Nuovi
   output iniziano con sintesi pubblica; dettagli storici espandibili senza
   riscrivere receipt, troncare Markdown o inventare reasoning.

5. **Revisioni d'attesa persistenti, seconda fase circoscritta.** Dopo i fix
   precedenti, aggiungere registro non finanziario separato da decisions e
   evaluation_windows: scope, origine, evidenza consumata, requisiti mancanti,
   scadenza e trigger materiali. Non riavviare 'altre 48 ore' a ogni revisione.
   Tick periodico controlla scadenze; modello solo quando dovuto o cambiamenti
   materiali, con massimo intervallo/backoff per evitare starvation. Consumo
   del trigger solo dopo admission durevole, successori coalescenti, owner jobs
   preservati. Le ore comparabili restano determinate dal forecast autorevole.
   Eventuale nuovo schema è additivo e richiede prova migrazione/rollback; non
   rifattorizzare scheduler/esecutore per uniformità di stile.

Prove richieste prima della pubblicazione:

- Dataset 229/18/34, refresh di soli metadata, mutazioni reali, paging legacy,
  cursore di altro job/query, expiry/restart, cap piena e cleanup; contare tool
  call e verificare somme/campionamento/gap, senza completezza upstream inventata.
- Vero Pi Durable con modello simulato insistente/lento, race timeout/finale,
  recovery senza nuova submission o budget, mock finanziario in-flight con
  massimo un effetto e receipt uncertain preservato. Nessuna chiamata finanziaria
  reale necessaria per questi test.
- Selezione quattro economiche più due qualification, scope duplicati, owner
  economico, legacy unknown, risultato nuovo incompleto e parità timestamp.
- Markdown ostile, URL offuscati, HTML/immagini, tabelle parziali; matrice esiti
  e origine dopo refresh. Preservare cache 250 terminali + attivi, 10000 eventi,
  cursor/dedup, pagina storica, nonce incerti e scroll. Browser 320/390/768/1440,
  zoom 200%, tastiera e VoiceOver reale dove disponibile; non dichiararlo senza
  prova. Orologio simulato 72 h per scadenze/trigger/recovery della seconda fase.
- Suite Node24/Python/typecheck/build/review su contenuti stabili. Accettazione
  installata con Pi reale esclusivamente read-only, pagination attraverso due
  acquisizioni host, concorrenti, refresh/restart e receipt originali; almeno
  quattro intervalli per confrontare ripetizioni prima/dopo. Nessun risparmio
  economico o di latenza dichiarato prima di misurarlo.

Gate operativo invariato: checkpoint consistente delle tre SQLite sotto lock,
SHA/integrità/restore isolato, release immutabile amd64/arm64, store e update
Umbrel, verifica nel browser visibile, riconciliazione e ripristino dello stato
iniziale di autonomia/timer/fence possedute. Nessun regtest o test finanziario,
nessun replay di operazioni incerte, nessun restore sopra receipt nuovi; M3/M4
restano fuori scope. Le consultazioni hanno terminato tutte le letture e non
hanno creato processi persistenti o altre risorse.

### Addendum UI, prestazioni e riferimento assistant-ui — 2026-10-09

Richiesta owner: valutazioni Astra, prove sulla demo pubblica e integrazione nel
piano; nessuna implementazione o nuova release in questa fase. Il riferimento
visivo/interattivo è https://www.assistant-ui.com/, non una sostituzione del
backend Pi o del modello Sol/high. **Ultima correzione owner prevalente:** JSON
in Parameters/Results va bene; adottare thinking e strumenti raggruppati,
collassabili, con righe leggere, senza box per ogni tool. Non è richiesto
sostituire i risultati originali con nuove card di sintesi.

Due lane Astra hanno verificato assistant-ui/react 0.15.25 e core 0.3.24:
ThreadPrimitive.Messages monta tutti gli ID, senza virtualizzazione automatica.
La finestra applicativa 250 job terminali (+ attivi) e 10000 eventi limita record,
non DOM/byte. Details chiusi montano ugualmente tool/Markdown e JSON.stringify.
Projection Context invalida tutti i messaggi; scansioni ripetute degli eventi e
converter inline invalidano cache. Riproduzione isolata sul core installato:
finestre di 500 messaggi visitando 3000 ID => visible=500, retainedRepository=3000.
Prova di ritenzione degli oggetti, non misura di heap o stallo nel browser.

Interventi UI obbligatori nel piano, oltre a GFM/stati/provenienza già previsti:

- Stabilizzare converter/componenti e identità dei messaggi immutati; indice
  incrementale per job/toolCallId/latest text/progress e subscription mirate.
  Poll invariato e chunk di un job non devono rilavorare tutto il thread.
- Allineare anche il repository interno assistant-ui alla retention della
  finestra. Qualificare l'adattatore messageRepository che elimina gli assenti;
  nessuna cancellazione dei job/journal per liberare una cache. Test di navigazione
  su migliaia di ID, con receipt attivi e history/recovery invariati.
- Raggruppamento come la demo: intestazione compatta aperta/chiusa, singole righe
  espandibili, Parameters e Results JSON lazy. Details chiusi non montano né
  serializzano i discendenti pesanti. Apertura/focus per ID stabile; lista tool
  aperta anch'essa bounded. Stato reale e breve risultato nel titolo solo quando
  direttamente disponibile, nessun riepilogo generato da un altro modello.
- Qualificare una lista virtuale ad altezze variabili con API installate
  unstable_useThreadMessageIds/Unstable_MessageById isolate in un adapter pinned.
  Finestra DOM distinta dalla retention, valida anche con molti job attivi.
  Ancoraggio ID+offset, overscan, resize, tool aperti, streaming e prepend; rimuovere
  l'attesa attuale DOM count == messages.length. Non bastano memo/content-visibility.
- Limitare separatamente byte per finestra, corpo e dettagli; una history response
  che raccoglie tutti gli eventi di 50 job può essere grande prima del cap client.
  Prevedere dettaglio autenticato paginato e disponibilità esplicita senza alterare
  receipt. Coalescere soltanto pubblicazioni UI cumulative sostituibili, mantenendo
  cursor/ordine/eventi terminali/tool e flush finale; nessuna coda illimitata.

Thinking: verificato direttamente nel provider Pi installato, non soltanto nei
componenti della demo. Il catalogo Sol usa openai-responses, non il vecchio
provider Codex: openai-responses.js richiede già reasoning effort high/summary auto,
Pi Durable generation trasmette thinkingLevel e conserva thinking_delta;
openai-responses-shared.js converte response.reasoning_summary_text.delta in
thinking_delta. Quindi la capacità e il flag di richiesta esistono, mentre
ui-events oggi li esclude. Verificare l'intero percorso provider/Pi Durable/snapshot/SSE,
selezionando **solo sintesi pubbliche con provenienza qualificata**. Il medesimo
campo interno può avere fallback da reasoning content: non pubblicare genericamente
ogni blocco thinking. Escludere chain-of-thought nascosta, reasoning signature,
encrypted content e provider metadata. Se la provenienza non è distinguibile,
aggiungere un adapter tipizzato e test prima di abilitare la proiezione.
Per finale/snapshot, candidato da qualificare: leggere solo sul server l'item
Responses conservato nel thinkingSignature, validare type reasoning e selezionare
esclusivamente summary[] di tipo summary_text. Nessun fallback a content/thinking,
nessuna signature o encrypted_content nel journal pubblico. Per i delta preservare
la provenienza prima della normalizzazione generica; onProviderStreamEvent è un
candidato, non un'integrazione durable già provata. Binding job/conversazione/
tentativo/item/summary index e persistenza idempotente obbligatori. Test di firme
malformate, raw-only, summary vuoti e encrypted payload esclusi. Nessuna risposta
autenticata reale è stata letta in questa lane: capacità non significa che ogni
risposta restituisca un summary. Fonti ufficiali:
[Reasoning summaries](https://developers.openai.com/api/docs/guides/reasoning),
[Streaming events](https://developers.openai.com/api/reference/resources/responses/streaming-events).
Sezione collassabile 'Ragionamento · sintesi' con streaming autentico, snapshot,
ID/dedup/recovery, limiti e montaggio lazy; nessun testo inventato o percentuale.
Disponibilità dipende anche dal modello/risposta: assenza della sintesi è uno
stato supportato, non un errore. Mantenerla distinta da milestone operative.

Capacità libreria: ExternalStoreRuntime e renderer tools.by_name/Fallback,
GroupedParts/groupPartByType sono installati; ToolGroup/ReasoningGroup nei vecchi
slot sono deprecati. Componenti registry Reasoning/ToolGroup richiedono integrazione
esplicita. AI Elements non fornisce virtualizzazione automatica e non giustifica
una migrazione ora. Fonti: [Thread](https://www.assistant-ui.com/docs/api-reference/primitives/thread),
[Message](https://www.assistant-ui.com/docs/api-reference/primitives/message),
[Tool UI](https://www.assistant-ui.com/docs/tools/tool-ui),
[Reasoning](https://www.assistant-ui.com/elements/reasoning).

Prove demo effettivamente eseguite dal primary nel browser visibile: richiesta
meteo generica, streaming iniziale 'thinking', gruppo 'ran 2 tools', espansione
di get_weather con parametri/risultato JSON; richiesta generica di tre punti e
tabella, tabella semantica completata; tema e full screen, pulsante ritorno al
fondo presente. Nessun dato privato trasmesso. Non è una prova di performance
della demo né di reasoning summary con Sol/high. Screenshot privato:
`/Users/whirmill/.local/share/satssurge/screenshots/assistant-ui-reference-dark.jpg`.

Tema nel piano: Chiaro/Scuro/Sistema, default Sistema, preferenza locale validata
e persistente. matchMedia segue il sistema solo in modalità Sistema; sincronizzare
schede e gestire storage indisponibile. Bootstrap prima del primo paint nella SPA
con asset locale compatibile CSP script-src self, senza unsafe-inline. Token per
superfici/testo/bordi/focus/stati/Markdown/tool/grafici, color-scheme e theme-color;
nessun semplice invert. Cambio tema non rimonta runtime né perde draft, aperture,
cursor o scroll. Contrasto e stati distinguibili anche senza colore.

Accettazione aggiuntiva: baseline prima della patch e confronto stessa macchina,
build/browser/dataset: 500 messaggi pesanti/GFM, 10000 eventi, molti attivi, singolo
corpo grande e migliaia di job paginati. Misurare nodi e righe montati, render React,
merge/parsing/Markdown, p95 input e chunk-to-paint, long task, heap dopo warm-up e
cicli ripetuti. Fissare soglie prima dell'implementazione; oggi non sono misurate.
Invarianti: DOM <= finestra+overscan+eccezione focus documentata; zero discendenti
pesanti nei details chiusi; repository non cresce con tutti gli ID visitati;
nessuna crescita monotona non spiegata a cicli equivalenti. Test summary pubblico
vs raw/encrypted thinking, assenza summary, refresh/restart/dedup, tema Sistema
live/override/refresh/cross-tab, entrambi i temi 320/390/768/1440 e zoom 200%,
tastiera/VoiceOver dove verificabile. Runtime finanziario e M3/M4 restano esclusi.

### Source implementation checkpoint — resolution plan, 2026-10-09

Source implementation owner completed a stable local checkpoint in the existing
checkout. Installed release remains **0.3.4**; no Git publication, image release,
SSH, LND/financial RPC, external mutation or deployment was performed by this lane.
Original financial executor, mandate, receipts, queue IDs/digests and schema4 are
preserved. New budget/review state uses additive meta records, not decisions or
financial evaluation tables. Qualification admissions explicitly deny financial,
review-wait and proposal mutations.

Implemented source:

- `evidence-source.ts` acquires only the requested collection;
  `evidence-views.ts` keeps immutable job/query-owned SCID/time-scoped snapshots.
  Three views/job, 4MiB/view, 16MiB globally, 5-minute TTL; capacity/expiry/restart
  are explicit, never silently evicting a live cursor. Release is explicit and
  all job views are released at exit. Pages reserve envelope headroom for budget
  metadata and remain <=12KB/20 rows. Legacy version/offset remains supported.
  BigInt summary totals, unsupported-filter rows, captureCounts validation and
  separate view/capture/upstream-history completeness are included. Target-only
  LM buckets cannot become complete corridor evidence. Store projection limits
  are explicit. `corridor_events` uses the same immutable paging instead of a
  silent 100-row terminal list; its source acquisition cap is explicit.
- `run-budget.ts` persists original start/calls/research/finalization across
  submitted recovery: research12 analyst/16 coordinator, soft120s/hard180s and
  absolute24 attempted tools before terminal control. On the next provider
  request finalization sets `toolChoice:none`; already-generated tools get
  structured denial, and new financial execution is blocked. An entered mocked
  financial tool is awaited through abort without losing ownership or replay.
  Terminal metrics include budget, cause and available usage even on failures.
  Pre-submission unavailable-model waits discard only the unused budget.
- Accepted origin/purpose metadata is atomic with admission and excluded from
  the immutable original payload digest. Legacy is unknown. Latest relevant
  economic analyst selection uses SQL scope ranking before the bounded limit;
  an incomplete successor exposes a gap, never an older silent fallback.
  Descriptors contain receipt IDs and actual evidence times; original text has
  bounded separate detail pages. Owner analysis is economic by default; explicit
  general stays general. Authenticated `purpose:"qualification"` is the supported
  installed read-only qualification admission contract, with no prefix/text
  inference and no UI QA control.
- `review-waits.ts` is a bounded256-scope nonfinancial persistent registry. It
  retains original deadlines, consumed evidence/missing requirements, material
  policy/operation or measured-forward triggers, backoff up to6h and maximum24h
  revisit. A trigger is consumed only with durable pending admission and an
  append-only linked trigger receipt. Scheduled successors coalesce; backlog
  preserves triggers and owner jobs. Forecast comparable hours are unchanged.
- GFM is pinned to remark-gfm4.0.1. Markdown tables are semantic and confine
  horizontal scroll; HTML/images/executable links remain excluded. New statuses
  distinguish final/partial/cancelled/current and origin is shown truthfully.
  Tools have lightweight grouped rows, with no mounted/serialized heavy JSON
  beneath closed disclosures. Detail pointers load authenticated original
  Parameters/Results on expansion. Reasoning is a separate lazy public-summary
  group, with no generated card replacing original output.
- Responses summaries are selected exclusively from qualified
  `reasoning.summary[].summary_text` signatures for snapshot/final projection.
  Streaming wraps the installed provider boundary, not serialized Durable
  streamOptions functions: persisted ProviderDoc sessionId maps to owned job,
  conversation and attempt; callbacks recheck the durable run token. Only typed
  `response.reasoning_summary_text.delta` is admitted, with sequence dedup and
  restart hydration. Raw thinking/content, signatures, encrypted data and provider
  metadata never enter public events. Per-job64 items and UTF-8-safe24KB summaries
  are bounded and cleaned up. Coalescing replaces only cumulative public text
  publications over80ms and flushes final/exit; journal cursor/tool/terminal
  semantics are preserved.
- UI job-local subscriptions and event/tool/text/progress/summary indexes avoid
  unrelated message invalidation; immutable message objects are reused. A pinned
  replacement messageRepository prunes absent IDs. A variable-height list uses
  the installed unstable ID adapter with overscan4 and at most one focused row
  beyond the window; ID/offset anchors replace DOM-count waiting. Heights and
  expansion state are bounded to retained job/message IDs. Repository receipts
  and original journal are never deleted to free UI memory.
- History SQL reads are bounded before tool-body serialization: <=2048 public
  descriptors and2MiB per history event page, with partial/detail availability.
  Client events retain <=10000 records/8MiB; public bodies have128KiB cap and
  oversized answers expose exact authenticated plain-text pages rather than
  parsing truncated Markdown. Original private answer receipts remain intact.
  Tool detail responses have a bounded32-record read and explicit legacy-body
  unavailability above its cap.
- Dark/Light/System preference defaults to System, validates storage, follows
  media only for System and syncs tabs. Local classic bootstrap runs before paint
  under script-src self, without unsafe-inline. Tokens cover existing UI surfaces,
  Markdown/tools/charts/states; theme-color/color-scheme follow preference. Theme
  does not recreate runtime. Mobile inputs/selects/textarea are >=16px, touch
  controls44px, dvh/safe-area composer and confined tables preserve manual zoom.
  The bootstrap asset is explicitly unignored for publication.

Stable local verification: Node24.21 `npm test` **109/109 PASS**, including actual
Pi Durable provider-boundary tests with three concurrent owned conversations,
public-summary dedup, final-only generation, explicit qualification write denial,
mocked financial in-flight deadline/recovery with exactly one effect and unchanged
submission/start budget. Tests also cover229-row immutable paging through mutation,
canonical scope, expiry/caps/release, capture-vs-history gaps, feed newest incomplete,
72h Scheduler/backpressure/deadline retention and first-paint storage/system behavior.
The actual installed assistant-ui core retained exactly500 messages while visiting
3000 IDs and kept an active receipt. Python **16/16 PASS**. Frontend/backend compile,
GFM dependency/build and explicit typecheck are included in the verification lane.
Private local logs: `/tmp/satssurge-resolution-node-20261009.log`,
`/tmp/satssurge-resolution-python-20261009.log`,
`/tmp/satssurge-resolution-typecheck-20261009.log`.

**Pending primary acceptance, not claimed complete:** rendered local heavy-fixture
qualification of variable-height anchors, focus/disclosure restoration, theme
contrast/cross-tab/system, table security,320/390/768/1440,200% zoom, mobile keyboard
and streaming/reconnect. `UI_FIXTURE_DIR=<private temp> FIXTURE_HISTORY_COUNT=3000
FIXTURE_HEAVY=1 node scripts/ui-fixture.mjs` seeds bounded heavy GFM/tool history.
Fixture-only `data-ui-performance` reports DOM/mounted rows/closed heavy descendants,
retained runtime repository, renders, p95 input/chunk paint and long tasks without
payloads. Primary must establish empirical thresholds/baseline comparison; no
latency/cost saving or heap improvement is claimed by helper tests. Native iOS
Safari keyboard/VoiceOver and real installed Responses streaming are still
unqualified. Independent review, immutable release and installed acceptance remain
primary-owned. No fixture server/process or persistent test resource was left
running by the source owner; all Harness/databases/temp effect fixtures closed.

### Stable review fixes — 2026-10-09

Source owner completed the review correction pass and stopped repository writes.
All three persistent tool/summary disclosures bind native `open` to their saved
React expansion state, preserving disclosure consistency through virtualized
remounts while keeping closed JSON children unmounted. The theme picker and its
media/storage lifecycle now live in the persistent application topbar, so System
and cross-tab preference updates continue on every page without recreating the
conversation runtime.

Evidence query normalization now precedes SQL acquisition: timestamps use canonical
ISO instants and numeric comparisons; SQL uses `julianday` for seconds/milliseconds
and equivalent time-zone offsets. Equivalent query property order shares the same
immutable cursor view. Coalesced cumulative text clears any pending earlier timer
before direct publication, preventing a stale final flush from regressing text.

Both `/api/status` chat and `/api/history` legacyChat now use the128KiB public
answer descriptor contract. Oversized originals remain private and unchanged;
authenticated `/api/chat/answer?key=<descriptor-key>&offset=<codepoint-offset>`
serves16384-codepoint pages, at most65536 UTF-8 bytes. Legacy conversation rows carry
the descriptor key into the existing lazy full-text page control. The HTTP test
verifies authentication, invalid offsets, exact public-text recovery, suppression
of raw reasoning and unchanged private storage.

Actual Pi Durable Harness40-tool batching showed that SDK tool termination alone
can still schedule a final provider generation. The owned provider boundary now
refuses generation after the persisted absolute tool limit; reconciliation reports
terminal partial failure rather than accepting SDK `done` as a completed answer.
The regression proves one underlying provider call, one original submission,
zero mocked financial effects and hydrated qualified summary text without replay
concatenation. The20-tool case still reaches the intended `toolChoice:none` final
synthesis. No live financial system was involved.

Mobile viewport includes `viewport-fit=cover`, preserves manual zoom, and applies
notch/safe-area padding plus44px checkbox labels. No VisualViewport lifecycle was
added: primary exploratory reduced-height focus testing already kept the composer
visible by normal document scrolling. This does not qualify native iOS Safari
keyboard behavior; primary browser validation of stable contents remains pending.

Stable verification: Node24.21 `npm test` **112/112 PASS**, including build;
explicit `npm run typecheck` PASS; Python **16/16 PASS**. Logs:
`/tmp/satssurge-resolution-review-node-20261009.log`,
`/tmp/satssurge-resolution-review-typecheck-20261009.log`,
`/tmp/satssurge-resolution-review-python-20261009.log`.
No source-owner process, fixture server or test resource remains running.
Version remains0.3.4. Browser acceptance, review and release remain primary-owned.

### Dark contrast correction — 2026-10-09

Primary browser qualification exposed a dark white conversation card with pale
text and an inverted sidebar background. CSS now separates semantic surface,
input, sidebar, selected-navigation and status-background roles from legacy numeric
foreground accents. Removed the literal white chat-panel surface, corrected input
foreground/placeholder and yellow-logo ink, brightened status/chart accents, and
kept disclosure/tool layout unchanged. Theme select uses96px width and the mobile
header wraps, preserving full mode labels without forcing a320px page overflow.

CSS palette contrast calculation for final dark role pairs: conversation12.60,
muted conversation7.45, sidebar14.42, inactive navigation8.53, selected navigation8.48,
input13.66, success8.34, danger7.76, warning8.58, local7.62. These are source palette
checks, not a browser contrast claim. Primary must repeat actual computed styles
and screenshots for stable final build. Targeted first-paint test passed; build
includes backend/frontend typecheck. Logs `/tmp/satssurge-resolution-dark-build-20261009.log`
and `/tmp/satssurge-resolution-dark-targeted-20261009.log`. Backend/features remain
at the preceding112/112 and16/16 checkpoints; this pass modifies only CSS/handoff.

### 320px heading overflow correction — 2026-10-09

Primary stable matrix passed23 viewport/page combinations;320px Conversation
exposed3px horizontal overflow from the heading's autonomy badge. Narrow headers
now wrap with12px gap and constrain heading content/badge to the available width.
CSS/handoff-only correction preserves accepted dark colors and other layouts.
Build/typechecks PASS; final browser320px readback remains primary-owned.
Log `/tmp/satssurge-resolution-320-build-20261009.log`. Source writer stopped with
no owned processes/resources left running.

### Explicit dark semantic foregrounds — 2026-10-09

Final CSS explicitly declares dark local/remote/success/danger/warning/neutral
foregrounds after all legacy rules. Error text uses semantic danger directly.
Chart fills/strokes use distinct drawing colors, leaving financial labels and
status text at brighter readable tones. This makes final cascade roles explicit
for primary error/negative-P&L fixture qualification; preceding320px wrapping and
surface corrections remain intact. Build/backend/frontend typechecks PASS; log
`/tmp/satssurge-resolution-semantic-build-20261009.log`. CSS/handoff only; writer
stopped with no owned resources left running.


### Primary local browser qualification — 2026-10-09, release pending

Stable112-test source plus CSS-only corrections passed in the visible in-app
browser against the private3000-job heavy fixture. All24 page/viewport cases
(Conversation,Activity,Node,Accounting,Experiments,Settings at320/390/768/1440)
have no document overflow and mobile inputs/selects/textarea are16px. At390x400,
focus naturally scrolls the entire composer into the viewport; scale remains1
in desktop emulation. Manual zoom is permitted by viewport metadata. Native
iOS keyboard/pinch zoom and VoiceOver are not proven by desktop emulation.

Dark mode was corrected after visible evidence of white cards/light text.
Actual computed contrast: Markdown12.60,muted7.45,active navigation8.48,
inputs13.66,status8.34. Real rendered fixture negativeP&L and login errors use
rgb(255,179,187), not the obsolete dark-red declarations. System follows the
current media preference; cross-tab changes update Settings outside the chat.
Explicit theme survives reload. Theme controls remain96px wide.

Grouped tools mount no heavy descendants while closed. Group/tool expansion
survives virtual unmount/remount; nested JSON disclosure resets closed (minor
usability limit). Seven loaded history pages retained exactly500 core messages,
with6 mounted messages/456 DOM nodes in that sample. On a separate streaming
fixture sample: input p95=7ms, projection-to-next-frame p95=29.2ms, maximum
observed long task91ms; these are local fixture observations, not before/after
latency or heap-saving claims. Original installed baseline is206 messages and
42376 DOM nodes, a different dataset. Heap was not profiled.

Two concurrent simulated requests ran together and completed once. Queued
cancellation, pause/resume(initial true restored), SSE disconnect/reconnect,
expiry with login focus, keyboard Enter login, refresh and process restart
preserved4 request IDs:3 completed/1 cancelled,0 financial operations. Console
warn/error capture is empty, including deliberate rejected login/session expiry.
Backend112/112 and Python16/16 remain valid; final CSS builds/typechecks pass.
Independent review approved backend/disclosure/budget and final cascade; the
intermediate low-contrast concern was retracted after cascade reconciliation.

Private evidence: plan-035-browser-matrix.json,plan-035-fixture-performance.json
and screenshots/plan-035-fixture-mobile-dark.jpg under local satssurge evidence.
Fixture cleanup is complete: tabs 15/16 closed, viewport reset, native session
53666 exited 130 and port 19538 has no listener. The private fixture database
remains evidence; no fixture process resources remain. At this browser-proof
checkpoint the version was 0.3.4; no release/installed acceptance was claimed. Next:0.3.5 immutable release,
consistent verified checkpoint, installed real Pi/read-only acceptance and
original autonomy/timer restoration.

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

Release preparation changes only package/root lock versions and documentation.
Exact source SHA, Actions run and image digest remain unset until publication.

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

### Terminal conversation correction for next patch — 2026-10-09

Installed0.3.5 qualification found terminal failed jobs described as partial even
when no public text existed, with the technical error always visible. A shared
state/text presentation helper now distinguishes failed-with-text (partial) from
`Non completata · nessun testo disponibile`; cancelled runs retain their recorded
state and explicitly identify any partial text. Empty terminal message bodies do
not mount an active-wait placeholder. Stale progress/wait notes are suppressed on
terminal conversation rows. No cause is inferred from `aborted` or other error
strings; public cause is never invented.

Conversation and Activity both expose original sanitized technical errors behind
lazy collapsed `Dettaglio errore`, rendered as plain escaped text. Receipt and error
storage remain unchanged; qualified public summaries remain independent. The
state regression covers failed/cancelled/completed with/without actual text and
active queued/waiting/running placeholders. Node24.21 `npm test` **113/113 PASS**,
including frontend/backend typechecks and build. Log:
`/tmp/satssurge-resolution-terminal-node-20261009.log`. Existing Python16/16 checkpoint
still applies (no Python changes). Writer stopped with no owned resources.

Installed0.3.5 is immutable; this source fix belongs to a new0.3.6 patch release
owned by primary/release lane. No retag, deployment or version mutation was
performed by source owner. Browser terminal fixtures and installed0.3.6 acceptance
remain primary-owned.

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

Final primary terminal-fixture browser proof: the 3006-job fixture rendered failed
no-text captions without waiting, retained partial text, and mounted no error body
while collapsed. Opening Chat/Activity detail showed escaped original technical
text without script nodes and shared stable expansion; reclosing removed all
error bodies. At 320x640 focused input remained 16px, composer visible and
document width 305<=320; viewport permits zoom. Console warn/error were empty.
Native fixture session 40887 exited 130; tab17 closed and viewport reset. This
qualifies the local patch presentation, not installed 0.3.6 or native iOS.

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

### Activity lazy body correction for next patch — 2026-10-09

Primary installed0.3.6 qualification completed three actual Pi runs once each in
29.8–32.6 seconds with two tools each; qualified public summary appeared for two
jobs. Primary reported107 ledger rows,116 terminal receipts and85 historical rows
preserved. Installed0.3.6 remained unaccepted because Activity mounted85 Markdown
bodies inside closed native disclosures, increasing loaded DOM from1126 to10028.
These are primary observations, not source-owner live actions.

Activity now mounts only native summary plus saved job-ID expansion state while
closed. Payload parsing, indexed job lookup/text, Markdown, tool components and
body descendants live in a separately mounted lazy body after opening. Indexed
answer text replaces the previous repeated whole-projection answerFor scans.
Oversized-answer descriptors use the existing lazy authenticated text-page control.
Native disclosure keyboard behavior, GFM/security and original receipts are
preserved. JSON components already defer their pre/stringify children; bounded
plain decision evidence and node table remain unchanged.

A real React server-rendered DOM regression checks100 closed disclosures with
zero heavy render callbacks and no payload/Markdown/tool/pre descendants, then
open/close/reopen. Node24.21 `npm test` **114/114 PASS**, including backend/frontend
typechecks and build. Log `/tmp/satssurge-resolution-activity-node-20261009.log`.
Changed files: `web/App.tsx`, `src/ui-disclosure.ts`,
`src/test/ui-disclosure.test.ts`, and this handoff. No Python changes (preceding
16/16 checkpoint applies). Source writer stopped, no owned resources running.
Next0.3.7 patch release and installed browser acceptance remain primary/release
owned; no version, Git, deployment or live system mutation by source owner.

The same pass also fixes Node diagnostics `Fonte e acquisizione`: its outer
native disclosure now gates all body children through the shared lazy boundary,
so previously opened nested JSON unmounts on parent close and cannot remain hidden
or serialize again during polling. Outer expansion persists by provider ID across
navigation in a separate map limited to the two fixed diagnostic providers;
nested JSON starts closed on remount. Final rerun **114/114 PASS** with build and
backend/frontend typechecks. Shared React DOM test covers nested JSON as well as
Activity payload/Markdown/tools. No additional source-owned resources remain;
repository writing is STOPPED after this final stable checkpoint.

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

### In-progress source0.3.8 contract — 2026-10-09

Primary holds the plan035 financial claim with enabled=false and backfill stopped;
original true/timer configuration is restored only after final acceptance. Actual
0.3.6 remains installed;0.3.7 image published with metadata held. Target is a new
immutable0.3.8 release. Primary checkpoint pre037-20261009T130801Z: three SQLite
stores/schema4,108 ledger rows (original107 unchanged plus one natural routing
revenue),85 historical exchanges and original terminal receipts preserved. Three
read-only Pi qualifications ran once plus six natural economic runs completed;
no financial operations. These are primary runtime observations, not source-owner
live actions. Subsequent ledger validation must preserve original-row subsets,
allowing natural collector revenue rather than demanding a frozen row count.

Astra diagnosis: natural economic replies recommended48h waiting but registered
no durable review outcome; optional tool was exhausted before closure. Source
strategy is one structured nonfinancial wait/no_wait outcome in the original
submission and24-call/180s budget. Verified Responses/Codex onPayload adapter forces
required tool choice until closure; after research/soft bounds only the closure
function remains in the request and other tool guards reject research/finance.
After valid outcome, final synthesis uses tool_choice none. Missing/invalid/timeout
outcome persists truthful policy fallback with fixed admission+1h deadline and
original submission receipt, never parses prose or reasoning for48h. Explicit agent
wait replaces policy deadline; policy cannot overwrite explicit wait/evidence, and
prior agent deadline never restarts. no_wait records this run without silently
removing prior unresolved waits. Eligibility requires accepted economic owner or
scheduler provenance; general/unknown/qualification never auto-write the registry.

User additions remain in this same source lane: paged authenticated legacy history
with stable absolute IDs and independent job/legacy cursors through bounded retained
windows, recent-return control and original data untouched; repo-native SVG favicon
under self CSP with explicit production MIME path; neutral near-black dark surfaces
and blue/orange status/chart accents, no green palette. Primary reproduced blank
Conversation after Node return: restored physical scroll at bottom but mounted
first18 rows, all above viewport, because child layout read parent ref before it
attached. Source now passes explicit attached viewport identity and persists measured
heights/ID-offset anchor across tab unmount; fixture metrics add visible intersections.

This section is in progress. Primary browser and natural installed-economic
acceptance follow stable writer STOPPED, review, immutable release and deployment.
No release/Git/deploy/live-system mutation belongs to this source lane.

### Stable source0.3.8 checkpoint — 2026-10-09

Source implementation is stable; repository writer is STOPPED after this checkpoint.
Node24.21 `npm test` **135/135 PASS** (build/backend/frontend compile included),
explicit typecheck PASS, Python **16/16 PASS**. Private logs:
`/tmp/satssurge-resolution-followup-node-20261009.log`,
`/tmp/satssurge-resolution-followup-typecheck-20261009.log`,
`/tmp/satssurge-resolution-followup-python-20261009.log`.
No owned fixture/server/Harness/test process remains running. No version, Git,
release, deployment, SSH, operational MCP or live financial mutation was performed.
Source package remains the primary's0.3.7; next immutable release is0.3.8.

Verified closure: actual Pi Durable Harness invokes the owned provider payload hook
using its declared tools. Cases cover early wait/no_wait; coordinator16+closure17
and analyst12+closure13; soft boundary; provider-ignored required choice; invalid
outcome/malformed bounded loop; hard timeout; closure followed by final model error;
recovery after cooldown; qualification/general/unknown zero registry mutation;
insistent financial call after closure (zero effects); duplicate40-closure batch
(one outcome, absolute limit); and economic financial mock already entered at hard
deadline (one effect, original submission and budget retained). All tests use mocked
providers/executor effects, not real LND. Outcome and registry writes are atomic and
idempotent by original job/submission. Finally fallback rechecks current ownership.

Legacy pending compatibility: installed SDK preserves a persisted tool filter
across configure. A real Harness test creates a node_state-only old conversation,
submits its original input before the new Agent owns the run, holds its first
provider stream in flight, resumes the same submission with the original aged
budget, then releases the old stream. If closure is absent from the original
provider context, research closes and the request uses tool_choice none with a
truthful admission+1h policy fallback (`closure_tool_unavailable_in_original_context`).
No missing required function or empty-tool required request is sent, original tool
context is not rewritten, no new submission is made, and recovery repeats no
provider/financial effect. This is an explicit legacy per-receipt gap, not an agent
wait inferred from historical text. New runs use mandatory structured closure.

Verified history contract: `/api/history` accepts additive independent `before`
(job rowid) and `legacyBefore` (exclusive absolute legacy index). Responses return
`nextBefore`/`nextLegacyBefore`; existing before compatibility remains. Legacy pages
are<=50 rows and1MiB of projected data, acquired through SQLite json_each rather
than parsing the whole private array in JavaScript. Stable legacyIndex IDs prevent
page-relative collisions. Both older controls continue until both collections end;
recent-return reloads newest pages while retaining active receipts. A1350-row
fixture (1000 durable+350 legacy) reaches every original through a<=250 retained
window, preserves SSE cursor77 during pagination, fetches exact paged oversized
public text, preserves original private arrays and produces zero submissions.
Production HTTP verifies legacy cursor authentication/validation and full-text
access. Fresh heavy browser fixture can use `FIXTURE_HISTORY_COUNT=3000
FIXTURE_LEGACY_COUNT=350 FIXTURE_HEAVY=1` (seed applies only to a fresh fixture).

Favicon is repo-native `web/public/favicon.svg`, explicitly unignored, linked in
index and served as image/svg+xml by production/fixture static routes. Real HTTP
confirms200, content, index link and self CSP. No external image dependency.

User theme correction uses neutral near-black body#111113/card#18181b/sidebar#09090b,
bright blue/purple/orange semantic text and distinct chart colors. Source palette
regression rejects green RGB hues anywhere in CSS and checks>=4.5 text contrast
for surfaces, sidebar/navigation, inputs and financial/error/status accents. System,
manual mode, media/storage lifecycle,16px mobile text,44px controls, safe areas and
manual zoom remain intact. Actual browser contrast is still primary qualification.

Conversation return fix uses stable callback adoption of the actual viewport
identity; listeners/observers depend on that element and clean up on replacement.
Measured heights and ID-offset reading anchor live in App across tab unmount,
without replacing projection/runtime/history. Range is recomputed from attached
scroll geometry. Regression covers the reproduced29567.5px bottom position,
reading-history positions, remount/resize/prepending with variable heights; fixture
metrics now expose `visibleMessages` intersections for primary real browser checks.
Actual tab-return, expanded-summary history anchoring, focus/resize and500-core
bounds need stable rendered qualification. No browser claim is inferred from pure
geometry tests.

Scope limit: persistent waits back off/coalesce per review scope, with fixed deadlines
and material triggers. The coordinator's existing15-minute scheduled cadence and
pending/event responsibilities remain unchanged; no global coordinator backoff is
claimed. Natural installed economic closure readback, all browser controls, final
independent review, release/deploy and fence/timer restoration remain primary-owned.

Final fixture parity check: local simulation also serves authenticated
`/api/chat/answer` through the same original-exchange page helper. Node syntax
check PASS. Final135/135/source build/typecheck and16/16 Python remain valid;
this parity addition changes only the fixture script. Writer is now STOPPED with
all native execution sessions finished.

### Source 0.3.8 follow-up checkpoint: history return and composer model (2026-10-09)

Sole-writer reassignment invalidated the previous browser candidate acceptance. The navigation callback no longer forces `follow=true` when Conversation is reopened: reading history retains its App-owned message ID/offset anchor and manual follow mode; explicitly returning to recent history and sending still use their existing follow actions. Regression executes the production navigation callback through Activity/Node/Conversation and checks retained legacy anchor plus intersecting virtual range. Final browser history-offset qualification remains primary-owned.

The composer now exposes the same controlled model setting as Preferences, through the existing authenticated/CSRF `/api/model` validation and refresh path. A failed save cannot optimistically change `auth.selected`. Provider identity, fixed `high` reasoning and positive safe-integer capacity from the runtime model catalog are shown; capacity is explicitly not current usage. No cumulative usage/context ratio, fictional token count, configurable effort, voice or attachment capabilities were added. The compact controls wrap, with 16px select text and 44px minimum target height; the existing neutral palette, safe-area/zoom behavior and paginated historical access remain.

At admission the selected model is pinned privately under `jobModel:<jobid>` outside the immutable payload/digest. Duplicate admissions retain the original pin; subsequent jobs use the new setting. Agent execution uses that pin. Already-submitted conversation recovery retains its original persisted `pi.agent.model` before configure. Old queued records without a pin retain the previous current-setting fallback; no receipt or historical payload is rewritten. Actual Harness early-no-wait now changes the setting after admission to an invalid new value and still proves the original GPT-6.1 Sol provider model executes.

Verification: Node 24.21 full `npm test` build + **138/138 PASS**; explicit typecheck PASS; Python **16/16 PASS**. Logs: `/tmp/satssurge-composer-node-20261009.log`, `/tmp/satssurge-composer-typecheck-20261009.log`, `/tmp/satssurge-composer-python-20261009.log`. This assignment changed `src/agent.ts`, `src/queue.ts`, `src/ui-model-picker.ts` (new), `src/test/{follow-up,queue,ui-virtual-window}.test.ts`, `src/test/ui-model-picker.test.ts` (new), `web/{App.tsx,style.css}` and this handoff. Generated ignored dist/public rebuilt. No Git/release/deploy/live financial writes or child resources. Package version remains release-owned. Writer STOPPED; primary review/browser/mobile acceptance and 0.3.8 publication/installed qualification remain pending.

Fixture-only composer qualification parity: auth now exposes Sol/Luna explicitly named “simulato”, with synthetic fixture capacity constants and catalog provenance. `/api/model` validates this synthetic catalog, persists selection in the fixture Store and auth reads it back. Production provider/defaults are untouched. `node --check scripts/ui-fixture.mjs` PASS; primary owns the already-running old fixture stop/restart and HTTP/browser synchronization qualification. Writer STOPPED after this fixture + handoff patch; no test/server process started by child.


Legacy model recovery review fix: Agent resolves the persisted submitted pi.agent.model before model validation and configure, and uses that effective model in provider configuration, status and returned result. Legacy receipts without jobModel recover even if the current preference is invalid or points at a different valid model. Actual Harness regression runs both cases on the original in-flight submission/old tool filter; original submission/budget/financial receipts stay intact, provider/result remain Sol, effects=0, no extra submission. Full Node24.21 build + **139/139 PASS**; explicit typecheck PASS. Logs /tmp/satssurge-model-recovery-node.log and /tmp/satssurge-model-recovery-typecheck.log. Initial test typo (kv instead of meta) caused cleanup to wait on mock provider; terminated that run, removed its exact leftover test directory, and added mock release to final cleanup. No child resources remain. Assignment changed only src/agent.ts, src/test/follow-up.test.ts and this handoff. Writer STOPPED; browser/release remains primary-owned.

### 0.3.8 release preparation — source ready, publication/install pending

Package and both root lockfile version fields are now 0.3.8. Immutable 0.3.7 is
published but will skip installation; manifest/compose remain on installed0.3.6
until 0.3.8 index/config/all-layer verification, then metadata publish together.
Source includes mandatory structured nonfinancial economic closure and truthful
policy fallback without prose inference, replay or widened financial authority;
legacy history paging/full-text access, stable reading anchors, repo-native
favicon, neutral palette and composer/Preferences model synchronization.
New admissions pin their selected model outside original payload digests;
submitted/legacy recovery retains the original persisted model. Default remains
Sol/high, reasoning fixed high, subscription OAuth preserved.

Source owner/reviewer stopped and approved. Final Node24 tests/build passed
139/139 (`/tmp/satssurge-038-final-node.log`); Python16/16 and typecheck passed.
Primary's visible24 cases at320/390/768/1440 had no overflow, mobile16px fields/
44px controls and empty console. Bidirectional composer model sync, exact
history anchor and oldest legacy access with bounded DOM passed. Native iOS,
VoiceOver and comparative heap/latency savings remain unproven. Natural
installed economic closure is not claimed from fixtures or mocked Harness.

Next primary schedules exact tested source commit/tag, then release lane
verifies immutable amd64/arm64 publication and updates catalog metadata. Primary
owns consistent checkpoint, installed real Pi/browser/natural follow-up evidence
and original autonomy/four-timer restoration. Keep the owned pause/fence until
that acceptance; preserve original accounting, OAuth, mandate and pending
receipts. No financial tests/regtest/M3/M4 expansion or historical prose import.

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

### Source 0.3.9: leading history anchor and compact model/effort controls

Actual installed038 first-history reproduction: at scrollTop=0 the first legacy row was 62px below the viewport due to the leading history control. Returning from Node preserved IDs but shifted them 62px. VirtualMessages now stores the raw scrollTop-minus-container-origin (negative offsets included), while visibleRange still uses nonnegative top. Regression executes the production scroll/resize callback with the observed 62px geometry, verifies legacy0 user/assistant offsets62/254.46875 and exact scroll0 across capture/remount.

Latest explicit user request supersedes the earlier fixed-high-only UI scope: composer has one compact provider/model/effort trigger with chevron; an accessible menu offers model and reasoning selects, plus Escape/outside close and focus return/initial select focus. Capacity stays compact at the right and labels only provider catalog capacity, with current context usage explicitly unavailable. No aggregate token ratio, microphone or attachments. Closed composer has no full-width model select or verbose capability label. Menu uses bounded height/scroll, 16px inputs and 44px controls; chat-panel overflow is released only while this menu exists to avoid clipping. Preferences retains synchronized model and reasoning controls.

Auth model catalog uses installed Pi getSupportedThinkingLevels: unsupported null mappings are excluded and xhigh/max require explicit mappings. Existing authenticated/CSRF model endpoint validates model+level and atomically saves both. Default remains Sol/high; changing model without explicit effort retains compatible current effort, otherwise high when supported, otherwise the catalog's first supported level. Queue pins effort alongside model outside immutable payload/digest. Submitted recovery reads original pi.agent model AND effort before validation/configure; results/status reflect them. Actual Harness verifies admitted low effort reaches provider options.reasoning despite later high preference, and old unpinned submitted conversations preserve original low under invalid/different valid model preferences. No budget/scheduler/financial authority changes.

Fixture catalog exposes explicitly simulated Sol/Luna capacities and supported levels; settings persist and read back so primary can qualify both composer and Preferences. Final verification Node24.21 full build + **141/141 PASS**, explicit typecheck PASS, Python **16/16 PASS**, fixture node-check PASS. Logs /tmp/satssurge-composer039-{node,typecheck,python}.log. Initial anchor-only140 run had one existing hard-deadline financial-mock timing assertion fail under concurrent compiler load (/tmp/satssurge-leading-anchor-node.log); that assertion and production budget were unchanged, and subsequent full141 runs passed. No native iOS, browser menu/mobile/contrast or installed039 acceptance is claimed by child; primary owns these.

Assignment files: web/components/VirtualMessages.tsx; src/test/ui-virtual-window.test.ts; src/model-settings.ts (new); src/test/model-settings.test.ts (new); src/ui-model-picker.ts; src/test/ui-model-picker.test.ts; src/{agent,queue,server}.ts; src/test/{queue,follow-up}.test.ts; web/{App.tsx,style.css}; scripts/ui-fixture.mjs; this handoff. Generated ignored dist/public rebuilt; package version remains release-owned. All child tests/checks exited, no child app/browser/server resources created. Writer STOPPED; primary review/browser, immutable039 publication and installed financial-fenced qualification remain.

039 visual-only integrated composer refinement: after inspecting primary's candidate screenshot, wrapped textarea and all footer controls in one rounded composer surface. Textarea is transparent/borderless with 16px text; focus-within highlights only the outer surface. One nonwrapping footer row contains the compact model/effort picker, its capacity indicator, a 44px read-only analysis icon and 44px arrow submit at far right. Full labels remain accessible/title; visible verbose mandate footer text removed. Pending retry/recovery, nonce, endpoint/auth/effort settings and financial protections are unchanged. Picker flexes with min-width0 and model ellipsis while effort/capacity remain distinct; existing safe-area/zoom/theme behavior preserved. No backend edits in this refinement. Files only web/App.tsx, web/style.css and this handoff. Full Node24.21 build +141/141 PASS and explicit typecheck PASS; logs /tmp/satssurge-integrated-composer-{node,typecheck}.log. Writer STOPPED, no child resources; primary owns final matched screenshot/mobile/browser qualification before039 publication.

### 039 economic closure time reserve after actual038 evidence

Primary/Astra evidence: three actual read-only qualification runs completed, once each and without follow-up registry writes. Four natural high-effort economic runs registered actual wait outcomes but failed at the original180s deadline; closure around149s left only31s for the additional final generation. Persistent agent waits/receipts remain useful and were not replayed; complete natural outcomes are not claimed. Primary records three scoped waits (48h/24h as explicitly produced), preserves pending work and the financial fence. This source correction targets time reserve, not a higher hard limit or silently reduced effort.

New RunBudget optional fifth policy parameter (fourth clock remains compatible) gives **60s soft** only when accepted metadata explicitly qualifies owner/scheduler economic. Qualification/general/unknown stay120s. Existing persisted budget objects, start, soft/hard and submission remain authoritative; policy never renews them. Hard180s, absolute24, analyst12/coordinator16 caps are unchanged. Kept research parallel_tool_calls=false pending independent financial-sequencing proof; no claim that serialization cost was removed.

Added up to96 additive run_phase events per original job, across recovery. A whitelist stores stage, request ordinal, phase/elapsed/remaining time, model/effort, tool choice and <=24 trusted tool names with truthful total count/truncation. Request start uses actual onPayload; first public text and response finish/failure use typed Responses provider hooks when emitted; closure registration and hard abort are explicit code boundaries. No prompt, arguments, text, hidden reasoning, signature, encrypted data, credentials or raw provider errors are stored. No retry metric is inferred where the SDK exposes no explicit retry event. Existing run_metrics/receipts remain.

Accelerated real-Harness tests retain an original synthetic start near60s, delay research then closure and final provider turns, prove closure-only payload at the60s boundary and tool_choice:none afterward, successful public final, one original submission, hard180 unchanged and zero mocked financial effects. A second actual-Harness case retains a pre-existing120s soft policy through the same sequence. Pure clock/cap tests preserve24 absolute and12 analyst; telemetry tests enforce96 rows across reconstruction,24 names/30 count and reject private extra fields. Existing Harness tests now assert explicit economic60 versus qualification/general/unknown120.

Verification: full Node24.21 build + **145/145 PASS**, explicit typecheck PASS, Python **16/16 PASS**. Logs /tmp/satssurge-economic-reserve-{node,typecheck,python}.log. Files only src/run-budget.ts, src/agent.ts, src/test/economic-reserve.test.ts (new), src/test/follow-up.test.ts and this handoff; generated ignored dist/public rebuilt. Earlier141 composer/effort/history-anchor contracts remain included. No version/Git/deploy/real provider or financial call. No child live resources. Writer STOPPED; primary owns final039 review/browser/release and financial-fenced natural-high completion/timing qualification, which is still pending.

Final039 narrow mobile polish after primary320px screenshot: the compact trigger displays Sol/Luna short labels at <=480px while its accessible label retains full provider/model identity. Desktop keeps catalog names. Popup width is now up to320px bounded by viewport-minus72px, independently of the small trigger width, so native model/effort choices are legible. Source SSR test checks the Sol short label; full145-suite/build and typecheck rerun PASS, Python16PASS retained in the same economic-reserve logs. Added assignment files src/ui-model-picker.ts, src/test/ui-model-picker.test.ts and web/style.css. Primary's root-owned fixture remains untouched; mobile popup/focus/screenshot verification is primary-owned. Writer STOPPED after final checks; all child process IDs completed and no child live resource remains.

Final039 reviewer/mobile boundary correction: request_start.phase is derived from the final tool choice/current budget immediately before recording, after awaited upstream payload hooks. Actual Harness test injects that original hook through the models boundary (not persisted function configuration), advances a bounded fake clock across60s during await, and asserts sole follow_up_outcome payload plus phase=closure at60000ms, then finalization/one submission/hard180/zero effects. Initial test used request0 although provider increments before invoking the hook; corrected its guard torequest1 without weakening assertions.

At <=480px footer frees space by hiding only decorative provider/context-clock spans, removing fixed trigger-width subtraction and reducing gaps/padding. Full provider/model accessible label, Sol/Luna short text, effort/capacity and44px actions remain; desktop unchanged. At <=768px native details summaries (tools, Activity/source, channel table and nested disclosures) receive minimum44px/padding12 targets while preserving native keyboard semantics.

Final full Node24.21 build **146/146 PASS**, explicit typecheck PASS, Python **16/16 PASS**. Logs /tmp/satssurge-final039-{node,typecheck,python}.log. This final bounded assignment changed only src/agent.ts, src/test/economic-reserve.test.ts, web/style.css and this handoff. All test/check processes exited; no child live resources. Writer STOPPED; primary final mobile screenshot/disclosure-target/review/release/natural-high acceptance remains pending.

### 0.3.9 source version preparation — installed acceptance pending

Package and both root lockfile version fields are 0.3.9. Manifest/compose remain
on verified installed 0.3.8 until immutable 0.3.9 multiarchitecture verification.
No new release/tag/source SHA is claimed by this preparation. Source writer is
stopped; 146 Node tests/build/typecheck and 16 Python passed, including the
provider phase-hook boundary. Final independent review/browser gates remain
primary-owned.

0.3.9 provides a unified composer model/effort picker and Settings sync, with
supported selectable effort pinned per new job and original submitted recovery
retained; default is Sol/high. It corrects the negative history reading anchor.
New eligible economic runs use a 60-second research soft boundary; every old
persisted budget remains immutable, hard180s and caps24/12/16 remain. Phase
metrics use a whitelist capped at96; no financial authority is widened.

Fresh pre-039-20261009T144906Z checkpoint passed host/Mac/isolated restore:
111 ledger rows,85 history files, one naturally queued unsubmitted job, original
owner/OAuth/mandate/operations preserved. Existing owned pause/fence and backfill
hold remain until installed0.3.9 natural economic, Pi/browser and reconciliation
acceptance. No financial tests/regtest/M3/M4 expansion. Primary owns final
checkpoint/update, acceptance and original autonomy/timer restoration.

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

### Source040: actual official composer primitives (039 remains immutable)

Latest user request is actual homepage composer, not another custom lookalike. Inspected official main source https://github.com/assistant-ui/assistant-ui/blob/main/apps/docs/components/pages/home/demo/composer.tsx and installed @assistant-ui/react0.15.25 Root/Input/Send/createActionButton implementation. New web/components/AgentComposer.tsx uses real ComposerPrimitive.Root/Input/Send with the relative full-width root, one muted rounded shell, border10%/focus25%, borderless16px/24px input and footer spacing16/12/8px as appropriate. Cross-browser adaptation: installed native autosize minRows1/maxRows8 plus CSS max12rem/resize:none replaces the homepage's asChild field-sizing-content textarea. Empty input is one row; no current fixed3-row/resizable field or amber circular send. Neutral foreground send uses rounded6px control; existing mobile44px target requirement is retained. Real model/effort/capacity and read-only analysis remain; no microphone/attachment capabilities added.

App owns draft and persistent nonce. Layout effect synchronizes SDK composer text from App state, including pending draft on remount and acknowledged empty state. Native Input updates both; Root caller prevents default and calls existing durable submit, and Send caller prevents default then requests that same form submission. Installed Radix composition therefore suppresses default runtime.send/automatic clear; acceptance/recovery still controls clearing. Input disables pasted attachments, Escape cancellation and automatic run/scroll/thread-switch focus; touch-primary Enter newline flag is enabled, desktop Enter submits/ShiftEnter newline follows the official primitive. Analysis remains separate typebutton. Ordinary empty-composer hint is removed; real notices/uncertain-recovery UI remain. Accepted notices now plain “Messaggio inviato”/“Analisi accodata”; recovery “Richiesta recuperata”. Receipt IDs remain in their existing receipt/Activity views.

Fixture-only FIXTURE_DROP_ACK_ONCE=1 destroys the first chat response AFTER durable Queue admission and starting its mock pipeline. Original ID/job remains, and duplicate/recovery cannot start it again; default fixture flow and production endpoints are unchanged. Primary owns live fixture/ACK-loss qualification; no child fixture process started.

Node regressions execute the production Root/Send event callbacks through the installed Radix composeEventHandlers, prove exactly one durable callback per event and zero default runtime sends/clears, guard busy/empty input, and exercise draft-to-SDK synchronization without sending. Full Node24.21 build **148/148 PASS**, explicit typecheck PASS, Python **16/16 PASS**, fixture node-check PASS. Logs /tmp/satssurge-official040-{node,typecheck,python}.log. Exact files: web/App.tsx, new web/components/AgentComposer.tsx, web/style.css, scripts/ui-fixture.mjs, new src/test/official-composer.test.ts, this handoff. Generated ignored dist/public rebuilt. Initial case-sensitive Button import compile error corrected to existing ui/button before full successful checks. No Agent/RunBudget/finance/scheduler/version/Git/deploy/provider edits; backend146 contract remains.

Primary039 evidence carried unchanged: leading history offsets62/254.46875 now exact across Node-return; three real qualification runs completed19/23/28s; natural high analyst98s/events132s registered waits without due changes. Other analyst provider stream ended before terminal (not deadline), existing cooldown until15:42:40Z honored, no replay/clear. Pending original autonomy bff remains queued and financial fence plan035 remains primary-owned. 039 actual healthy but acceptance in progress;040 publication/installed/browser/native-mobile acceptance is NOT claimed. Writer STOPPED; all child build/test/check processes exited and no child live resources remain. Primary owns one-row/autogrow/Enter/ShiftEnter/tab-draft/ACK-loss and matched official screenshot qualification, review and immutable040 release.

### 0.4.0 source version preparation — official composer, acceptance pending

Exact next version is0.4.0; intended workflow tag is
`satssurge-autopilot-v0.4.0`. Package and both root lock version fields are0.4.0;
manifest/compose remain on verified installed0.3.9 until new image verification.
0.3.9 backend remains unchanged. New frontend uses official Composer.Root/Input/
Send with one durable submission callback, native single-line autosizing and
persistent admission nonce. Review approved; Node tests/build/typecheck passed
148 and Python16 (`/tmp/satssurge-official040*.log`).

Actual local fixture qualified Enter/ShiftEnter,44→68px autosize, draft return
across tabs and recovery of a dropped post-COMMIT acknowledgment into one job.
24 responsive cases had no overflow, mobile controls>=16px text/44px targets
and empty console. These are candidate frontend proofs; installed0.4.0
acceptance is pending, not inferred from installed healthy0.3.9.

Current original autonomy remains paused under ownedplan-035-qualification;
backfill timer inactive, zero active/financial-pending operations, original
naturally queued job preserved under legitimate model cooldown. Publication
never authorizes clearing that fence or replaying its submission. Primary owns
checkpoint/update, real official composer/Pi/browser/natural economic checks,
reconciliation and original autonomy/timer restoration. Previous immutable
0.3.9 tag/image remain unchanged. No financial tests/regtest/M3/M4 expansion.

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
