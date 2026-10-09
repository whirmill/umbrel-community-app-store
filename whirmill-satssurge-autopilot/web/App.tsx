import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  createContext,
  useContext,
} from "react";
import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  MessagePrimitive,
  useExternalStoreRuntime,
  useAuiState,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import Markdown from "react-markdown";
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
import { Button } from "./components/ui/button";
import {
  answerFor,
  canCancel,
  mergeEvents,
  mergeJobs,
  mergeHistory,
  messageStatus,
  parseJson,
  pendingSubmission,
  ownerRequestId,
  pendingKey,
  requestHeaders,
  expireSession,
  safeUrl,
  sats,
  sseFrames,
  type Projection,
  type Job,
  type Pending,
} from "../src/ui-client";
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
const jobContext = createContext<Projection>(empty);
function Json({
  value,
  label = "Dettagli",
}: {
  value: unknown;
  label?: string;
}) {
  return (
    <details className="details">
      <summary>
        {label}
        <ChevronDown size={14} />
      </summary>
      <pre tabIndex={0} aria-label={label}>
        {JSON.stringify(value, null, 2)}
      </pre>
    </details>
  );
}
function Mark({ children }: { children: string }) {
  return (
    <div className="markdown">
      <Markdown
        skipHtml
        urlTransform={(url) => safeUrl(url) ?? ""}
        components={{
          img: () => null,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          pre: ({ children }) => <pre tabIndex={0}>{children}</pre>,
        }}
      >
        {children}
      </Markdown>
    </div>
  );
}
function Badge({ state }: { state: string }) {
  return <span className={"badge " + state}>{labels[state] ?? state}</span>;
}
function ToolCards({ id }: { id: string }) {
  const p = useContext(jobContext);
  const calls = new Map<string, any>();
  for (const e of p.events.filter(
    (e) => e.job_id === id && ["tool_call", "tool_result"].includes(e.type),
  )) {
    const key = e.data.toolCallId;
    calls.set(key, { ...calls.get(key), ...e.data, [e.type]: true });
  }
  return (
    <div className="tool-list">
      {[...calls.entries()].map(([key, t]) => (
        <details className="tool" key={key}>
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
          <p className="muted">Eseguito dal backend · {key}</p>
          {t.argsAvailable === false ? (
            <p className="muted">
              Parametri non disponibili nello snapshot di recupero.
            </p>
          ) : (
            <Json value={t.args} label="Parametri" />
          )}
          {t.tool_result && <Json value={t.result} label="Risultato" />}
        </details>
      ))}
    </div>
  );
}
function ChatMessage() {
  const id = useAuiState((s) => s.message.id);
  const role = useAuiState((s) => s.message.role);
  const p = useContext(jobContext),
    job = p.jobs[id.replace(/:(user|assistant)$/, "")];
  return (
    <MessagePrimitive.Root className={"message " + role}>
      <div className="message-meta">
        {role === "user"
          ? "Tu"
          : job?.kind === "analysis"
            ? "Analista · sola lettura"
            : "Coordinatore"}
        {role !== "user" && job && <Badge state={job.state} />}
      </div>
      <MessagePrimitive.Parts
        components={{ Text: ({ text }) => <Mark>{text}</Mark> }}
      />
      {role !== "user" && job && (
        <>
          <ToolCards id={job.id} />
          {p.events
            .filter((e) => e.job_id === job.id && e.type === "progress")
            .at(-1) && (
            <p className="progress-note">
              {(
                {
                  run_start: "Pi ha avviato il lavoro",
                  turn_start: "Risposta in elaborazione",
                  turn_end: "Passaggio completato",
                  run_end: "Pi ha terminato il lavoro",
                  compaction_start: "Pi sta compattando il contesto",
                  compaction_end: "Contesto aggiornato",
                  resynchronized: "Cronologia sincronizzata",
                } as Record<string, string>
              )[
                p.events
                  .filter((e) => e.job_id === job.id && e.type === "progress")
                  .at(-1)!.data.state
              ] ?? "Aggiornamento da Pi Durable"}
            </p>
          )}
          {job.error && <p className="error">{job.error}</p>}
          {job.wait_reason && <p className="muted">{job.wait_reason}</p>}
        </>
      )}
    </MessagePrimitive.Root>
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
  const update = useCallback((fn: (p: Projection) => Projection) => {
    canonical.current = fn(canonical.current);
    setProjection(canonical.current);
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
    const wait = () =>
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 1800);
        controller.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
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
        while (!controller.signal.aborted) {
          try {
            setConnection("Riconnessione…");
            const r = await fetch(
              "/api/events?after=" + canonical.current.cursor,
              {
                credentials: "same-origin",
                headers: requestHeaders(session),
                signal: controller.signal,
              },
            );
            if (r.status === 409) {
              await history(true);
              continue;
            }
            if (r.status === 401) {
              expireSession(sessionStorage, session);
              setSession("");
              break;
            }
            if (!r.ok || !r.body) throw Error("Stream non disponibile");
            setConnection("In tempo reale");
            setError("");
            const reader = r.body.getReader(),
              decoder = new TextDecoder();
            let buffer = "";
            try {
              while (!controller.signal.aborted) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const parsed = sseFrames(buffer);
                buffer = parsed.rest;
                if (parsed.frames.length) {
                  const unknown = parsed.frames.some(
                    (e) => !canonical.current.jobs[e.job_id],
                  );
                  update((p) => mergeEvents(p, parsed.frames));
                  if (unknown) void refresh(controller.signal).catch(() => {});
                }
              }
            } finally {
              await reader.cancel().catch(() => {});
            }
            if (!controller.signal.aborted)
              setConnection("Offline · riconnessione");
          } catch (e) {
            if (!controller.signal.aborted)
              setConnection("Offline · riconnessione");
          }
          await wait();
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
  const messages = useMemo<ThreadMessageLike[]>(
    () =>
      jobs
        .filter((j) => parseJson(j.payload)?.message)
        .flatMap((j) => [
          {
            id: j.id + ":user",
            role: "user" as const,
            content: [
              {
                type: "text" as const,
                text: String(parseJson(j.payload).message),
              },
            ],
          },
          {
            id: j.id + ":assistant",
            role: "assistant" as const,
            status: messageStatus(j),
            content: [
              {
                type: "text" as const,
                text:
                  answerFor(projection, j.id) ||
                  (j.state === "completed"
                    ? "Attività completata senza testo restituito."
                    : j.state === "failed"
                      ? "Attività non completata."
                      : j.state === "cancelled"
                        ? "Richiesta annullata."
                        : "In attesa di aggiornamenti…"),
              },
            ],
          },
        ]),
    [jobs, projection],
  );
  const submit = useCallback(
    async (kind: Pending["kind"], message = draft) => {
      if (busy || !message.trim()) return;
      setBusy(true);
      setError("");
      try {
        const p = pendingSubmission(
          sessionStorage,
          message.trim(),
          kind,
          () => ownerRequestId(),
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
        setNotice(
          "La richiesta resta salvata: riprova con lo stesso identificatore.",
        );
      } finally {
        setBusy(false);
      }
    },
    [api, draft, busy, update, refresh],
  );
  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage: (m) => m,
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
        .join("|") + Math.max(0, ...projection.events.map((e) => e.id)),
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
      observer.observe(el, { childList: true, subtree: true, characterData: true });
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
  useLayoutEffect(() => {
    const el = scroll.current, saved = restoreScroll.current;
    if (!el || !saved) return;
    const restore = () => {
      if (el.querySelectorAll('.message').length < messages.length) return false;
      el.scrollTop = saved.top + el.scrollHeight - saved.height;
      restoreScroll.current = null;
      return true;
    };
    // assistant-ui publishes its message tree independently of the parent.
    // Anchor only when the new messages are present in the DOM.
    const observer = new MutationObserver(() => {
      if (restore()) observer.disconnect();
    });
    observer.observe(el, { childList: true, subtree: true });
    if (restore()) observer.disconnect();
    return () => observer.disconnect();
  }, [messages]);
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
              onClick={() => { if (id === "chat") follow.current = true; setTab(id); }}
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
                  ? "Evidenze, strumenti e decisioni. Una conversazione continua con il tuo nodo."
                  : "Il tuo nodo, osservato attraverso dati e risultati verificabili."}
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
                    <jobContext.Provider value={projection}>
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
                                  Chiedi al coordinatore di leggere le evidenze
                                  oppure avvia un’analisi in sola lettura.
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
                            <ThreadPrimitive.Messages
                              components={{
                                UserMessage: ChatMessage,
                                AssistantMessage: ChatMessage,
                              }}
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
                                "La chat può proporre interventi entro il mandato. Le analisi restano in sola lettura."}
                            </p>
                          </form>
                        </ThreadPrimitive.Root>
                      </AssistantRuntimeProvider>
                    </jobContext.Provider>
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
                      <p className="muted">
                        Oggi · {sats(status.budget?.dailyMsat)} / 1.500 sat
                      </p>
                      <p className="muted">
                        Esplorazione · {sats(status.budget?.exploratoryMsat)} /
                        750 sat
                      </p>
                      <div className="protected">
                        <Shield size={15} /> Riserva protetta · 500.000 sat
                      </div>
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
                    <div className="queue-counts">
                      {(status.queue?.states ?? []).map((v: any) => (
                        <span key={v.state}>
                          {labels[v.state] ?? v.state}{" "}
                          <strong>{v.count}</strong>
                        </span>
                      ))}
                    </div>
                    {!jobs.length && (
                      <p className="empty">Nessuna attività registrata.</p>
                    )}
                    <jobContext.Provider value={projection}>
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
                          <small className="muted">
                            {j.created_at} · {j.id} ·{" "}
                            {j.lane ?? "corsia non specificata"}
                          </small>
                          <p>{parseJson(j.payload)?.message}</p>
                          {j.wait_reason && (
                            <p className="muted">{j.wait_reason}</p>
                          )}
                          {j.error && <p className="error">{j.error}</p>}
                          <ToolCards id={j.id} />
                          {answerFor(projection, j.id) && (
                            <details>
                              <summary>Risposta dell’agente</summary>
                              <Mark>{answerFor(projection, j.id)}</Mark>
                            </details>
                          )}
                        </article>
                      ))}
                    </jobContext.Provider>
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
                    title="Canali Lightning"
                    sub={
                      "Snapshot · " +
                      (status.snapshot?.at ?? "non ancora disponibile")
                    }
                  >
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
                                  {Number(c.localSat).toLocaleString("it-IT")} /{" "}
                                  {Number(c.remoteSat).toLocaleString("it-IT")}{" "}
                                  sat
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
                            <p>Versione · {d?.version ?? "sconosciuta"}</p>
                            {d?.status === "qualified" ? (
                              <>
                                <p>Acquisito · {d.capturedAt}</p>
                                <p>
                                  {d.failures?.length ?? 0} record di errore ·{" "}
                                  {d.rebalances?.length ?? 0} rebalance
                                </p>
                                <p>
                                  Copertura{" "}
                                  {d.coverage?.complete
                                    ? "completa"
                                    : "parziale"}{" "}
                                  · {d.coverage?.note}
                                </p>
                                <Json value={d} label="Evidenze della fonte" />
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
                      {status.competition?.status !== "qualified" ? (
                        <p className="empty">
                          {status.competition?.reason ??
                            "Confronto non disponibile"}
                        </p>
                      ) : (
                        (status.competition.channels ?? []).map(
                          (c: any, i: number) => (
                            <article className="record" key={i}>
                              <h3>
                                {c.alias} <Badge state={c.status} />
                              </h3>
                              {c.quotes ? (
                                <>
                                  <p>
                                    Grafo · {c.capturedChannels} /{" "}
                                    {c.graphChannelCount} canali ·{" "}
                                    {c.missingPolicies} policy mancanti
                                  </p>
                                  <small>{c.capturedAt}</small>
                                  {c.quotes.map((q: any, n: number) => (
                                    <p key={n}>
                                      {q.amountSat} sat · nostra fee{" "}
                                      {sats(q.ourFeeMsat)} sat · mediana{" "}
                                      {q.medianFeeMsat == null
                                        ? "sconosciuta"
                                        : sats(q.medianFeeMsat) + " sat"}{" "}
                                      · {q.cheaperThanUs} /{" "}
                                      {q.announcedEligible} prezzi inferiori
                                    </p>
                                  ))}
                                </>
                              ) : (
                                <p>{c.reason}</p>
                              )}
                            </article>
                          ),
                        )
                      )}
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
                  <div className="stats-row">
                    {[
                      ["Ricavi · 30 giorni", status.pnl30?.revenueMsat],
                      ["Costi · 30 giorni", status.pnl30?.costMsat],
                      [
                        status.partial
                          ? "Risultato parziale"
                          : "Risultato netto",
                        status.pnl30?.netMsat,
                      ],
                    ].map(([l, v]) => (
                      <Panel key={l} title={l}>
                        <strong className="large-number">
                          {sats(v)} <small>sat</small>
                        </strong>
                      </Panel>
                    ))}
                  </div>
                  {status.partial && (
                    <div className="notice">
                      Contabilità parziale: copertura storica o costi di
                      sottoscrizione incompleti.
                    </div>
                  )}
                  <div className="two-columns">
                    <Panel title="Budget e riserva">
                      <dl>
                        <dt>Spesa giornaliera</dt>
                        <dd>{sats(status.budget?.dailyMsat)} / 1.500 sat</dd>
                        <dt>Esplorazione</dt>
                        <dd>
                          {sats(status.budget?.exploratoryMsat)} / 750 sat
                        </dd>
                        <dt>Residuo</dt>
                        <dd>{sats(status.budget?.remainingMsat)} sat</dd>
                        <dt>Riserva protetta</dt>
                        <dd>500.000 sat</dd>
                      </dl>
                      <Json value={status.budget} label="Budget completo" />
                      <Json value={status.mandate} label="Mandato applicato" />
                    </Panel>
                    <Panel title="Contabilità cumulativa">
                      <dl>
                        <dt>Ricavi riconciliati</dt>
                        <dd>{sats(status.cumulative?.revenueMsat)} sat</dd>
                        <dt>Costi registrati</dt>
                        <dd>{sats(status.cumulative?.costMsat)} sat</dd>
                        <dt>
                          Risultato {status.partial ? "parziale" : "netto"}
                        </dt>
                        <dd>{sats(status.cumulative?.netMsat)} sat</dd>
                      </dl>
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
                        <small>
                          {d.at} · massimo {sats(d.proposal.maxFeeMsat)} sat ·
                          beneficio previsto {sats(d.forecast.benefitMsat)} sat
                        </small>
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
                          <p>
                            Contributo osservato ·{" "}
                            {r.result.observedContributionMsat == null
                              ? "non determinabile"
                              : sats(r.result.observedContributionMsat) +
                                " sat"}
                          </p>
                          <p>
                            Costi ·{" "}
                            {r.result.costMsat == null
                              ? "non determinabili"
                              : sats(r.result.costMsat) + " sat"}{" "}
                            · {r.result.samples} inoltri · copertura{" "}
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
                      onClick={() => {
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
