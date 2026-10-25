# SatsSurge: simplifying the Pi Durable integration

Status: design for #137 points 1, 2 and 4, written 2026-10-25 against main `b0a4811` (0.5.25).
Revised after an independent review the same day; the review result is summarized in
§ "Review outcome".
Points 3 (native retry, PR #139) and 5 (docs, PR #138) are already merged.

## What is wrong today

The app uses Pi Durable 1.1.0 as a durable model runner, but it also re-implements
part of what Durable already does, and the two copies have to be reconciled.

1. **Library patch.** `scripts/pi-scoped-stop-patch.mjs` rewrites
   `node_modules/@earendil-works/pi-durable/dist/harness/scheduler.js` at build to add
   `cancelConversationScoped`.
   - It is used to apply a Telegram Stop received for a turn interrupted by a restart,
     while Durable's scheduler is still paused.
   - Stock `conversation.abort()` and `waitForIdle()` resume the scheduler first.
   - The pause is weaker than it looks. The first `submit`/`wait` of any job after a restart
     resumes every pending conversation too. Recovered work that no job owns yet then runs
     unowned and its tools fail closed.
2. **Tools registered per slot.** `install()` runs for coordinator, analyst 0, analyst 1
   and Telegram (slot 2). Each registers 21 tools with suffixed names
   (`node_state_analyst_0`, …) and builds per-slot extensions (`satssurge-analyst-N`).
   Slot identity also drives:
   - the Telegram session binding keys;
   - budgets (analyst budget for Telegram);
   - instructions and the provider closure name.
   - The provider closure name has a bug: an economic Telegram run looks for
     `follow_up_outcome` but has `follow_up_outcome_analyst_2`.
3. **Mirrored run state.** For every model run the app keeps copies of what Durable
   already stores:
   - conversation and submission IDs;
   - leases: written and renewed every 15 s, **never read**;
   - restart re-attachment per job;
   - scoped-stop proofs and native-cancellation receipts.

## Review outcome (2026-10-25)

An independent read-only review (Opus) confirmed the direction and found these corrections,
now folded into the plan below:

- **F1.** A global `resume()` at open would bypass the app gates for recovered runs:
  `enabled`, `bootstrapReady`, uncertain operation, model availability and hard deadline.
  **Owner decision:** recovered runs that the gates would not admit now are **aborted at open**
  and finalized as interrupted, with no automatic replay.
- **F2.** Durable work can exist for a job whose app copy says `submitted=0`, when a crash
  falls between `submit` and `markSubmitted`. Recovery must bind by `requestId` and sweep
  `harness.inspect()`, not trust `submitted`.
- **F3.** Stock Durable has a stop path that does not resume: `harness.abortTask`,
  `harness.abortSubmission` and `harness.inspect` commit marks without resuming. Use them
  before `resume()`; keep `conversation.abort()` for live Stops.
- **F4.** Recovered Telegram runs need their runner (Stop, steer, withdraw), not just a
  registry entry. Split `runJob` into `attach` and `await`.
- **F5.** Slot is used beyond tool names. See the table in A.
- **F6.** The operation ID is random (`Store.reserve`), so nothing links a Durable tool call
  to its operation. Add that link.
- **F7.** Telegram owner intents, the pre-native correction states, withdrawals, baselines
  and the terminal result object must stay app-side.
- **F8.** Lease removal is safe and `run_token` stays. `updated_at` stops ticking during a run.
- **F9.** Keeping two database files is right, but for the reasons below, not for the
  (false) "operation ID derived from the call".

## What stays app-side, and why

The app queue decides **what may run and when**, which Durable does not do across
conversations:
- admission and gating (`enabled`, `bootstrapReady`, read-only capabilities when gated);
- lanes: one financial coordinator, one Telegram coordinator, two read-only analysts;
- priority with aging, and Telegram per-chat ordering;
- no new financial work while an operation is uncertain;
- model cooldown;
- request IDs, and the UI and Telegram projections.

The executor's operation ledger stays the source of truth for money. Financial tools stay
`replay: "unsafe"`: Durable settles an interrupted unsafe call as `interrupted` and never
re-runs it, and `Store.reserve` refuses a duplicate while an operation is active.

Telegram app state that stays (F7):
- owner intents before any native write (`received`, `choice_pending`, `late`, expiry);
- admitted corrections without a native submission, their order, and `withdrawalRequested`;
- Stop receipts with their generation and version fences;
- per-turn entry and usage baselines for reused sessions;
- the terminal receipt with outcome, final entry **and** result object (projected into
  `jobs.result` after a crash before `finish`).

## Target

**The app decides what runs; Durable runs it and recovers it.** Every cross-database
reference is an idempotent key: job → submission by `requestId`, session → conversation by
binding entry, tool call → operation by call ID (new, F6).

### A. One run registry, one tool set

- `Agent.runs: Map<ConversationId, Run>` replaces `coordinator`, `analysts` and
  `sessions`. The provider wrapper maps `sessionId → conversationId` when the run is bound.
- Tools are registered **once**, without suffixes. `limit(api.conversationId)` resolves
  the run and keeps today's checks: job running, `run_token`, conversation match, Telegram
  authority.
- A run has a **role** derived from lane and capability, not from slot:

  | Capability | Role | Extensions | Budget |
  |---|---|---|---|
  | `financial_guarded` (coordinator) | coordinator | read, financial, content | coordinator |
  | `read_only_qualification` | coordinator | read | coordinator |
  | `guarded_manual_proposal` | analyst | read, propose (manual and channel proposals, **no** `execute_decision`) | analyst |
  | `read_only_research` (analyst lane, Telegram `/analyze`) | analyst | read, propose | analyst |
  | `read_only_chat` (Telegram) | chat | read, propose (as today) | analyst (12 research calls, as today) |

  - Tools still re-check capability at execution, so a misconfigured conversation fails closed.
  - Instructions, the closure name (`follow_up_outcome`), the drafts collection and the
    `agent` status key follow the role. This fixes the slot-2 closure bug; a test pins the
    corrected behaviour.
  - Telegram answers stay out of the `chat` memory, as today.
- **Session binding keys stay stable** so Telegram memory survives the upgrade:
  - chat keeps the `:2` suffix;
  - research keeps `:0`. An existing `/analyze` session bound on `:1` starts a fresh
    conversation once.
- Recovered conversations still name the old extension (`satssurge-analyst-N`), which Durable
  would silently drop (no tools). Recovery **re-configures** every bound conversation before
  `resume()`.
- `state_page` `nextCall.tool` drops the suffix. Persisted cursors that name a suffixed tool
  become `tool_unavailable`, which is harmless.

### B. Startup recovery: attach, stop, resume

`runJob` splits into two halves:
- `attach(job)`: claim/token, registry entry, `configure`, `turns.bind`, pending Stop and
  withdraw marks. It never calls `submit`, `wait`, `waitForIdle` or `conversation.abort`.
- `await(job)`: submit or find the submission, wait, join corrections, finalize.

At open, with the scheduler still paused:

1. For every `restart_recovery` job, whatever `submitted` says (F2):
   - resolve the conversation from `jobs.conversation_id` or
     `conversationIntent:<job>` → `app.conversation_binding`;
   - resolve the submission by `submissionByRequest(conversation, request_id)`.
2. Apply the gates (F1). A job the gates would not admit now has its root tasks aborted with
   `harness.abortTask` and its queued inputs with `harness.abortSubmission`, and is finalized
   `failed` with "interrupted at restart; no automatic replay". The gates are:
   - `enabled` and `bootstrapReady` for its capability;
   - an uncertain operation for the financial coordinator;
   - model availability and cooldown;
   - remaining hard-deadline time.
3. Apply pending Telegram Stops the same way, with `abortTask`/`abortSubmission` (F3).
4. `attach` every remaining job into its lane, with a token issued through `Queue` (not an
   un-gated claim), and re-configure its conversation.
5. `harness.inspect()` sweep: every live task and queued or placed submission must belong to an
   attached run. Abort anything else before resuming.
6. `harness.resume()`, then the scheduler launches the `await` halves.

Live Stops keep using `conversation.abort()` and `waitForIdle()` (already native today).

The following are removed:
- `pi-scoped-stop-patch.*` and its build step;
- `cancelConversationScoped`;
- the scoped-stop recovery: `recoverTelegramStops`, `reconcileClosedScopedStop`,
  `finalizeScopedStop`.

`pi-scoped-stop.test.ts` is **ported**, not deleted. Its ToolTask-children abort test checks a
property native abort must keep.

### C. Queue without leases

- Remove `renew()`, the heartbeat timers and the writes of `lease_owner`/`lease_until`.
  Strip `lease_until` from the public job JSON.
- `run_token` stays. It fences late async work of a finished run in the same process:
  `finish`, `wait`, bind, submit, tools and provider ownership checks.
- No schema change. The lease columns stay NULL and are dropped at the next migration that
  already needs a checkpoint.

### D. Telegram turns: drop only the scoped-stop machinery

- Remove `nativeCancellation`, `stopProof`, `telegramStopRecovery` and the
  `scoped`/`stop_requested` → `finalizeScopedStop` path.
- Historical rows stay readable.
- Correction **status after native admission** is read from Durable by
  `telegram-steer:<id>`. Everything listed under "Telegram app state that stays" remains.

### E. Tool call ↔ operation link (F6)

- `execute_decision` passes `api.conversationId` and `api.callId` to `executor.execute`.
- The reservation persists `operationCall:<operation>` = `{conversation, callId, job}` in the
  same `Store.tx`. It is an additive meta key, so there is no schema bump.
- `execute_decision` refuses a call ID that already has an operation.
- Reconciliation and the UI can then report "interrupted call X ↔ operation Y" exactly.

### Why the two database files stay

- Merging would not make `Store.tx` (synchronous) and Durable `commit` (asynchronous, own
  connection) atomic.
- The files hold different data with different retention: node accounting and canonical
  archives versus transcripts. The launcher already checkpoints all three databases together.
- After A–E every cross-reference is an idempotent key. The problem was the mirrored state,
  not the second file.

## Data on the node

- No schema migration.
- Existing jobs keep `conversation_id`/`submission_id`; they become caches.
- Historical Telegram receipts stay readable.
- The upgrade happens only when no job, operation or reservation is active, as for every
  release. That also avoids pending calls to renamed tools.

## Plan

Each step is a PR with tests:

0. **Characterization tests on current code:**
   - Stop before SIGKILL, with zero provider requests in that conversation after reopen;
   - `submitted=0` crash next to another recovered run;
   - recovered run while `enabled=false`, model unavailable, or an operation uncertain;
   - late Stop on a recovered turn;
   - Telegram session reused across the change.
1. **C** (leases) and **A** (registry, roles, single tool set, stable session keys).
2. **B** (attach/await, abort-before-resume, gates, inspect sweep) together with **E**;
   remove the patch.
3. **D**.
4. Update `docs/pi` (architecture, durable-patterns, telegram-integration), then an
   independent code review, then one release.

## Risks

- **Recovered safe tool calls run again after restart.** That is Durable's contract, and
  they are read-only. A recovered safe call to a renamed tool settles as `interrupted`.
- **Abort ordering.** Marks are committed with `abortTask`/`abortSubmission` before
  `resume()`, so no stopped turn can start a request. The characterization test pins it.
- **Telegram Stop semantics.** The owner-visible behaviour must not change: Stop ends the
  turn, queued corrections are withdrawn, and no later turn is affected. The existing
  Telegram tests plus the new recovery tests are the acceptance.
