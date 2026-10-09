import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store.js";
import { Queue } from "../queue.js";
import { Agent } from "../agent.js";
import { FollowUps } from "../follow-up.js";
import { ReviewWaits } from "../review-waits.js";
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
for (const scenario of [
  "early_wait",
  "early_no_wait",
  "insistent_finance",
  "duplicate_closure",
  "hard",
  "invalid_loop",
  "threshold",
  "analyst_threshold",
  "soft",
  "early_unregistered",
  "invalid",
  "registered_failure",
  "qualification",
  "general",
  "unknown",
])
  test("actual Harness economic closure: " + scenario, async () => {
    const dir = mkdtempSync(join(tmpdir(), "followup-")),
      store = new Store(join(dir, "op.sqlite")),
      queue = new Queue(store);
    store.set("bootstrapReady", true);
    store.set("model", "gpt-6.1-sol");
    const provider = openaiProvider();
    let requests = 0,
      effects = 0;
    const payloads: any[] = [];
    const analyst = scenario === "analyst_threshold";
    const closureName = "follow_up_outcome" + (analyst ? "_analyst_0" : "");
    const scope = analyst ? "a->b" : "node";
    const threshold = analyst ? 12 : 16;
    const dueAt = new Date(Date.now() + 48 * 3600000).toISOString();
    provider.streamSimple = (model, transcript, options) => {
      if (scenario === "early_no_wait") {
        assert.equal(
          options?.reasoning,
          "low",
          "actual provider receives pinned reasoning effort",
        );
        assert.equal(
          model.id,
          "gpt-6.1-sol",
          "actual Harness uses admitted model after preference change",
        );
      }
      const request = ++requests,
        stream = createAssistantMessageEventStream();
      queueMicrotask(async () => {
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
        if (scenario === "registered_failure" && request > 1) {
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
              errorMessage: "fixture final failure",
            },
          });
          return;
        }
        if (scenario === "hard") await new Promise((r) => setTimeout(r, 80));
        let content: any[];
        if (
          scenario === "early_unregistered" ||
          scenario === "hard" ||
          (scenario === "invalid" && request > 1) ||
          (scenario !== "invalid_loop" &&
            request >
              ([
                "threshold",
                "analyst_threshold",
                "insistent_finance",
                "duplicate_closure",
              ].includes(scenario)
                ? 2
                : 1))
        )
          content = [
            {
              type: "text",
              text: "Attendere48h in prosa non costituisce registrazione.",
            },
          ];
        else if (scenario === "duplicate_closure" && request === 2)
          content = Array.from({ length: 40 }, (_, i) => ({
            type: "toolCall",
            id: "duplicate" + i,
            name: closureName,
            arguments: {
              outcome: "wait",
              scope,
              dueAt,
              evidenceIds: [],
              missing: [],
            },
          }));
        else if (scenario === "insistent_finance" && request === 2)
          content = [
            {
              type: "toolCall",
              id: "late-finance",
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
          ];
        else if (
          ["threshold", "analyst_threshold"].includes(scenario) &&
          request === 1
        )
          content = Array.from({ length: threshold }, (_, i) => ({
            type: "toolCall",
            id: "research" + i,
            name: "node_state" + (analyst ? "_analyst_0" : ""),
            arguments: {},
          }));
        else
          content = [
            {
              type: "toolCall",
              id: "closure" + request,
              name: closureName,
              arguments: {
                outcome: scenario === "early_no_wait" ? "no_wait" : "wait",
                scope,
                dueAt: ["invalid", "invalid_loop"].includes(scenario)
                  ? "invalid"
                  : dueAt,
                evidenceIds: ["fixture"],
                missing: ["comparable demand"],
              },
            },
          ];
        const message: any = {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: Date.now(),
          usage,
          stopReason: content[0].type === "toolCall" ? "toolUse" : "stop",
          content,
        };
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
      queue,
      provider,
    );
    agent.credentials.read = async () => ({ type: "oauth" }) as any;
    try {
      await agent.open();
      const purpose =
        scenario === "qualification"
          ? "qualification"
          : scenario === "general"
            ? "general"
            : scenario === "unknown"
              ? undefined
              : "economic";
      if (scenario === "early_no_wait") store.set("thinkingLevel", "low");
      const admitted = queue.enqueue({
        requestId: "closure-test",
        kind: analyst ? "analysis" : "chat",
        scope,
        origin:
          purpose === "qualification"
            ? "qualification"
            : purpose === undefined
              ? undefined
              : "owner",
        purpose,
        payload: { message: "fixture" },
      });
      if (scenario === "early_no_wait") {
        store.set("model", "invalid-new-selection");
        store.set("thinkingLevel", "high");
      }
      if (["soft", "hard"].includes(scenario))
        store.set("runBudget:" + admitted.id, {
          started: Date.now(),
          calls: 0,
          phase: "research",
          reason: null,
          hardMs: scenario === "hard" ? 20 : 180000,
          softMs: 0,
          researchCalls: 16,
        });
      const job = queue.claim(analyst ? "analyst" : "coordinator", "test")!;
      if (
        [
          "registered_failure",
          "hard",
          "invalid_loop",
          "duplicate_closure",
        ].includes(scenario)
      )
        await assert.rejects(agent.runJob(job, analyst ? 0 : undefined));
      else {
        const final = await agent.runJob(job, analyst ? 0 : undefined);
        if (scenario === "early_no_wait")
          assert.equal(final.thinkingLevel, "low");
      }
      const outcomes = new FollowUps(store),
        outcome = outcomes.get(job.id),
        economic = purpose === "economic";
      assert.equal(effects, 0);
      assert.equal(queue.get(job.id)!.submitted, 1);
      if (!["soft", "hard"].includes(scenario))
        assert.equal(
          store.get<any>("runBudget:" + job.id).softMs,
          purpose === "economic" ? 60000 : 120000,
        );
      if (!economic) {
        assert.equal(outcome, undefined);
        assert.equal(new ReviewWaits(store).all().length, 0);
      } else {
        assert.equal(payloads[0].tool_choice, "required");
        assert.ok(payloads[0].tools.some((t: any) => t.name === closureName));
        if (
          ["early_unregistered", "invalid", "hard", "invalid_loop"].includes(
            scenario,
          )
        ) {
          assert.equal(outcome.outcome, "unregistered");
          assert.equal(outcome.provenance, "policy");
          assert.equal(
            outcome.dueAt,
            null,
          );
          assert.doesNotMatch(JSON.stringify(outcome), /48h/);
        } else {
          assert.equal(
            outcome.outcome,
            scenario === "early_no_wait" ? "no_wait" : "wait",
          );
          assert.equal(
            outcome.dueAt,
            scenario === "early_no_wait" ? null : dueAt,
          );
          if (scenario === "early_no_wait")
            assert.equal(new ReviewWaits(store).all().length, 0);
          assert.equal(payloads.at(-1).tool_choice, "none");
          if (["threshold", "analyst_threshold"].includes(scenario))
            assert.deepEqual(
              payloads[1].tools.map((t: any) => t.name),
              [closureName],
            );
          if (["soft", "hard"].includes(scenario))
            assert.deepEqual(
              payloads[0].tools.map((t: any) => t.name),
              [closureName],
            );
        }
        if (["threshold", "analyst_threshold"].includes(scenario))
          assert.equal(
            store.get<any>("runBudget:" + job.id).calls,
            threshold + 1,
          );
        assert.equal(
          store.one(
            "SELECT count(*) n FROM job_events WHERE job_id=? AND type='follow_up_outcome'",
            job.id,
          ).n,
          1,
        );
        if (scenario === "invalid_loop") assert.ok(requests <= 25);
        const originalSubmission = queue.get(job.id)!.submission_id,
          originalStarted = store.get<any>("runBudget:" + job.id).started,
          requestCount = requests;
        queue.recoverAfterRestart();
        const recovered = queue.claim(
          analyst ? "analyst" : "coordinator",
          "recovery",
        )!;
        // Exercise the terminal original submission after model cooldown, not only the wait gate.
        if (scenario === "registered_failure") (agent as any).cooldown = 0;
        if (
          [
            "registered_failure",
            "hard",
            "invalid_loop",
            "duplicate_closure",
          ].includes(scenario)
        )
          await assert.rejects(
            agent.runJob(recovered, analyst ? 0 : undefined),
          );
        else await agent.runJob(recovered, analyst ? 0 : undefined);
        assert.equal(requests, requestCount);
        assert.equal(queue.get(job.id)!.submission_id, originalSubmission);
        assert.equal(
          store.get<any>("runBudget:" + job.id).started,
          originalStarted,
        );
        assert.deepEqual(outcomes.get(job.id), outcome);
        assert.equal(
          store.one(
            "SELECT count(*) n FROM job_events WHERE job_id=? AND type='follow_up_outcome'",
            job.id,
          ).n,
          1,
        );
      }
    } finally {
      await agent.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
test("explicit agent wait replaces policy due date but fallback never replaces prior explicit evidence/deadline", () => {
  const store = new Store(":memory:"),
    reviews = new ReviewWaits(store);
  const clock = Date.now();
  const policy = reviews.register({
    scope: "s",
    origin: "policy:first",
    dueAt: new Date(clock + 3600000).toISOString(),
    evidenceIds: [],
    missing: ["unregistered"],
  });
  const explicit = reviews.register({
    scope: "s",
    origin: "agent:second",
    dueAt: new Date(clock + 48 * 3600000).toISOString(),
    evidenceIds: ["real"],
    missing: ["demand"],
  });
  assert.notEqual(explicit.dueAt, policy.dueAt);
  const fallback = reviews.register({
    scope: "s",
    origin: "policy:third",
    dueAt: new Date(clock + 3600000).toISOString(),
    evidenceIds: [],
    missing: ["unregistered"],
  });
  assert.deepEqual(fallback, explicit);
  const successor = reviews.register({
    scope: "s",
    origin: "agent:fourth",
    dueAt: new Date(clock + 72 * 3600000).toISOString(),
    evidenceIds: ["new"],
    missing: ["more"],
  });
  assert.equal(successor.dueAt, explicit.dueAt);
  store.close();
});

import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
for (const changedPreference of ["invalid-current-model", "gpt-6-luna"])
  test(
    `actual Harness legacy in-flight original model survives ${changedPreference} without pin`,
    { timeout: 10000 },
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "legacy-closure-")),
        store = new Store(join(dir, "op.sqlite")),
        queue = new Queue(store);
      store.set("bootstrapReady", true);
      store.set("model", "gpt-6.1-sol");
      const provider = openaiProvider();
      let requests = 0,
        effects = 0,
        release: () => void = () => {};
      const payloads: any[] = [];
      provider.streamSimple = (model, transcript, options) => {
        assert.equal(model.id, "gpt-6.1-sol");
        assert.equal(options?.reasoning, "low");
        const request = ++requests,
          stream = createAssistantMessageEventStream();
        const emit = async () => {
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
          const content =
            request === 1
              ? [
                  {
                    type: "toolCall",
                    id: "original-research",
                    name: "node_state",
                    arguments: {},
                  },
                ]
              : [{ type: "text", text: "Original legacy answer" }];
          const message: any = {
            role: "assistant",
            api: model.api,
            provider: model.provider,
            model: model.id,
            timestamp: Date.now(),
            usage,
            stopReason: request === 1 ? "toolUse" : "stop",
            content,
          };
          stream.push({ type: "start", partial: message });
          stream.push({ type: "done", reason: message.stopReason, message });
        };
        if (request === 1) release = () => void emit();
        else queueMicrotask(() => void emit());
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
      const releaseDeadline = setTimeout(() => release(), 5000);
      try {
        await agent.open();
        const admitted = queue.enqueue({
            requestId: "old-original",
            kind: "chat",
            origin: "owner",
            purpose: "economic",
            payload: { message: "original pre-upgrade input" },
          }),
          claimed = queue.claim("coordinator", "legacy-owner")!;
        const started = Date.now() - 5000;
        store.set("runBudget:" + admitted.id, {
          started,
          calls: 2,
          phase: "research",
          reason: null,
          hardMs: 180000,
          softMs: 120000,
          researchCalls: 16,
        });
        const harness = (agent as any).harness;
        const conversation = await harness.createConversation(
          {
            ownership: { kind: "ownerless" },
            agent: {
              model: { provider: "openai", modelId: "gpt-6.1-sol" },
              thinkingLevel: "low",
              extensions: [{ name: "satssurge" }],
              tools: [{ name: "node_state" }],
            },
          },
          context,
        );
        queue.bindConversation(
          claimed.id,
          claimed.run_token!,
          String(conversation.id),
        );
        const submission = await conversation.submit(
          {
            type: "input",
            content: "original pre-upgrade input",
            requestId: claimed.request_id,
            whenBusy: "reject",
          },
          context,
        );
        queue.markSubmitted(
          claimed.id,
          claimed.run_token!,
          String(submission.id),
        );
        for (let i = 0; i < 100 && requests === 0; i++)
          await new Promise((r) => setTimeout(r, 1));
        assert.equal(requests, 1);
        store.run("DELETE FROM meta WHERE key=?", `jobModel:${claimed.id}`);
        store.set("model", changedPreference);
        store.set("thinkingLevel", "high");
        const run = agent.runJob(queue.get(claimed.id)!);
        for (let i = 0; i < 100 && (agent as any).sessions.size === 0; i++)
          await new Promise((r) => setTimeout(r, 1));
        assert.equal((agent as any).sessions.size, 1);
        release();
        const result: any = await run;
        assert.equal(result.answer, "Original legacy answer");
        assert.equal(result.model, "gpt-6.1-sol");
        assert.equal(result.thinkingLevel, "low");
        assert.equal(requests, 2);
        assert.equal(effects, 0);
        assert.equal(payloads[1].tool_choice, "none");
        assert.equal(
          payloads[1].tools.some((t: any) => t.name === "follow_up_outcome"),
          false,
        );
        const outcome = new FollowUps(store).get(claimed.id);
        assert.equal(outcome.provenance, "policy");
        assert.equal(
          outcome.cause,
          "closure_tool_unavailable_in_original_context",
        );
        assert.equal(
          outcome.dueAt,
          null,
        );
        assert.equal(
          queue.get(claimed.id)!.submission_id,
          String(submission.id),
        );
        assert.equal(queue.get(claimed.id)!.submitted, 1);
        assert.equal(
          store.get<any>("runBudget:" + claimed.id).started,
          started,
        );
        queue.recoverAfterRestart();
        const recovered = queue.claim("coordinator", "new-owner")!;
        await agent.runJob(recovered);
        assert.equal(requests, 2);
        assert.deepEqual(new FollowUps(store).get(claimed.id), outcome);
      } finally {
        clearTimeout(releaseDeadline);
        release();
        await agent.close();
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
