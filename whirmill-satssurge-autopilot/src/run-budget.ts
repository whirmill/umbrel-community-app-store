import { Store } from "./store.js";
import { now, json } from "./domain.js";
export class RunBudget {
  readonly key: string;
  private state: {
    started: number;
    calls: number;
    phase: "research" | "finalization";
    reason: string | null;
    hardMs: number;
    softMs: number;
    researchCalls: number;
  };
  constructor(
    private store: Store,
    readonly jobId: string,
    analyst: boolean,
    private clock = Date.now,
    policy: { economic?: boolean } = {},
  ) {
    this.key = "runBudget:" + jobId;
    this.state = store.get(this.key) ?? {
      started: clock(),
      calls: 0,
      phase: "research",
      reason: null,
      hardMs: 180000,
      softMs: policy.economic ? 60000 : 120000,
      researchCalls: analyst ? 12 : 16,
    };
    this.save();
  }
  private save() {
    this.store.set(this.key, this.state);
  }
  status() {
    if (
      this.clock() - this.state.started >= this.state.softMs &&
      this.state.phase === "research"
    ) {
      this.state.phase = "finalization";
      this.state.reason = "soft_deadline";
      this.save();
    }
    return {
      ...this.state,
      elapsedMs: this.clock() - this.state.started,
      remainingMs: Math.max(
        0,
        this.state.hardMs - (this.clock() - this.state.started),
      ),
      remainingResearchCalls: Math.max(
        0,
        this.state.researchCalls - this.state.calls,
      ),
    };
  }
  call(financial = false) {
    this.status();
    this.state.calls++;
    if (
      this.state.calls >= this.state.researchCalls &&
      this.state.phase === "research"
    ) {
      this.state.phase = "finalization";
      this.state.reason = "research_calls";
    }
    this.save();
    return (
      this.state.calls <= 24 && (!financial || this.state.phase === "research")
    );
  }
  closeResearch() {
    this.state.phase = "finalization";
    this.state.reason ??= "follow_up_registered";
    this.save();
  }
  hardExhaust() {
    this.state.phase = "finalization";
    this.state.reason = "absolute_tool_limit";
    this.save();
  }
  exhausted() {
    return this.status().phase === "finalization";
  }
  discardBeforeSubmission() {
    this.store.run("DELETE FROM meta WHERE key=?", this.key);
  }
  /** Bounded whitelist telemetry: never accepts prompts, arguments, reasoning or errors. */
  phase(
    stage:
      | "request_start"
      | "public_first_text"
      | "response_finish"
      | "response_failed"
      | "closure_registered"
      | "hard_abort",
    details: {
      phase?: "research" | "closure" | "finalization" | "lifecycle";
      model?: string;
      effort?: string;
      toolChoice?: string;
      toolNames?: string[];
      requestOrdinal?: number;
      requestElapsedMs?: number;
    } = {},
  ) {
    return this.store.tx(() => {
      const count = this.store.one(
        "SELECT count(*) n FROM job_events WHERE job_id=? AND type='run_phase'",
        this.jobId,
      ).n;
      if (count >= 96) return undefined;
      const ordinal = count + 1,
        status = this.status(),
        phase = details.phase ?? status.phase;
      const first = this.store.one(
        "SELECT details FROM job_events WHERE job_id=? AND type='run_phase' AND json_extract(details,'$.phase')=? ORDER BY at,id LIMIT 1",
        this.jobId,
        phase,
      );
      const firstElapsed = first
        ? JSON.parse(first.details).elapsedMs
        : status.elapsedMs;
      const allNames = (details.toolNames ?? []).filter((name) =>
        /^[a-zA-Z0-9_-]{1,100}$/.test(name),
      );
      const names = allNames.slice(0, 24);
      this.store.run(
        "INSERT INTO job_events VALUES(?,?,?,?,?)",
        `phase:${this.jobId}:${ordinal}`,
        this.jobId,
        now(),
        "run_phase",
        json({
          stage,
          ordinal,
          phase,
          elapsedMs: status.elapsedMs,
          phaseElapsedMs: Math.max(0, status.elapsedMs - firstElapsed),
          remainingMs: status.remainingMs,
          model: details.model?.slice(0, 100),
          effort: details.effort?.slice(0, 16),
          toolChoice: ["auto", "required", "none"].includes(
            details.toolChoice ?? "",
          )
            ? details.toolChoice
            : undefined,
          toolCount: allNames.length,
          toolNamesTruncated: allNames.length > names.length,
          toolNames: names,
          requestOrdinal: details.requestOrdinal,
          requestElapsedMs: details.requestElapsedMs,
        }),
      );
      return ordinal;
    });
  }
  finish(cause: string, usage: unknown) {
    this.store.run(
      "INSERT INTO job_events VALUES(?,?,?,?,?)",
      "budget:" + this.jobId + ":" + now(),
      this.jobId,
      now(),
      "run_metrics",
      json({ ...this.status(), cause, usage }),
    );
  }
}
