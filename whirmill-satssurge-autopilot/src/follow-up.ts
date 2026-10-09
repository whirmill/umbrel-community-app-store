import { Store } from "./store.js";
import { provenance } from "./analysis-feed.js";
import { ReviewWaits } from "./review-waits.js";
import { type Job } from "./queue.js";
import { json } from "./domain.js";

export class FollowUps {
  constructor(
    private store: Store,
    private clock = Date.now,
  ) {}
  eligible(job: Job) {
    const p = provenance(this.store, job.id);
    return (
      p.purpose === "economic" && ["owner", "scheduler"].includes(p.origin)
    );
  }
  get(jobId: string): any {
    return this.store.get("followUpOutcome:" + jobId);
  }
  record(
    job: Job,
    input: {
      outcome: "wait" | "no_wait";
      scope: string;
      dueAt?: string;
      evidenceIds: string[];
      missing: string[];
    },
  ) {
    if (!this.eligible(job) || !job.submission_id)
      throw Error("Economic submitted receipt required");
    const old = this.get(job.id);
    if (old) return old;
    const scope = job.scope || "node";
    if (
      input.scope !== scope ||
      !["wait", "no_wait"].includes(input.outcome) ||
      !Array.isArray(input.evidenceIds) ||
      !Array.isArray(input.missing) ||
      !input.evidenceIds.every(
        (x) => typeof x === "string" && x.length <= 500,
      ) ||
      !input.missing.every((x) => typeof x === "string" && x.length <= 1000)
    )
      throw Error("Invalid follow-up outcome/scope");
    if (
      input.outcome === "wait" &&
      (!input.dueAt ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(
          input.dueAt,
        ) ||
        !Number.isFinite(Date.parse(input.dueAt)) ||
        Date.parse(input.dueAt) <= this.clock())
    )
      throw Error("Wait needs an explicit future deadline");
    return this.store.tx(() => {
      const wait =
        input.outcome === "wait"
          ? new ReviewWaits(this.store, this.clock).register({
              scope,
              dueAt: input.dueAt!,
              origin: "agent:" + job.id,
              evidenceIds: input.evidenceIds,
              missing: input.missing,
            })
          : undefined;
      return this.save(job, {
        outcome: input.outcome,
        scope,
        dueAt: wait?.dueAt ?? null,
        provenance: "agent",
        evidenceIds: input.evidenceIds.slice(0, 32),
        missing: input.missing.slice(0, 16),
      });
    });
  }
  fallback(job: Job, cause: string) {
    if (!this.eligible(job) || !job.submission_id || this.get(job.id))
      return this.get(job.id);
    // Policy uses admission time, never parses prose or restarts an observation window.
    const dueAt = new Date(Date.parse(job.created_at) + 3600000).toISOString();
    const scope = job.scope || "node";
    return this.store.tx(() => {
      let registryError: string | null = null;
      try {
        new ReviewWaits(this.store, this.clock).register({
          scope,
          dueAt,
          origin: "policy:" + job.id,
          evidenceIds: [],
          missing: ["follow-up outcome not registered"],
        });
      } catch {
        registryError =
          "Review registry unavailable; policy deadline retained in original outcome receipt";
      }
      return this.save(job, {
        outcome: "unregistered",
        scope,
        dueAt,
        provenance: "policy",
        cause,
        missing: ["follow-up outcome not registered"],
        registryError,
      });
    });
  }
  private save(job: Job, detail: any) {
    const value = {
      ...detail,
      jobId: job.id,
      submissionId: job.submission_id,
      at: new Date(this.clock()).toISOString(),
    };
    this.store.set("followUpOutcome:" + job.id, value);
    this.store.run(
      "INSERT OR IGNORE INTO job_events VALUES(?,?,?,?,?)",
      "follow-up:" + job.id,
      job.id,
      value.at,
      "follow_up_outcome",
      json(value),
    );
    return value;
  }
}
