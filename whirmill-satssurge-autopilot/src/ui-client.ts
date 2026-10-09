export type UiEvent = {
  id: number;
  job_id: string;
  at: string;
  type: string;
  data: Record<string, any>;
};
export type Job = {
  id: string;
  history_id?: number;
  kind: string;
  lane?: string;
  state: string;
  submitted?: number;
  payload?: string;
  result?: string;
  error?: string;
  created_at?: string;
  wait_reason?: string;
  [key: string]: any;
};
export type Projection = {
  jobs: Record<string, Job>;
  events: UiEvent[];
  cursor: number;
  truncatedEvents?: boolean;
  truncatedHistory?: boolean;
  historyWindowIds?: string[];
};
export function mergeEvents(
  state: Projection,
  events: UiEvent[],
  advance = true,
): Projection {
  const merged = new Map(state.events.map((e) => [e.id, e]));
  for (const e of events) if (!merged.has(e.id)) merged.set(e.id, e);
  // Text/progress are cumulative snapshots, not deltas to concatenate.
  const snapshots = new Map<string, number>();
  const snapshotKey = (e: UiEvent) =>
    e.type === "reasoning_summary"
      ? e.job_id + ":" + e.type + ":" + e.data.itemId + ":" + e.data.index
      : ["text", "progress", "job"].includes(e.type)
        ? e.job_id + ":" + e.type
        : null;
  for (const e of merged.values())
    if (snapshotKey(e)) {
      const key = snapshotKey(e)!;
      snapshots.set(key, Math.max(snapshots.get(key) ?? 0, e.id));
    }
  const compact = [...merged.values()].filter(
    (e) => !snapshotKey(e) || snapshots.get(snapshotKey(e)!) === e.id,
  );
  const byId = compact.sort((a, b) => a.id - b.id);
  // Retain current snapshots preferentially, even when an old job emits many tools.
  const current = byId
    .filter((e) => ["text", "progress", "job"].includes(e.type))
    .slice(-10000);
  const details = byId.filter(
    (e) => !["text", "progress", "job"].includes(e.type),
  );
  let ordered = [
      ...current,
      ...(current.length === 10000
        ? []
        : details.slice(-(10000 - current.length))),
    ].sort((a, b) => a.id - b.id),
    jobs = { ...state.jobs };
  let windowBytes = 0;
  ordered = ordered
    .slice()
    .reverse()
    .filter((e) => {
      const bytes = new TextEncoder().encode(JSON.stringify(e)).byteLength;
      if (windowBytes + bytes > 8 * 1024 * 1024) return false;
      windowBytes += bytes;
      return true;
    })
    .reverse();
  for (const e of ordered) {
    const j = jobs[e.job_id];
    if (e.type === "job" && j && (!j.updated_at || e.at >= j.updated_at))
      jobs[e.job_id] = { ...j, ...e.data, updated_at: e.at };
  }
  return {
    ...state,
    jobs,
    events: ordered,
    truncatedEvents:
      state.truncatedEvents ||
      compact.length > 10000 ||
      ordered.length < compact.length,
    cursor: advance
      ? events.reduce((cursor, e) => Math.max(cursor, e.id), state.cursor)
      : state.cursor,
  };
}
export function mergeJobs(state: Projection, incoming: Job[]): Projection {
  const jobs = { ...state.jobs };
  for (const j of incoming) {
    const old = jobs[j.id];
    if (!old?.updated_at || !j.updated_at || j.updated_at >= old.updated_at)
      jobs[j.id] =
        old && Object.keys(j).every((k) => old[k] === j[k])
          ? old
          : { ...old, ...j };
    for (const existing of Object.values(jobs))
      if (
        existing.id.startsWith("legacy:") &&
        j.request_id &&
        existing.request_id === j.request_id
      )
        delete jobs[existing.id];
  }
  const pinned = new Set([
    ...(state.historyWindowIds ?? []),
    ...incoming.map((j) => j.id),
  ]);
  const terminal = Object.values(jobs).filter((j) =>
    ["completed", "failed", "cancelled"].includes(j.state),
  );
  terminal.sort(
    (a, b) =>
      Number(pinned.has(b.id)) - Number(pinned.has(a.id)) ||
      (b.created_at ?? "").localeCompare(a.created_at ?? "") ||
      (b.history_id ?? 0) - (a.history_id ?? 0),
  );
  for (const j of terminal.slice(250)) delete jobs[j.id];
  return {
    ...state,
    jobs,
    events: state.events.filter((e) => !!jobs[e.job_id]),
    truncatedHistory: state.truncatedHistory || terminal.length > 250,
  };
}
export function canCancel(job: Job) {
  return job.state === "queued" || (job.state === "waiting" && !job.submitted);
}
export function parseJson(value: unknown): any {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}
export function answerFor(state: Projection, id: string): string {
  const final = parseJson(state.jobs[id]?.result)?.answer;
  if (state.jobs[id]?.state === "completed" && typeof final === "string")
    return final;
  const latest = state.events
    .filter((e) => e.job_id === id && e.type === "text")
    .at(-1);
  return latest
    ? String(latest.data.text ?? "")
    : String(parseJson(state.jobs[id]?.result)?.answer ?? "");
}
export function sats(value: unknown): string {
  try {
    const n = BigInt(String(value ?? 0)),
      v = n < 0n ? -n : n,
      f = (v % 1000n).toString().padStart(3, "0").replace(/0+$/, "");
    return (
      (n < 0n ? "−" : "") +
      new Intl.NumberFormat("it-IT", { useGrouping: "always" }).format(
        v / 1000n,
      ) +
      (f ? "," + f : "")
    );
  } catch {
    return "sconosciuto";
  }
}
export function safeUrl(value: string) {
  try {
    const u = new URL(value);
    return ["https:", "http:", "mailto:"].includes(u.protocol)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}
export type Pending = {
  requestId: string;
  message: string;
  kind: "chat" | "analysis";
};
export interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}
export const pendingKey = "satssurge.pendingSubmission";
export function validChatPayload(message: string) {
  return (
    new TextEncoder().encode(JSON.stringify({ message })).byteLength <= 16384
  );
}
export function pendingSubmission(
  storage: StorageLike,
  message: string,
  kind: Pending["kind"],
  createId: () => string,
): Pending {
  const old = parseJson(storage.getItem(pendingKey));
  if (old?.requestId) {
    if (old.message !== message || old.kind !== kind)
      throw Error("Recupera prima la ricevuta della richiesta precedente.");
    return old;
  }
  if (!validChatPayload(message))
    throw Error(
      "Il messaggio supera il limite di 16 KiB. Riducilo prima di inviare.",
    );
  const pending = { requestId: createId(), message, kind };
  storage.setItem(pendingKey, JSON.stringify(pending));
  return pending;
}
export function requestHeaders(session: string, csrf?: string) {
  return {
    Authorization: "Bearer " + session,
    ...(csrf
      ? { "Content-Type": "application/json", "X-CSRF-Token": csrf }
      : {}),
  };
}
export function expireSession(storage: StorageLike, requested: string) {
  if (storage.getItem("satssurge.ownerSession") === requested)
    storage.removeItem("satssurge.ownerSession");
}
export function sseFrames(buffer: string): { frames: UiEvent[]; rest: string } {
  const parts = buffer.replace(/\r\n/g, "\n").split("\n\n"),
    rest = parts.pop() ?? "",
    frames: UiEvent[] = [];
  for (const part of parts) {
    const data = part
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (data) {
      const event = parseJson(data);
      if (Number.isSafeInteger(event?.id)) frames.push(event);
    }
  }
  return { frames, rest };
}
export function mergeHistory(
  state: Projection,
  history: {
    jobs: Job[];
    events: UiEvent[];
    legacyChat?: any[];
    cursor: number;
    eventsPartial?: boolean;
  },
  reset = false,
): Projection {
  const retainedActive = Object.fromEntries(
    Object.entries(state.jobs).filter(
      ([, j]) => !["completed", "failed", "cancelled"].includes(j.state),
    ),
  );
  // A preserved active receipt may have finished outside the newest history page.
  // Replay from its old cursor so its terminal event cannot be skipped by reset.
  const resetCursor = Object.keys(retainedActive).length
    ? Math.min(state.cursor, history.cursor)
    : history.cursor;
  let p = mergeJobs(
    {
      ...(reset
        ? { jobs: retainedActive, events: [], cursor: resetCursor }
        : state),
      historyWindowIds: history.jobs.map((j) => j.id),
    },
    history.jobs,
  );
  const requests = new Set(
    Object.values(p.jobs)
      .filter((j) => !j.id.startsWith("legacy:"))
      .map((j) => j.request_id),
  );
  for (const j of Object.values(p.jobs))
    if (j.id.startsWith("legacy:") && requests.has(j.request_id))
      delete p.jobs[j.id];
  for (const [index, c] of (history.legacyChat ?? []).entries())
    if (!c.requestId || !requests.has(c.requestId)) {
      const id = "legacy:" + (c.requestId ?? index);
      p.jobs[id] = {
        id,
        request_id: c.requestId,
        history_id: -index - 1,
        kind: "chat",
        state: "completed",
        created_at: c.at,
        payload: JSON.stringify({ message: c.user }),
        result: JSON.stringify({
          answer: c.answer,
          answerDetailAvailable: c.answerDetailAvailable === true,
          answerDetailKey: c.answerDetailKey,
        }),
        legacy: true,
      };
    }
  p = mergeJobs(p, []);
  p.truncatedEvents = p.truncatedEvents || history.eventsPartial === true;
  return mergeEvents(
    p,
    history.events.filter((e) => !!p.jobs[e.job_id]),
    false,
  );
}
/** Public terminal presentation uses recorded state and actual public text only. */
export function messagePresentation(job: Job, text: string) {
  const hasText = text.trim().length > 0;
  const terminal = ["completed", "failed", "cancelled"].includes(job.state);
  const caption =
    job.state === "failed"
      ? hasText
        ? "Risposta parziale · non completata"
        : "Non completata · nessun testo disponibile"
      : job.state === "cancelled"
        ? hasText
          ? "Annullata · testo parziale"
          : "Annullata · nessun testo disponibile"
        : job.state === "completed"
          ? hasText
            ? "Risposta finale"
            : "Completata · nessun testo disponibile"
          : job.state === "queued"
            ? "In coda"
            : job.state === "waiting"
              ? "In attesa"
              : "Risposta in corso";
  return {
    terminal,
    caption,
    body: hasText ? text : terminal ? "" : "In attesa di aggiornamenti…",
  };
}

export function messageStatus(
  job: Job,
):
  | { type: "running" }
  | { type: "complete"; reason: "stop" }
  | { type: "incomplete"; reason: "error" | "cancelled" } {
  return job.state === "completed"
    ? { type: "complete", reason: "stop" }
    : job.state === "failed"
      ? { type: "incomplete", reason: "error" }
      : job.state === "cancelled"
        ? { type: "incomplete", reason: "cancelled" }
        : { type: "running" };
}

/** getRandomValues is available on Umbrel HTTP origins where randomUUID is not. */
export function ownerRequestId(
  source: {
    getRandomValues(bytes: Uint8Array): Uint8Array;
  } = globalThis.crypto,
): string {
  const bytes = source.getRandomValues(new Uint8Array(16));
  return (
    "owner:" +
    Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
  );
}
