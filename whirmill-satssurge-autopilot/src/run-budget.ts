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
  ) {
    this.key = "runBudget:" + jobId;
    this.state = store.get(this.key) ?? {
      started: clock(),
      calls: 0,
      phase: "research",
      reason: null,
      hardMs: 180000,
      softMs: 120000,
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
