import {
  type Projection,
  type Job,
  type UiEvent,
  parseJson,
  messageStatus,
} from "./ui-client.js";
export type JobView = {
  job: Job;
  events: UiEvent[];
  tools: Map<string, any>;
  text: string;
  progress: string;
  reasoning: Map<string, string>;
};
/** Job-local identity/subscriptions. Unchanged polling does not invalidate rendered messages. */
export class ProjectionIndex {
  private views = new Map<string, JobView>();
  private listeners = new Map<string, Set<() => void>>();
  publish(p: Projection) {
    const groups = new Map<string, UiEvent[]>();
    for (const e of p.events) {
      const a = groups.get(e.job_id) ?? [];
      a.push(e);
      groups.set(e.job_id, a);
    }
    for (const key of this.views.keys())
      if (!p.jobs[key]) this.views.delete(key);
    for (const job of Object.values(p.jobs)) {
      const events = groups.get(job.id) ?? [],
        old = this.views.get(job.id);
      if (
        old &&
        JSON.stringify(old.job) === JSON.stringify(job) &&
        events.length === old.events.length &&
        events.every((e, i) => e === old.events[i])
      )
        continue;
      const tools = new Map<string, any>(),
        reasoning = new Map<string, string>();
      let text = "",
        progress = "";
      for (const e of events) {
        if (e.type === "text") text = String(e.data.text ?? "");
        if (e.type === "progress") progress = e.data.state;
        if (
          e.type === "reasoning_summary" &&
          e.data.provenance === "responses.summary_text"
        )
          reasoning.set(e.data.itemId + ":" + e.data.index, e.data.text);
        if (["tool_call", "tool_result"].includes(e.type))
          tools.set(e.data.toolCallId, {
            ...tools.get(e.data.toolCallId),
            ...e.data,
            [e.type]: true,
          });
      }
      if (job.state === "completed")
        text = parseJson(job.result)?.answer ?? text;
      this.views.set(job.id, { job, events, tools, text, progress, reasoning });
      for (const fn of this.listeners.get(job.id) ?? []) fn();
    }
  }
  get = (id: string) => this.views.get(id);
  subscribe = (id: string, fn: () => void) => {
    const s = this.listeners.get(id) ?? new Set();
    s.add(fn);
    this.listeners.set(id, s);
    return () => {
      s.delete(fn);
      if (!s.size) this.listeners.delete(id);
    };
  };
  metrics() {
    return {
      jobs: this.views.size,
      listeners: [...this.listeners.values()].reduce((n, s) => n + s.size, 0),
    };
  }
}
