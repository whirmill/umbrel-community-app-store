import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { Store } from "../store.js";
import { Queue } from "../queue.js";
import { UiEvents } from "../ui-events.js";
test("actual HTTP auth, legacy projection, history pages and SSE replay use durable cursors without secrets", async () => {
  const dir = mkdtempSync(join(tmpdir(), "surge-http-"));
  const socket = createServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const port = (socket.address() as any).port;
  socket.close();
  const store = new Store(join(dir, "operational.sqlite"));
  store.set("enabled", false);
  const largePublic = "π".repeat(150000),
    largePrivate = JSON.stringify([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "HIDDEN-LARGE-SECRET" },
          { type: "text", text: largePublic },
        ],
      },
    ]);
  store.set("chat", [
    {
      requestId: "legacy",
      user: "hello",
      answer: JSON.stringify([
        {
          role: "assistant",
          provider: "private-provider",
          content: [
            { type: "thinking", thinking: "HIDDEN-SECRET" },
            { type: "text", text: "Public only" },
          ],
        },
      ]),
    },
    {
      at: "2026-10-09T00:00:00Z",
      requestId: "large-legacy",
      user: "large answer",
      answer: largePrivate,
    },
  ]);
  const q = new Queue(store),
    events = new UiEvents(store);
  const legacyMessage = "sk-a" + "a".repeat(17000);
  for (let n = 0; n < 60; n++) {
    const job = q.enqueue({
      requestId: "http:" + n,
      kind: "chat",
      payload: { message: n === 0 ? legacyMessage : "Read only " + n },
    });
    events.append(job.id, "text", { text: "Persisted public text " + n });
  }
  const cursor = events.cursor();
  store.close();
  writeFileSync(join(dir, "owner.secret"), "fixture-password", { mode: 0o600 });
  const child = spawn(process.execPath, ["dist/server.js"], {
    env: {
      ...process.env,
      DATA_DIR: dir,
      HISTORY_DIR: join(dir, "missing"),
      PORT: String(port),
    },
    stdio: "ignore",
  });
  const base = "http://127.0.0.1:" + port;
  try {
    for (let n = 0; n < 100; n++) {
      try {
        if ((await fetch(base + "/health")).ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal((await fetch(base + "/api/events?after=0")).status, 401);
    const login = await fetch(base + "/api/owner/login", {
      method: "POST",
      headers: { Origin: base, "Content-Type": "application/json" },
      body: JSON.stringify({ password: "fixture-password" }),
    });
    assert.equal(login.status, 200);
    const { session } = (await login.json()) as any;
    const headers = { Authorization: "Bearer " + session };
    const response = await fetch(base + "/api/history", { headers });
    assert.equal(response.status, 200);
    const history = (await response.json()) as any;
    assert.equal(history.jobs.length, 50);
    assert.equal(history.cursor, cursor);
    assert.equal(history.legacyChat[0].answer, "Public only");
    const descriptor = history.legacyChat[1];
    assert.equal(descriptor.answerDetailAvailable, true);
    assert.ok(Buffer.byteLength(descriptor.answer) < 128 * 1024);
    assert.ok(descriptor.answerDetailKey.startsWith("legacyChat:"));
    const boundedStatus = (await (
      await fetch(base + "/api/status", { headers })
    ).json()) as any;
    assert.equal(boundedStatus.chat[1].answerDetailAvailable, true);
    assert.ok(Buffer.byteLength(boundedStatus.chat[1].answer) < 128 * 1024);
    assert.equal(
      (
        await fetch(
          base +
            "/api/chat/answer?key=" +
            encodeURIComponent(descriptor.answerDetailKey),
        )
      ).status,
      401,
    );
    let offset = 0,
      recoveredAnswer = "";
    do {
      const page = (await (
        await fetch(
          base +
            "/api/chat/answer?key=" +
            encodeURIComponent(descriptor.answerDetailKey) +
            "&offset=" +
            offset,
          { headers },
        )
      ).json()) as any;
      assert.ok(Buffer.byteLength(page.text) <= 65536);
      recoveredAnswer += page.text;
      offset = page.nextOffset;
    } while (offset !== null);
    assert.equal(recoveredAnswer, largePublic);
    assert.equal(
      (
        await fetch(
          base +
            "/api/chat/answer?key=" +
            encodeURIComponent(descriptor.answerDetailKey) +
            "&offset=-1",
          { headers },
        )
      ).status,
      400,
    );
    const originalStore = new Store(join(dir, "operational.sqlite"));
    assert.equal(originalStore.get<any[]>("chat")![1].answer, largePrivate);
    originalStore.close();
    assert.doesNotMatch(
      JSON.stringify(history),
      /HIDDEN-SECRET|private-provider/,
    );
    const older = (await (
      await fetch(base + "/api/history?before=" + history.nextBefore, {
        headers,
      })
    ).json()) as any;
    assert.equal(older.jobs.length, 10);
    assert.equal(older.nextBefore, null);
    const controller = new AbortController();
    const stream = await fetch(base + "/api/events?after=" + (cursor - 2), {
      headers,
      signal: controller.signal,
    });
    assert.equal(stream.headers.get("content-type"), "text/event-stream");
    const reader = stream.body!.getReader();
    const chunk = await reader.read();
    const wire = new TextDecoder().decode(chunk.value);
    assert.match(wire, new RegExp("id: " + cursor));
    assert.doesNotMatch(wire, new RegExp("id: " + (cursor - 2) + "\\n"));
    controller.abort();
    await reader.cancel().catch(() => {});
    assert.equal(
      (await fetch(base + "/api/events?after=" + (cursor + 1), { headers }))
        .status,
      409,
    );
    assert.equal(
      (await fetch(base + "/api/events?after=-1", { headers })).status,
      400,
    );
    const status = (await (
      await fetch(base + "/api/status", { headers })
    ).json()) as any;
    const logoutHeaders = {
      ...headers,
      Origin: base,
      "Content-Type": "application/json",
      "X-CSRF-Token": status.csrf,
    };
    const original = (await (
      await fetch(base + "/api/jobs/receipt?requestId=http:0", { headers })
    ).json()) as any;
    const recoveredResponse = await fetch(base + "/api/chat", {
      method: "POST",
      headers: logoutHeaders,
      body: JSON.stringify({ requestId: "http:0", message: legacyMessage }),
    });
    assert.equal(recoveredResponse.status, 202);
    const recovered = (await recoveredResponse.json()) as any;
    assert.equal(recovered.job.id, original.job.id);
    const oversized = await fetch(base + "/api/chat", {
      method: "POST",
      headers: logoutHeaders,
      body: JSON.stringify({
        requestId: "never-admitted",
        message: "x".repeat(17000),
      }),
    });
    assert.equal(oversized.status, 413);
    assert.equal(((await oversized.json()) as any).admissionRejected, true);
    assert.equal(
      (
        await fetch(base + "/api/owner/logout", {
          method: "POST",
          headers: { ...logoutHeaders, Origin: "http://other.invalid" },
          body: "{}",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(base + "/api/owner/logout", {
          method: "POST",
          headers: { ...logoutHeaders, "X-CSRF-Token": "bad" },
          body: "{}",
        })
      ).status,
      403,
    );
    assert.equal((await fetch(base + "/api/history", { headers })).status, 200);
    assert.equal(
      (
        await fetch(base + "/api/owner/logout", {
          method: "POST",
          headers: logoutHeaders,
          body: "{}",
        })
      ).status,
      200,
    );
    assert.equal((await fetch(base + "/api/history", { headers })).status, 401);
    assert.equal(
      (await fetch(base + "/api/events?after=0", { headers })).status,
      401,
    );
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit");
    rmSync(dir, { recursive: true, force: true });
  }
});
