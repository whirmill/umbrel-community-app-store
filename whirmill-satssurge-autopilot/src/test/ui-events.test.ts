import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../store.js";
import { Queue } from "../queue.js";
import { UiEvents, ConversationProjection, bounded } from "../ui-events.js";
import { fixture } from "./pi-fixture.js";
const message = (text: string) => ({
  role: "assistant",
  content: [
    { type: "thinking", thinking: "NEVER-PUBLIC", signature: "private" },
    { type: "text", text },
  ],
});
function setup() {
  const store = new Store(":memory:"),
    q = new Queue(store),
    job = q.enqueue({
      requestId: "public:test",
      kind: "chat",
      payload: { message: "Read only" },
    }),
    events = new UiEvents(store);
  return {
    store,
    q,
    job,
    events,
    projection: new ConversationProjection(events, job.id),
  };
}
test("first committed partial includes prefix, subsequent delta streams and long texts retain exact public shape", () => {
  const { events, projection, store } = setup();
  projection.accept({
    type: "message_start",
    message: message("prefix "),
  } as any);
  projection.accept({
    type: "message_update",
    changes: [
      { type: "text_delta", contentIndex: 1, delta: "next" },
      { type: "thinking_delta", contentIndex: 0, delta: "hidden" },
    ],
  } as any);
  assert.equal(
    events
      .after(0)
      .filter((e) => e.type === "text")
      .at(-1).data.text,
    "prefix next",
  );
  const text = "à🙂".repeat(20000);
  projection.accept({
    type: "message_end",
    entry: { id: 11, model: [message(text)] },
  } as any);
  const stream = events
    .after(0)
    .filter((e) => e.type === "text")
    .at(-1);
  assert.equal(stream.data.text, text);
  assert.doesNotMatch(
    JSON.stringify(events.after(0)),
    /NEVER-PUBLIC|signature|hidden/,
  );
  store.close();
});
test("restart and compacted snapshots merge immutable entry IDs and recover tool identity/results", () => {
  const { store, events, job, projection } = setup();
  projection.accept({
    type: "message_end",
    entry: { id: 10, model: [message("Prior full history")] },
  } as any);
  const restarted = new ConversationProjection(events, job.id);
  const snapshot: any = {
    type: "snapshot",
    entries: [
      {
        id: 20,
        model: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "After compaction" },
              {
                type: "toolCall",
                id: "call1",
                name: "node_state",
                arguments: { password: "private", query: "read" },
              },
            ],
          },
        ],
      },
      {
        id: 21,
        model: [
          {
            role: "toolResult",
            toolCallId: "call1",
            toolName: "node_state",
            content: [{ type: "text", text: '{"secret":"private","ok":true}' }],
          },
        ],
      },
    ],
    tools: [{ callId: "active", name: "state_page", status: "running" }],
  };
  restarted.accept(snapshot);
  restarted.accept(snapshot);
  const rows = events.after(0);
  assert.equal(
    rows.filter((e) => e.type === "tool_call" && e.data.toolCallId === "call1")
      .length,
    1,
  );
  assert.equal(rows.filter((e) => e.type === "tool_result").length, 1);
  assert.equal(
    rows.filter((e) => e.type === "text").at(-1).data.text,
    "Prior full history\n\nAfter compaction",
  );
  assert.equal(
    rows.find((e) => e.data.toolCallId === "active").data.argsAvailable,
    false,
  );
  assert.doesNotMatch(JSON.stringify(rows), /private/);
  store.close();
});
test("queue terminal events, replay cursor and cancellation remain authoritative", () => {
  const { store, q, job, events } = setup();
  store.set("bootstrapReady", true);
  const claimed = q.claim("coordinator", "test")!;
  q.finish(job.id, claimed.run_token!, "completed", { answer: "done" });
  assert.equal(events.after(0).at(-1).data.state, "completed");
  const cursor = events.cursor();
  assert.deepEqual(events.after(cursor), []);
  assert.equal(q.cancel(job.id), false);
  store.close();
});
test("actual Pi watcher records public final text and safe read-only tool receipt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "surge-public-"));
  const f = fixture(dir, "state");
  try {
    await f.agent.open();
    f.queue.enqueue({
      requestId: "pi-public",
      kind: "analysis",
      payload: { message: "read competition" },
    });
    const job = f.queue.claim("analyst", "test")!;
    await f.agent.runJob(job, 0);
    const events = new UiEvents(f.store).after(0);
    assert.ok(
      events.some(
        (e) =>
          e.type === "tool_call" && e.data.toolName === "state_page_analyst_0",
      ),
    );
    assert.ok(
      events.some((e) => e.type === "tool_result" && !e.data.unavailable),
    );
    assert.ok(events.some((e) => e.type === "text"));
    assert.equal(f.store.one("SELECT count(*) n FROM operations").n, 0);
  } finally {
    await f.agent.close();
    f.store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("bounded untrusted tool output is explicit and never adds executable markup", () => {
  const v = bounded({
    html: "<script>untrusted</script>",
    secret: "secret",
  }) as any;
  assert.equal(v.html, "<script>untrusted</script>");
  assert.equal(v.secret, undefined);
  assert.equal((bounded("x".repeat(30000)) as any).truncated, true);
});

test("text redacts credential patterns and repeated revisions recover the newest state", () => {
  const { events, projection, store, job } = setup();
  projection.accept({ type: "message_start", message: message("A") } as any);
  projection.accept({
    type: "message_update",
    changes: [{ type: "text_delta", contentIndex: 1, delta: "B" }],
  } as any);
  projection.accept({
    type: "snapshot",
    entries: [],
    tools: [],
    generation: { message: message("A") },
  } as any);
  assert.equal(
    events
      .after(0)
      .filter((e) => e.type === "text")
      .at(-1).data.text,
    "A",
  );
  const restored = new ConversationProjection(events, job.id);
  restored.accept({ type: "message_start", message: message("A") } as any);
  assert.equal(events.after(0).filter((e) => e.type === "text").length, 3);
  events.append(job.id, "text", {
    text: "sk-testcredential ghp_testcredential nsec1testcredential",
  });
  assert.doesNotMatch(JSON.stringify(events.after(0)), /testcredential/);
  store.close();
});
