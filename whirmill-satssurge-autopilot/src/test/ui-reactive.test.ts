import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Store } from "../store.js";
import { Queue } from "../queue.js";
import { UiEvents, serveUiEvents } from "../ui-events.js";
import { ownerEventStream } from "../ui-stream.js";
import { mergeEvents } from "../ui-client.js";
function fixture() {
  const store = new Store(":memory:"),
    q = new Queue(store);
  const job = q.enqueue({ requestId: "reactive", kind: "chat", payload: {} });
  return { store, job, events: new UiEvents(store) };
}
const pause = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
test("notification is post-COMMIT, coalesced per transaction, duplicate/rollback silent", async () => {
  const { store, job, events } = fixture(),
    controller = new AbortController();
  const stream = events.stream(events.cursor(), controller.signal, {
    heartbeatMs: 10000,
  });
  let reads = 0,
    after = events.after.bind(events);
  events.after = (...args) => {
    reads++;
    assert.equal(store.db.isTransaction, false);
    return after(...args);
  };
  const waiting = stream.next();
  store.tx(() => {
    events.append(job.id, "text", { text: "committed" }, "unique");
    events.append(job.id, "text", { text: "ignored" }, "unique");
    assert.equal(reads, 1);
  });
  assert.deepEqual((await waiting).value, []);
  const batch = (await stream.next()).value!;
  assert.equal(batch.length, 1);
  assert.equal(batch[0].data.text, "committed");
  const waitAgain = stream.next();
  events.append(job.id, "text", { text: "ignored" }, "unique");
  assert.throws(() =>
    store.tx(() => {
      events.append(job.id, "text", { text: "rollback" });
      throw Error("rollback");
    }),
  );
  await pause();
  assert.equal(reads, 3);
  controller.abort();
  await waitAgain;
  assert.equal(events.subscriberCount(), 0);
  store.close();
});
test("subscribe before read and version check recover a write between read and wait; batches replay ordered", async () => {
  const { store, job, events } = fixture(),
    controller = new AbortController(),
    cursor = events.cursor();
  const after = events.after.bind(events);
  let inject = true;
  events.after = (...args) => {
    assert.equal(events.subscriberCount(), 1);
    const batch = after(...args);
    if (inject) {
      inject = false;
      new UiEvents(store).append(job.id, "text", { text: "raced" });
    }
    return batch;
  };
  const stream = events.stream(cursor, controller.signal, {
    batchSize: 2,
    heartbeatMs: 10000,
  });
  assert.deepEqual((await stream.next()).value, []);
  for (let i = 0; i < 4; i++)
    events.append(job.id, "text", { text: String(i) });
  const received = [];
  for (let i = 0; i < 3; i++) received.push(...(await stream.next()).value!);
  assert.equal(received.length, 5);
  assert.deepEqual(
    received.map((e) => e.id),
    after(cursor).map((e) => e.id),
  );
  controller.abort();
  await stream.next();
  assert.equal(events.subscriberCount(), 0);
  store.close();
});
test("heartbeat recovers journal writes without notification and abort stops idle reads", async () => {
  const { store, job, events } = fixture(),
    controller = new AbortController();
  const stream = events.stream(events.cursor(), controller.signal, {
    heartbeatMs: 10,
  });
  const next = stream.next();
  store.run(
    "INSERT INTO ui_events(job_id,at,type,data) VALUES(?,?,?,?)",
    job.id,
    new Date().toISOString(),
    "text",
    '{"text":"missed"}',
  );
  assert.deepEqual((await next).value, []);
  assert.equal((await stream.next()).value![0].data.text, "missed");
  const pending = stream.next();
  controller.abort();
  await pending;
  assert.equal(events.subscriberCount(), 0);
  store.close();
});
class Response extends EventEmitter {
  destroyed = false;
  frames: string[] = [];
  writable = true;
  ended = false;
  write(frame: string) {
    this.frames.push(frame);
    return this.writable;
  }
  end() {
    this.ended = true;
  }
  destroy() {
    this.destroyed = true;
  }
}
test("slow-client drain bounds consumption, timeout releases listeners, expiry closes idle stream", async () => {
  const { store, events } = fixture(),
    controller = new AbortController();
  const slow = new Response();
  slow.writable = false;
  await serveUiEvents(events, slow as any, 0, controller.signal, () => true, {
    drainTimeoutMs: 10,
  });
  assert.equal(slow.frames.length, 1);
  assert.equal(slow.ended, true);
  assert.equal(slow.destroyed, true);
  assert.equal(slow.listenerCount("drain"), 0);
  assert.equal(slow.listenerCount("close"), 0);
  assert.equal(events.subscriberCount(), 0);
  const expired = new Response();
  let valid = true;
  const run = serveUiEvents(
    events,
    expired as any,
    events.cursor(),
    controller.signal,
    () => valid,
    { heartbeatMs: 10 },
  );
  valid = false;
  await run;
  assert.equal(expired.frames.length, 0);
  assert.equal(expired.ended, true);
  assert.equal(events.subscriberCount(), 0);
  const disconnected = new Response();
  const close = serveUiEvents(
    events,
    disconnected as any,
    events.cursor(),
    controller.signal,
    () => true,
  );
  disconnected.emit("close");
  await close;
  assert.equal(events.subscriberCount(), 0);
  store.close();
});
test("post-commit observer errors cannot turn committed actions into retries", () => {
  const { store } = fixture();
  const action = () => {
    store.set("committed", true);
    store.afterCommit(() => {
      throw Error("observer failed");
    });
    return 42;
  };
  assert.equal(store.tx(action), 42);
  assert.equal(store.get("committed"), true);
  store.close();
});
test("frontend fragmented UTF8/CRLF, reconnect cursor and replay dedup, 409 reset and 401 lifecycle", async () => {
  const event = {
    id: 7,
    job_id: "j",
    at: "now",
    type: "text",
    data: { text: "à🙂" },
  };
  const encoded = new TextEncoder().encode(
    "data: " + JSON.stringify(event) + "\r\n\r\n",
  );
  let cancelled = 0,
    call = 0,
    cursor = 0;
  const urls: string[] = [];
  const fakeFetch = (async (url: any, init: any) => {
    urls.push(String(url));
    assert.equal(init.credentials, "same-origin");
    assert.equal(init.headers.Authorization, "Bearer session");
    call++;
    if (call === 3) return new ResponseWeb(null, { status: 409 });
    if (call === 4) return new ResponseWeb(null, { status: 401 });
    let index = 0;
    return new ResponseWeb(
      new ReadableStream({
        pull(controller) {
          if (index < encoded.length)
            controller.enqueue(encoded.slice(index, ++index));
          else controller.close();
        },
        cancel() {
          cancelled++;
        },
      }),
    );
  }) as typeof fetch;
  const signal = new AbortController().signal;
  let projection = { jobs: {}, events: [], cursor: 0 } as any,
    resync = 0,
    expired = 0;
  for await (const update of ownerEventStream({
    session: "session",
    signal,
    cursor: () => cursor,
    fetch: fakeFetch,
    reconnectMs: 1,
  })) {
    if (update.type === "events") {
      projection = mergeEvents(projection, update.events);
      cursor = projection.cursor;
    }
    if (update.type === "resync") {
      resync++;
      cursor = 0;
    }
    if (update.type === "expired") expired++;
  }
  assert.equal(projection.events.length, 1);
  assert.equal(projection.events[0].data.text, "à🙂");
  assert.deepEqual(urls, [
    "/api/events?after=0",
    "/api/events?after=7",
    "/api/events?after=7",
    "/api/events?after=0",
  ]);
  assert.equal(resync, 1);
  assert.equal(expired, 1);
});
const ResponseWeb = globalThis.Response;
test("frontend abort cancels and releases locked reader; oversized incomplete frames reconnect boundedly", async () => {
  const controller = new AbortController();
  let cancelled = 0;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled++;
    },
  });
  const stream = ownerEventStream({
    session: "s",
    signal: controller.signal,
    cursor: () => 0,
    fetch: (async () => new ResponseWeb(body)) as typeof fetch,
  });
  await stream.next();
  await stream.next();
  const read = stream.next();
  controller.abort();
  await read;
  assert.equal(cancelled, 1);
  assert.equal(body.locked, false);
  let calls = 0;
  const overflow = ownerEventStream({
    session: "s",
    signal: new AbortController().signal,
    cursor: () => 0,
    maxBufferChars: 20,
    reconnectMs: 1,
    fetch: (async () => {
      calls++;
      return calls === 1
        ? new ResponseWeb(
            new ReadableStream({
              start(c) {
                c.enqueue(new TextEncoder().encode("x".repeat(21)));
              },
            }),
          )
        : new ResponseWeb(null, { status: 401 });
    }) as typeof fetch,
  });
  const updates = [];
  for await (const update of overflow) updates.push(update.type);
  assert.ok(updates.includes("expired"));
  assert.equal(calls, 2);
});

test("consumer return releases backend subscription and frontend reader without abort", async () => {
  const { store, events } = fixture();
  const backend = events.stream(0, new AbortController().signal);
  await backend.next();
  assert.equal(events.subscriberCount(), 1);
  await backend.return(undefined);
  assert.equal(events.subscriberCount(), 0);
  let cancelled = 0;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled++;
    },
  });
  const frontend = ownerEventStream({
    session: "s",
    signal: new AbortController().signal,
    cursor: () => 0,
    fetch: (async () => new ResponseWeb(body)) as typeof fetch,
  });
  await frontend.next();
  await frontend.next();
  await frontend.return(undefined);
  assert.equal(cancelled, 1);
  assert.equal(body.locked, false);
  store.close();
});
test("transaction callback set coalesces repeated notifications and rollback discards them", () => {
  const { store } = fixture();
  let count = 0;
  const notify = () => {
    count++;
    assert.equal(store.db.isTransaction, false);
  };
  store.tx(() => {
    store.afterCommit(notify);
    store.afterCommit(notify);
    assert.equal(count, 0);
  });
  assert.equal(count, 1);
  assert.throws(() =>
    store.tx(() => {
      store.afterCommit(notify);
      throw Error("rollback");
    }),
  );
  assert.equal(count, 1);
  store.close();
});
