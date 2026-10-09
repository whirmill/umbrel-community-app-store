import { channelScid } from "./diagnostics.js";
import { Store } from "./store.js";
import {
  normalizeEvidenceQuery,
  type EvidenceQuery,
} from "./evidence-views.js";
const tables: Record<string, { table: string; order: string }> = {
  decisions: { table: "decisions", order: "at" },
  operations: { table: "operations", order: "at" },
  evaluations: { table: "evaluations", order: "at" },
  evaluationWindows: { table: "evaluation_windows", order: "at" },
  coverage: { table: "coverage", order: "end" },
  claims: { table: "claims", order: "at" },
  holds: { table: "channel_holds", order: "at" },
};
/** Only the requested collection is acquired; page continuations never call this again. */
export function evidenceSource(store: Store, input: EvidenceQuery) {
  const q = normalizeEvidenceQuery(input);
  if (q.section === "channels") return { snapshot: store.get("snapshot") };
  if (q.section === "competition" || q.section === "competition_alternatives")
    return { competition: store.get("competition") };
  if (q.section === "diagnostics")
    return { diagnostics: store.get("diagnostics") };
  if (q.section === "corridor_events") {
    const rows = store.all(
      "SELECT * FROM events WHERE source=? AND target=? AND (? IS NULL OR julianday(occurred_at)>=julianday(?)) AND (? IS NULL OR julianday(occurred_at)<julianday(?)) ORDER BY occurred_at,id LIMIT 10001",
      decimal(q.source),
      decimal(q.target),
      q.start ?? null,
      q.start ?? null,
      q.end ?? null,
      q.end ?? null,
    );
    return {
      corridor_events: rows.slice(0, 10000),
      projectionLimits: {
        selected: rows.length,
        limit: 10000,
        truncated: rows.length > 10000,
        upstreamHistoryComplete: false,
      },
    };
  }
  const config = tables[q.section];
  if (!config) return {};
  const rows = store.all(
    `SELECT * FROM ${config.table} ORDER BY ${config.order}${q.section === "holds" ? ",channel_id" : ",id"} LIMIT 10001`,
  );
  return {
    [q.section]: rows.slice(0, 10000),
    projectionLimits: {
      selected: rows.length,
      limit: 10000,
      truncated: rows.length > 10000,
      upstreamHistoryComplete: false,
    },
  };
}

function decimal(v: string | undefined) {
  if (!v) return "";
  const [h, t, o] = channelScid(v).split("x").map(BigInt);
  return ((h! << 40n) + (t! << 16n) + o!).toString();
}
