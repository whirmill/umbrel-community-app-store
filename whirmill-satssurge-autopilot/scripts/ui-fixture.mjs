import {Research} from '../dist/research.js';
import { legacyHistory } from "../dist/legacy-history.js";
import { historyEvents } from "../dist/ui-history.js";
import { publicJob, exchangeAnswerPage } from "../dist/public-job.js";
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
      id: process.env.FIXTURE_RESEARCH_REPAIR==='1'?'1':'fake1',
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
  const historyCount = Math.max(
    125,
    Math.min(5000, Number(process.env.FIXTURE_HISTORY_COUNT) || 125),
  );
  for (let n = 0; n < historyCount; n++) {
    const j = queue.enqueue({
      requestId: "fixture:" + n,
      kind: "chat",
      origin: "owner",
      purpose: "general",
      payload: { message: "Cronologia simulata " + n },
    });
    const claimed = queue.claim("coordinator", "fixture");
    queue.finish(j.id, claimed.run_token, "completed", {
      answer:
        n === historyCount - 1
          ? '## Contenuti non attendibili\n\n<script>untrusted</script> [link](javascript:alert(1))\n\n```js\nconsole.log("Test locale");\n```\n\n' +
            "Cronologia lunga. ".repeat(1800)
          : process.env.FIXTURE_HEAVY
            ? "## Sintesi simulata\n\n| Misura | Valore | Copertura |\n|---|---:|---|\n" +
              "| Corridoio | 1000 | parziale |\n".repeat(15) +
              "\n" +
              "Osservazione simulata. ".repeat(100)
            : "Risposta storica " + n,
    });
    if (process.env.FIXTURE_HEAVY)
      for (let i = 0; i < 18; i++) {
        events.append(j.id, "tool_call", {
          toolCallId: "heavy:" + n + ":" + i,
          toolName: "state_page",
          args: { section: "diagnostics", offset: i * 20 },
        });
        events.append(j.id, "tool_result", {
          toolCallId: "heavy:" + n + ":" + i,
          toolName: "state_page",
          result: {
            rows: Array.from({ length: 20 }, (_, r) => ({
              id: r,
              note: "Fixture ".repeat(100),
            })),
            coverage: "partial",
          },
        });
      }
  }
  if (process.env.FIXTURE_LEGACY_COUNT)
    store.set(
      "legacyChat",
      Array.from(
        { length: Math.min(5000, Number(process.env.FIXTURE_LEGACY_COUNT)) },
        (_, i) => ({
          at: new Date(Date.parse("2026-01-01") + i * 1000).toISOString(),
          user: "Legacy fixture " + i,
          answer: "Historical preserved answer " + i,
        }),
      ),
    );
  store.set("seeded", true);
}
// Research examples are appended after historical jobs so they are in the latest window.
if(process.env.FIXTURE_RESEARCH_REPAIR==='1'&&!store.get('researchRepairSeededV2')){
  const research=new Research(store);
  const make=(name,message)=>queue.enqueue({requestId:'fixture-research-v2:'+name,kind:'analysis',scope:'node',origin:'scheduler',purpose:'economic',payload:{message:'Fixture sintetica · '+message}});
  const finish=(job,answer)=>{
    const at=new Date().toISOString();
    store.run("UPDATE jobs SET state='completed',result=?,finished_at=?,updated_at=? WHERE id=?",JSON.stringify({answer:'Fixture locale, senza provider o effetti finanziari. '+answer}),at,at,job.id);
    queue.event(job.id,'completed',{});
  };
  const budget=(job,calls,elapsed)=>store.set('runBudget:'+job.id,{started:Date.now()-elapsed,calls,phase:'finalization',reason:'fixture',hardMs:180000,softMs:60000,researchCalls:12,endedMs:elapsed,usage:{input:1,output:1,totalTokens:2}});
  const partial=make('partial','ricerca parziale con dati non acquisiti');research.initialize(partial);research.state(partial);budget(partial,3,4200);finish(partial,'Ricerca parziale: il budget è stato letto; copertura e confronto restano da esaminare.');
  const blocked=make('blocked','ricerca al limite dei tre segmenti');const blockedState=research.initialize(blocked);blockedState.segmentIndex=2;store.set('research:'+blocked.id,blockedState);research.state(blocked);budget(blocked,24,180000);finish(blocked,'Tre segmenti raggiunti: servono nuovi fatti materiali.');
  const complete=make('observation','ricerca completa sulle evidenze disponibili; attesa esplicita, idoneità non dimostrata');const completeState=research.initialize(complete);research.state(complete);
  for(const key of completeState.required){
    if(key==='state_budget'||key==='alternatives')continue;
    let query;
    if(key.startsWith('diagnostics:')){const [,provider,collection]=key.split(':');query={section:'diagnostics',provider,collection};}
    else if(key.startsWith('competition_alternatives:'))query={section:'competition_alternatives',channel:key.slice('competition_alternatives:'.length)};
    else if(key.startsWith('corridor_events:')){const [source,target]=key.slice('corridor_events:'.length).split('->');query={section:'corridor_events',source,target};}
    else query={section:key};
    query=research.query(complete,query);
    // Missing sources complete their explicit availability assessment, never assert financial eligibility.
    research.page(complete,query,{available:false,rows:null,nextOffset:null,note:'Fonte non disponibile nella fixture sintetica',version:null});
  }
  research.alternatives(complete,{wait:'Attendere dati autorevoli completi.',priceChange:'Non giustificato senza copertura.',smallerRebalance:'Non giustificato senza previsione.',proposedAction:'Nessuna azione finanziaria nella fixture.'});
  const dueAt=new Date(Date.now()+48*3600000).toISOString();
  store.set('followUpOutcome:'+complete.id,{outcome:'wait',scope:'node',dueAt,at:new Date().toISOString(),provenance:'fixture'});
  budget(complete,12,15000);finish(complete,'Ricerca completa sulle fonti disponibili, con lacune esplicite. Attendere la scadenza o fatti materiali; non è una previsione idonea.');
  store.ledger({id:'fixture-routing-revenue',at:new Date().toISOString(),classification:'revenue',amountMsat:'364358',category:'routing'});
  store.ledger({id:'fixture-swap-revenue',at:new Date().toISOString(),classification:'revenue',amountMsat:'1958000',details:{scope:'swap'}});
  store.ledger({id:'fixture-unallocated-cost',at:new Date().toISOString(),classification:'expense',amountMsat:'10705169'});
  store.set('researchRepairSeededV2',true);
}
if(process.env.FIXTURE_OPERATIONAL_BLOCKED==='1')store.set('blockers',['Blocco operativo sintetico: acquisizione autorevole non disponibile']);
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
// Explicit synthetic catalog: these capacities are fixture values, not provider claims.
const fixtureModels = [
  {
    id: "gpt-6.1-sol",
    name: "GPT-6.1 Sol · simulato",
    provider: "openai",
    contextWindow: 128000,
    thinkingLevels: ["low", "medium", "high"],
  },
  {
    id: "gpt-6-luna",
    name: "GPT-6 Luna · simulato",
    provider: "openai",
    contextWindow: 64000,
    thinkingLevels: ["low", "medium", "high"],
  },
];
if (!store.get("model")) store.set("model", "gpt-6.1-sol");
let authPrompt = false;
let droppedAdmissionAck = false;
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
      if (!/^(index.html|theme.js|favicon.svg|assets\/[\w.-]+)$/.test(path))
        return send({}, 404);
      res.setHeader(
        "Content-Type",
        {
          ".html": "text/html",
          ".js": "text/javascript",
          ".css": "text/css",
          ".svg": "image/svg+xml",
        }[extname(path)] ?? "application/octet-stream",
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
      session = "fixture-session-" + crypto.randomUUID();
      return send({ session });
    }
    if (req.headers.authorization !== "Bearer " + session)
      return send({ error: "Sessione scaduta" }, 401);
    if (url.pathname === "/api/owner/logout") {
      session = "revoked-" + Date.now();
      return send({ disconnected: true });
    }
    if (url.pathname === "/api/status")
      return send({
        ...store.stats(),
        uiFixture: true,
        csrf: "fixture-csrf",
        jobs: queue.list().map((j) => publicJob(store, j)),
        queue: queue.metrics(),
        pool: { analystRunning: 0, maxAnalysts: 2 },
      });
    if (url.pathname === "/api/auth")
      return send({
        connected: true,
        models: fixtureModels,
        selected: store.get("model"),
        catalogProvenance: "simulated fixture capacities",
        thinkingLevel: store.get("thinkingLevel") ?? "high",
        events: [],
        prompt: authPrompt ? { message: "Codice OAuth simulato" } : null,
      });
    if (url.pathname === "/api/history") {
      const jobs = store.all(
        "SELECT rowid history_id,* FROM jobs WHERE rowid<? ORDER BY rowid DESC LIMIT 50",
        Number(url.searchParams.get("before") ?? Number.MAX_SAFE_INTEGER),
      );
      return send({
        jobs: jobs.map((j) => publicJob(store, j)),
        ...historyEvents(
          store,
          jobs.map((j) => j.id),
        ),
        cursor: events.cursor(),
        nextBefore: jobs.length === 50 ? jobs.at(-1).history_id : null,
        ...legacyHistory(
          store,
          url.searchParams.has("legacyBefore")
            ? Number(url.searchParams.get("legacyBefore"))
            : undefined,
        ),
      });
    }
    if (url.pathname === "/api/chat/answer") {
      const page = exchangeAnswerPage(
        store,
        url.searchParams.get("key") ?? "",
        Number(url.searchParams.get("offset") ?? 0),
      );
      return page
        ? send(page)
        : send({ error: "Original exchange unavailable" }, 404);
    }
    if (url.pathname === "/api/jobs/events") {
      const jobId = url.searchParams.get("jobId") ?? "",
        after = Number(url.searchParams.get("after") ?? 0);
      const tool = url.searchParams.get("toolCallId");
      const rows = store
        .all(
          "SELECT * FROM ui_events WHERE job_id=? AND id>? AND (? IS NULL OR json_extract(data,'$.toolCallId')=?) ORDER BY id LIMIT 32",
          jobId,
          tool ? 0 : after,
          tool,
          tool,
        )
        .map((e) => ({ ...e, data: JSON.parse(e.data) }));
      return send({ events: rows });
    }
    if (url.pathname === "/api/events") {
      let cursor = Number(url.searchParams.get("after") ?? 0);
      res.setHeader("Content-Type", "text/event-stream");
      res.flushHeaders();
      clients.add(res);
      const controller = new AbortController();
      res.on("close", () => {
        controller.abort();
        clients.delete(res);
      });
      await serveUiEvents(
        events,
        res,
        cursor,
        controller.signal,
        () => req.headers.authorization === "Bearer " + session,
      );
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
      if (
        url.pathname === "/api/chat" &&
        process.env.FIXTURE_DROP_ACK_ONCE === "1" &&
        !droppedAdmissionAck
      ) {
        droppedAdmissionAck = true;
        if (!old) run(job);
        res.destroy();
        return;
      }
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
    if (url.pathname === "/api/auth/start") {
      authPrompt = true;
      return send({ started: true });
    }
    if (url.pathname === "/api/auth/respond") {
      if (body.value !== "fixture-code")
        return send({ error: "Codice simulato rifiutato" }, 400);
      authPrompt = false;
      return send({ connected: true });
    }
    if (url.pathname === "/api/model") {
      if (!fixtureModels.some((model) => model.id === body.model))
        return send({ error: "Unavailable simulated model" }, 400);
      const selected = fixtureModels.find((model) => model.id === body.model);
      const thinkingLevel =
        body.thinkingLevel ?? store.get("thinkingLevel") ?? "high";
      if (!selected.thinkingLevels.includes(thinkingLevel))
        return send({ error: "Unavailable simulated reasoning level" }, 400);
      store.tx(() => {
        store.set("model", body.model);
        store.set("thinkingLevel", thinkingLevel);
      });
      return send({ saved: true });
    }
    send({ error: "Not found" }, 404);
  } catch (e) {
    send({ error: e.message }, 400);
  }
});
const fixturePort=Number(process.env.UI_FIXTURE_PORT??19538);
if(!Number.isInteger(fixturePort)||fixturePort<1024||fixturePort>65535)throw Error('Invalid local fixture port');
server.listen(fixturePort, "127.0.0.1", () =>
  console.log('UI fixture listening on'+fixturePort),
);
process.once("SIGTERM", () => {
  for (const t of timers) clearTimeout(t);
  for (const c of clients) c.end();
  server.close(() => {
    store.close();
    process.exit(0);
  });
});
