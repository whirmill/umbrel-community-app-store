import {createHash} from 'node:crypto';
import type {DatabaseSync} from 'node:sqlite';
import {channelScid} from './diagnostics.js';

export const CANONICAL_SCHEMA = 7;
export type Meaning = 'lnd_effect' | 'satssurge_intent' | 'external_intent' | 'derived_aggregate' | 'booked_claim' | 'historical_evidence';
export interface Binding {nodeId:string|null;network:string|null}
export interface Observation extends Binding {
  id?:string; kind:string; meaning:Meaning; source:string; sourceVersion:string|null;
  sourceInstance:string; originalId:string; batchId:string; occurredAt:string|null;
  observedAt:string; originalTimestamp?:string|null; timestampNs?:string|null;
  granularity:string; calculationVersion?:string|null; sourceChannel?:string|null;
  targetChannel?:string|null; endpointScope?:'single_effect'|'aggregate'; amountMsat?:string|null; feeMsat?:string|null;
  signedFeeDeltaMsat?:string|null; originalDigest?:string|null; payload:unknown;
}
export interface Coverage extends Binding {
  id?:string; capability:string; scope:string; source:string; epoch:string;
  start:string; end:string; observedAt:string;
  status:'complete'|'partial'|'unknown'|'gap'|'expired'|'ready'|'checkpoint';
  details:unknown; supersedes?:string|null;
}
export const digest=(value:unknown)=>createHash('sha256').update(stable(value)).digest('hex');
export function stable(value:unknown):string {
  if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
  if(typeof value==='number'&&Number.isSafeInteger(value))return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(stable).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+stable(v)).join(',')+'}';
  throw Error('Unsupported canonical value');
}
export function safePayload(value:unknown):string {
  const visit=(v:unknown,depth:number):void=>{
    if(depth>32)throw Error('Canonical payload depth limit');
    if(typeof v==='string'&&(/\b(?:lnbc|lntb|lnbcrt)[a-z0-9]{30,}/i.test(v)||v.length>262144))throw Error('Unsafe or oversized canonical payload');
    if(Array.isArray(v)){if(v.length>10000)throw Error('Canonical array limit');for(const x of v)visit(x,depth+1);}
    else if(v&&typeof v==='object')for(const [k,x] of Object.entries(v)){
      if(/(?:preimage|macaroon|credential|oauth|secret|token|invoice|payment_request|failure_string|personal_payments)/i.test(k))throw Error('Sensitive canonical payload field');
      visit(x,depth+1);
    }
  };visit(value,0);const text=stable(value);if(Buffer.byteLength(text)>1024*1024)throw Error('Canonical payload size limit');return text;
}
function stamp(v:string){if(!/^\d{4}-\d\d-\d\dT.*Z$/.test(v)||!Number.isFinite(Date.parse(v)))throw Error('Canonical UTC timestamp required');return new Date(v).toISOString();}
function decimal(v:string|null|undefined,signed=false){if(v==null)return null;if(typeof v!=='string'||v.length>100||!(signed?/^-?\d+$/:/^\d+$/).test(v))throw Error('Exact decimal string required');return BigInt(v).toString();}
function uint64(v:string){const n=decimal(v);if(n===null||BigInt(n)>18446744073709551615n)throw Error('Exact uint64 identity required');return n;}
function label(v:string){if(!v||v.length>512)throw Error('Missing or oversized canonical qualifier');return v;}
function binding(v:Binding){return {node_id:v.nodeId===null?null:label(v.nodeId),network:v.network===null?null:label(v.network)};}

/** Caller owns connection, executor fence and transaction lifetime. Never opens a database or books money. */
export class CanonicalModel {
  constructor(readonly db:DatabaseSync) {
    if(Number(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys)!==1)throw Error('Canonical connection requires foreign keys');if(Number(db.prepare('PRAGMA user_version').get()?.user_version)!==CANONICAL_SCHEMA)throw Error('Explicit canonical migration required');
  }
  transaction<T>(fn:()=>T):T {this.db.exec('BEGIN IMMEDIATE');try{const value=fn();this.db.exec('COMMIT');return value;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  private insert(table:string,row:Record<string,unknown>){
    const old=this.db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(String(row.id));
    if(old){if(stable(old)!==stable(row))throw Error('Immutable canonical identity conflict');return false;}
    const keys=Object.keys(row);this.db.prepare(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...Object.values(row) as any[]);return true;
  }
  observe(o:Observation):string {
    if(o.endpointScope!==undefined&&!['single_effect','aggregate'].includes(o.endpointScope))throw Error('Invalid endpoint scope');
    const payload=safePayload(o.payload);const row={
      id:'',...binding(o),kind:label(o.kind),meaning:o.meaning,source:label(o.source),source_version:o.sourceVersion===null?null:label(o.sourceVersion),
      source_instance:label(o.sourceInstance),original_id:label(o.originalId),batch_id:label(o.batchId),
      occurred_at:o.occurredAt===null?null:stamp(o.occurredAt),observed_at:stamp(o.observedAt),
      original_timestamp:o.originalTimestamp??o.occurredAt,timestamp_ns:decimal(o.timestampNs),
      granularity:label(o.granularity),calculation_version:o.calculationVersion==null?null:label(o.calculationVersion),
      source_channel:o.sourceChannel==null?null:channelScid(o.sourceChannel),target_channel:o.targetChannel==null?null:channelScid(o.targetChannel),
      endpoint_scope:o.endpointScope??'single_effect',amount_msat:decimal(o.amountMsat),fee_msat:decimal(o.feeMsat),signed_fee_delta_msat:decimal(o.signedFeeDeltaMsat,true),
      original_digest:o.originalDigest??null,payload_digest:digest(o.payload),payload};
    row.id=o.id??digest({...row,id:null});this.insert('canonical_observations',row);return row.id;
  }
  observation(id:string){return this.db.prepare('SELECT * FROM canonical_observations WHERE id=?').get(id) as any;}
  private validateEntityLink(observation:any,entity:any,relation:string):void {
    if(!entity||entity.node_id!==observation.node_id||entity.network!==observation.network)throw Error('Evidence link binding mismatch');
    if(['ambiguous','conflict','same_effect'].includes(relation)){
      const kinds:Record<string,string[]>={payment_index:['payment'],payment_hash:['payment'],payment_attempt:['payment_attempt'],htlc_circuit:['forward','native_htlc']};
      if(observation.meaning!=='lnd_effect'||entity.kind!==observation.kind||!kinds[entity.identity_namespace]?.includes(observation.kind))throw Error('Observation kind/meaning/namespace mismatch');
    }
    // There is currently no concrete LND-incarnation/financial-effect verifier.
    // Neither client labels nor caller-supplied proof-shaped JSON can replace one.
    if(relation==='same_effect')throw Error('Concrete financial-effect verifier unavailable');
  }
  link(input:{observationId:string;entityId?:string|null;referenceTable?:string|null;referenceId?:string|null;relation:'same_effect'|'original'|'booked_receipt'|'intent'|'attempt'|'ambiguous'|'conflict'|'projection_input';method:string;details:unknown}):string {
    const observation=this.observation(input.observationId);if(!observation)throw Error('Unknown canonical observation');
    if(input.relation==='same_effect'&&!input.entityId)throw Error('Concrete financial-effect verifier unavailable');
    if((input.referenceTable==null)!==(input.referenceId==null))throw Error('Complete original reference required');
    if(input.entityId)this.validateEntityLink(observation,this.db.prepare('SELECT * FROM canonical_entities WHERE id=?').get(input.entityId),input.relation);
    const row={id:'',observation_id:input.observationId,entity_id:input.entityId??null,reference_table:input.referenceTable??null,reference_id:input.referenceId??null,relation:input.relation,method:label(input.method),details:safePayload(input.details)};
    row.id=digest({...row,id:null});this.insert('canonical_evidence_links',row);return row.id;
  }
  /** Record candidates only. Native index/circuit correspondence never qualifies a financial effect. */
  identify(observationId:string,identity:{namespace:'payment_index'|'payment_hash'|'payment_attempt'|'forward_cursor'|'htlc_circuit'|'satssurge_operation';key:string}):{entityId:string;status:'matched'|'conflict'|'ambiguous'} {
    const o=this.observation(observationId);if(!o||!o.node_id||!o.network)throw Error('Qualified node/network binding required');
    let key=label(identity.key);
    if(identity.namespace==='forward_cursor')throw Error('Forward window offset is not a qualified global event identity; native circuit evidence required');
    if(identity.namespace==='payment_index')key=uint64(key);
    if(identity.namespace==='payment_attempt'){if(!/^\d+:\d+$/.test(key))throw Error('Attempt identity requires payment_index and attempt_id');key=key.split(':').map(uint64).join(':');}
    if(identity.namespace==='htlc_circuit'&&!/^[^:]+:\d+:\d+:\d+:\d+:(forward|link_fail|downstream_fail|settle):\d+$/.test(key))throw Error('HTLC identity requires client scope, circuit, variant and exact timestamp');
    if(identity.namespace==='payment_hash'&&!/^[0-9a-f]{64}$/.test(key))throw Error('Payment hash correlation requires a hash');
    const row={id:'',node_id:o.node_id,network:o.network,kind:o.kind,identity_namespace:identity.namespace,identity_key:key};
    this.validateEntityLink(o,row,'ambiguous');row.id=digest({...row,id:null});this.insert('canonical_entities',row);
    const previous=this.db.prepare("SELECT DISTINCT o.* FROM canonical_observations o JOIN canonical_evidence_links l ON l.observation_id=o.id WHERE l.entity_id=? AND (l.relation='same_effect' OR (l.relation='ambiguous' AND l.method='record_match_v2'))").iterate(row.id) as Iterable<any>;
    let conflict=false;if(identity.namespace!=='payment_hash')for(const p of previous){const aggregate=identity.namespace==='payment_index'&&(p.endpoint_scope==='aggregate'||o.endpoint_scope==='aggregate');const fields=aggregate?['amount_msat','fee_msat']:['amount_msat','fee_msat','source_channel','target_channel'];if(fields.some(k=>p[k]!==null&&o[k]!==null&&p[k]!==o[k])){conflict=true;break;}}
    const payload=JSON.parse(o.payload),fingerprint=identity.namespace==='htlc_circuit'?digest({nodeId:o.node_id,network:o.network,clientScope:key}):payload.recordFingerprint??null;
    const details={version:2,fingerprint,scope:identity.namespace==='htlc_circuit'?'client_observation_scope':'unverified_lnd_record_candidate',identityNamespace:identity.namespace,identityKey:key,sourceInstanceMeaning:'client_provenance_not_database_epoch',accountingAuthority:'none',financialQualified:false};
    this.link({observationId,entityId:row.id,relation:'ambiguous',method:'record_match_v2',details});
    if(conflict)this.link({observationId,entityId:row.id,relation:'conflict',method:'record_match_v2',details:{...details,reason:'known_record_metadata_conflict'}});
    return {entityId:row.id,status:conflict?'conflict':'ambiguous'};
  }
  appendCoverage(c:Coverage):string {
    const start=stamp(c.start),end=stamp(c.end);if(start>end)throw Error('Inverted canonical coverage');
    if(c.supersedes){const previous=this.db.prepare('SELECT * FROM canonical_coverage WHERE id=?').get(c.supersedes) as any;if(!previous||previous.node_id!==c.nodeId||previous.network!==c.network||previous.capability!==c.capability||previous.scope!==c.scope||previous.source!==c.source)throw Error('Coverage supersession scope mismatch');
      // Checkpoints/readiness advance independently; retained historical intervals
      // may disappear from active coverage only when their replacement covers them fully.
      if(!['ready','checkpoint'].includes(previous.status)&&(start>previous.start||end<previous.end||['ready','checkpoint'].includes(c.status)))throw Error('Coverage supersession must preserve historical interval');}
    const row={id:c.id??'',...binding(c),capability:label(c.capability),scope:label(c.scope),source:label(c.source),epoch:label(c.epoch),start,end,observed_at:stamp(c.observedAt),status:c.status,details:safePayload(c.details),supersedes:c.supersedes??null};row.id=c.id??digest({...row,id:null});this.insert('canonical_coverage',row);return row.id;
  }
  coverageRequirement(r:Binding&{capability:string;scope:string;start:string;end:string;source?:string;at?:string;maxAgeMs?:number}):{qualified:boolean;reasons:string[];coverageIds:string[]} {
    const start=stamp(r.start),end=stamp(r.end);if(start>=end)throw Error('Nonempty coverage interval required');
    if(!r.nodeId||!r.network)return {qualified:false,reasons:['unknown_binding'],coverageIds:[]};
    const rows=this.db.prepare(`SELECT c.* FROM canonical_coverage c WHERE node_id=? AND network=? AND capability=? AND scope=? AND start<? AND end>? AND NOT EXISTS(SELECT 1 FROM canonical_coverage n WHERE n.supersedes=c.id) ORDER BY start,end,id`).all(r.nodeId,r.network,r.capability,r.scope,end,start) as any[];
    const selected=rows.filter(c=>!r.source||c.source===r.source),reasons:string[]=[];
    if(selected.some(c=>['gap','unknown','partial','expired'].includes(c.status)))reasons.push('explicit_coverage_gap');
    const intervals=selected.filter(c=>c.status==='complete');let until=start;
    for(const c of intervals){if(c.start>until)break;if(c.end>until)until=c.end;}
    if(until<end)reasons.push('incomplete_interval');
    if(r.maxAgeMs!==undefined){const maxAgeMs=r.maxAgeMs;const at=Date.parse(stamp(r.at??new Date().toISOString()));if(!Number.isFinite(r.maxAgeMs)||r.maxAgeMs<0)throw Error('Invalid freshness requirement');if(!intervals.length||intervals.some(c=>Date.parse(c.observed_at)>at||at-Date.parse(c.observed_at)>maxAgeMs))reasons.push('stale_coverage');}
    return {qualified:reasons.length===0,reasons,coverageIds:selected.map(c=>c.id)};
  }
  readinessRequirement(r:Binding&{capability:string;scope:string;epoch:string;at:string;maxAgeMs:number}):{qualified:boolean;reasons:string[];coverageIds:string[]} {
    if(!r.nodeId||!r.network)return {qualified:false,reasons:['unknown_binding'],coverageIds:[]};
    const at=Date.parse(stamp(r.at));if(!Number.isFinite(r.maxAgeMs)||r.maxAgeMs<0)throw Error('Invalid readiness freshness');
    const row=this.db.prepare('SELECT * FROM canonical_coverage WHERE node_id=? AND network=? AND capability=? AND scope=? AND epoch=? ORDER BY rowid DESC LIMIT 1').get(r.nodeId,r.network,r.capability,r.scope,r.epoch) as any;
    const reasons:string[]=[];if(!row||row.status!=='ready')reasons.push('subscription_not_ready');
    if(row&&(Date.parse(row.observed_at)>at||at-Date.parse(row.observed_at)>r.maxAgeMs))reasons.push('stale_readiness');
    return {qualified:reasons.length===0,reasons,coverageIds:row?[row.id]:[]};
  }
  query(q:Binding&{kind?:string;source?:string;start?:string;end?:string;limit?:number}) {
    const limit=q.limit??1000;if(!Number.isSafeInteger(limit)||limit<1||limit>10000)throw Error('Bounded canonical query required');
    const clauses=['node_id IS ?','network IS ?'],args:any[]=[q.nodeId,q.network];for(const [column,value] of [['kind',q.kind],['source',q.source],['occurred_at>=',q.start?stamp(q.start):undefined],['occurred_at<',q.end?stamp(q.end):undefined]] as const)if(value!==undefined){clauses.push(column.endsWith('=')||column.endsWith('<')?column+'?':column+'=?');args.push(value);}
    const rows=this.db.prepare(`SELECT * FROM canonical_observations WHERE ${clauses.join(' AND ')} ORDER BY occurred_at,source,original_id,id LIMIT ?`).all(...args,limit+1) as any[];
    return {rows:rows.slice(0,limit),truncated:rows.length>limit,complete:false as const,note:'Retained observation query; coverage is qualified separately'};
  }
  effects(q:Binding&{kind:string}) {
    if(!q.nodeId||!q.network)return {available:false,entities:null,unresolvedObservationIds:null,complete:false as const};
    const entities=this.db.prepare('SELECT * FROM canonical_entities WHERE node_id IS ? AND network IS ? AND kind=? ORDER BY id').all(q.nodeId,q.network,q.kind) as any[];
    // Retained legacy same_effect rows are immutable evidence, not a verifier.
    const resolved=entities.map(entity=>({...entity,status:'unresolved',financialQualified:false,accountingAuthority:'none',observationIds:[...new Set((this.db.prepare('SELECT observation_id FROM canonical_evidence_links WHERE entity_id=? ORDER BY observation_id').all(entity.id) as any[]).map(r=>r.observation_id))]}));
    const unresolved=(this.db.prepare("SELECT o.id FROM canonical_observations o WHERE node_id=? AND network=? AND kind=? AND meaning='lnd_effect' ORDER BY o.id").all(q.nodeId,q.network,q.kind) as any[]).map(r=>r.id);
    return {available:true,entities:resolved,unresolvedObservationIds:unresolved,complete:false as const};
  }
  publishProjection(input:{name:string;scope:string;epoch:string;calculationVersion:string;observationIds:string[];coverageIds:string[];result:unknown;supersedes?:string|null}):string {
    return this.transaction(()=>this.publishProjectionInTransaction(input));
  }
  /** Explicit atomic composition; caller owns an active SQLite transaction. */
  publishProjectionInTransaction(input:Parameters<CanonicalModel['publishProjection']>[0]):string {
    if(!this.db.isTransaction)throw Error('Projection publication requires an active transaction');
    if(input.supersedes){const previous=this.db.prepare('SELECT * FROM canonical_projection_revisions WHERE id=?').get(input.supersedes) as any;if(!previous||previous.name!==input.name||previous.scope!==input.scope)throw Error('Projection supersession scope mismatch');}const ids=[...new Set(input.observationIds)].sort(),coverageIds=[...new Set(input.coverageIds)].sort();
    const observations=ids.map(id=>{const row=this.observation(id);if(!row)throw Error('Missing projection evidence');return row;});
    const coverage=coverageIds.map(id=>{const row=this.db.prepare('SELECT * FROM canonical_coverage WHERE id=?').get(id);if(!row)throw Error('Missing projection coverage');return row;});
    const lineage=ids.flatMap(id=>this.db.prepare("SELECT * FROM canonical_evidence_links WHERE observation_id=? AND relation<>'projection_input' ORDER BY id").all(id));const row={id:'',name:label(input.name),scope:label(input.scope),epoch:label(input.epoch),calculation_version:label(input.calculationVersion),input_digest:digest({observations,coverage,lineage}),evidence_ids:stable(ids),lineage_ids:stable(lineage.map((l:any)=>l.id)),coverage_ids:stable(coverageIds),result:safePayload(input.result),supersedes:input.supersedes??null};row.id=digest({name:row.name,scope:row.scope,epoch:row.epoch,calculationVersion:row.calculation_version,inputDigest:row.input_digest,supersedes:row.supersedes});
    this.insert('canonical_projection_revisions',row);for(const observationId of ids)this.link({observationId,referenceTable:'canonical_projection_revisions',referenceId:row.id,relation:'projection_input',method:input.calculationVersion,details:{}});return row.id;
  }
}
