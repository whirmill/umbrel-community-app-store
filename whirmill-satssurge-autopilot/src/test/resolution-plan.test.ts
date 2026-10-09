import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceViews } from "../evidence-views.js";
import { RunBudget } from "../run-budget.js";
import { Store } from "../store.js";
import { Queue } from "../queue.js";
import { analystFeed } from "../analysis-feed.js";
import { ReviewWaits } from "../review-waits.js";
import { responseSummaries, summaryDelta } from "../public-reasoning.js";
import { Agent } from "../agent.js";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { historyEvents, HISTORY_BYTES } from "../ui-history.js";
import { UiEvents } from "../ui-events.js";
import { ProjectionIndex } from "../ui-index.js";
function state() {
  return {
    snapshot: {
      at: "2026-10-09T00:00:00Z",
      channels: [{ id: "1099511627776" }, { id: "2199023255552" }],
    },
    competition: {
      status: "qualified",
      channels: [{ id: "1099511627776", alternatives: [{ ppm: 2 }] }],
    },
    diagnostics: {
      lndg: {
        status: "qualified",
        capturedAt: "2026-10-09T00:00:00Z",
        coverage: { complete: false },
        captureComplete: true,
        captureCounts: {
          failures: { selected: 229, returned: 229, pagesComplete: true },
        },
        failures: Array.from({ length: 229 }, (_, i) => ({
          id: String(i),
          source: "1099511627776",
          target: "2199023255552",
          at: "2026-10-09T00:00:00Z",
          amountMsat: "900719925474099300",
          distinctPaymentsUnknown: true,
        })),
      },
    },
  };
}
test("immutable scoped pages retain 229 exact rows across metadata/mutation, ownership, TTL, capacity and cleanup", () => {
  let clock = 0;
  const views = new EvidenceViews(() => clock);
  const s = state(),
    query = {
      section: "diagnostics" as const,
      provider: "lndg" as const,
      collection: "failures" as const,
      source: "1x0x0",
      target: "2x0x0",
    };
  let p: any = views.page("job", s, query),
    cursor = p.cursor,
    version = p.version;
  assert.equal(p.metadata.captureComplete, true);
  assert.equal(p.metadata.upstreamHistoryComplete, false);
  assert.equal(
    p.summary.totals.amountMsat,
    (229n * 900719925474099300n).toString(),
  );
  const ids = p.rows.map((r: any) => r.id);
  s.diagnostics.lndg.failures.push({
    ...s.diagnostics.lndg.failures[0]!,
    id: "new",
  });
  s.diagnostics.lndg.capturedAt = "2026-10-09T00:02:00Z";
  while (p.nextOffset !== null) {
    p = views.page("job", s, { ...query, cursor, offset: p.nextOffset });
    assert.equal(p.version, version);
    assert.ok(Buffer.byteLength(JSON.stringify(p)) <= 12000);
    ids.push(...p.rows.map((r: any) => r.id));
  }
  assert.equal(new Set(ids).size, 229);
  assert.throws(() => views.page("other", s, { ...query, cursor }));
  assert.throws(() =>
    views.page("job", s, { ...query, cursor, target: "3x0x0" }),
  );
  const channel: any = views.page("job", s, {
    section: "channels",
    channel: "1x0x0",
  });
  assert.equal(channel.total, 1);
  const alternatives: any = views.page("job", s, {
    section: "competition_alternatives",
    channel: "1x0x0",
  });
  assert.equal(alternatives.total, 1);
  assert.equal((views.page("job", s, query) as any).capacity, true);
  views.release("job");
  assert.equal(views.metrics().bytes, 0);
  clock = 300001;
  assert.equal(
    (views.page("job", s, { ...query, cursor }) as any).expired,
    true,
  );
  assert.equal(
    (new EvidenceViews().page("job", s, { ...query, cursor }) as any).expired,
    true,
  );
});
test("public reasoning accepts Responses summary only and rejects malformed/raw/encrypted/signature leakage", () => {
  const signature = JSON.stringify({
    type: "reasoning",
    id: "r",
    summary: [
      { type: "summary_text", text: "Public summary" },
      { type: "text", text: "raw" },
    ],
    content: [{ text: "private" }],
    encrypted_content: "secret",
  });
  assert.deepEqual(responseSummaries(signature), [
    { itemId: "r", index: 0, text: "Public summary", truncated: false },
  ]);
  for (const value of [
    "bad",
    JSON.stringify({
      type: "reasoning",
      id: "r",
      content: [{ text: "private" }],
    }),
  ])
    assert.deepEqual(responseSummaries(value), []);
  assert.equal(
    summaryDelta(
      { type: "response.reasoning_text.delta", delta: "raw" },
      "openai-responses",
    ),
    null,
  );
  assert.equal(
    summaryDelta(
      {
        type: "response.reasoning_summary_text.delta",
        item_id: "r",
        summary_index: 0,
        sequence_number: 1,
        delta: "public",
      },
      "wrong",
    ),
    null,
  );
});
test("durable budget persists phase/calls across recovery and does not renew finalization", () => {
  const store = new Store(":memory:");
  let clock = 100;
  const b = new RunBudget(store, "job", true, () => clock);
  for (let i = 0; i < 12; i++) b.call();
  assert.equal(b.exhausted(), true);
  clock += 1000;
  const recovery = new RunBudget(store, "job", true, () => clock);
  assert.equal(recovery.status().calls, 12);
  assert.equal(recovery.status().started, 100);
  assert.equal(recovery.call(true), false);
  clock += 180000;
  assert.equal(recovery.status().remainingMs, 0);
  b.discardBeforeSubmission();
  assert.equal(store.get(b.key), undefined);
  store.close();
});
test("economic feed dedups before limit, retains newest incomplete, excludes qualification and unknown", () => {
  const store = new Store(":memory:"),
    q = new Queue(store);
  const add = (
    requestId: string,
    scope: string,
    purpose: "economic" | "qualification" | "unknown",
    origin: "owner" | "scheduler" | "qualification" | "unknown",
    completed = true,
  ) => {
    const j = q.enqueue(
      {
        requestId,
        kind: "analysis",
        scope,
        purpose,
        origin,
        payload: { message: "test" },
      },
      "2026-10-09T00:00:00Z",
    );
    if (completed)
      store.run(
        "UPDATE jobs SET state='completed',result=? WHERE id=?",
        JSON.stringify({ answer: "a", evidenceAt: "2026-10-08T23:59:00Z" }),
        j.id,
      );
    return j;
  };
  add("a", "s1", "economic", "owner");
  add("b", "s2", "economic", "scheduler");
  add("c", "s3", "economic", "scheduler");
  add("d", "s4", "economic", "scheduler");
  add("q1", "q1", "qualification", "qualification");
  add("q2", "q2", "qualification", "qualification");
  const fresh = add("new", "s1", "economic", "owner", false);
  add("u", "u", "unknown", "unknown");
  const result = analystFeed(store);
  assert.equal(result.length, 4);
  assert.equal(result[0]!.id, fresh.id);
  assert.equal(result[0]!.complete, false);
  assert.equal(result[0]!.gap !== null, true);
  assert.equal(
    result.some((r) => r.purpose === "qualification"),
    false,
  );
  store.close();
});
test("review wait retains original due time across 72h/backoff/restart and consumes triggers only after admission", () => {
  const store = new Store(":memory:");
  let clock = Date.parse("2026-10-09T00:00:00Z");
  let waits = new ReviewWaits(store, () => clock);
  let r = waits.register({
    scope: "s",
    origin: "owner",
    evidenceIds: ["e"],
    missing: ["48h"],
    dueAt: new Date(clock + 48 * 3600000).toISOString(),
  });
  waits.admitted("s");
  clock += 3600000;
  waits.register({ ...r, dueAt: new Date(clock + 48 * 3600000).toISOString() });
  assert.equal(waits.get("s")!.dueAt, r.dueAt);
  assert.equal(waits.due(waits.get("s")!), false);
  waits.signal("s", "policy1");
  assert.equal(waits.due(waits.get("s")!), true);
  assert.equal(waits.get("s")!.consumedTrigger, null);
  waits.admitted("s");
  clock += 72 * 3600000;
  waits = new ReviewWaits(store, () => clock);
  assert.equal(waits.due(waits.get("s")!), true);
  assert.equal(waits.get("s")!.dueAt, r.dueAt);
  store.close();
});
test("history bounds heavy detail before serialization and index only notifies changed jobs", () => {
  const store = new Store(":memory:"),
    q = new Queue(store),
    events = new UiEvents(store);
  const j = q.enqueue({
    requestId: "heavy",
    kind: "chat",
    payload: { message: "a" },
  });
  for (let i = 0; i < 3000; i++)
    events.append(j.id, "tool_result", {
      toolCallId: "c" + i,
      toolName: "read",
      result: "x".repeat(24000),
    });
  const page = historyEvents(store, [j.id]);
  assert.equal(page.partial, true);
  assert.ok((page.bytes ?? 0) <= HISTORY_BYTES);
  assert.ok(
    page.events.every(
      (e) => e.data.result === undefined && e.data.detailEventId,
    ),
  );
  const index = new ProjectionIndex(),
    p: any = { jobs: { [j.id]: j }, events: page.events, cursor: 0 };
  index.publish(p);
  let changed = 0;
  const stop = index.subscribe(j.id, () => changed++);
  index.publish(p);
  assert.equal(changed, 0);
  index.publish({ ...p, jobs: { [j.id]: { ...j, state: "completed" } } });
  assert.equal(changed, 1);
  stop();
  assert.equal(index.metrics().listeners, 0);
  store.close();
});
for (const toolCount of [20, 40])
  test(
    "real Harness public-summary recovery and tool budget: " +
      toolCount +
      " batched attempts",
    async () => {
      const directory = mkdtempSync(join(tmpdir(), "resolution-harness-"));
      const store = new Store(join(directory, "op.sqlite")),
        q = new Queue(store);
      store.set("bootstrapReady", true);
      store.set("model", "gpt-6.1-sol");
      let effects = 0;
      const provider = openaiProvider();
      const observed: { session?: string; choice?: string }[] = [];
      provider.streamSimple = (model, transcript, options) => {
        observed.push({
          session: options?.sessionId,
          choice: options?.toolChoice,
        });
        const stream = createAssistantMessageEventStream();
        const finished = transcript.messages.some(
          (m: any) => m.role === "toolResult",
        );
        const message: any = {
          role: "assistant",
          api: "openai-responses",
          provider: "openai",
          model: model.id,
          timestamp: Date.now(),
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: finished ? "stop" : "toolUse",
          content: finished
            ? [
                {
                  type: "thinking",
                  thinking: "PRIVATE raw",
                  thinkingSignature: JSON.stringify({
                    type: "reasoning",
                    id: "reason",
                    summary: [{ type: "summary_text", text: "Public summary" }],
                    encrypted_content: "PRIVATE encrypted",
                  }),
                },
                { type: "text", text: "Final qualified answer" },
              ]
            : Array.from({ length: toolCount }, (_, i) => ({
                type: "toolCall",
                id: "c" + i,
                name: "node_state",
                arguments: {},
              })),
        };
        queueMicrotask(async () => {
          await options?.onProviderStreamEvent?.(
            {
              type: "response.reasoning_summary_text.delta",
              item_id: "reason",
              summary_index: 0,
              sequence_number: 1,
              delta: "summary",
            },
            model,
          );
          await options?.onProviderStreamEvent?.(
            {
              type: "response.reasoning_text.delta",
              item_id: "reason",
              delta: "PRIVATE raw",
            },
            model,
          );
          stream.push({ type: "start", partial: message });
          stream.push({ type: "done", reason: message.stopReason, message });
        });
        return stream;
      };
      const agent = new Agent(
        store,
        {
          execute: async () => {
            effects++;
            return {};
          },
        } as any,
        directory,
        q,
        provider,
      );
      agent.credentials.read = async () => ({ type: "oauth" }) as any;
      try {
        await agent.open();
        const admitted = q.enqueue({
            requestId: "provider-harness",
            kind: "chat",
            origin: "owner",
            purpose: "general",
            payload: { message: "bounded model" },
          }),
          job = q.claim("coordinator", "test")!;
        new UiEvents(store).append(
          job.id,
          "reasoning_summary",
          {
            itemId: "reason",
            index: 0,
            text: "Public ",
            sequence: 0,
            provenance: "responses.summary_text",
          },
          "summary:reason:0:0",
        );
        if (toolCount === 20) {
          const result: any = await agent.runJob(job);
          assert.equal(result.answer, "Final qualified answer");
        } else {
          await assert.rejects(agent.runJob(job));
          assert.equal(
            store.get<any>("runBudget:" + job.id).reason,
            "absolute_tool_limit",
          );
        }
        assert.equal(effects, 0);
        assert.equal(observed.length, toolCount === 20 ? 2 : 1);
        if (toolCount === 20) {
          assert.equal(observed[1]?.choice, "none");
          assert.equal(observed[0]?.session, observed[1]?.session);
        }
        assert.equal(q.get(admitted.id)?.submitted, 1);
        const publicEvents = store
          .all("SELECT data FROM ui_events WHERE job_id=?", job.id)
          .map((e) => JSON.parse(e.data));
        assert.ok(
          publicEvents.some((e) => e.provenance === "responses.summary_text"),
        );
        assert.equal(JSON.stringify(publicEvents).includes("PRIVATE"), false);
        const summaries = publicEvents.filter(
          (e) => e.provenance === "responses.summary_text",
        );
        assert.equal(summaries.at(-1).text, "Public summary");
        assert.equal(
          summaries.some((e) => e.text === "Public summarysummary"),
          false,
        );
        assert.ok(
          store.one(
            "SELECT id FROM job_events WHERE job_id=? AND type='run_metrics'",
            job.id,
          ),
        );
      } finally {
        await agent.close();
        store.close();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

test("actual Harness hard deadline awaits an entered financial mock and recovery keeps original receipt/budget with one effect", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deadline-recovery-")),
    store = new Store(join(dir, "op.sqlite")),
    q = new Queue(store);
  store.set("bootstrapReady", true);
  store.set("model", "gpt-6.1-sol");
  let effects = 0;
  const provider = openaiProvider();
  provider.streamSimple = (model, transcript) => {
    const stream = createAssistantMessageEventStream();
    const done = transcript.messages.some((m: any) => m.role === "toolResult");
    const message: any = {
      role: "assistant",
      api: "openai-responses",
      provider: "openai",
      model: model.id,
      timestamp: Date.now(),
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: done ? "stop" : "toolUse",
      content: done
        ? [{ type: "text", text: "final" }]
        : [
            {
              type: "toolCall",
              id: "financial-inflight",
              name: "execute_decision",
              arguments: {
                kind: "rebalance",
                category: "exploratory",
                strategy: "mock",
                source: "a",
                target: "b",
                amountSat: "1",
                maxFeeMsat: "1",
                decisionCapMsat: "1",
                demandKey: "a->b",
                evidenceIds: [],
                problem: "mock",
                evidence: "mock",
                whyAct: "mock",
                alternatives: "wait",
                verify: "mock",
                hypothesis: "mock",
              },
            },
          ],
    };
    queueMicrotask(() => {
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: message.stopReason, message });
    });
    return stream;
  };
  let released = false;
  const agent = new Agent(
    store,
    {
      execute: async () => {
        effects++;
        await new Promise((r) => setTimeout(r, 120));
        released = true;
        return { status: "uncertain", receipt: "original", replay: false };
      },
    } as any,
    dir,
    q,
    provider,
  );
  agent.credentials.read = async () => ({ type: "oauth" }) as any;
  try {
    await agent.open();
    const queued = q.enqueue({
      requestId: "deadline",
      kind: "chat",
      origin: "owner",
      purpose: "economic",
      payload: { message: "mock only" },
    });
    const started = Date.now();
    store.set("runBudget:" + queued.id, {
      started,
      calls: 0,
      phase: "research",
      reason: null,
      hardMs: 80,
      softMs: 60,
      researchCalls: 16,
    });
    let owned = q.claim("coordinator", "owner")!;
    await assert.rejects(agent.runJob(owned), /hard deadline/);
    assert.equal(effects, 1);
    assert.equal(released, true);
    const followUp = store.get<any>("followUpOutcome:" + queued.id);
    assert.equal(followUp.outcome, "unregistered");
    assert.equal(
      followUp.dueAt,
      new Date(Date.parse(queued.created_at) + 3600000).toISOString(),
    );
    const receipt = q.get(queued.id)!;
    assert.ok(receipt.submission_id);
    q.recoverAfterRestart();
    owned = q.claim("coordinator", "new-owner")!;
    await assert.rejects(agent.runJob(owned));
    assert.equal(effects, 1);
    assert.deepEqual(store.get("followUpOutcome:" + queued.id), followUp);
    assert.equal(q.get(queued.id)!.submission_id, receipt.submission_id);
    assert.equal(store.get<any>("runBudget:" + queued.id).started, started);
    assert.ok(
      store.one(
        "SELECT data FROM ui_events WHERE job_id=? AND type='tool_result'",
        queued.id,
      ),
    );
  } finally {
    await agent.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("pre-submission unavailable-model wait discards only unused budget before a fresh original submission", async () => {
  const dir = mkdtempSync(join(tmpdir(), "unavailable-budget-")),
    store = new Store(join(dir, "op.sqlite")),
    q = new Queue(store);
  store.set("bootstrapReady", true);
  store.set("model", "gpt-6.1-sol");
  const agent = new Agent(store, {} as any, dir, q);
  agent.credentials.read = async () => undefined;
  try {
    const j = q.enqueue({
        requestId: "unavailable",
        kind: "chat",
        payload: { message: "original" },
      }),
      owned = q.claim("coordinator", "owner")!;
    await assert.rejects(agent.runJob(owned), /unavailable/);
    assert.equal(q.get(j.id)!.submitted, 0);
    assert.equal(store.get("runBudget:" + j.id), undefined);
  } finally {
    await agent.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
import { Scheduler } from "../scheduler.js";
test("scheduler fixed deadlines survive 72h, same-bucket finished work cannot consume a new trigger and backpressure preserves it", async () => {
  const store = new Store(":memory:"),
    q = new Queue(store, 10),
    scheduler = new Scheduler(q, {
      available: async () => false,
      runJob: async () => {
        throw Error("No model run expected");
      },
    });
  store.set("bootstrapReady", true);
  let clock = Date.parse("2026-10-09T00:00:00Z");
  const original = Date.now;
  Date.now = () => clock;
  try {
    const waits = new ReviewWaits(store),
      entry = waits.register({
        scope: "s",
        origin: "owner",
        evidenceIds: ["a"],
        missing: ["48h"],
        dueAt: new Date(clock + 48 * 3600000).toISOString(),
      });
    waits.signal("s", "first");
    scheduler.tick();
    const first = store.one("SELECT * FROM jobs WHERE scope='s'");
    assert.ok(first);
    store.run("UPDATE jobs SET state='completed' WHERE id=?", first.id);
    waits.signal("s", "policy:new");
    clock += 900000; // backoff boundary in same 15-min bucket generation uses trigger/sequence IDs
    scheduler.tick();
    const second = store.one(
      "SELECT * FROM jobs WHERE scope='s' ORDER BY rowid DESC LIMIT 1",
    );
    assert.notEqual(second.id, first.id);
    assert.equal(waits.get("s")!.consumedTrigger, "policy:new");
    clock += 72 * 3600000;
    scheduler.tick();
    assert.equal(waits.get("s")!.dueAt, entry.dueAt);
    store.run("UPDATE jobs SET state='completed' WHERE scope='s'");
    const cap = new Queue(store, 1),
      blockedScheduler = new Scheduler(cap, {
        available: async () => false,
        runJob: async () => undefined,
      });
    waits.signal("s", "policy:blocked");
    clock += 7 * 3600000;
    blockedScheduler.tick();
    assert.notEqual(waits.get("s")!.consumedTrigger, "policy:blocked");
    blockedScheduler.stop();
    await blockedScheduler.drain();
  } finally {
    Date.now = original;
    scheduler.stop();
    await scheduler.drain();
    store.close();
  }
});
import { ExternalStoreThreadRuntimeCore } from "../../node_modules/@assistant-ui/core/dist/runtimes/external-store/external-store-thread-runtime-core.js";
import { ExportedMessageRepository } from "@assistant-ui/react";
test("installed assistant-ui replacement repository remains bounded after 3000 visited IDs and retains active receipt", () => {
  const active: any = {
    id: "active",
    role: "assistant",
    content: [{ type: "text", text: "active receipt" }],
    status: { type: "running" },
  };
  const adapter = (offset: number) => ({
    messageRepository: ExportedMessageRepository.fromArray([
      ...Array.from({ length: 499 }, (_, i) => ({
        id: "m" + (offset + i),
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "message " + (offset + i) }],
      })),
      active,
    ]),
    convertMessage: (m: any) => m,
    onNew: async () => {},
    isRunning: false,
  });
  const core = new ExternalStoreThreadRuntimeCore(
    { getModelContext: () => ({}) },
    adapter(0),
  );
  for (let offset = 0; offset < 3000; offset += 100) {
    core.__internal_setAdapter(adapter(offset));
    assert.equal(core.export().messages.length, 500);
    assert.ok(core.export().messages.some((m) => m.message.id === "active"));
  }
  core.__internal_setAdapter(adapter(0));
  assert.equal(core.export().messages.length, 500);
});
import { qualifyDiagnostics } from "../diagnostics.js";
test("capture completeness is independently validated and target-only buckets cannot become corridor evidence", () => {
  const at = "2026-10-09T00:00:00Z";
  const p: any = {
    schema: 1,
    identity: "node",
    capturedAt: at,
    providers: {
      lndg: {
        status: "ok",
        version: "1.11.1",
        schemaFingerprint:
          "f12ae61382e1eff131904419106c3ddb51d30f2443990443ed65c848de419682",
        coverage: {
          start: at,
          end: at,
          complete: false,
          source: "selected tables",
        },
        forwards: [],
        failures: [],
        failureRollups: [],
        rebalances: [],
        captureCounts: Object.fromEntries(
          ["forwards", "failures", "failureRollups", "rebalances"].map((k) => [
            k,
            { selected: 0, returned: 0, pagesComplete: true },
          ]),
        ),
      },
    },
  };
  let result: any = qualifyDiagnostics(p, "node", at).lndg;
  assert.equal(result.captureComplete, true);
  assert.equal(result.coverage.complete, false);
  p.providers.lndg.captureCounts.failures.returned = 1;
  assert.equal(qualifyDiagnostics(p, "node", at).lndg.status, "incompatible");
  const views = new EvidenceViews(),
    targetOnly: any = {
      diagnostics: {
        lightningMate: {
          status: "qualified",
          failures: [
            { target: "2x0x0", count: "18", granularity: "target bucket" },
          ],
        },
      },
    };
  const page: any = views.page("j", targetOnly, {
    section: "diagnostics",
    provider: "lightningMate",
    collection: "failures",
    source: "1x0x0",
    target: "2x0x0",
  });
  assert.equal(page.total, 0);
  assert.equal(page.metadata.unsupportedRows, 1);
  assert.equal(page.metadata.captureComplete, null);
  assert.equal(views.releaseCursor("j", page.cursor), true);
  assert.equal(views.metrics().views, 0);
});
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
test("theme first paint follows system, validates persisted override and works when storage is unavailable under self-only CSP", () => {
  const code = readFileSync(
    new URL("../../web/public/theme.js", import.meta.url),
    "utf8",
  );
  for (const [saved, system, expected] of [
    ["system", true, "dark"],
    ["light", true, "light"],
    ["dark", false, "dark"],
    ["invalid", false, "light"],
  ] as const) {
    const root: any = { dataset: {}, style: {} },
      meta: any = {};
    runInNewContext(code, {
      localStorage: { getItem: () => saved },
      matchMedia: () => ({ matches: system }),
      document: { documentElement: root, querySelector: () => meta },
    });
    assert.equal(root.dataset.theme, expected);
    assert.equal(root.style.colorScheme, expected);
  }
  const root: any = { dataset: {}, style: {} };
  runInNewContext(code, {
    localStorage: {
      getItem: () => {
        throw Error("Storage unavailable");
      },
    },
    matchMedia: () => ({ matches: true }),
    document: { documentElement: root, querySelector: () => null },
  });
  assert.equal(root.dataset.theme, "dark");
  const html = readFileSync(
    new URL("../../web/index.html", import.meta.url),
    "utf8",
  );
  assert.ok(html.indexOf("/theme.js") < html.indexOf('id="root"'));
  assert.equal(html.includes("maximum-scale"), false);
  assert.equal(html.includes("user-scalable"), false);
});
import { proposal as mockProposal } from "./pi-fixture.js";
test("concurrent real Harness provider summaries bind distinct conversations and explicit qualification cannot mutate waits, proposals or financial effects", async () => {
  const dir = mkdtempSync(join(tmpdir(), "summary-concurrency-")),
    store = new Store(join(dir, "op.sqlite")),
    q = new Queue(store);
  store.set("bootstrapReady", true);
  store.set("model", "gpt-6.1-sol");
  let effects = 0;
  const provider = openaiProvider();
  provider.streamSimple = (model, transcript, options) => {
    const stream = createAssistantMessageEventStream(),
      text = JSON.stringify(transcript.messages),
      suffix = text.includes("node_state_analyst_0")
        ? "_analyst_0"
        : text.includes("node_state_analyst_1")
          ? "_analyst_1"
          : "";
    const done = transcript.messages.some((m: any) => m.role === "toolResult");
    const message: any = {
      role: "assistant",
      api: "openai-responses",
      provider: "openai",
      model: model.id,
      timestamp: Date.now(),
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: done ? "stop" : "toolUse",
      content: done
        ? [{ type: "text", text: "Qualified readonly final " + suffix }]
        : [
            {
              type: "toolCall",
              id: "review-call",
              name: "review_wait" + suffix,
              arguments: {
                scope: "qualification-scope",
                dueAt: new Date(Date.now() + 48 * 3600000).toISOString(),
                missing: ["48h"],
                evidenceIds: [],
              },
            },
            {
              type: "toolCall",
              id: "write-call",
              name: suffix ? "propose" + suffix : "execute_decision",
              arguments: mockProposal,
            },
          ],
    };
    queueMicrotask(async () => {
      const event = {
        type: "response.reasoning_summary_text.delta",
        item_id: "shared-item-id",
        summary_index: 0,
        sequence_number: 1,
        delta: "Public " + options?.sessionId,
      };
      await options?.onProviderStreamEvent?.(event, model);
      await options?.onProviderStreamEvent?.(event, model);
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: message.stopReason, message });
    });
    return stream;
  };
  const agent = new Agent(
    store,
    {
      execute: async () => {
        effects++;
        return {};
      },
    } as any,
    dir,
    q,
    provider,
  );
  agent.credentials.read = async () => ({ type: "oauth" }) as any;
  try {
    await agent.open();
    q.enqueue({
      requestId: "coordinator-q",
      kind: "chat",
      origin: "qualification",
      purpose: "qualification",
      payload: { message: "qualification" },
    });
    q.enqueue({
      requestId: "analyst-q0",
      kind: "analysis",
      origin: "qualification",
      purpose: "qualification",
      payload: { message: "qualification" },
    });
    q.enqueue({
      requestId: "analyst-q1",
      kind: "analysis",
      origin: "qualification",
      purpose: "qualification",
      payload: { message: "qualification" },
    });
    const jobs = [
      q.claim("coordinator", "test")!,
      q.claim("analyst", "test")!,
      q.claim("analyst", "test")!,
    ];
    await Promise.all(
      jobs.map((job, i) => agent.runJob(job, i === 0 ? undefined : i - 1)),
    );
    assert.equal(effects, 0);
    assert.equal(new ReviewWaits(store).all().length, 0);
    assert.equal(
      store.one("SELECT count(*) n FROM job_events WHERE type='proposal'").n,
      0,
    );
    assert.equal(analystFeed(store).length, 0);
    const conversations = new Set<string>(),
      summaries = new Set<string>();
    for (const job of jobs) {
      const rows = store.all(
        "SELECT data FROM ui_events WHERE job_id=? AND type='reasoning_summary'",
        job.id,
      );
      assert.equal(rows.length, 1);
      const value = JSON.parse(rows[0].data);
      assert.equal(value.conversationId, q.get(job.id)!.conversation_id);
      conversations.add(value.conversationId);
      summaries.add(value.text);
    }
    assert.equal(conversations.size, 3);
    assert.equal(summaries.size, 3);
  } finally {
    await agent.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
import { evidenceSource } from "../evidence-source.js";
import { ConversationProjection } from "../ui-events.js";
test("numeric evidence intervals match second/millisecond/offset-equivalent timestamps before SQL acquisition and cursor continuation", () => {
  const store = new Store(":memory:"),
    views = new EvidenceViews();
  const timestamps = [
    "2026-10-09T00:00:00Z",
    "2026-10-09T00:00:00.001Z",
    "2026-10-09T02:00:01+02:00",
    "2026-10-09T00:00:02Z",
    "2026-10-09T00:00:00-01:00",
  ];
  for (const [i, at] of timestamps.entries())
    store.event({
      id: "time:" + i,
      at,
      type: "external_forward",
      source: "1099511627776",
      target: "2199023255552",
      amountMsat: "1",
      feeMsat: "0",
      details: {},
    });
  const query: any = {
    section: "corridor_events",
    source: "1x0x0",
    target: "2x0x0",
    start: "2026-10-09T02:00:00+02:00",
    end: "2026-10-09T00:00:02.000Z",
  };
  const source: any = evidenceSource(store, query);
  assert.equal(source.corridor_events.length, 3);
  const page: any = views.page("time", source, query);
  assert.equal(page.total, 3);
  const continuation: any = views.page(
    "time",
    {},
    {
      end: "2026-10-09T02:00:02+02:00",
      start: "2026-10-09T00:00:00Z",
      target: "2199023255552",
      source: "1099511627776",
      section: "corridor_events",
      cursor: page.cursor,
      offset: 1,
    },
  );
  assert.equal(continuation.rows.length, 2);
  assert.equal(continuation.cursor, page.cursor);
  assert.throws(() => evidenceSource(store, { ...query, start: "bad" }));
  views.release("time");
  store.close();
});
test("coalesced public text cannot regress after elapsed-window direct write and final flush", () => {
  const store = new Store(":memory:"),
    q = new Queue(store),
    events = new UiEvents(store),
    j = q.enqueue({
      requestId: "coalescing-regression",
      kind: "chat",
      payload: { message: "test" },
    }),
    projection = new ConversationProjection(events, j.id, 80);
  const original = Date.now;
  let at = 1000;
  Date.now = () => at;
  try {
    projection.accept({
      type: "message_start",
      message: { role: "assistant", content: [{ type: "text", text: "A" }] },
    } as any);
    at = 1010;
    projection.accept({
      type: "message_update",
      changes: [{ type: "text_delta", contentIndex: 0, delta: "B" }],
    } as any);
    at = 1085;
    projection.accept({
      type: "message_update",
      changes: [{ type: "text_delta", contentIndex: 0, delta: "C" }],
    } as any);
    projection.flush();
    const texts = store
      .all(
        "SELECT data FROM ui_events WHERE job_id=? AND type='text' ORDER BY id",
        j.id,
      )
      .map((r) => JSON.parse(r.data).text);
    assert.deepEqual(texts, ["A", "ABC"]);
  } finally {
    Date.now = original;
    projection.flush();
    store.close();
  }
});
