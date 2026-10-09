import { Store } from "./store.js";
import { hash, now } from "./domain.js";
export interface ReviewWait {
  scope: string;
  origin: string;
  evidenceIds: string[];
  missing: string[];
  dueAt: string;
  nextCheckAt: string;
  trigger: string | null;
  consumedTrigger: string | null;
  checks: number;
  lastAdmissionAt: string | null;
}
/** Nonfinancial, additive meta registry. Does not change forecast observation hours. */
export class ReviewWaits {
  constructor(
    private store: Store,
    private clock = Date.now,
  ) {}
  get(scope: string): ReviewWait | undefined {
    return this.store.get("reviewWait:" + hash(scope));
  }
  register(input: {
    scope: string;
    origin: string;
    evidenceIds: string[];
    missing: string[];
    dueAt: string;
  }) {
    if (
      !input.scope ||
      input.scope.length > 200 ||
      !Number.isFinite(Date.parse(input.dueAt))
    )
      throw Error("Invalid review scope/deadline");
    const old = this.get(input.scope),
      at = this.clock();
    if (!old && this.all().length >= 256)
      throw Error(
        "Review registry capacity reached; no existing deadline was discarded",
      );
    if (old?.origin.startsWith("agent:") && input.origin.startsWith("policy:"))
      return old;
    const replacePolicy =
      old?.origin.startsWith("policy:") && input.origin.startsWith("agent:");
    const entry: ReviewWait = {
      ...input,
      evidenceIds: input.evidenceIds.slice(0, 32),
      missing: input.missing.slice(0, 16),
      dueAt:
        (!replacePolicy ? old?.dueAt : undefined) ??
        new Date(
          Math.min(Date.parse(input.dueAt), at + 7 * 86400000),
        ).toISOString(),
      nextCheckAt: old?.nextCheckAt ?? new Date(at).toISOString(),
      trigger: old?.trigger ?? null,
      consumedTrigger: old?.consumedTrigger ?? null,
      checks: old?.checks ?? 0,
      lastAdmissionAt: old?.lastAdmissionAt ?? new Date(at).toISOString(),
    };
    this.store.set("reviewWait:" + hash(input.scope), entry);
    return entry;
  }
  signal(scope: string, trigger: string) {
    const r = this.get(scope);
    if (r && trigger !== r.consumedTrigger) {
      r.trigger = trigger;
      this.store.set("reviewWait:" + hash(scope), r);
    }
  }
  all() {
    return this.store
      .all("SELECT value FROM meta WHERE key LIKE 'reviewWait:%'")
      .map((r) => JSON.parse(r.value) as ReviewWait);
  }
  due(r: ReviewWait) {
    const at = this.clock();
    return (r.trigger !== null && r.trigger !== r.consumedTrigger) ||
      (at >= Date.parse(r.dueAt) && r.consumedTrigger !== 'due:'+r.dueAt);
  }

  admitted(scope: string, jobId?: string) {
    const r = this.get(scope);
    if (!r) return;
    r.consumedTrigger = r.trigger ?? (this.clock()>=Date.parse(r.dueAt)?'due:'+r.dueAt:null);
    r.lastAdmissionAt = new Date(this.clock()).toISOString();
    r.checks++;
    r.nextCheckAt = new Date(
      this.clock() + Math.min(6 * 3600000, 900000 * 2 ** Math.min(r.checks, 5)),
    ).toISOString();
    this.store.tx(() => {
      if (jobId)
        this.store.run(
          "INSERT OR IGNORE INTO job_events VALUES(?,?,?,?,?)",
          "review:" + hash(jobId + scope + (r.trigger ?? "") + r.checks),
          jobId,
          new Date(this.clock()).toISOString(),
          "review_trigger",
          JSON.stringify({ scope, trigger: r.trigger, dueAt: r.dueAt }),
        );
      this.store.set("reviewWait:" + hash(scope), r);
    });
  }
}
