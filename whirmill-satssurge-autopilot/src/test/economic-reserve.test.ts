import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store.js";
import { Queue } from "../queue.js";
import { RunBudget } from "../run-budget.js";
import { Agent } from "../agent.js";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { getDeclaredTools } from "@earendil-works/pi-ai/utils/transcript";
const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
test("economic policy reserves120s for closure/final while persisted120s policy/start and absolute caps remain immutable", () => {
  const store = new Store(":memory:");
  let clock = 1000;
  const fresh = new RunBudget(store, "fresh", false, () => clock, {
    economic: true,
  });
  assert.equal(fresh.status().softMs, 60000);
  assert.equal(fresh.status().hardMs, 180000);
  clock += 60000;
  assert.equal(fresh.status().phase, "finalization");
  assert.equal(fresh.status().remainingMs, 120000);
  const old = new RunBudget(store, "old", true, () => clock);
  const before = old.status();
  clock += 61000;
  const recovered = new RunBudget(store, "old", true, () => clock, {
    economic: true,
  });
  assert.equal(recovered.status().started, before.started);
  assert.equal(recovered.status().softMs, 120000);
  assert.equal(recovered.status().phase, "research");
  assert.equal(recovered.status().researchCalls, 12);
  for (let i = 0; i < 24; i++) assert.equal(recovered.call(), true);
  assert.equal(recovered.call(), false);
  store.close();
});
test("phase telemetry whitelists bounded public metadata across recoveries without storing payloads", () => {
  const store = new Store(":memory:"),
    queue = new Queue(store);
  const job = queue.enqueue({
    requestId: "metrics-bound",
    kind: "chat",
    payload: { message: "PRIVATE_PROMPT" },
  });
  const budget = new RunBudget(store, job.id, false);
  for (let i = 0; i < 120; i++)
    budget.phase("request_start", {
      phase: "research",
      model: "sol",
      effort: "high",
      toolChoice: "required",
      toolNames: Array.from({ length: 30 }, (_, j) => "node_state_" + j),
      prompt: "PRIVATE_PROMPT",
      arguments: "PRIVATE_ARGS",
      encrypted: "PRIVATE_ENCRYPTED",
    } as any);
  const rows = store.all(
    "SELECT details FROM job_events WHERE job_id=? AND type='run_phase'",
    job.id,
  );
  assert.equal(rows.length, 96);
  assert.equal(
    new RunBudget(store, job.id, false).phase("hard_abort"),
    undefined,
  );
  const first = JSON.parse(rows[0].details);
  assert.equal(first.toolCount, 30);
  assert.equal(first.toolNames.length, 24);
  assert.equal(first.toolNamesTruncated, true);
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE/);
  store.close();
});
for (const legacy of [false, true])
  test(
    `actual Harness delayed research/closure/final keeps original180s submission and ${legacy ? "persisted120" : "economic60"} soft policy`,
    { timeout: 10000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "economic-reserve-")),
        store = new Store(join(dir, "op.sqlite")),
        queue = new Queue(store);
      store.set("bootstrapReady", true);
      store.set("model", "gpt-6.1-sol");
      const provider = openaiProvider();
      let requests = 0,
        effects = 0;
      const seen: any[] = [];
      provider.streamSimple = (model, transcript, options) => {
        const request = ++requests,
          stream = createAssistantMessageEventStream();
        void (async () => {
          const payload: any = await options!.onPayload!(
            {
              tools: getDeclaredTools(transcript.messages).map((t) => ({
                ...t,
                type: "function",
              })),
              tool_choice: "auto",
            },
            model,
          );
          seen.push(payload);
          await new Promise((r) => setTimeout(r, request === 1 ? 45 : 35));
          const content =
            request === 1
              ? [
                  {
                    type: "toolCall",
                    id: "research",
                    name: "node_state",
                    arguments: {},
                  },
                ]
              : request === 2
                ? [
                    {
                      type: "toolCall",
                      id: "closure",
                      name: "follow_up_outcome",
                      arguments: {
                        outcome: "wait",
                        scope: "node",
                        dueAt: new Date(Date.now() + 3600000).toISOString(),
                        evidenceIds: [],
                        missing: [],
                      },
                    },
                  ]
                : [{ type: "text", text: "Completed after reserved closure." }];
          if (request === 3)
            await options?.onProviderStreamEvent?.(
              {
                type: "response.output_text.delta",
                delta: "PRIVATE_NOT_TELEMETRY",
              },
              model,
            );
          await options?.onProviderStreamEvent?.(
            { type: "response.completed" },
            model,
          );
          const message: any = {
            role: "assistant",
            api: model.api,
            provider: model.provider,
            model: model.id,
            timestamp: Date.now(),
            usage,
            content,
            stopReason: request === 3 ? "stop" : "toolUse",
          };
          stream.push({ type: "start", partial: message });
          stream.push({ type: "done", reason: message.stopReason, message });
        })().catch((error) => {
          stream.push({
            type: "error",
            reason: "error",
            error: {
              role: "assistant",
              content: [],
              api: model.api,
              provider: model.provider,
              model: model.id,
              timestamp: Date.now(),
              usage,
              stopReason: "error",
              errorMessage: String(error),
            },
          } as any);
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
        queue,
        provider,
      );
      agent.credentials.read = async () => ({ type: "oauth" }) as any;
      try {
        await agent.open();
        const admitted = queue.enqueue({
          requestId: "economic-delayed",
          kind: "chat",
          origin: "owner",
          purpose: "economic",
          payload: { message: "PRIVATE_ORIGINAL" },
        });
        const started = Date.now() - 59990;
        new RunBudget(store, admitted.id, false, () => started, {
          economic: !legacy,
        });
        const job = queue.claim("coordinator", "test")!,
          result: any = await agent.runJob(job);
        assert.equal(result.answer, "Completed after reserved closure.");
        assert.equal(requests, 3);
        assert.equal(effects, 0);
        assert.equal(queue.get(job.id)!.submitted, 1);
        assert.equal(result.budget.started, started);
        assert.equal(result.budget.hardMs, 180000);
        assert.equal(result.budget.softMs, legacy ? 120000 : 60000);
        assert.equal(seen[1].tool_choice, "required");
        assert.equal(seen[2].tool_choice, "none");
        if (!legacy)
          assert.deepEqual(
            seen[1].tools.map((t: any) => t.name),
            ["follow_up_outcome"],
          );
        else assert.ok(seen[1].tools.length > 1);
        const metrics = store
          .all(
            "SELECT details FROM job_events WHERE job_id=? AND type='run_phase'",
            job.id,
          )
          .map((row) => JSON.parse(row.details));
        assert.equal(
          metrics.filter((m) => m.stage === "request_start").length,
          3,
        );
        assert.equal(
          metrics.filter((m) => m.stage === "closure_registered").length,
          1,
        );
        assert.equal(
          metrics.filter((m) => m.stage === "response_finish").length,
          3,
        );
        assert.equal(
          metrics.filter((m) => m.stage === "public_first_text").length,
          1,
        );
        assert.equal(
          metrics.find(
            (m) => m.stage === "request_start" && m.toolChoice === "none",
          ).phase,
          "finalization",
        );
        assert.doesNotMatch(
          JSON.stringify(metrics),
          /PRIVATE|arguments|encrypted|signature/,
        );
        assert.equal(result.followUpOutcome.provenance, "agent");
        assert.ok(result.budget.remainingMs > 110000);
      } finally {
        await agent.close();
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

test(
  "actual Harness async payload hook crossing soft boundary labels its final closure-only request",
  { timeout: 10000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "economic-hook-boundary-")),
      store = new Store(join(dir, "op.sqlite")),
      queue = new Queue(store);
    store.set("bootstrapReady", true);
    store.set("model", "gpt-6.1-sol");
    const provider = openaiProvider();
    let requests = 0,
      effects = 0;
    const payloads: any[] = [];
    const originalNow = Date.now;
    let clock = originalNow();
    Date.now = () => clock;
    provider.streamSimple = (model, transcript, options) => {
      const stream = createAssistantMessageEventStream(),
        request = ++requests;
      void (async () => {
        const payload: any = await options!.onPayload!(
          {
            tools: getDeclaredTools(transcript.messages).map((t) => ({
              ...t,
              type: "function",
            })),
            tool_choice: "auto",
          },
          model,
        );
        payloads.push(payload);
        const message: any = {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: clock,
          usage,
          stopReason: request === 1 ? "toolUse" : "stop",
          content:
            request === 1
              ? [
                  {
                    type: "toolCall",
                    id: "closure-after-hook",
                    name: "follow_up_outcome",
                    arguments: {
                      outcome: "wait",
                      scope: "node",
                      dueAt: new Date(clock + 3600000).toISOString(),
                      evidenceIds: [],
                      missing: [],
                    },
                  },
                ]
              : [{ type: "text", text: "Completed with truthful phase." }],
        };
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: message.stopReason, message });
      })().catch((error) =>
        stream.push({
          type: "error",
          reason: "error",
          error: {
            role: "assistant",
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            timestamp: clock,
            usage,
            stopReason: "error",
            errorMessage: String(error),
          },
        } as any),
      );
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
      queue,
      provider,
    );
    agent.credentials.read = async () => ({ type: "oauth" }) as any;
    const baseStream = agent.models.streamSimple.bind(agent.models);
    let jobId = "";
    agent.models.streamSimple = (model, transcript, options) =>
      baseStream(model, transcript, {
        ...options,
        onPayload: async (payload) => {
          if (requests === 1) {
            assert.equal(
              new RunBudget(store, jobId, false).status().phase,
              "research",
            );
            await Promise.resolve();
            clock += 60000;
          }
          return payload;
        },
      });
    try {
      await agent.open();
      const admitted = queue.enqueue({
        requestId: "hook-crossing",
        kind: "chat",
        origin: "owner",
        purpose: "economic",
        payload: { message: "fixture" },
      });
      jobId = admitted.id;
      const job = queue.claim("coordinator", "test")!,
        result: any = await agent.runJob(job);
      assert.equal(result.answer, "Completed with truthful phase.");
      assert.equal(requests, 2);
      assert.equal(effects, 0);
      assert.deepEqual(
        payloads[0].tools.map((t: any) => t.name),
        ["follow_up_outcome"],
      );
      const phases = store
        .all(
          "SELECT details FROM job_events WHERE job_id=? AND type='run_phase'",
          job.id,
        )
        .map((row) => JSON.parse(row.details));
      assert.equal(
        phases.find((phase) => phase.stage === "request_start").phase,
        "closure",
      );
      assert.equal(
        phases.find((phase) => phase.stage === "request_start").elapsedMs,
        60000,
      );
      assert.equal(
        phases.filter((phase) => phase.stage === "request_start").at(-1).phase,
        "finalization",
      );
      assert.equal(result.budget.hardMs, 180000);
      assert.equal(queue.get(job.id)!.submitted, 1);
    } finally {
      Date.now = originalNow;
      await agent.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
