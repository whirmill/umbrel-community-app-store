import { Store } from "./store.js";
import { json } from "./domain.js";
export const HISTORY_BYTES = 2 * 1024 * 1024;
/** Bound the SQL read before allocation. Replace heavy tool bodies with authenticated detail pointers. */
export function historyEvents(store: Store, ids: string[]) {
  if (!ids.length) return { events: [], partial: false };
  const rows = store.all(
    `SELECT id,job_id,at,type,CASE WHEN type IN ('tool_call','tool_result') THEN json_object('toolCallId',json_extract(data,'$.toolCallId'),'toolName',json_extract(data,'$.toolName'),'isError',json_extract(data,'$.isError'),'unavailable',json_extract(data,'$.unavailable'),'detailEventId',id,'argsAvailable',0) ELSE data END data FROM ui_events e WHERE job_id IN (${ids.map(() => "?").join(",")}) AND (type NOT IN ('text','progress','job','reasoning_summary') OR id=(SELECT max(id) FROM ui_events x WHERE x.job_id=e.job_id AND x.type=e.type AND (e.type<>'reasoning_summary' OR json_extract(x.data,'$.itemId')=json_extract(e.data,'$.itemId') AND json_extract(x.data,'$.index')=json_extract(e.data,'$.index')))) ORDER BY id DESC LIMIT 2049`,
    ...ids,
  );
  let bytes = 0;
  const events = [];
  for (const r of rows.slice(0, 2048)) {
    const event = { ...r, data: JSON.parse(r.data) };
    const n = Buffer.byteLength(json(event));
    if (bytes + n > HISTORY_BYTES) break;
    events.push(event);
    bytes += n;
  }
  return {
    events: events.reverse(),
    partial: rows.length > events.length,
    detailAccess: "/api/jobs/events?jobId=…&after=…",
    bytes,
  };
}
