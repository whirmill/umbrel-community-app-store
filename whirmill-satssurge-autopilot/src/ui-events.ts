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
/** Public allowlist: no thinking, provider metadata or raw errors. */
export class UiEvents {
  constructor(readonly store: Store) {}
  append(jobId: string, type: string, data: unknown, key?: string) {
    this.store.run(
      "INSERT OR IGNORE INTO ui_events(job_id,at,type,data,event_key) VALUES(?,?,?,?,?)",
      jobId,
      now(),
      type,
      json(scrub(data)),
      key ?? null,
    );
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
