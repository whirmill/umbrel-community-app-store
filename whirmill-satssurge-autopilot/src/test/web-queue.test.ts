import { test } from "node:test";
import assert from "node:assert/strict";
import {
  answerFor,
  canCancel,
  expireSession,
  mergeEvents,
  mergeJobs,
  mergeHistory,
  messageStatus,
  pendingSubmission,
  pendingKey,
  requestHeaders,
  safeUrl,
  sats,
  sseFrames,
  type Projection,
} from "../ui-client.js";
const empty = (): Projection => ({ jobs: {}, events: [], cursor: 0 });
function storage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => {
      m.set(k, v);
    },
    removeItem: (k: string) => {
      m.delete(k);
    },
  };
}
test("browser persists receipt before admission and recovers same id after reload or ambiguous response", () => {
  const s = storage(),
    p = pendingSubmission(
      s,
      "Analizza le rotte",
      "analysis",
      () => "owner:first",
    );
  assert.equal(JSON.parse(s.getItem(pendingKey)!).requestId, p.requestId);
  const reload = pendingSubmission(
    s,
    "Analizza le rotte",
    "analysis",
    () => "owner:second",
  );
  assert.deepEqual(reload, p);
  assert.throws(
    () => pendingSubmission(s, "Altra richiesta", "chat", () => "owner:third"),
    /precedente/,
  );
  s.removeItem(pendingKey);
  assert.equal(
    pendingSubmission(s, "Nuova richiesta", "chat", () => "owner:fourth")
      .requestId,
    "owner:fourth",
  );
});
test("stream replay deduplicates ids, uses cumulative snapshots and retains terminal receipt", () => {
  let p = mergeJobs(empty(), [
    {
      id: "a",
      kind: "analysis",
      state: "running",
      payload: '{"message":"hello"}',
      updated_at: "2026-01-01T00:00:00Z",
    },
  ]);
  const e = {
    id: 1,
    job_id: "a",
    at: "2026-01-01T00:00:01Z",
    type: "text",
    data: { text: "One" },
  };
  p = mergeEvents(p, [e, e, { ...e, id: 2, data: { text: "One two" } }]);
  assert.equal(p.events.length, 2);
  assert.equal(p.cursor, 2);
  assert.equal(answerFor(p, "a"), "One two");
  p = mergeJobs(p, [
    {
      ...p.jobs.a!,
      state: "completed",
      result: '{"answer":"Final"}',
      updated_at: "2026-01-01T00:00:10Z",
    },
  ]);
  p = mergeEvents(p, [
    { ...e, id: 3, type: "job", data: { state: "running" } },
  ]);
  assert.equal(p.jobs.a!.state, "completed");
  assert.equal(answerFor(p, "a"), "Final");
});
test("history pagination does not advance live cursor; newer job events update terminal state", () => {
  let p = mergeJobs({ ...empty(), cursor: 90 }, [
    {
      id: "a",
      kind: "chat",
      state: "queued",
      updated_at: "2026-01-01T00:00:00Z",
    },
  ]);
  p = mergeEvents(
    p,
    [
      {
        id: 12,
        job_id: "a",
        at: "2026-01-01T00:00:01Z",
        type: "text",
        data: { text: "older" },
      },
    ],
    false,
  );
  assert.equal(p.cursor, 90);
  p = mergeEvents(p, [
    {
      id: 91,
      job_id: "a",
      at: "2026-01-01T00:00:03Z",
      type: "job",
      data: { state: "cancelled" },
    },
  ]);
  assert.equal(p.jobs.a!.state, "cancelled");
  assert.equal(p.cursor, 91);
  p = mergeEvents(p, [
    {
      id: 92,
      job_id: "new",
      at: "now",
      type: "job",
      data: { state: "queued" },
    },
  ]);
  assert.equal(p.jobs.new, undefined);
  assert.equal(p.events.at(-1)!.job_id, "new");
});
test("owner session expiration is race safe and headers retain same-origin bearer + CSRF contract", () => {
  const s = storage();
  s.setItem("satssurge.ownerSession", "new-token");
  expireSession(s, "old-token");
  assert.equal(s.getItem("satssurge.ownerSession"), "new-token");
  assert.deepEqual(requestHeaders("owner", "csrf"), {
    Authorization: "Bearer owner",
    "Content-Type": "application/json",
    "X-CSRF-Token": "csrf",
  });
  assert.deepEqual(requestHeaders("owner"), { Authorization: "Bearer owner" });
  expireSession(s, "new-token");
  assert.equal(s.getItem("satssurge.ownerSession"), null);
});
test("SSE parser preserves split frames, CRLF, heartbeat and exactly-once application", () => {
  const e = {
    id: 1,
    job_id: "a",
    type: "text",
    at: "now",
    data: { text: "è bene" },
  };
  const wire =
    ": heartbeat\r\n\r\nid: 1\r\nevent: update\r\ndata: " +
    JSON.stringify(e) +
    "\r\n\r\n";
  const first = sseFrames(wire.slice(0, -5));
  assert.equal(first.frames.length, 0);
  const last = sseFrames(first.rest + wire.slice(-5));
  assert.deepEqual(last.frames, [e]);
  assert.equal(last.rest, "");
});
test("cancellation is available only while queued or waiting before financial submission", () => {
  for (const state of ["running", "completed", "failed", "cancelled"])
    assert.equal(canCancel({ id: "a", kind: "chat", state }), false);
  assert.equal(canCancel({ id: "a", kind: "chat", state: "queued" }), true);
  assert.equal(
    canCancel({ id: "a", kind: "chat", state: "waiting", submitted: 0 }),
    true,
  );
  assert.equal(
    canCancel({ id: "a", kind: "chat", state: "waiting", submitted: 1 }),
    false,
  );
});
test("render helpers preserve precision and reject executable links", () => {
  assert.equal(sats("9007199254740993003"), "9.007.199.254.740.993,003");
  assert.equal(sats("-1378000"), "−1.378");
  assert.equal(sats("unknown"), "sconosciuto");
  for (const u of [
    "javascript:alert(1)",
    "data:text/html,x",
    "file:///etc/passwd",
    "//unknown.example",
  ])
    assert.equal(safeUrl(u), undefined);
  assert.equal(safeUrl("https://example.com/path"), "https://example.com/path");
});

test("legacy conversation stays visible until the corresponding durable receipt is loaded", () => {
  let p = mergeHistory(
    empty(),
    {
      cursor: 5,
      jobs: [],
      events: [],
      legacyChat: [
        { requestId: "old", at: "2026-01-01", user: "Hi", answer: "Answer" },
      ],
    },
    true,
  );
  assert.equal(Object.values(p.jobs).length, 1);
  assert.equal(answerFor(p, "legacy:old"), "Answer");
  assert.equal(p.cursor, 5);
  p = mergeHistory(p, {
    cursor: 6,
    jobs: [
      {
        id: "real",
        request_id: "old",
        kind: "chat",
        state: "completed",
        payload: '{"message":"Hi"}',
        result: '{"answer":"Answer"}',
      },
    ],
    events: [],
    legacyChat: [{ requestId: "old", user: "Hi", answer: "Answer" }],
  });
  assert.equal(Object.values(p.jobs).length, 1);
  assert.equal(p.jobs.real?.state, "completed");
  assert.equal(p.cursor, 5);
});
test("message runtime accurately represents pending, completed, failed and cancelled jobs", () => {
  const j = { id: "a", kind: "analysis", state: "queued" };
  assert.deepEqual(messageStatus(j), { type: "running" });
  assert.deepEqual(messageStatus({ ...j, state: "completed" }), {
    type: "complete",
    reason: "stop",
  });
  assert.deepEqual(messageStatus({ ...j, state: "failed" }), {
    type: "incomplete",
    reason: "error",
  });
  assert.deepEqual(messageStatus({ ...j, state: "cancelled" }), {
    type: "incomplete",
    reason: "cancelled",
  });
});
test("slow status polling cannot overwrite a more recent terminal receipt", () => {
  let p = mergeJobs(empty(), [
    { id: "a", kind: "chat", state: "completed", updated_at: "2026-01-02" },
  ]);
  p = mergeJobs(p, [
    { id: "a", kind: "chat", state: "running", updated_at: "2026-01-01" },
  ]);
  assert.equal(p.jobs.a?.state, "completed");
});
