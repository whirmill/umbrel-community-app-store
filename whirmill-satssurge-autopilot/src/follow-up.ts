import { Store } from "./store.js";
import { provenance } from "./analysis-feed.js";
import { ReviewWaits } from "./review-waits.js";
import { type Job } from "./queue.js";
import { json,hash } from "./domain.js";

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
      const ownership=this.store.get<any>('automaticOwnership:'+job.id);
      const live=this.store.one('SELECT generation,job_id,due_consumed FROM automatic_scopes WHERE scope=?',scope);
      const ownedGeneration=!ownership||(live?.generation===ownership.generation&&live?.job_id===job.id);
      if(!ownedGeneration)return this.save(job,{outcome:input.outcome,scope,dueAt:input.dueAt??null,provenance:'agent',superseded:true,evidenceIds:input.evidenceIds,missing:input.missing});
      const priorWait=new ReviewWaits(this.store,this.clock).get(scope);
      if(ownership&&priorWait&&(live?.due_consumed===priorWait.dueAt||priorWait.consumedTrigger==='due:'+priorWait.dueAt))this.store.run('DELETE FROM meta WHERE key=?','reviewWait:'+hash(scope));
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
      const owner=this.store.get<any>('automaticOwnership:'+job.id);
      if(input.outcome==='no_wait'&&owner&&ownedGeneration)
        this.store.run('DELETE FROM meta WHERE key=?','reviewWait:'+hash(scope));
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
    return this.store.tx(()=>this.save(job,{
      outcome:'unregistered',scope:job.scope||'node',dueAt:null,
      researchStatus:'partial',provenance:'policy',cause,
      missing:['follow-up outcome not registered'],
    }));
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
