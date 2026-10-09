import {Store} from './store.js';
import { hash, json, scrub, id } from "./domain.js";
import { channelScid } from "./diagnostics.js";
import {
  statePage,
  type StatePageQuery,
  STATE_PAGE_BYTES,
} from "./agent-state.js";
export interface EvidenceQuery extends StatePageQuery {
  cursor?: string;
  source?: string;
  target?: string;
  start?: string;
  end?: string;
}
type View = {
  owner: string;
  query: string;
  version: string;
  rows: any[];
  metadata: any;
  capturedAt: string;
  bytes: number;
  expires: number;
};
function canonical(v: string) {
  return channelScid(v);
}
export function normalizeEvidenceQuery(q: EvidenceQuery): EvidenceQuery {
  const query = { ...q };
  for (const name of ["source", "target", "channel"] as const)
    if (query[name] !== undefined) query[name] = canonical(query[name]!);
  for (const name of ["start", "end"] as const)
    if (query[name] !== undefined) {
      const timestamp = Date.parse(query[name]!);
      if (!Number.isFinite(timestamp)) throw Error("Invalid UTC interval");
      query[name] = new Date(timestamp).toISOString();
    }
  if (
    query.start &&
    query.end &&
    Date.parse(query.start) > Date.parse(query.end)
  )
    throw Error("Inverted interval");
  return query;
}
/** Derived immutable views: explicit capacity errors, never silently evict a live cursor. */
export class EvidenceViews {
  has(cursor: string | undefined) {
    this.expire();
    return !!cursor && this.views.has(cursor);
  }
  private views = new Map<string, View>();
  constructor(
    private clock = Date.now,
    readonly ttl = 300000,
    readonly perView = 4 * 1024 * 1024,
    readonly globalBytes = 16 * 1024 * 1024,
    private store?:Store,
  ) {
    for(const row of store?.all("SELECT key,value FROM meta WHERE key LIKE 'evidenceView:%'")??[]){const view=JSON.parse(row.value);this.views.set(row.key.slice(13),view);}
    this.expire();
  }
  releaseCursor(owner: string, cursor: string) {
    const v = this.views.get(cursor);
    if (!v) return false;
    if (v.owner !== owner) throw Error("Cursor owned by another job");
    this.views.delete(cursor);
    this.store?.run("DELETE FROM meta WHERE key=?",'evidenceView:'+cursor);
    return true;
  }
  release(owner: string) {
    for (const [k, v] of this.views)
      if (v.owner === owner) {this.views.delete(k);this.store?.run('DELETE FROM meta WHERE key=?','evidenceView:'+k);}
  }
  private expire() {
    for (const [k, v] of this.views)
      if (v.expires <= this.clock()) {this.views.delete(k);this.store?.run('DELETE FROM meta WHERE key=?','evidenceView:'+k);}
  }
  page(owner: string, state: any, q: EvidenceQuery) {
    this.expire();
    const { cursor, offset = 0, version, ...query } = normalizeEvidenceQuery(q);
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw Error("Invalid offset");
    let canonicalQuery=query;
    const existing=cursor?this.views.get(cursor):undefined;
    if(existing){
      const saved=JSON.parse(existing.query);
      for(const [name,value] of Object.entries(query))if(value!==undefined&&saved[name]!==value)throw Error('Cursor belongs to another query');
      canonicalQuery=saved;
    }
    const key = json(
      Object.fromEntries(
        Object.entries(canonicalQuery).sort(([a], [b]) => a.localeCompare(b)),
      ),
    );
    let token = cursor,
      v = cursor ? this.views.get(cursor) : undefined;
    if (cursor && !v)
      return {
        available: false,
        expired: true,
        reopen: true,
        rows: [],
        nextOffset: null,
        note: "View expired or server restarted; reopen explicitly in the original submission.",
      };
    if (v && (v.owner !== owner || v.query !== key))
      throw Error("Cursor belongs to another job or query");
    if (!v) {
      // Preserve the legacy current-acquisition version contract when explicitly supplied.
      if(version)return {available:false,changed:true,reopen:true,rows:[],nextOffset:null,nextCall:{tool:'state_page',query:{...query,offset:0}},note:'Version without immutable cursor requires explicit reopen; no section completion is implied'};
      if (offset) throw Error("Continuation requires cursor or legacy version");
      const first = statePage(state, {
        ...q,
        channel:
          q.section === "competition_alternatives"
            ? state.competition?.channels?.find(
                (r: any) => canonical(r.id) === query.channel,
              )?.id
            : q.channel,
        offset: 0,
      });
      if (!first.available) return first;
      let rows: any[];
      if (q.section === "diagnostics")
        rows = state.diagnostics[q.provider!][q.collection!];
      else if (q.section === "channels") rows = state.snapshot.channels;
      else if (q.section === "competition")
        rows = state.competition.channels.map(
          ({ alternatives, ...r }: any) => ({
            ...r,
            availableAlternativeRows: alternatives?.length ?? null,
          }),
        );
      else if (q.section === "competition_alternatives")
        rows =
          state.competition.channels.find(
            (r: any) => canonical(r.id) === query.channel,
          )?.alternatives ?? [];
      else rows = state[q.section];
      let unsupported = 0;
      rows = state.adapterFiltered ? rows : rows.filter((r) => {
        if (query.channel && q.section !== "competition_alternatives") {
          const channel = r.id ?? r.channelId ?? r.channel_id;
          if (!channel) {
            unsupported++;
            return false;
          }
          try {
            if (canonical(channel) !== query.channel) return false;
          } catch {
            unsupported++;
            return false;
          }
        }
        for (const name of ["source", "target"] as const)
          if (query[name]) {
            if (!r[name]) {
              unsupported++;
              return false;
            }
            try {
              if (canonical(r[name]) !== query[name]) return false;
            } catch {
              unsupported++;
              return false;
            }
          }
        const at =
          r.at ?? r.occurred_at ?? (r.day ? r.day + "T00:00:00.000Z" : null);
        if (
          (query.start || query.end) &&
          (!at || !Number.isFinite(Date.parse(at)))
        ) {
          unsupported++;
          return false;
        }
        return (
          (!query.start || Date.parse(at) >= Date.parse(query.start)) &&
          (!query.end || Date.parse(at) < Date.parse(query.end))
        );
      });
      if(unsupported)return {available:false,unsupportedFilter:true,rows:null,nextOffset:null,note:'Unsupported scoped filter is unavailable, never an empty result'};
      rows = JSON.parse(json(scrub(rows)));
      const metadata = {
        ...first.metadata,
        ...state.sourceMetadata,
        scope: query,
        unsupportedRows: unsupported,
        viewComplete: true,
        captureComplete: (first.metadata as any)?.captureComplete ?? null,
        captureCounts: (first.metadata as any)?.captureCounts ?? null,
        upstreamHistoryComplete:
          (first.metadata as any)?.coverage?.complete ?? false,
        projectionLimits: state.projectionLimits ?? null,
      };
      const bytes = Buffer.byteLength(json({ rows, metadata }));
      if (
        bytes > this.perView ||
        [...this.views.values()].reduce((a, v) => a + v.bytes, 0) + bytes >
          this.globalBytes ||
        [...this.views.values()].filter((v) => v.owner === owner).length >= 3
      )
        return {
          available: false,
          capacity: true,
          rows: [],
          nextOffset: null,
          note: "Evidence view capacity reached; narrow the scope or release a view. No live view was evicted.",
        };
      token = id();
      v = {
        owner,
        query: key,
        rows,
        metadata,
        version: hash(json({schema:1,query,rows,coverage:metadata.coverage,limits:metadata.projectionLimits,captureComplete:metadata.captureComplete,captureCounts:metadata.captureCounts,upstreamHistoryComplete:metadata.upstreamHistoryComplete})),
        capturedAt: new Date(this.clock()).toISOString(),
        bytes,
        expires: this.clock() + this.ttl,
      };
      this.views.set(token, v);
      this.store?.set('evidenceView:'+token,v);
    }
    if (offset > v.rows.length) throw Error("Offset beyond view");
    const page: any = {
      available: true,
      section: q.section,
      cursor: token,
      version: v.version,
      capturedAt: v.capturedAt,
      expiresAt: new Date(v.expires).toISOString(),
      metadata: v.metadata,
      total: v.rows.length,
      offset,
      rows: [],
      nextOffset: null,
    };
    for (let i = offset; i < v.rows.length && page.rows.length < 20; i++) {
      page.rows.push(v.rows[i]);
      page.nextOffset = i + 1 < v.rows.length ? i + 1 : null;
      if (Buffer.byteLength(json(page)) > STATE_PAGE_BYTES - 1024) {
        page.rows.pop();
        page.nextOffset = i;
        break;
      }
    }
    if (!page.rows.length && offset < v.rows.length)
      throw Error("Record exceeds bounded envelope; narrow source detail");
    page.nextCall=page.nextOffset===null?null:{tool:'state_page',query:{...JSON.parse(v.query),cursor:token,offset:page.nextOffset}};
    if (offset === 0) page.summary = {...this.summarize(v.rows),schema:1,source:v.metadata.source??canonicalQuery.provider??canonicalQuery.section,granularity:canonicalQuery.collection==='failureRollups'?'attempt buckets':canonicalQuery.collection==='failures'?'HTLC attempts':'original records',scope:JSON.parse(v.query),interval:{start:canonicalQuery.start??null,end:canonicalQuery.end??null},selected:v.rows.length,processed:v.rows.length,truncated:v.metadata.projectionLimits?.truncated??false,coverage:v.metadata.coverage??null,sourceRefs:v.rows.slice(0,20).map(r=>r.id??r.evidence_id??null),note:'Whole retained view; diagnostic copies are separate from authoritative LND originals. Failed or missed fees do not establish distinct recoverable demand.'};
    if (Buffer.byteLength(json(page)) > STATE_PAGE_BYTES - 1024)
      delete page.summary;
    return page;
  }
  private summarize(rows: any[]) {
    const totals: Record<string, bigint> = {};
    for (const row of rows)
      for (const k of [
        "amountMsat",
        "feeMsat",
        "missedFeeMsat",
        "amount_msat",
        "fee_msat",
        "count",
      ])
        if (typeof row[k] === "string" && /^\d+$/.test(row[k]))
          totals[k] = (totals[k] ?? 0n) + BigInt(row[k]);
    return {
      records: rows.length,
      groups: ['external_forward','htlc_rejected','manual_operation','manual_policy'].map(type=>({type,records:rows.filter(r=>r.type===type).length,amountMsat:rows.filter(r=>r.type===type).reduce((n,r)=>n+BigInt(r.amount_msat??'0'),0n).toString(),feeMsat:rows.filter(r=>r.type===type).reduce((n,r)=>n+BigInt(r.fee_msat??'0'),0n).toString()})),
      units:'integer msat; counts are records, not distinct recoverable demand',
      combinesSources:false,
      totals: Object.fromEntries(
        Object.entries(totals).map(([k, v]) => [k, v.toString()]),
      ),
      distinctPaymentsUnknown: rows.some(
        (r) => r.distinctPaymentsUnknown || r.granularity,
      ),
    };
  }
  metrics() {
    this.expire();
    return {
      views: this.views.size,
      bytes: [...this.views.values()].reduce((a, v) => a + v.bytes, 0),
    };
  }
}
