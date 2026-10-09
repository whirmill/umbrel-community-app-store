// Explicit local-only simulation; never imported by production or copied into image.
import { createServer } from "node:http";
import { readFileSync, mkdirSync } from "node:fs";
import { resolve, extname } from "node:path";
import { Store } from "../dist/store.js";
import { Queue } from "../dist/queue.js";
import { UiEvents, serveUiEvents } from "../dist/ui-events.js";
const dir = process.env.UI_FIXTURE_DIR;
if (!dir) throw Error("UI_FIXTURE_DIR required");
mkdirSync(dir, { recursive: true });
const store = new Store(resolve(dir, "fixture.sqlite")),
  queue = new Queue(store, 500),
  events = new UiEvents(store),
  clients = new Set(),
  timers = new Set();
store.set("bootstrapReady", true);
store.set("snapshot", {
  at: new Date().toISOString(),
  synced: true,
  confirmedSat: "502858",
  channels: [
    {
      id: "fake1",
      alias: "SatsSurge · demo",
      localSat: "672264",
      remoteSat: "326762",
      ppm: 400,
      baseMsat: "0",
      active: true,
    },
  ],
});
if (!store.get("seeded")) {
  const historyCount=Math.max(125,Math.min(1000,Number(process.env.FIXTURE_HISTORY_COUNT)||125));
  for (let n = 0; n < historyCount; n++) {
    const j = queue.enqueue({
      requestId: "fixture:" + n,
      kind: "chat",
      payload: { message: "Cronologia simulata " + n },
    });
    const claimed = queue.claim("coordinator", "fixture");
    queue.finish(j.id, claimed.run_token, "completed", {
      answer:
        n === historyCount-1
          ? '## Contenuti non attendibili\n\n<script>untrusted</script> [link](javascript:alert(1))\n\n```js\nconsole.log("Test locale");\n```\n\n' +
            "Cronologia lunga. ".repeat(1800)
          : "Risposta storica " + n,
    });
  }
  store.set("seeded", true);
}
let session = "fixture-session";
const later = (ms, fn) => {
  const t = setTimeout(() => {
    timers.delete(t);
    fn();
  }, ms);
  timers.add(t);
};
function run(job) {
  if (!store.get("enabled")) return;
  store.run(
    "UPDATE jobs SET state='running',updated_at=? WHERE id=?",
    new Date().toISOString(),
    job.id,
  );
  queue.event(job.id, "claimed", {});
  later(300, () =>
    events.append(job.id, "text", { text: "Sto leggendo lo stato simulato…" }),
  );
  later(600, () =>
    events.append(job.id, "tool_call", {
      toolCallId: "fake:" + job.id,
      toolName: "node_state",
      args: {},
    }),
  );
  later(1200, () =>
    events.append(job.id, "tool_result", {
      toolCallId: "fake:" + job.id,
      toolName: "node_state",
      result: { synced: true },
      isError: false,
    }),
  );
  later(2000, () => {
    store.run(
      "UPDATE jobs SET state='completed',result=?,updated_at=? WHERE id=?",
      JSON.stringify({
        answer: "**Test simulato completato**. Nessuna operazione finanziaria.",
      }),
      new Date().toISOString(),
      job.id,
    );
    queue.event(job.id, "completed", {});
  });
}
let authPrompt = false;
const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const send = (x, status = 200) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(x));
  };
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'",
  );
  try {
    if (url.pathname === "/__test/disconnect") {
      for (const c of clients) c.end();
      return send({ closed: true });
    }
    if (url.pathname === "/__test/expire") {
      session = "expired";
      return send({ expired: true });
    }
    if (!url.pathname.startsWith("/api/")) {
      const path = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      if (!/^(index.html|assets\/[\w.-]+)$/.test(path)) return send({}, 404);
      res.setHeader(
        "Content-Type",
        { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[
          extname(path)
        ] ?? "application/octet-stream",
      );
      return res.end(readFileSync(resolve("public", path)));
    }
    let body = {};
    if (req.method === "POST") {
      let raw = "";
      for await (const c of req) raw += c;
      body = JSON.parse(raw || "{}");
    }
    if (url.pathname === "/api/owner/login") {
      if (body.password !== "fixture-only")
        return send({ error: "Password rifiutata" }, 403);
      session = "fixture-session-"+crypto.randomUUID();
      return send({ session });
    }
    if (req.headers.authorization !== "Bearer " + session)
      return send({ error: "Sessione scaduta" }, 401);
    if (url.pathname === "/api/owner/logout") {session="revoked-"+Date.now();return send({disconnected:true});}
    if (url.pathname === "/api/status")
      return send({
        ...store.stats(),
        csrf: "fixture-csrf",
        jobs: queue.list(),
        queue: queue.metrics(),
        pool: { analystRunning: 0, maxAnalysts: 2 },
      });
    if (url.pathname === "/api/auth")
      return send({
        connected: true,
        models: [{ id: "gpt-6.1-sol", name: "GPT-6.1 Sol" }],
        selected: "gpt-6.1-sol",
        thinkingLevel: "high",
        events: [],
        prompt: authPrompt ? { message: "Codice OAuth simulato" } : null,
      });
    if (url.pathname === "/api/history") {
      const jobs = store.all(
        "SELECT rowid history_id,* FROM jobs WHERE rowid<? ORDER BY rowid DESC LIMIT 50",
        Number(url.searchParams.get("before") ?? Number.MAX_SAFE_INTEGER),
      );
      return send({
        jobs,
        events: events.after(0, 20000),
        cursor: events.cursor(),
        nextBefore: jobs.length === 50 ? jobs.at(-1).history_id : null,
        legacyChat: [],
      });
    }
    if (url.pathname === "/api/events") {
      let cursor = Number(url.searchParams.get("after") ?? 0);
      res.setHeader("Content-Type", "text/event-stream");
      res.flushHeaders();
      clients.add(res);
      const controller = new AbortController();
      res.on("close", () => { controller.abort(); clients.delete(res); });
      await serveUiEvents(events, res, cursor, controller.signal, () => req.headers.authorization === "Bearer " + session);
      return;
    }
    if (url.pathname === "/api/chat" || url.pathname === "/api/analyze") {
      const old = store.one(
          "SELECT id FROM jobs WHERE request_id=?",
          body.requestId,
        ),
        job = queue.enqueue({
          requestId: body.requestId,
          kind: url.pathname.endsWith("analyze") ? "analysis" : "chat",
          payload: { message: body.message },
        });
      send({ accepted: true, job }, 202);
      if (!old) run(job);
      return;
    }
    if (url.pathname === "/api/jobs/receipt")
      return send({
        job: store.one(
          "SELECT * FROM jobs WHERE request_id=?",
          url.searchParams.get("requestId"),
        ),
      });
    if (url.pathname === "/api/jobs/cancel")
      return send({ cancelled: queue.cancel(body.id) });
    if (url.pathname === "/api/pause") {
      store.set("enabled", false);
      return send({ paused: true });
    }
    if (url.pathname === "/api/resume") {
      store.set("enabled", true);
      for (const j of store.all("SELECT * FROM jobs WHERE state='queued'"))
        run(j);
      return send({ enabled: true });
    }
    if (url.pathname === "/api/auth/start") { authPrompt = true; return send({ started: true }); }
    if (url.pathname === "/api/auth/respond") {
      if (body.value !== "fixture-code") return send({ error: "Codice simulato rifiutato" }, 400);
      authPrompt = false; return send({ connected: true });
    }
    if (url.pathname === "/api/model")
      return send({ saved: true });
    send({ error: "Not found" }, 404);
  } catch (e) {
    send({ error: e.message }, 400);
  }
});
server.listen(19538, "127.0.0.1", () =>
  console.log("UI fixture listening on19538"),
);
process.once("SIGTERM", () => {
  for (const t of timers) clearTimeout(t);
  for (const c of clients) c.end();
  server.close(() => {
    store.close();
    process.exit(0);
  });
});
