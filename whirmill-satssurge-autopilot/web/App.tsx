import { repositoryFor } from "./components/repository";
import { useExpansion, pruneExpansions } from "./components/expansions";
import { FixtureMetrics, fixtureCounters } from "./components/FixtureMetrics";
import { ownerEventStream } from "../src/ui-stream.js";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  createContext,
  useContext,
  useSyncExternalStore,
} from "react";
import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  MessagePrimitive,
  useExternalStoreRuntime,
  useAuiState,
  type ThreadMessageLike,
  ExportedMessageRepository,
} from "@assistant-ui/react";
import { ThemePicker } from "./components/Theme";
import { Mark } from "./components/Markdown";
import { VirtualMessages } from "./components/VirtualMessages";
import { ProjectionIndex } from "../src/ui-index";
import {
  Zap,
  MessageSquare,
  Activity,
  Network,
  Wallet,
  FlaskConical,
  Settings,
  ArrowUp,
  Pause,
  Play,
  RefreshCw,
  LogOut,
  ChevronDown,
  Shield,
  ArrowDown,
  AlertCircle,
} from "lucide-react";
import {
  Liquidity,
  BudgetGauges,
  AccountingChart,
  QueueChart,
  FeeChart,
  MiniBadge,
} from "./components/Charts";
import { satLabel, financialTone } from "../src/ui-chart-data";
import { Button } from "./components/ui/button";
import {
  answerFor,
  canCancel,
  mergeEvents,
  mergeJobs,
  mergeHistory,
  messageStatus,
  messagePresentation,
  parseJson,
  pendingSubmission,
  ownerRequestId,
  pendingKey,
  requestHeaders,
  expireSession,
  safeUrl,
  sats,
  type Projection,
  type Job,
  type Pending,
} from "../src/ui-client";
const identityMessage = (message: ThreadMessageLike) => message;
const empty: Projection = { jobs: {}, events: [], cursor: 0 };
const labels: Record<string, string> = {
  queued: "In coda",
  running: "In esecuzione",
  waiting: "In attesa",
  completed: "Completata",
  failed: "Non completata",
  cancelled: "Annullata",
};
const tabs = [
  ["chat", "Conversazione", MessageSquare],
  ["activity", "Attività", Activity],
  ["node", "Nodo e rotte", Network],
  ["accounting", "Contabilità", Wallet],
  ["experiments", "Esperimenti", FlaskConical],
  ["settings", "Impostazioni", Settings],
] as const;
const detailContext = createContext<(path: string) => Promise<any>>(
  async () => ({ events: [] }),
);
const jobContext = createContext<ProjectionIndex>(new ProjectionIndex());
function useJob(id: string) {
  const index = useContext(jobContext);
  return useSyncExternalStore(
    (fn) => index.subscribe(id, fn),
    () => index.get(id),
  );
}
function Json({
  value,
  label = "Dettagli",
}: {
  value: unknown;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="details"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>
        {label}
        <ChevronDown size={14} />
      </summary>
      {open && (
        <pre tabIndex={0} aria-label={label}>
          {JSON.stringify(value, null, 2)}
        </pre>
      )}
    </details>
  );
}
function Badge({ state }: { state: string }) {
  return <MiniBadge state={state} />;
}
function ToolCards({ id }: { id: string }) {
  const view = useJob(id);
  const calls = view?.tools ?? new Map<string, any>();
  const [open, setOpen] = useExpansion(id + "|tools");
  const [count, setCount] = useState(24);
  if (!calls.size) return null;
  return (
    <details
      className="tool-group"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>
        <Shield size={14} />
        {calls.size} strumenti utilizzati
      </summary>
      {open && (
        <div className="tool-list">
          {[...calls.entries()].slice(0, count).map(([key, t]) => (
            <ToolRow key={key} call={t} callId={key} jobId={id} />
          ))}
          {calls.size > count && (
            <Button variant="ghost" onClick={() => setCount((n) => n + 24)}>
              Altri strumenti
            </Button>
          )}
        </div>
      )}
    </details>
  );
}
function ToolRow({ call, callId, jobId }: any) {
  const [open, setOpen] = useExpansion(jobId + "|tool:" + callId),
    [detail, setDetail] = useState<any>(null),
    [error, setError] = useState("");
  const api = useContext(detailContext);
  useEffect(() => {
    let active = true;
    if (open && call.detailEventId && !detail)
      void api(
        "jobs/events?jobId=" +
          encodeURIComponent(jobId) +
          "&after=" +
          (call.detailEventId - 1) +
          "&toolCallId=" +
          encodeURIComponent(callId),
      )
        .then((p) => {
          const rows = p.events?.filter(
            (r: any) => r.data.toolCallId === callId,
          );
          const merged = Object.assign(
            {},
            ...rows.map((r: any) => ({ ...r.data, [r.type]: true })),
          );
          if (active) setDetail(rows?.length ? merged : { unavailable: true });
        })
        .catch(() => {
          if (active)
            setError("Dettaglio non disponibile; puoi riaprire per riprovare.");
        });
    return () => {
      active = false;
    };
  }, [open, call.detailEventId, detail, jobId, api]);
  const t = { ...call, ...detail };
  return (
    <details
      className="tool"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>
        <Shield size={14} />
        <span>{t.toolName ?? "Strumento"}</span>
        <Badge
          state={
            t.tool_result
              ? t.isError
                ? "failed"
                : t.unavailable
                  ? "Risultato non disponibile"
                  : "completed"
              : "running"
          }
        />
      </summary>
      {open && (
        <>
          <p className="muted">Eseguito dal backend · {callId}</p>
          {error && <p role="status">{error}</p>}
          {call.detailEventId && !detail ? (
            <p>Caricamento dettaglio…</p>
          ) : (
            <>
              <Json value={t.args ?? null} label="Parametri" />
              {t.tool_result && (
                <Json value={t.result ?? null} label="Risultato" />
              )}
            </>
          )}
        </>
      )}
    </details>
  );
}
const MESSAGE_PARTS = {
  Text: ({ text }: { text: string }) => <Mark>{text}</Mark>,
};
function ChatMessage() {
  if (fixtureCounters.enabled) fixtureCounters.renders++;
  const id = useAuiState((s) => s.message.id);
  const role = useAuiState((s) => s.message.role);
  const view = useJob(id.replace(/:(user|assistant)$/, "")),
    job = view?.job;
  const presentation = job ? messagePresentation(job, view?.text ?? "") : null;
  return (
    <MessagePrimitive.Root className={"message " + role}>
      <div className="message-meta">
        {role === "user"
          ? job?.origin === "owner"
            ? "Tu"
            : job?.origin === "scheduler"
              ? "Richiesta automatica"
              : job?.origin === "qualification"
                ? "Verifica tecnica"
                : "Richiesta · origine non registrata"
          : job?.kind === "analysis"
            ? "Analista · sola lettura"
            : "Coordinatore"}
        {role !== "user" && job && <Badge state={job.state} />}
      </div>
      <MessagePrimitive.Parts components={MESSAGE_PARTS} />
      {role !== "user" && job && (
        <>
          <ToolCards id={job.id} />
          {!!view?.reasoning.size && (
            <Reasoning
              jobId={job.id}
              summaries={[...view.reasoning.values()]}
            />
          )}
          {!presentation?.terminal && view?.progress && (
            <p className="progress-note">{view.progress}</p>
          )}
          <p className="muted">{presentation?.caption}</p>
          {(parseJson(job.result)?.answerDetailAvailable ||
            view?.events.some(
              (e) => e.type === "text" && e.data.bodyDetailAvailable,
            )) && (
            <AnswerPages
              jobId={job.id}
              detailKey={parseJson(job.result)?.answerDetailKey}
            />
          )}
          {job.error && <ErrorDetail jobId={job.id} error={job.error} />}
          {!presentation?.terminal && job.wait_reason && (
            <p className="muted">{job.wait_reason}</p>
          )}
        </>
      )}
    </MessagePrimitive.Root>
  );
}
function ErrorDetail({ jobId, error }: { jobId: string; error: string }) {
  const [open, setOpen] = useExpansion(jobId + "|error");
  return (
    <details
      className="compact-details"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>Dettaglio errore</summary>
      {open && <p className="error">{error}</p>}
    </details>
  );
}
function Reasoning({
  summaries,
  jobId,
}: {
  summaries: string[];
  jobId: string;
}) {
  const [open, setOpen] = useExpansion(jobId + "|reasoning");
  return (
    <details
      className="reasoning-group"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>Ragionamento · sintesi</summary>
      {open && summaries.map((text, i) => <Mark key={i}>{text}</Mark>)}
    </details>
  );
}
function AnswerPages({
  jobId,
  detailKey,
}: {
  jobId: string;
  detailKey?: string;
}) {
  const api = useContext(detailContext),
    [open, setOpen] = useState(false),
    [page, setPage] = useState<any>(null),
    [error, setError] = useState("");
  const read = async (offset = 0) => {
    try {
      setPage(
        await api(
          (detailKey
            ? "chat/answer?key=" + encodeURIComponent(detailKey)
            : "jobs/answer?jobId=" + encodeURIComponent(jobId)) +
            "&offset=" +
            offset,
        ),
      );
      setError("");
    } catch {
      setError("Testo non disponibile.");
    }
  };
  useEffect(() => {
    if (open && !page) void read();
  }, [open]);
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Testo completo · pagine</summary>
      {open && (
        <>
          {error && <p role="status">{error}</p>}
          {page && (
            <>
              <p className="muted">
                Pagina di testo originale, {page.offset}–
                {page.offset + page.text.length} di {page.total} caratteri. La
                sintassi Markdown resta testo nelle pagine parziali.
              </p>
              <pre tabIndex={0}>{page.text}</pre>
              <Button
                variant="ghost"
                disabled={!page.offset}
                onClick={() => void read(Math.max(0, page.offset - 16384))}
              >
                Precedente
              </Button>
              <Button
                variant="ghost"
                disabled={page.nextOffset === null}
                onClick={() => void read(page.nextOffset)}
              >
                Successiva
              </Button>
            </>
          )}
        </>
      )}
    </details>
  );
}
function Panel({
  title,
  children,
  sub,
}: {
  title: string;
  children: React.ReactNode;
  sub?: string;
}) {
  return (
    <section className="panel">
      <h2>{title}</h2>
      {sub && <p className="muted">{sub}</p>}
      {children}
    </section>
  );
}
export function App() {
  const [session, setSession] = useState(
      () => sessionStorage.getItem("satssurge.ownerSession") ?? "",
    ),
    [status, setStatus] = useState<any>(null),
    [auth, setAuth] = useState<any>(null),
    [tab, setTab] = useState("chat"),
    [projection, setProjection] = useState<Projection>(empty),
    [nextBefore, setNextBefore] = useState<number | null>(null),
    [connection, setConnection] = useState("Connessione…"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [older, setOlder] = useState(false),
    [retry, setRetry] = useState(0),
    [password, setPassword] = useState(""),
    [authResponse, setAuthResponse] = useState(""),
    [draft, setDraft] = useState(
      () => parseJson(sessionStorage.getItem(pendingKey))?.message ?? "",
    ),
    [pending, setPending] = useState<Pending | null>(
      () => parseJson(sessionStorage.getItem(pendingKey)) ?? null,
    ),
    [notice, setNotice] = useState(""),
    [unread, setUnread] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null),
    previousPage = useRef(tab + session);
  useEffect(() => {
    const page = tab + session;
    if (previousPage.current !== page) {
      previousPage.current = page;
      if (session) heading.current?.focus();
      else document.getElementById("password")?.focus();
    }
  }, [tab, session]);
  const restoreScroll = useRef<{ height: number; top: number } | null>(null);
  const csrf = useRef(""),
    canonical = useRef(empty),
    scroll = useRef<HTMLDivElement>(null),
    follow = useRef(true),
    currentSession = useRef(session);
  currentSession.current = session;
  const projectionIndex = useRef(new ProjectionIndex()).current;
  const update = useCallback((fn: (p: Projection) => Projection) => {
    canonical.current = fn(canonical.current);
    const paintStart = performance.now();
    projectionIndex.publish(canonical.current);
    setProjection(canonical.current);
    if (fixtureCounters.enabled)
      requestAnimationFrame(() => {
        fixtureCounters.chunks.push(performance.now() - paintStart);
        if (fixtureCounters.chunks.length > 512) fixtureCounters.chunks.shift();
      });
  }, []);
  const api = useCallback(
    async (path: string, body?: unknown, signal?: AbortSignal) => {
      const token = currentSession.current;
      const r = await fetch("/api/" + path, {
        method: body === undefined ? "GET" : "POST",
        credentials: "same-origin",
        headers: requestHeaders(
          token,
          body === undefined ? undefined : csrf.current,
        ),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal,
      });
      const data = await r.json();
      if (r.status === 401 && currentSession.current === token) {
        expireSession(sessionStorage, token);
        setSession("");
        setStatus(null);
        setConnection("Accesso richiesto");
      }
      if (!r.ok)
        throw Object.assign(new Error(data.error ?? `Errore ${r.status}`), {
          status: r.status,
          admissionRejected: data.admissionRejected === true,
        });
      return data;
    },
    [],
  );
  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      const started = currentSession.current;
      const [s, a] = await Promise.all([
        api("status", undefined, signal),
        api("auth", undefined, signal),
      ]);
      if (signal?.aborted || started !== currentSession.current) return;
      csrf.current = s.csrf;
      setStatus(s);
      setAuth(a);
      update((p) => mergeEvents(mergeJobs(p, s.jobs ?? []), [], false));
    },
    [api, update],
  );
  useEffect(() => {
    if (!session) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let polling: ReturnType<typeof setInterval>;
    const history = async (reset = false) => {
      const h = await api("history", undefined, controller.signal);
      if (controller.signal.aborted) return;
      update((p) => mergeHistory(p, h, reset));
      setNextBefore(h.nextBefore);
    };
    void (async () => {
      try {
        await Promise.all([refresh(controller.signal), history(true)]);
        polling = setInterval(
          () =>
            void refresh(controller.signal).catch((e) => {
              if (!controller.signal.aborted) setError(e.message);
            }),
          5000,
        );
        for await (const change of ownerEventStream({
          session,
          signal: controller.signal,
          cursor: () => canonical.current.cursor,
        })) {
          if (controller.signal.aborted) break;
          if (change.type === "resync") await history(true);
          else if (change.type === "expired") {
            expireSession(sessionStorage, session);
            setSession("");
            break;
          } else if (change.type === "connection") {
            setConnection(
              change.state === "online"
                ? "In tempo reale"
                : change.state === "connecting"
                  ? "Riconnessione…"
                  : "Offline · riconnessione",
            );
            if (change.state === "online") setError("");
          } else {
            const unknown = change.events.some(
              (e) => !canonical.current.jobs[e.job_id],
            );
            update((p) => mergeEvents(p, change.events));
            if (unknown) void refresh(controller.signal).catch(() => {});
          }
        }
      } catch (e: any) {
        if (!controller.signal.aborted) {
          setError(e.message);
          setConnection("Connessione non disponibile");
          timer = setTimeout(() => setRetry((v) => v + 1), 2500);
        }
      }
    })();
    return () => {
      controller.abort();
      clearTimeout(timer);
      clearInterval(polling);
    };
  }, [session, refresh, api, update, retry]);
  const jobs = useMemo(
    () =>
      Object.values(projection.jobs).sort(
        (a, b) =>
          String(a.created_at ?? "").localeCompare(
            String(b.created_at ?? ""),
          ) || (a.history_id ?? 0) - (b.history_id ?? 0),
      ),
    [projection.jobs],
  );
  const messageCache = useRef(
    new Map<
      string,
      { job: Job; text: string; messages: ThreadMessageLike[] }
    >(),
  );
  const messages = useMemo<ThreadMessageLike[]>(
    () =>
      jobs
        .filter((j) => parseJson(j.payload)?.message)
        .flatMap((j) => {
          const text =
              projectionIndex.get(j.id)?.text ?? answerFor(projection, j.id),
            old = messageCache.current.get(j.id);
          if (old?.job === j && old.text === text) return old.messages;
          const result: ThreadMessageLike[] = [
            {
              id: j.id + ":user",
              role: "user",
              content: [
                { type: "text", text: String(parseJson(j.payload).message) },
              ],
            },
            {
              id: j.id + ":assistant",
              role: "assistant",
              status: messageStatus(j),
              content: [
                {
                  type: "text",
                  text: messagePresentation(j, text).body,
                },
              ],
            },
          ];
          messageCache.current.set(j.id, { job: j, text, messages: result });
          return result;
        }),
    [jobs, projection],
  );
  pruneExpansions(new Set(Object.keys(projection.jobs)));
  for (const id of messageCache.current.keys())
    if (!projection.jobs[id]) messageCache.current.delete(id);
  const submit = useCallback(
    async (kind: Pending["kind"], message = draft) => {
      if (busy || !message.trim()) return;
      setBusy(true);
      setError("");
      try {
        const p = pendingSubmission(sessionStorage, message.trim(), kind, () =>
          ownerRequestId(),
        );
        setPending(p);
        const accepted = await api(kind === "analysis" ? "analyze" : "chat", {
          message: p.message,
          requestId: p.requestId,
        });
        if (!accepted.job?.id) throw Error("Ricevuta non disponibile");
        update((s) => mergeJobs(s, [accepted.job]));
        sessionStorage.removeItem(pendingKey);
        setPending(null);
        setDraft("");
        setNotice("Richiesta accettata · " + accepted.job.id);
        follow.current = true;
        await refresh().catch(() => {});
      } catch (e: any) {
        setError(e.message);
        if (e.admissionRejected) {
          sessionStorage.removeItem(pendingKey);
          setPending(null);
        }
        setNotice(
          e.admissionRejected
            ? "Richiesta rifiutata prima dell’ammissione: puoi correggere il messaggio."
            : "Se la richiesta è salvata, riprova con lo stesso identificatore.",
        );
      } finally {
        setBusy(false);
      }
    },
    [api, draft, busy, update, refresh],
  );
  const repositoryCache = useRef(new WeakMap<object, any>()).current;
  const runtime = useExternalStoreRuntime({
    convertMessage: identityMessage,
    messageRepository: useMemo(
      () => repositoryFor(messages, repositoryCache),
      [messages],
    ),
    isRunning: false,
    onNew: async (message) => {
      const text = message.content
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n");
      await submit("chat", text);
    },
  });
  const latestFingerprint = useMemo(
    () =>
      messages
        .slice(-2)
        .map((m) => m.id + JSON.stringify(m.content) + JSON.stringify(m.status))
        .join("|") + projection.events.reduce((id, e) => Math.max(id, e.id), 0),
    [messages, projection.events],
  );
  useEffect(() => {
    if (tab !== "chat") return;
    const el = scroll.current;
    if (!el) return;
    if (follow.current) {
      const followLatest = () => {
        if (follow.current) el.scrollTop = el.scrollHeight;
      };
      const observer = new MutationObserver(followLatest);
      observer.observe(el, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      followLatest();
      setUnread(false);
      return () => observer.disconnect();
    }
    setUnread(true);
  }, [latestFingerprint, tab]);
  const mutate = async (path: string, body: unknown = {}) => {
    setBusy(true);
    setError("");
    try {
      await api(path, body);
      await refresh();
      return true;
    } catch (e: any) {
      setError(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const loadOlder = async () => {
    if (!nextBefore) return;
    setOlder(true);
    const el = scroll.current,
      oldHeight = el?.scrollHeight ?? 0;
    follow.current = false;
    try {
      const h = await api("history?before=" + nextBefore);
      restoreScroll.current = { height: oldHeight, top: el?.scrollTop ?? 0 };
      update((p) => mergeHistory(p, h));
      setNextBefore(h.nextBefore);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setOlder(false);
    }
  };
  const recentHistory = async () => {
    setOlder(true);
    try {
      const h = await api("history");
      update((p) => mergeHistory(p, h, true));
      setNextBefore(h.nextBefore);
      follow.current = true;
      setNotice("Cronologia recente caricata.");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setOlder(false);
    }
  };
  const recover = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      const r = await api(
        "jobs/receipt?requestId=" + encodeURIComponent(pending.requestId),
      );
      update((p) => mergeJobs(p, [r.job]));
      sessionStorage.removeItem(pendingKey);
      setPending(null);
      setDraft("");
      setNotice("Ricevuta recuperata · " + r.job.id);
    } catch (e: any) {
      setError(
        e.status === 404
          ? "Nessuna ricevuta: puoi reinviare la richiesta salvata."
          : e.message,
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="shell">
      <a className="skip" href="#main">
        Vai al contenuto
      </a>
      <aside className="sidebar">
        <a className="brand" href="/">
          <span className="logo">
            <Zap size={23} />
          </span>
          <span>
            SatsSurge<small>AUTOPILOT</small>
          </span>
        </a>
        <div className="workspace">
          <span className="dot" /> Lightning workspace{" "}
          <small>Console del proprietario</small>
        </div>
        <nav aria-label="Navigazione principale">
          {tabs.map(([id, label, Icon]) => (
            <button
              key={id}
              aria-current={tab === id ? "page" : undefined}
              onClick={() => {
                if (id === "chat") follow.current = true;
                setTab(id);
              }}
            >
              <Icon size={18} />
              {label}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <Shield size={17} />
          <span>
            Mandato protetto<small>Un solo esecutore finanziario</small>
          </span>
        </div>
      </aside>
      <div className="workspace-main">
        <header className="topbar">
          <ThemePicker />
          <span className="breadcrumb">
            Workspace <span>/</span>{" "}
            <strong>{tabs.find((t) => t[0] === tab)?.[1]}</strong>
          </span>
          <span className="connection" role="status">
            <span
              className={
                "dot " + (connection === "In tempo reale" ? "live" : "")
              }
            />
            {connection}
          </span>
          {status && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void mutate(status.enabled ? "pause" : "resume")}
            >
              {status.enabled ? <Pause size={14} /> : <Play size={14} />}{" "}
              {status.enabled ? "Pausa" : "Riprendi"}
            </Button>
          )}
        </header>
        <main id="main" tabIndex={-1}>
          <div className="page-heading">
            <div>
              <span className="eyebrow">LIGHTNING OPERATIONS</span>
              <h1 tabIndex={-1} ref={heading}>
                {tabs.find((t) => t[0] === tab)?.[1]}
              </h1>
              <p>
                {tab === "chat"
                  ? "Il tuo nodo, una conversazione continua."
                  : "Dati osservati. Risultati misurabili."}
              </p>
            </div>
            {status && (
              <Badge state={status.enabled ? "Autonomia attiva" : "In pausa"} />
            )}
          </div>
          {error && (
            <div className="notice error" role="alert">
              <AlertCircle size={17} />
              {error}
              <Button variant="ghost" size="sm" onClick={() => setError("")}>
                Chiudi
              </Button>
            </div>
          )}
          {!session ? (
            <Panel
              title="Accedi al tuo workspace"
              sub="La password privata dell’installazione si trova in data/owner.secret sul tuo Umbrel."
            >
              <form
                className="login-form"
                onSubmit={async (e) => {
                  e.preventDefault();
                  setBusy(true);
                  try {
                    const r = await api("owner/login", { password });
                    sessionStorage.setItem("satssurge.ownerSession", r.session);
                    setPassword("");
                    setError("");
                    setSession(r.session);
                  } catch (e: any) {
                    setError(e.message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <label htmlFor="password">Password del proprietario</label>
                <input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <Button type="submit" disabled={busy}>
                  {busy ? "Accesso…" : "Accedi"}
                </Button>
              </form>
            </Panel>
          ) : !status ? (
            <Panel title="Caricamento workspace">
              <p role="status">Recupero stato, autenticazione e cronologia…</p>
              <Button
                variant="outline"
                onClick={() => void refresh().catch((e) => setError(e.message))}
              >
                Riprova
              </Button>
            </Panel>
          ) : (
            <>
              {(status.blockers ?? []).map((b: string, i: number) => (
                <div className="notice" key={i}>
                  {b}
                </div>
              ))}
              {tab === "chat" && (
                <div className="chat-layout">
                  <section className="chat-panel">
                    <div className="panel-title">
                      <span>
                        <Zap size={17} /> Coordinatore & analisti
                      </span>
                      <small>
                        Pi Durable ·{" "}
                        {auth?.thinkingLevel ?? "livello non disponibile"}
                      </small>
                    </div>
                    <detailContext.Provider value={api}>
                      <jobContext.Provider value={projectionIndex}>
                        <FixtureMetrics
                          enabled={status?.uiFixture === true}
                          runtime={runtime}
                        />
                        <AssistantRuntimeProvider runtime={runtime}>
                          <ThreadPrimitive.Root className="thread">
                            <div
                              className="chat-scroll"
                              ref={scroll}
                              onScroll={(e) => {
                                const el = e.currentTarget;
                                follow.current =
                                  el.scrollHeight -
                                    el.scrollTop -
                                    el.clientHeight <
                                  80;
                                if (follow.current) setUnread(false);
                              }}
                            >
                              {projection.truncatedHistory && (
                                <div role="status">
                                  Sono visibili al massimo 250 richieste
                                  concluse e quelle attive. Puoi continuare a
                                  leggere le pagine precedenti.{" "}
                                  <Button
                                    variant="ghost"
                                    disabled={older}
                                    onClick={() => void recentHistory()}
                                  >
                                    Torna ai recenti
                                  </Button>
                                </div>
                              )}
                              {nextBefore && (
                                <Button
                                  variant="ghost"
                                  disabled={older}
                                  onClick={() => void loadOlder()}
                                >
                                  {older
                                    ? "Caricamento…"
                                    : "Carica cronologia precedente"}
                                </Button>
                              )}
                              {!messages.length && (
                                <div className="chat-empty">
                                  <span className="empty-logo">
                                    <Zap size={30} />
                                  </span>
                                  <h2>Conosci meglio il tuo nodo.</h2>
                                  <p>
                                    Chiedi al coordinatore di leggere le
                                    evidenze oppure avvia un’analisi in sola
                                    lettura.
                                  </p>
                                  <Button
                                    variant="outline"
                                    onClick={() =>
                                      setDraft(
                                        "Quali evidenze sono disponibili sul mio nodo?",
                                      )
                                    }
                                  >
                                    Quali evidenze sono disponibili?
                                  </Button>
                                  <Button
                                    variant="outline"
                                    onClick={() =>
                                      setDraft(
                                        "Analizza la liquidità e le commissioni dei canali.",
                                      )
                                    }
                                  >
                                    Analizza i canali
                                  </Button>
                                </div>
                              )}
                              <VirtualMessages
                                scroll={scroll}
                                Message={ChatMessage}
                                follow={follow}
                              />
                            </div>
                            {unread && (
                              <Button
                                className="new-messages"
                                variant="outline"
                                onClick={() => {
                                  follow.current = true;
                                  scroll.current?.scrollTo({
                                    top: scroll.current.scrollHeight,
                                  });
                                  setUnread(false);
                                }}
                              >
                                <ArrowDown size={15} /> Nuovi aggiornamenti
                              </Button>
                            )}
                            <form
                              className="composer"
                              onSubmit={(e) => {
                                e.preventDefault();
                                void submit(pending?.kind ?? "chat");
                              }}
                            >
                              <label className="sr-only" htmlFor="message">
                                Messaggio al coordinatore
                              </label>
                              <textarea
                                id="message"
                                value={draft}
                                disabled={busy || !!pending}
                                onChange={(e) => setDraft(e.target.value)}
                                placeholder="Chiedi al tuo agente…"
                                rows={3}
                              />
                              <div className="composer-actions">
                                <span>
                                  <Shield size={13} /> Mandato applicato dal
                                  backend
                                </span>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  disabled={busy || !draft.trim() || !!pending}
                                  onClick={() => void submit("analysis")}
                                >
                                  Analisi in sola lettura
                                </Button>
                                <Button
                                  size="sm"
                                  disabled={busy || !draft.trim()}
                                  type="submit"
                                >
                                  <ArrowUp size={16} />
                                  {busy
                                    ? "Invio…"
                                    : pending
                                      ? "Riprova"
                                      : "Invia"}
                                </Button>
                              </div>
                              {pending && (
                                <div className="pending">
                                  Richiesta salvata in attesa di conferma.
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    disabled={busy}
                                    onClick={() => void recover()}
                                  >
                                    Recupera ricevuta
                                  </Button>
                                </div>
                              )}
                              <p className="composer-status" role="status">
                                {notice ||
                                  (projection.truncatedEvents
                                    ? "Dettagli più vecchi limitati in memoria; ricevute e cronologia restano persistite."
                                    : "La chat può proporre interventi entro il mandato. Le analisi restano in sola lettura.")}
                              </p>
                            </form>
                          </ThreadPrimitive.Root>
                        </AssistantRuntimeProvider>
                      </jobContext.Provider>
                    </detailContext.Provider>
                  </section>
                  <div className="chat-aside">
                    <Panel title="Stato operativo">
                      <Badge
                        state={status.enabled ? "Autonomia attiva" : "In pausa"}
                      />
                      <dl>
                        <dt>Coordinatore</dt>
                        <dd>
                          {status.pool?.coordinatorRunning
                            ? "Occupato"
                            : "Disponibile"}
                        </dd>
                        <dt>Analisti</dt>
                        <dd>
                          {status.pool?.analystRunning ?? 0} /{" "}
                          {status.pool?.maxAnalysts ?? 2}
                        </dd>
                        <dt>Modello</dt>
                        <dd>{auth?.selected ?? "Non selezionato"}</dd>
                        <dt>Codex</dt>
                        <dd>
                          {auth?.connected ? "Collegato" : "Da collegare"}
                        </dd>
                      </dl>
                      {!auth?.connected && (
                        <Button
                          variant="outline"
                          onClick={() => setTab("settings")}
                        >
                          Collega ChatGPT
                        </Button>
                      )}
                    </Panel>
                    <Panel title="Budget disponibile">
                      <strong className="large-number">
                        {sats(status.budget?.remainingMsat)} <small>sat</small>
                      </strong>
                      <BudgetGauges
                        budget={status.budget}
                        mandate={status.mandate}
                        compact
                      />
                      <div className="protected">
                        <Shield size={15} /> Riserva protetta · 500.000 sat
                      </div>
                    </Panel>
                    <Panel title="Liquidità del nodo">
                      <Liquidity
                        channels={status.snapshot?.channels ?? []}
                        compact
                      />
                    </Panel>
                  </div>
                </div>
              )}
              {tab === "activity" && (
                <>
                  <div className="stats-row">
                    <Panel title="Coordinatore">
                      <strong>
                        {status.pool?.coordinatorRunning
                          ? "Occupato"
                          : "Disponibile"}
                      </strong>
                    </Panel>
                    <Panel title="Analisti">
                      <strong>
                        {status.pool?.analystRunning ?? 0} /{" "}
                        {status.pool?.maxAnalysts ?? 2}
                      </strong>
                    </Panel>
                    <Panel title="Attesa media">
                      <strong>
                        {status.queue?.averageWaitMs == null
                          ? "Non disponibile"
                          : Math.round(status.queue.averageWaitMs / 1000) +
                            " s"}
                      </strong>
                    </Panel>
                  </div>
                  <Panel
                    title="Coda persistente"
                    sub={
                      "Limite " +
                      (status.queue?.maxPending ?? 100) +
                      " richieste · un solo esecutore finanziario"
                    }
                  >
                    <QueueChart states={status.queue?.states ?? []} />
                    {!jobs.length && (
                      <p className="empty">Nessuna attività registrata.</p>
                    )}
                    <detailContext.Provider value={api}>
                      <jobContext.Provider value={projectionIndex}>
                        {[...jobs].reverse().map((j) => (
                          <article className="job" key={j.id}>
                            <div className="row-heading">
                              <h3>
                                {j.kind === "analysis"
                                  ? "Analista · sola lettura"
                                  : j.kind === "chat"
                                    ? "Coordinatore · chat"
                                    : j.kind}
                              </h3>
                              <Badge state={j.state} />
                              {canCancel(j) && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  disabled={busy}
                                  onClick={() =>
                                    void mutate("jobs/cancel", { id: j.id })
                                  }
                                >
                                  Annulla
                                </Button>
                              )}
                            </div>
                            <span className="job-date">
                              {j.created_at
                                ? new Date(j.created_at).toLocaleString(
                                    "it-IT",
                                    {
                                      dateStyle: "short",
                                      timeStyle: "short",
                                    },
                                  )
                                : "Data non disponibile"}
                            </span>
                            {j.error && (
                              <ErrorDetail jobId={j.id} error={j.error} />
                            )}
                            <details className="compact-details">
                              <summary>Messaggio e attività</summary>
                              <p>{parseJson(j.payload)?.message}</p>
                              <small className="muted">
                                {j.id} · {j.lane ?? "corsia non specificata"}
                              </small>
                              {j.wait_reason && (
                                <p className="muted">{j.wait_reason}</p>
                              )}
                              <ToolCards id={j.id} />
                              {answerFor(projection, j.id) && (
                                <Mark>{answerFor(projection, j.id)}</Mark>
                              )}
                            </details>
                          </article>
                        ))}
                      </jobContext.Provider>
                    </detailContext.Provider>
                    {nextBefore && (
                      <Button
                        variant="outline"
                        disabled={older}
                        onClick={() => void loadOlder()}
                      >
                        Carica altre attività
                      </Button>
                    )}
                  </Panel>
                </>
              )}
              {tab === "node" && (
                <>
                  <Panel
                    title="Distribuzione della liquidità"
                    sub={
                      "Snapshot · " +
                      (status.snapshot?.at ?? "non ancora disponibile")
                    }
                  >
                    <Liquidity channels={status.snapshot?.channels ?? []} />
                    <details className="compact-details">
                      <summary>Tabella completa dei canali</summary>
                      <div
                        className="table-wrap"
                        tabIndex={0}
                        role="region"
                        aria-label="Canali Lightning, tabella scorrevole"
                      >
                        <table>
                          <thead>
                            <tr>
                              <th>Canale</th>
                              <th>Uscita / ingresso</th>
                              <th>Commissioni</th>
                              <th>Stato</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(status.snapshot?.channels ?? []).map(
                              (c: any, i: number) => (
                                <tr key={c.id ?? i}>
                                  <td>
                                    <strong>{c.alias}</strong>
                                    <small>{c.id}</small>
                                  </td>
                                  <td>
                                    {satLabel(c.localSat, false)} /{" "}
                                    {satLabel(c.remoteSat, false)}
                                  </td>
                                  <td>
                                    {c.ppm} ppm + {c.baseMsat} msat
                                  </td>
                                  <td>
                                    <Badge
                                      state={c.active ? "Attivo" : "Offline"}
                                    />
                                  </td>
                                </tr>
                              ),
                            )}
                          </tbody>
                        </table>
                        {!status.snapshot?.channels?.length && (
                          <p className="empty">Nessun canale acquisito.</p>
                        )}
                      </div>
                    </details>
                    <Json
                      value={status.snapshot}
                      label="Snapshot completo del nodo"
                    />
                  </Panel>
                  <div className="two-columns">
                    <Panel
                      title="Diagnostica delle rotte"
                      sub="HTLC, pagamenti e riepiloghi restano fonti distinte."
                    >
                      {["lndg", "lightningMate"].map((name) => {
                        const d = status.diagnostics?.[name];
                        return (
                          <article className="record" key={name}>
                            <h3>
                              {name === "lndg" ? "LNDg" : "Lightning Mate"}{" "}
                              <Badge state={d?.status ?? "Non disponibile"} />
                            </h3>
                            {d?.status === "qualified" ? (
                              <>
                                <div className="key-metrics">
                                  <span>
                                    Record di errore
                                    <strong className="tone-danger">
                                      {d.failures?.length ?? "Non disponibili"}
                                    </strong>
                                  </span>
                                  <span>
                                    Rebalance nel log
                                    <strong>
                                      {d.rebalances?.length ??
                                        "Non disponibili"}
                                    </strong>
                                  </span>
                                </div>
                                <p className="chart-note">
                                  Copertura{" "}
                                  {d.coverage?.complete
                                    ? "completa"
                                    : "parziale"}
                                </p>
                                <details className="compact-details">
                                  <summary>Fonte e acquisizione</summary>
                                  <p>
                                    Versione · {d.version ?? "sconosciuta"} ·{" "}
                                    {d.capturedAt ?? "data non disponibile"}
                                  </p>
                                  <p>{d.coverage?.note}</p>
                                  <Json
                                    value={d}
                                    label="Evidenze della fonte"
                                  />
                                </details>
                              </>
                            ) : (
                              <p>
                                {d?.reason ?? "Esportazione non disponibile"}
                              </p>
                            )}
                          </article>
                        );
                      })}
                    </Panel>
                    <Panel
                      title="Confronto commissioni"
                      sub="Prezzi annunciati: non provano rotte eseguibili, liquidità, domanda o redditività."
                    >
                      <FeeChart capture={status.competition} />
                    </Panel>
                  </div>
                  <Panel title="Copertura e inizializzazione">
                    <Json
                      label="Collector, importazione e limiti osservati"
                      value={{
                        collector: status.collector,
                        diagnostics: status.diagnostics,
                        coverage: status.coverage,
                        import: status.importReport,
                        partialAccounting: status.partial,
                      }}
                    />
                  </Panel>
                </>
              )}
              {tab === "accounting" && (
                <>
                  <div className="stats-row financial-metrics">
                    {[
                      {
                        title: "Ricavi · 30 giorni",
                        value: status.pnl30?.revenueMsat,
                        tone: "success",
                        icon: "↗",
                      },
                      {
                        title: "Costi · 30 giorni",
                        value: status.pnl30?.costMsat,
                        tone: "danger",
                        icon: "↘",
                      },
                      {
                        title: status.partial
                          ? "Risultato parziale"
                          : "Risultato netto",
                        value: status.pnl30?.netMsat,
                        tone: financialTone(status.pnl30?.netMsat),
                        icon: "=",
                      },
                    ].map((m) => (
                      <Panel key={m.title} title={m.title}>
                        <strong className={"large-number tone-" + m.tone}>
                          <span className="metric-symbol">{m.icon}</span>
                          {satLabel(m.value)}
                        </strong>
                      </Panel>
                    ))}
                  </div>
                  <Panel title="Ricavi e costi · 30 giorni">
                    <AccountingChart pnl={status.pnl30} label="30 giorni" />
                  </Panel>
                  {status.partial && (
                    <div className="notice">
                      Contabilità parziale: copertura storica o costi di
                      sottoscrizione incompleti.
                    </div>
                  )}
                  <div className="two-columns">
                    <Panel title="Budget e riserva">
                      <BudgetGauges
                        budget={status.budget}
                        mandate={status.mandate}
                      />
                      <div className="budget-remaining">
                        Residuo
                        <strong>
                          {satLabel(status.budget?.remainingMsat)}
                        </strong>
                      </div>
                      <Json value={status.budget} label="Budget completo" />
                      <Json value={status.mandate} label="Mandato applicato" />
                    </Panel>
                    <Panel title="Contabilità cumulativa">
                      <AccountingChart
                        pnl={status.cumulative}
                        label="Contabilità cumulativa"
                      />
                      <Json value={status.modelUsage} label="Uso del modello" />
                    </Panel>
                  </div>
                  <Panel title="Operazioni registrate">
                    <Json
                      value={status.operations}
                      label="Stato, riconciliazione e dettagli"
                    />
                  </Panel>
                </>
              )}
              {tab === "experiments" && (
                <>
                  <Panel
                    title="Decisioni ed esperimenti"
                    sub="Ogni intervento conserva problema, evidenze, ipotesi e previsione."
                  >
                    {!status.decisions?.length && (
                      <p className="empty">
                        Nessun intervento. Attesa di evidenze qualificate.
                      </p>
                    )}
                    {(status.decisions ?? []).map((d: any) => (
                      <article className="record" key={d.id}>
                        <div className="row-heading">
                          <h3>{d.proposal.problem}</h3>
                          <Badge state={d.status} />
                        </div>
                        <div className="key-metrics">
                          <span>
                            Limite costo
                            <strong className="tone-danger">
                              {satLabel(d.proposal.maxFeeMsat)}
                            </strong>
                          </span>
                          <span>
                            Beneficio previsto
                            <strong className="tone-success">
                              {satLabel(d.forecast.benefitMsat)}
                            </strong>
                          </span>
                        </div>
                        <details className="compact-details">
                          <summary>Evidenze e ipotesi</summary>
                          <p>{d.proposal.whyAct}</p>
                          <p>{d.proposal.evidence}</p>
                          <p>
                            <strong>Ipotesi · </strong>
                            {d.proposal.hypothesis}
                          </p>
                          <p>
                            <strong>Verifica · </strong>
                            {d.proposal.verify}
                          </p>
                          <small>{d.at}</small>
                        </details>
                        <Json value={d} label="Decisione completa" />
                      </article>
                    ))}
                  </Panel>
                  <Panel
                    title="Previsioni e risultati · 7 / 30 giorni"
                    sub="I ricavi osservati non provano un beneficio causale. Dati mancanti e interventi manuali limitano il confronto."
                  >
                    {!status.evaluationWindows?.length && (
                      <p className="empty">
                        Nessuna finestra di valutazione ancora maturata.
                      </p>
                    )}
                    {(status.evaluationWindows ?? []).map(
                      (r: any, i: number) => (
                        <article className="record" key={i}>
                          <h3>
                            {r.horizon_days} giorni · revisione {r.revision}{" "}
                            <Badge state={r.status} />
                          </h3>
                          <div className="key-metrics">
                            <span>
                              Contributo osservato
                              <strong
                                className={
                                  "tone-" +
                                  financialTone(
                                    r.result.observedContributionMsat,
                                  )
                                }
                              >
                                {satLabel(r.result.observedContributionMsat)}
                              </strong>
                            </span>
                            <span>
                              Costi
                              <strong className="tone-danger">
                                {satLabel(r.result.costMsat)}
                              </strong>
                            </span>
                            <span>
                              Inoltri
                              <strong>
                                {r.result.samples ?? "Non disponibili"}
                              </strong>
                            </span>
                          </div>
                          <p className="chart-note">
                            Copertura{" "}
                            {r.result.coverageComplete
                              ? "completa nella finestra"
                              : "incompleta"}
                          </p>
                          <Json
                            value={r.result}
                            label="Previsione originale, ipotesi e limiti"
                          />
                        </article>
                      ),
                    )}
                  </Panel>
                  <Panel title="Vincoli e osservazioni">
                    <Json
                      value={{
                        claims: status.claims,
                        holds: status.holds,
                        evaluations: status.evaluations,
                      }}
                    />
                  </Panel>
                </>
              )}
              {tab === "settings" && (
                <>
                  <Panel
                    title="Sottoscrizione Codex"
                    sub="Accesso OAuth tramite ChatGPT. Nessuna chiave API e nessun ripiego a consumo."
                  >
                    <div className="row-heading">
                      <Badge
                        state={auth?.connected ? "Collegato" : "Da collegare"}
                      />
                      <Button
                        disabled={busy || auth?.busy}
                        onClick={() => void mutate("auth/start")}
                      >
                        {auth?.busy
                          ? "Accesso in corso…"
                          : auth?.connected
                            ? "Ricollega ChatGPT"
                            : "Collega ChatGPT"}
                      </Button>
                    </div>
                    <div role="status">
                      {(auth?.events ?? []).map((e: any, i: number) => (
                        <p key={i}>
                          {e.message ?? e.instructions ?? e.userCode ?? ""}{" "}
                          {safeUrl(e.url ?? e.verificationUri ?? "") && (
                            <a
                              href={safeUrl(e.url ?? e.verificationUri)}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              Apri accesso sicuro ↗
                            </a>
                          )}
                        </p>
                      ))}
                    </div>
                    {auth?.prompt && (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          void mutate("auth/respond", {
                            value: authResponse,
                          }).then((ok) => {
                            if (ok) setAuthResponse("");
                          });
                        }}
                      >
                        <label htmlFor="auth-response">
                          {auth.prompt.message}
                        </label>
                        <input
                          id="auth-response"
                          type="password"
                          autoComplete="off"
                          required
                          value={authResponse}
                          onChange={(e) => setAuthResponse(e.target.value)}
                        />
                        <Button type="submit" disabled={busy}>
                          Completa accesso
                        </Button>
                      </form>
                    )}
                    <label htmlFor="model">Modello</label>
                    <select
                      id="model"
                      value={auth?.selected ?? ""}
                      disabled={busy || !auth?.models?.length}
                      onChange={(e) =>
                        void mutate("model", { model: e.target.value })
                      }
                    >
                      <option value="" disabled>
                        Seleziona modello
                      </option>
                      {(auth?.models ?? []).map((m: any) => (
                        <option value={m.id} key={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                    <p className="muted">
                      Ragionamento · {auth?.thinkingLevel ?? "non disponibile"}
                    </p>
                  </Panel>
                  <Panel title="Sessione del proprietario">
                    <p>La sessione resta nel browser corrente.</p>
                    <Button
                      variant="outline"
                      onClick={async () => {
                        try {
                          await api("owner/logout", {});
                        } catch (e: any) {
                          setError(e.message);
                          return;
                        }
                        sessionStorage.removeItem("satssurge.ownerSession");
                        setSession("");
                        setStatus(null);
                        setProjection(empty);
                        canonical.current = empty;
                      }}
                    >
                      <LogOut size={16} /> Esci dal workspace
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        void refresh().catch((e) => setError(e.message))
                      }
                    >
                      <RefreshCw size={16} /> Aggiorna connessione
                    </Button>
                  </Panel>
                  <Panel title="Disponibilità delle funzioni">
                    <ul>
                      {(status.roadmap ?? []).map((r: string) => (
                        <li key={r}>{r}</li>
                      ))}
                    </ul>
                    <Json value={status.agent} label="Stato agente" />
                  </Panel>
                </>
              )}
            </>
          )}
        </main>
        <footer>
          SatsSurge Autopilot <span>·</span> Evidenze prima delle decisioni{" "}
          <span>·</span> M2.1
        </footer>
      </div>
    </div>
  );
}
