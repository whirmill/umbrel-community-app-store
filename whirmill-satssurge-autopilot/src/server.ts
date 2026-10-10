import {ApplicationControl} from "./application-control.js";
import {Telegram} from "./telegram.js";
import { modelSettings } from "./model-settings.js";
import { legacyHistory } from "./legacy-history.js";
import { publicJob, publicExchange, exchangeAnswerPage } from "./public-job.js";
import { historyEvents } from "./ui-history.js";
import { provenance } from "./analysis-feed.js";
import { createServer } from "node:http";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, join, extname } from "node:path";
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { Store } from "./store.js";
import { Lnd } from "./lnd.js";
import { Executor } from "./executor.js";
import { Collector } from "./collector.js";
import { Queue } from "./queue.js";
import { Scheduler } from "./scheduler.js";
import { Agent } from "./agent.js";
import { UiEvents, serveUiEvents } from "./ui-events.js";
import { OwnerSessions } from "./owner-auth.js";
import { importHistory } from "./importer.js";
import { now, json, publicAnswer, scrub } from "./domain.js";
const directory = resolve(process.env.DATA_DIR ?? "/data");
mkdirSync(directory, { recursive: true, mode: 0o700 });
const store = new Store(join(directory, "operational.sqlite"));
if (!store.get("installedAt")) store.set("installedAt", now());
const importDir = process.env.HISTORY_DIR ?? "/history";
if (existsSync(importDir)) importHistory(store, importDir);
const csrf = randomBytes(32).toString("hex");
const ownerPath = join(directory, "owner.secret");
if (!existsSync(ownerPath)) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(ownerPath, randomBytes(24).toString("hex"), { mode: 0o600 });
}
const owner = readFileSync(ownerPath, "utf8").trim();
const ownerDigest = createHash("sha256").update(owner).digest();
const sessions = new OwnerSessions();
const uiEvents = new UiEvents(store);
const queue = new Queue(store);
let control = new ApplicationControl(store, queue);
const telegram = new Telegram(store, control, directory);
queue.recoverAfterRestart();
// Preserve pre-queue exchanges once. Durable jobs own all subsequent history.
if (store.get("legacyChat") === undefined)
  store.set(
    "legacyChat",
    (store.get<any[]>("chat") ?? []).filter(
      (c) =>
        !c.requestId ||
        !store.one("SELECT id FROM jobs WHERE request_id=?", c.requestId),
    ),
  );
let agent: Agent | undefined,
  collector: Collector | undefined,
  scheduler: Scheduler | undefined;
const intervals: ReturnType<typeof setInterval>[] = [];
const streamAbort = new AbortController();
let closing = false;
let streamRetry: ReturnType<typeof setTimeout> | undefined;
try {
  const node = new Lnd(
    process.env.LND_URL ?? "https://10.21.21.9:8080",
    "/credentials/tls.cert",
    "/credentials/read.macaroon",
    "/credentials/write.macaroon",
  );
  const expected = readFileSync("/credentials/node-pubkey", "utf8").trim();
  if (!/^[0-9a-f]{66}$/.test(expected)) throw new Error("Invalid node binding");
  store.set("expectedIdentity", expected);
  const executor = new Executor(store, node);
  control = new ApplicationControl(store, queue, executor);
  Object.assign(telegram, {control});
  collector = new Collector(
    store,
    node,
    executor,
    process.env.INTERLOCK_FILE ?? "/interlock/status.json",
  );
  agent = new Agent(store, executor, directory, queue);
  await agent.open();
  await collector.collect();
  intervals.push(setInterval(() => void collector!.collect(), 60000));
  scheduler = new Scheduler(queue, agent);
  telegram.setWake(()=>scheduler!.dispatchTelegram());
  intervals.push(
    setInterval(() => scheduler!.tick(), 60000),
    setInterval(() => void scheduler!.pump(), 1000),
  );
  scheduler.tick();
  const streamLoop = async () => {
    try {
      await collector!.stream(streamAbort.signal);
    } catch {}
    if (!closing) streamRetry = setTimeout(() => void streamLoop(), 5000);
  };
  void streamLoop();
} catch {
  store.set("bootstrapReady", false);
  store.set("blockers", [
    "LND credentials/configuration unavailable; provision dedicated restricted macaroons",
  ]);
}
void telegram.loop();
const staticFiles: Record<string, [string, string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
  "/favicon.svg": ["favicon.svg", "image/svg+xml"],
  "/theme.js": ["theme.js", "text/javascript; charset=utf-8"],
};
const server = createServer(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'",
  );
  const url = new URL(req.url ?? "/", "http://localhost");
  const send = (data: unknown, status = 200) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.end(json(data));
  };
  try {
    if (closing) {
      send(
        {
          error:
            "Service shutting down; retry the same request ID after restart",
        },
        503,
      );
      return;
    }
    if (
      req.method === "GET" &&
      url.pathname.startsWith("/assets/") &&
      /^\/assets\/[a-zA-Z0-9_.-]+$/.test(url.pathname)
    ) {
      const file = resolve("public", url.pathname.slice(1));
      if (!existsSync(file)) {
        send({ error: "Not found" }, 404);
        return;
      }
      res.setHeader(
        "Content-Type",
        (
          {
            ".js": "text/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".svg": "image/svg+xml",
            ".woff2": "font/woff2",
          } as Record<string, string>
        )[extname(file)] ?? "application/octet-stream",
      );
      res.end(readFileSync(file));
      return;
    }
    if (req.method === "GET" && staticFiles[url.pathname]) {
      const [file, type] = staticFiles[url.pathname]!;
      res.setHeader("Content-Type", type);
      res.end(readFileSync(resolve("public", file)));
      return;
    }
    if (req.method === "GET" && url.pathname === "/health") {
      send({ ok: true });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/owner/login") {
      if (
        !req.headers.origin ||
        new URL(req.headers.origin).host !==
          (req.headers["x-forwarded-host"] ?? req.headers.host)
      ) {
        send({ error: "Origin rejected" }, 403);
        return;
      }
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 2048) {
          send({ error: "Too large" }, 413);
          return;
        }
      }
      const password = JSON.parse(raw).password;
      if (
        typeof password !== "string" ||
        !timingSafeEqual(
          createHash("sha256").update(password).digest(),
          ownerDigest,
        )
      ) {
        send({ error: "Owner password rejected" }, 403);
        return;
      }
      const session = sessions.issue();
      res.setHeader(
        "Set-Cookie",
        "satssurge=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/",
      );
      send({ connected: true, session });
      return;
    }
    if (!sessions.accepts(req.headers.authorization)) {
      send({ error: "Owner authentication required" }, 401);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/events") {
      const supplied =
        url.searchParams.get("after") ??
        String(req.headers["last-event-id"] ?? "0");
      if (!/^\d{1,15}$/.test(supplied)) {
        send({ error: "Invalid event cursor" }, 400);
        return;
      }
      let cursor = Number(supplied);
      if (cursor > uiEvents.cursor()) {
        send({ error: "Cursor ahead of store; resynchronize history" }, 409);
        return;
      }
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("X-Accel-Buffering", "no");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();
      await serveUiEvents(
        uiEvents,
        res,
        cursor,
        streamAbort.signal,
        () => !closing && sessions.accepts(req.headers.authorization),
      );
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/history") {
      const before = Number(
        url.searchParams.get("before") ?? Number.MAX_SAFE_INTEGER,
      );
      if (!Number.isSafeInteger(before) || before < 1) {
        send({ error: "Invalid history cursor" }, 400);
        return;
      }
      // Cursor and materialized events are read synchronously on the single writer.
      const cursor = uiEvents.cursor();
      const jobs = store
        .all(
          "SELECT rowid history_id,* FROM jobs WHERE rowid<? ORDER BY rowid DESC LIMIT 50",
          before,
        )
        .map((job: any) => publicJob(store, job));
      const ids = jobs.map((j) => j.id);
      const page = historyEvents(store, ids);
      const projections = page.events;
      send({
        cursor,
        jobs,
        events: projections,
        eventsPartial: page.partial,
        detailAccess: page.detailAccess,
        nextBefore: jobs.length === 50 ? jobs.at(-1)?.history_id : null,
        ...legacyHistory(
          store,
          url.searchParams.has("legacyBefore")
            ? Number(url.searchParams.get("legacyBefore"))
            : undefined,
        ),
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/status") {
      send({
        ...store.stats(),
        csrf,
        telegram: telegram.status(),
        proposals: control.proposals(),
        chat: (store.get<any[]>("chat") ?? [])
          .slice(-12)
          .map((c) => publicExchange(c, "chat")),
        collector: store.get("collector") ?? {},
        queue: queue.metrics(),
        jobs: queue.list().map((job: any) => publicJob(store, job)),
        pool: scheduler?.status(),
        modelUsage: store.get("modelUsage"),
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/chat/answer") {
      const page = exchangeAnswerPage(
        store,
        url.searchParams.get("key") ?? "",
        Number(url.searchParams.get("offset") ?? 0),
      );
      if (!page) {
        send(
          { error: "Original exchange no longer available in this collection" },
          404,
        );
        return;
      }
      send(page);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/jobs/answer") {
      const jobId = url.searchParams.get("jobId") ?? "",
        offset = Number(url.searchParams.get("offset") ?? 0);
      if (!Number.isSafeInteger(offset) || offset < 0 || !queue.get(jobId)) {
        send({ error: "Invalid answer cursor" }, 400);
        return;
      }
      const row = store.one(
        "SELECT length(json_extract(result,'$.answer')) total,substr(json_extract(result,'$.answer'),?,16384) text FROM jobs WHERE id=?",
        offset + 1,
        jobId,
      );
      send({
        text: row?.text ?? "",
        offset,
        total: row?.total ?? 0,
        nextOffset: offset + 16384 < (row?.total ?? 0) ? offset + 16384 : null,
        format: "exact text page; Markdown is not parsed across partial pages",
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/jobs/events") {
      const jobId = url.searchParams.get("jobId") ?? "",
        after = Number(url.searchParams.get("after") ?? 0);
      if (!Number.isSafeInteger(after) || after < 0 || !queue.get(jobId)) {
        send({ error: "Invalid detail cursor" }, 400);
        return;
      }
      const toolCallId = url.searchParams.get("toolCallId");
      const rows = store
        .all(
          "SELECT id,job_id,at,type,CASE WHEN length(data)>131072 THEN json_object('unavailable',1,'detailExpired',0,'reason','Legacy body exceeds detail byte cap; original private receipt retained') ELSE data END data FROM ui_events WHERE job_id=? AND id>? AND (? IS NULL OR json_extract(data,'$.toolCallId')=?) ORDER BY id LIMIT 32",
          jobId,
          toolCallId ? 0 : after,
          toolCallId,
          toolCallId,
        )
        .map((e) => ({ ...e, data: JSON.parse(e.data) }));
      send({
        events: rows,
        nextAfter: rows.length === 32 ? rows.at(-1)?.id : null,
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/jobs/receipt") {
      const job = store.one(
        "SELECT rowid history_id,* FROM jobs WHERE request_id=?",
        url.searchParams.get("requestId") ?? "",
      );
      if (!job) {
        send({ error: "Request receipt not found" }, 404);
        return;
      }
      send({ job: publicJob(store, job) });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/telegram/status") { send(telegram.status()); return; }
    if (req.method === "GET" && url.pathname === "/api/proposals") { send(control.proposals()); return; }
    if (req.method === "GET" && url.pathname === "/api/auth") {
      send(agent ? await agent.authStatus() : { connected: false, events: [] });
      return;
    }
    if (req.method !== "POST") {
      send({ error: "Not found" }, 404);
      return;
    }
    // Umbrel app proxy supplies authentication. Every write also requires same-origin + anti-CSRF.
    const origin = req.headers.origin,
      forwardedHost = req.headers["x-forwarded-host"];
    const host =
      typeof forwardedHost === "string"
        ? forwardedHost.split(",")[0]!.trim()
        : req.headers.host;
    if (!origin || new URL(origin).host !== host) {
      send({ error: "Origin rejected" }, 403);
      return;
    }
    const token = String(req.headers["x-csrf-token"] ?? "");
    if (
      token.length !== csrf.length ||
      !timingSafeEqual(Buffer.from(token), Buffer.from(csrf))
    ) {
      send({ error: "CSRF rejected" }, 403);
      return;
    }
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (Buffer.byteLength(raw) > 32768) {
        send({ error: "Request too large" }, 413);
        return;
      }
    }
    const body = JSON.parse(raw || "{}");
    if((url.pathname==='/api/chat'||url.pathname==='/api/analyze')&&!store.one('SELECT id FROM jobs WHERE request_id=?',typeof body.requestId==='string'?body.requestId:'')){
      send({error:'La conversazione con il coordinatore è disponibile su Telegram. La web app conserva impostazioni e ricevute.'},410);return;
    }
    if (
      (url.pathname === "/api/chat" || url.pathname === "/api/analyze") &&
      typeof body.message === "string" &&
      Buffer.byteLength(JSON.stringify({ message: body.message })) > 16384
    ) {
      // Legacy admission measured scrubbed bytes. Recover an original receipt first;
      // queue validates the original digest before any definitive rejection.
      if (
        typeof body.requestId === "string" &&
        store.one("SELECT id FROM jobs WHERE request_id=?", body.requestId)
      ) {
        const job = queue.enqueue({
          requestId: body.requestId,
          kind: url.pathname === "/api/analyze" ? "analysis" : "chat",
          origin: body.purpose === "qualification" ? "qualification" : "owner",
          purpose:
            body.purpose === "qualification"
              ? "qualification"
              : body.purpose === "economic" ||
                  (url.pathname === "/api/analyze" &&
                    body.purpose !== "general")
                ? "economic"
                : "general",
          payload: { message: body.message },
          scope: typeof body.scope === "string" ? body.scope.slice(0, 200) : "",
        });
        send({ accepted: true, job }, 202);
        return;
      }
      send({ error: "Job payload too large", admissionRejected: true }, 413);
      return;
    }
    if (url.pathname === "/api/owner/logout") {
      sessions.revoke(req.headers.authorization);
      send({ disconnected: true });
      return;
    }
    if (url.pathname === "/api/telegram/stream-policy") { try{send(telegram.streamPolicy(body.richDraftPolicy));}catch(e){send({error:e instanceof Error?e.message:"Stream policy rejected"},(e as any).statusCode??400);} return; }
    if (url.pathname === "/api/telegram/config") { telegram.configure(body.token); send(telegram.status()); return; }
    if (url.pathname === "/api/telegram/pairing") { send(telegram.pairing()); return; }
    if (url.pathname === "/api/telegram/confirm") { send(telegram.confirm(body.userId)); return; }
    if (url.pathname === "/api/telegram/revoke") { send(telegram.revoke()); return; }
    if (url.pathname === "/api/proposals/approve") { send(await control.approve(body.id)); return; }
    if (url.pathname === "/api/proposals/reject") { send({rejected:control.reject(body.id)}); return; }
    if (url.pathname === "/api/pause") { send(control.pause()); return; }
    if (url.pathname === "/api/resume/summary") { send(control.resumeSummary()); return; }
    if (url.pathname === "/api/resume") { send(control.resume(body.code)); scheduler?.tick(); return; }
    if (!agent) throw new Error("Agent unavailable until LND provisioning");
    if (url.pathname === "/api/auth/start") {
      agent.login();
      send({ started: true });
      return;
    }
    if (url.pathname === "/api/auth/respond") {
      if (typeof body.value !== "string")
        throw new Error("Invalid login response");
      agent.answer(body.value);
      send({ accepted: true });
      return;
    }
    if (url.pathname === "/api/model") {
      const settings = modelSettings(
        await agent.models.getAvailable("openai"),
        body.model,
        body.thinkingLevel,
        store.get<string>("thinkingLevel") ?? "high",
      );
      store.tx(() => {
        store.set("model", settings.model);
        store.set("thinkingLevel", settings.thinkingLevel);
      });
      send({ saved: true });
      return;
    }
    if (url.pathname === "/api/chat" || url.pathname === "/api/analyze") {
      if (typeof body.message !== "string" || !body.message.trim())
        throw new Error("Empty message");
      if (typeof body.requestId !== "string")
        throw new Error("A persistent request ID is required");
      const job = control.admit(body.requestId,body.message,"owner",url.pathname === "/api/analyze",body.purpose === "qualification"?"qualification":body.purpose === "economic"?"economic":body.purpose === "general"?"general":undefined,typeof body.scope === "string"?body.scope.slice(0,200):"");
      send({ accepted: true, job }, 202);
      void scheduler?.pump();
      return;
    }
    if (url.pathname === "/api/jobs/cancel") {
      if (typeof body.id !== "string") throw new Error("Invalid job");
      send({error:'Gestisci i turni della conversazione su Telegram.'},410);
      return;
    }
    send({ error: "Not found" }, 404);
  } catch (e) {
    send({ error: e instanceof Error ? e.message : "Request failed" }, 400);
  }
});
server.listen(Number(process.env.PORT ?? 8080), "0.0.0.0");
async function shutdown() {
  if (closing) return;
  closing = true;
  scheduler?.stop();
  telegram.stop();
  for (const timer of intervals) clearInterval(timer);
  if (streamRetry) clearTimeout(streamRetry);
  streamAbort.abort();
  server.close();
  store.set("shutdown", {
    at: now(),
    state: "draining",
    note: "No new jobs; original durable submissions retained",
  });
  const deadline = Date.now() + 25000;
  const drained = (await scheduler?.drain(25000)) ?? true;
  while (collector?.busy && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 50));
  store.set("shutdown", {
    at: now(),
    state:
      drained && !collector?.busy ? "drained" : "restart_recovery_required",
  });
  if (drained && !collector?.busy) await agent?.close();
  // SQLite FULL commits and durable operation receipts, not this exit status,
  // determine recovery. Never mark an uncertain financial operation failed.
  process.exit(0);
}
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
