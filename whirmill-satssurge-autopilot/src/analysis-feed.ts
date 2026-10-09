import { Store } from "./store.js";
export type Origin = "owner" | "scheduler" | "qualification" | "unknown";
export type Purpose = "economic" | "general" | "qualification" | "unknown";
export function provenance(store: Store, id: string) {
  const row = store.one(
    "SELECT details FROM job_events WHERE job_id=? AND type='accepted' ORDER BY at,id LIMIT 1",
    id,
  );
  const d = JSON.parse(row?.details ?? "{}");
  return { origin: d.origin ?? "unknown", purpose: d.purpose ?? "unknown" };
}
/** Latest outcome per scope, including incomplete successors; dedup before applying limit. */
export function analystFeed(store: Store, scope?: string, limit = 6) {
  const rows = store.all(
    `SELECT * FROM (SELECT j.*,j.rowid history_id,json_extract(e.details,'$.origin') origin,json_extract(e.details,'$.purpose') purpose,row_number() OVER (PARTITION BY j.scope ORDER BY j.created_at DESC,j.rowid DESC) rank FROM jobs j JOIN job_events e ON e.job_id=j.id AND e.type='accepted' WHERE j.lane='analyst' AND json_extract(e.details,'$.purpose')='economic' AND json_extract(e.details,'$.origin') IN ('owner','scheduler') AND (? IS NULL OR j.scope=?)) WHERE rank=1 ORDER BY created_at DESC,history_id DESC LIMIT ?`,
    scope ?? null,
    scope ?? null,
    Math.max(1, Math.min(100, limit)),
  );
  return rows.map((j) => {
    let r: any;
    try {
      r = JSON.parse(j.result ?? "{}");
    } catch {
      r = {};
    }
    return {
      id: j.id,
      scope: j.scope,
      state: j.state,
      origin: j.origin,
      purpose: j.purpose,
      requestId: j.request_id,
      conversationId: j.conversation_id,
      submissionId: j.submission_id,
      evidenceAt: r.evidenceAt ?? null,
      finishedAt: j.finished_at,
      complete: j.state === "completed" && !!r.answer,
      gap:
        j.state === "completed"
          ? null
          : "Latest relevant analysis is not complete; no older fallback.",
      detailTool: "analysis_detail",
    };
  });
}
