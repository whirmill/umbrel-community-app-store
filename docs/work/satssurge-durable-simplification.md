# SatsSurge: simplifying the Pi Durable integration

Status: design for #137 points 1, 2 and 4, written 2026-10-25 against main `b0a4811` (0.5.25).
Points 3 (native retry, PR #139) and 5 (docs, PR #138) are already separate PRs.

## What is wrong today

The app uses Pi Durable 1.1.0 as a durable model runner, but it also re-implements
much of what Durable already does, and the two copies have to be reconciled.

1. **Library patch.** `scripts/pi-scoped-stop-patch.mjs` rewrites
   `node_modules/@earendil-works/pi-durable/dist/harness/scheduler.js` at build to add
   `cancelConversationScoped`.
   - It exists because the app keeps Durable's scheduler paused at startup
     (`agent.ts` open: "Scheduling starts only when a recovered job owns the run").
   - Stock `conversation.abort()` and `waitForIdle()` start the whole scheduler, so a
     Stop received for a turn interrupted by a restart could not be applied without
     also resuming every other pending task.
2. **Tools registered per slot.** `install()` runs for coordinator, analyst 0, analyst 1
   and Telegram (slot 2). Each run registers 21 tools with suffixed names
   (`node_state_analyst_0`, …) and builds per-slot extensions (`satssurge-analyst-N`).
   - Each tool finds its run through a slot closure (`current()`).
   - It then checks that the run's conversation equals `api.conversationId`.
   - The provider wrapper finds the same run a third way, through `pi.provider` `sessionId`.
3. **Two copies of run state.** For every model run the app's `jobs` row and meta keys
   in `operational.sqlite` mirror what Durable already stores in `durable.sqlite`:

   | App copy | Durable already has |
   |---|---|
   | `conversation_id`, `conversationIntent:*`, Telegram session keys | `app.conversation_binding` entry in the root conversation (written in the same commit as the conversation) |
   | `submission_id`, `submitted` | the submission, findable by `requestId` (`submissionByRequest`) |
   | `lease_owner`, `lease_until`, 15 s heartbeat `renew()` | nothing. **No code reads `lease_until`.** One process holds the executor flock, so leases protect against nobody. |
   | `restart_recovery` waiting state plus per-job re-attach in `runJob` | pending tasks resume on `harness.resume()` |
   | Telegram correction states, scoped-stop proofs, `telegramTerminal` native cancellation receipts | submission status (`queued`/`done`/`unanswered`), `abort()` |

   Most of the 1,622 lines of `agent.ts` and 185 of `telegram-turns.ts` exist to keep
   these copies consistent across a crash between the two databases.

## What stays app-side, and why

The app queue is not only duplication. It decides **what may run and when**, which
Durable does not do across conversations:

- admission and gating: `enabled`, `bootstrapReady`, read-only capabilities when gated;
- lanes: one financial coordinator, one Telegram coordinator, two read-only analysts;
- priority with aging, and Telegram per-chat ordering;
- no new financial work while an operation is uncertain;
- model cooldown (`modelUnavailableUntil`);
- request IDs and UI and Telegram projections of job history.

The financial non-replay rule also stays app-side. Financial tools are `replay: "unsafe"`.
Durable never re-runs an interrupted unsafe call (the model gets an `interrupted` result), and the executor's operation ledger in
`operational.sqlite` stays the source of truth for money.

## Target

**The app decides what runs; Durable runs it and recovers it.** Every cross-database
reference is an idempotent key that can be re-derived, not state that must be reconciled.

### A. One run registry, one tool set

- `Agent.runs: Map<ConversationId, Run>` replaces `coordinator`, `analysts` and `sessions`.
  - A `Run` holds the job, budget, call count, analyst proposals and capability.
  - The provider wrapper maps `sessionId → conversationId` once when the run is bound.
- Tools are registered **once**, without suffixes. `limit(api.conversationId)` resolves the
  run from the registry and keeps today's checks: job running, run token, conversation
  matches, Telegram authority not revoked.
- Extensions by capability instead of by slot:
  - `satssurge-read`: state, pages, research, follow-up, runtime advisories;
  - `satssurge-propose`: analyst proposals;
  - `satssurge-financial`: guarded fee and rebalance and the channel tools;
  - `satssurge-content`: export, only when authorized.

  A conversation is configured with the extensions its job capability allows. Tools still
  re-check the capability at execution, so a wrongly configured conversation fails closed.
- Instructions name tools without slot suffixes (for example `follow_up_outcome`).

### B. Startup recovery with a running scheduler; the patch goes

At open:

1. Open the harness (paused, as today).
2. Bind **every** recovered job that has a submission (`restart_recovery` with
   `submitted=1`) into the registry before anything runs.
   - Each gets a fresh run token and a budget restored from `runBudget:<job>`.
   - The conversation comes from the binding entry, so a missing app copy is re-derived.
3. Apply pending Telegram Stops with the native `conversation.abort()`.
4. `harness.resume()`. Pending generations and safe tool calls continue with a run in the
   registry. An interrupted unsafe call settles as interrupted (Durable 1.1.0) and the
   executor reconciles it as today.
5. The scheduler waits on the recovered submissions like any other run.

`pi-scoped-stop-patch.*`, its build step, `cancelConversationScoped`,
`recoverTelegramStops`/`reconcileClosedScopedStop` and the patch's tests are removed.

### C. Queue without leases

- Remove `renew()`, the heartbeat timers and the writes of `lease_owner`/`lease_until`.
- `run_token` stays: it fences late async writes of a run that the same process has
  already finished or recovered.
- No schema change. The two lease columns stay NULL and are dropped at the next
  migration that already needs a checkpoint, so this release does not force a 1 GB
  baseline copy on the node.

### D. Telegram turns derived from Durable

- A turn keeps job ↔ chat ↔ generation, its correction request IDs
  (`telegram-steer:<id>`) and the public result receipt.
- Correction and Stop **status** is read from Durable (submission status, `abort()`
  result) instead of being mirrored in app state machines.
- `telegramTerminal` keeps only what Telegram needs to answer: outcome and final entry.

### Why the two database files stay

Merging them would not give atomic transactions:
- Durable commits asynchronously on its own connection;
- the app's `Store.tx` is synchronous;
- a shared connection would deadlock or nest transactions.

The files also hold different data with different retention: node accounting and
canonical archives versus transcripts. After A–D, nothing needs cross-database atomicity:
- job → submission is `requestId`;
- session → conversation is the binding entry;
- tool call → operation is the operation ID the executor derives from the call.

The real problem was the mirrored state, not the second file.

## Data on the node

- No schema migration for `operational.sqlite` or `durable.sqlite`.
- Existing jobs keep their `conversation_id`/`submission_id`; they become caches.
- Historical `telegramTerminal` and scoped-stop receipts stay readable but are no longer
  written.
- Upgrade only when no job, operation or reservation is active, as for every release.

## Plan

Each step is a PR on top of the previous one, with tests:

1. A: registry, single tool set, capability extensions. Update the tool-name tests.
2. B: startup recovery with `resume()`, native Stop.
   - Remove the patch and `pi-scoped-stop.test.ts`.
   - Keep and adapt the real SIGKILL recovery tests: `pi-recovery`, `pi-native-qualification`,
     `telegram-restart-fixture`. The key acceptance is still "no second effect, no second submission".
3. C: remove leases and heartbeats.
4. D: Telegram turn ledger reduced to keys plus a native status read.
5. Update `docs/pi` (architecture, durable-patterns, telegram-integration), then an
   independent review, then one release.

## Risks

- **Recovered safe tool calls run again after restart.** That is Durable's contract; they
  are read-only. Unsafe financial calls are never re-run.
- **Renamed tools in existing conversations.** Durable resolves a call by name among the
  conversation's current tools (spec "tool task"). A call still pending to a suffixed
  name would settle as `tool_unavailable` after the upgrade, which is why the upgrade
  waits for no active job. Old suffixed calls in reused Telegram sessions remain only
  as history.
- **A recovered run whose job is missing or already terminal.** Abort its conversation
  natively before `resume()`, and record why.
- **Telegram Stop semantics.** The owner-visible behavior must not change: Stop ends the
  turn, queued corrections are withdrawn, and no later turn is affected. The existing
  Telegram tests are the acceptance.
