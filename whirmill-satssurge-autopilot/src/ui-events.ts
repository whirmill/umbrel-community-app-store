import type { ServerResponse } from "node:http";
import { EventEmitter } from "node:events";
import type { AgentEvent } from "@earendil-works/pi-durable";
import { Store } from "./store.js";
import { hash, json, now, scrub } from "./domain.js";
function redact(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return typeof JSON.parse(value) === "object"
        ? json(scrub(JSON.parse(value)))
        : scrub(value);
    } catch {
      return scrub(value);
    }
  }
  return scrub(value);
}
export function bounded(value: unknown): unknown {
  const clean = Array.isArray(value)
      ? value.map((v) =>
          v && typeof v === "object" && "text" in v
            ? { ...(scrub(v) as object), text: redact(v.text) }
            : redact(v),
        )
      : redact(value),
    encoded = json(clean) ?? "null";
  return encoded.length > 24000
    ? { truncated: true, text: encoded.slice(0, 24000) }
    : clean;
}
// Instances used by Queue and Pi share one notification source per database owner.
const notifications = new WeakMap<
  Store,
  { emitter: EventEmitter; version: number; notify: () => void }
>();
function source(store: Store) {
  let state = notifications.get(store);
  if (!state) {
    const emitter = new EventEmitter();
    emitter.setMaxListeners(0);
    state = {
      emitter,
      version: 0,
      notify: () => {
        state!.version++;
        emitter.emit("persisted");
      },
    };
    notifications.set(store, state);
  }
  return state;
}
/** Public allowlist: no thinking, provider metadata or raw errors. */
export class UiEvents {
  constructor(readonly store: Store) {}
  append(jobId: string, type: string, data: unknown, key?: string) {
    const inserted = this.store.run(
      "INSERT OR IGNORE INTO ui_events(job_id,at,type,data,event_key) VALUES(?,?,?,?,?)",
      jobId,
      now(),
      type,
      json(scrub(data)),
      key ?? null,
    );
    if (Number(inserted.changes))
      this.store.afterCommit(source(this.store).notify);
  }
  /** Notifications carry no payload; SQLite and the cursor remain authoritative. */
  async *stream(
    cursor: number,
    signal: AbortSignal,
    options: { batchSize?: number; heartbeatMs?: number } = {},
  ) {
    const state = source(this.store),
      batchSize = Math.max(1, Math.min(256, options.batchSize ?? 64));
    let wake: (() => void) | undefined;
    const notify = () => wake?.();
    state.emitter.on("persisted", notify); // Subscribe before the initial journal read.
    signal.addEventListener("abort", notify);
    try {
      while (!signal.aborted) {
        const observed = state.version,
          batch = this.after(cursor, batchSize);
        if (batch.length) {
          cursor = batch.at(-1)!.id;
          yield batch;
          continue;
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, options.heartbeatMs ?? 15000);
          function done() {
            clearTimeout(timer);
            wake = undefined;
            resolve();
          }
          wake = done;
          if (signal.aborted || state.version !== observed) done();
        });
        if (!signal.aborted) yield []; // Heartbeat also recovers writes from another connection.
      }
    } finally {
      wake?.();
      state.emitter.off("persisted", notify);
      signal.removeEventListener("abort", notify);
    }
  }
  subscriberCount() {
    return source(this.store).emitter.listenerCount("persisted");
  }
  cursor() {
    return this.store.one("SELECT coalesce(max(id),0) id FROM ui_events")
      .id as number;
  }
  after(cursor: number, limit = 256) {
    return this.store
      .all(
        "SELECT id,job_id,at,type,data FROM ui_events WHERE id>? ORDER BY id LIMIT ?",
        cursor,
        limit,
      )
      .map((e) => ({ ...e, data: JSON.parse(e.data) }));
  }
}
export class ConversationProjection {
  private completed = new Map<number, string>();
  private blocks = new Map<number, string>();
  private last = "";
  constructor(
    private events: UiEvents,
    private jobId: string,
  ) {
    this.last =
      JSON.parse(
        events.store.one(
          "SELECT data FROM ui_events WHERE job_id=? AND type='text' ORDER BY id DESC LIMIT 1",
          jobId,
        )?.data ?? "{}",
      ).text ?? "";
    for (const row of events.store.all(
      "SELECT entry_id,text FROM ui_messages WHERE job_id=? ORDER BY entry_id",
      jobId,
    ))
      this.completed.set(row.entry_id, row.text);
  }
  private entry(e: any) {
    for (const m of e.model ?? []) {
      if (m.role === "assistant") {
        const text = m.content
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("\n");
        this.completed.set(Number(e.id), text);
        this.events.store.run(
          "INSERT OR IGNORE INTO ui_messages VALUES(?,?,?)",
          this.jobId,
          Number(e.id),
          text,
        );
        for (const b of m.content)
          if (b.type === "toolCall")
            this.events.append(
              this.jobId,
              "tool_call",
              {
                toolCallId: b.id,
                toolName: b.name,
                args: bounded(b.arguments),
              },
              "call:" + b.id,
            );
      } else if (m.role === "toolResult")
        this.events.append(
          this.jobId,
          "tool_result",
          {
            toolCallId: m.toolCallId,
            toolName: m.toolName,
            result: bounded(m.content),
            isError: !!m.isError,
          },
          "result:" + m.toolCallId,
        );
    }
  }

  accept(event: AgentEvent) {
    if (event.type === "snapshot") {
      for (const e of event.entries) this.entry(e);
      this.blocks.clear();
      event.generation?.message?.content.forEach((b, i) => {
        if (b.type === "text") this.blocks.set(i, b.text);
      });
      this.publish();
      for (const tool of event.tools)
        this.events.append(
          this.jobId,
          "tool_call",
          {
            toolCallId: tool.callId,
            toolName: tool.name,
            argsAvailable: false,
            state: tool.status,
          },
          "call:" + tool.callId,
        );
      this.events.append(this.jobId, "progress", {
        state: "resynchronized",
        note: "Cronologia recuperata da Pi Durable",
      });
    } else if (
      event.type === "message_start" &&
      event.message.role === "assistant"
    ) {
      this.blocks.clear();
      event.message.content.forEach((b, i) => {
        if (b.type === "text") this.blocks.set(i, b.text);
      });
      this.publish();
    } else if (event.type === "message_update") {
      for (const change of event.changes) {
        if (change.type === "text_delta")
          this.blocks.set(
            change.contentIndex,
            (this.blocks.get(change.contentIndex) ?? "") + change.delta,
          );
        else if (
          (change.type === "text_start" || change.type === "block") &&
          change.block.type === "text"
        )
          this.blocks.set(change.contentIndex, change.block.text);
        else if (change.type === "message") {
          this.blocks.clear();
          change.message.content.forEach((b, i) => {
            if (b.type === "text") this.blocks.set(i, b.text);
          });
        }
      }
      this.publish();
    } else if (event.type === "message_end") {
      this.entry(event.entry);
      if (event.entry.model?.some((m) => m.role === "assistant")) {
        this.blocks.clear();
        this.publish();
      }
    } else if (event.type === "tool_execution_start")
      this.events.append(
        this.jobId,
        "tool_call",
        {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: bounded(event.args),
        },
        "call:" + event.toolCallId,
      );
    else if (event.type === "tool_execution_end") {
      const m = event.entry?.model?.find(
        (m: any) => m.role === "toolResult",
      ) as any;
      this.events.append(
        this.jobId,
        "tool_result",
        {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: m ? bounded(m.content) : null,
          isError: !!m?.isError,
          unavailable: !m,
        },
        "result:" + event.toolCallId,
      );
    } else if (
      [
        "run_start",
        "run_end",
        "turn_start",
        "turn_end",
        "compaction_start",
        "compaction_end",
      ].includes(event.type)
    )
      this.events.append(this.jobId, "progress", { state: event.type });
  }
  private publish() {
    const partial = [...this.blocks.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, t]) => t)
      .join("\n");
    const text = [
      ...[...this.completed.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, t]) => t),
      partial,
    ]
      .filter(Boolean)
      .join("\n\n");
    if (text === this.last) return;
    this.last = text;
    this.events.append(this.jobId, "text", { text });
  }
}

/** At most one journal batch plus Node's writable buffer per connection. */
export async function serveUiEvents(
  events: UiEvents,
  response: ServerResponse,
  cursor: number,
  signal: AbortSignal,
  authorized: () => boolean,
  options: {
    heartbeatMs?: number;
    drainTimeoutMs?: number;
    batchSize?: number;
  } = {},
) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal.addEventListener("abort", stop);
  response.on("close", stop);
  if (signal.aborted || response.destroyed) stop();
  async function write(frame: string) {
    if (controller.signal.aborted || !authorized()) {
      stop();
      return;
    }
    if (response.write(frame)) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        response.off("drain", done);
        controller.signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(() => {
        response.destroy();
        stop();
      }, options.drainTimeoutMs ?? 15000);
      response.once("drain", done);
      controller.signal.addEventListener("abort", done);
      if (controller.signal.aborted) done();
    });
  }
  try {
    for await (const batch of events.stream(
      cursor,
      controller.signal,
      options,
    )) {
      if (!batch.length) await write(": heartbeat\n\n");
      else
        for (const event of batch) {
          await write(
            "id: " +
              event.id +
              "\nevent: update\ndata: " +
              json(event) +
              "\n\n",
          );
          if (controller.signal.aborted) break;
        }
    }
  } catch {
    response.destroy();
  } finally {
    stop();
    signal.removeEventListener("abort", stop);
    response.off("close", stop);
    response.end();
  }
}
