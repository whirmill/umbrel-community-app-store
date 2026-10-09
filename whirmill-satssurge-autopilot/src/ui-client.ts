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
};
export function mergeEvents(
  state: Projection,
  events: UiEvent[],
  advance = true,
): Projection {
  const merged = new Map(state.events.map((e) => [e.id, e]));
  for (const e of events) merged.set(e.id, e);
  const ordered = [...merged.values()].sort((a, b) => a.id - b.id),
    jobs = { ...state.jobs };
  for (const e of ordered) {
    const j = jobs[e.job_id];
    if (e.type === "job" && j && (!j.updated_at || e.at >= j.updated_at))
      jobs[e.job_id] = { ...j, ...e.data, updated_at: e.at };
  }
  return {
    jobs,
    events: ordered,
    cursor: advance
      ? Math.max(state.cursor, ...events.map((e) => e.id))
      : state.cursor,
  };
}
export function mergeJobs(state: Projection, incoming: Job[]): Projection {
  const jobs = { ...state.jobs };
  for (const j of incoming) {
    const old = jobs[j.id];
    if (!old?.updated_at || !j.updated_at || j.updated_at >= old.updated_at)
      jobs[j.id] = { ...old, ...j };
    for (const existing of Object.values(jobs))
      if (
        existing.id.startsWith("legacy:") &&
        j.request_id &&
        existing.request_id === j.request_id
      )
        delete jobs[existing.id];
  }
  return { ...state, jobs };
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
  },
  reset = false,
): Projection {
  let p = mergeJobs(
    reset ? { jobs: {}, events: [], cursor: history.cursor } : state,
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
        result: JSON.stringify({ answer: c.answer }),
        legacy: true,
      };
    }
  return mergeEvents(p, history.events, false);
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
export function ownerRequestId(source: { getRandomValues(bytes: Uint8Array): Uint8Array } = globalThis.crypto): string {
  const bytes = source.getRandomValues(new Uint8Array(16));
  return "owner:" + Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}
