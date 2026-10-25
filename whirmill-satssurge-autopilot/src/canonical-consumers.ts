import {nativeFailureRollups} from './native-failure-aggregate.js';
import type {Store} from './store.js';
import {channelScid} from './diagnostics.js';
import {archiveOriginal,boundedOriginalRows,encodeOriginal,type LegacyTable} from './canonical-migration.js';
import {CanonicalModel,digest} from './canonical-model.js';
export interface CanonicalReadQuery {section?:string;kind?:string;subtype?:'failures'|'circular_attempts';source?:string;target?:string;channel?:string;start?:string;end?:string;limit?:number;after?:number;through?:number}
function coverageSummary(store:Store){const r=store.one('SELECT count(*) checkpointCount,coalesce(max(rowid),0) through FROM canonical_coverage');return {...r,complete:false,sourceHistoryComplete:false,details:{tool:'state_page',query:{section:'coverage',provider:'native'}}};}
const sections:Record<string,string[]>={corridor_events:['forward','events'],manual_events:['payment','payment_attempt','events'],policy_events:['native_policy','events'],coverage:[],decisions:['decisions'],operations:['operations'],evaluations:['evaluations'],evaluationWindows:['evaluation_windows'],claims:['claims'],holds:['channel_holds']};
/** Public allowlist only: confidential originals, personal hashes/routes and private narratives never leave storage. */
export function canonicalRead(store:Store,q:CanonicalReadQuery={}){
 if(!store.canonical)throw Error('Canonical runtime unavailable');
 q=Object.fromEntries(Object.entries(q).filter(([,value])=>value!==undefined));
 for(const key of ['start','end'] as const)if(q[key]&&!Number.isFinite(Date.parse(q[key]!)))throw Error('Invalid canonical interval');
 if(q.start&&q.end&&Date.parse(q.start)>Date.parse(q.end))throw Error('Inverted canonical interval');
 if(q.subtype!==undefined&&!(q.subtype==='failures'&&q.kind==='native_htlc'||q.subtype==='circular_attempts'&&q.kind==='payment_attempt'))throw Error('Unsupported canonical subtype');

 const limit=q.limit??200,after=q.after??0;
 if(!Number.isSafeInteger(limit)||limit<1||limit>10000||!Number.isSafeInteger(after)||after<0)throw Error('Bounded canonical pagination required');
 if(q.section==='coverage'){
  if(q.source||q.target||q.channel)throw Error('Coverage directional filter requires a qualified scope');
  const through=q.through??Number(store.one('SELECT coalesce(max(rowid),0) n FROM canonical_coverage').n);
  if(!Number.isSafeInteger(through)||through<after)throw Error('Invalid canonical high water');
  const filter=['rowid>?','rowid<=?'],parameters:any[]=[after,through];
  if(q.start){filter.push('end>=?');parameters.push(new Date(q.start).toISOString());}if(q.end){filter.push('start<?');parameters.push(new Date(q.end).toISOString());}
  const selected=store.all('SELECT rowid cursor,id,capability,scope,source,start,end,observed_at,status FROM canonical_coverage WHERE '+filter.join(' AND ')+' ORDER BY rowid LIMIT ?',...parameters,limit+1),rows=selected.slice(0,limit).map(({cursor,...r})=>r),nextAfter=selected.length>limit?Number(selected[limit-1]!.cursor):null;
  return {rows,available:true,nextAfter,through,version:digest({through,query:q,ids:rows.map(r=>r.id)}),coverage:coverageSummary(store),complete:false,sourceHistoryComplete:false,accountingAuthority:'none',note:'Coverage checkpoints do not prove completeness',projectionLimits:{selected:rows.length,limit,truncated:nextAfter!==null,upstreamHistoryComplete:false},filterSemantics:'directional-canonical-v1'};
 }
 const high=q.through??Number(store.one('SELECT coalesce(max(rowid),0) n FROM canonical_observations').n);
 if(!Number.isSafeInteger(high)||high<after)throw Error('Invalid canonical high water');
 const clauses=['rowid>?','rowid<=?'],args:any[]=[after,high];
 if(q.kind){clauses.push('kind=?');args.push(q.kind);}else if(q.section){const kinds=sections[q.section];if(!kinds)throw Error('Unsupported canonical section');if(kinds.length){clauses.push(`kind IN (${kinds.map(()=>'?')})`);args.push(...kinds);}}
 for(const [key,column] of [['source','source_channel'],['target','target_channel']] as const)if(q[key]){clauses.push(column+'=?');args.push(channelScid(q[key]));}
 if(q.channel){clauses.push('(source_channel=? OR target_channel=?)');args.push(channelScid(q.channel),channelScid(q.channel));}
 for(const [key,operator] of [['start','>='],['end','<']] as const)if(q[key]){const t=Date.parse(q[key]!);if(!Number.isFinite(t))throw Error('Invalid canonical interval');clauses.push(`(occurred_at${operator}? OR (kind='native_policy' AND occurred_at IS NULL AND observed_at${operator}?))`);args.push(new Date(t).toISOString(),new Date(t).toISOString());}
 if(q.start&&q.end&&Date.parse(q.start)>Date.parse(q.end))throw Error('Inverted canonical interval');
 if(q.section==='corridor_events')clauses.push("(kind='forward' OR json_extract(payload,'$.type')='external_forward')");
 if(q.section==='manual_events')clauses.push("(kind IN ('payment','payment_attempt') OR json_extract(payload,'$.type')='manual_operation')");
 if(q.section==='policy_events')clauses.push("(kind='native_policy' OR json_extract(payload,'$.type')='manual_policy')");
 if(q.subtype==='failures')clauses.push("kind='native_htlc' AND json_extract(payload,'$.native.variant') IN ('link_fail','forward_fail')");
 else if(q.subtype==='circular_attempts')clauses.push("kind='payment_attempt' AND json_extract(payload,'$.status')='SUCCEEDED' AND EXISTS (SELECT 1 FROM canonical_evidence_links l JOIN canonical_observations p ON p.id=l.reference_id WHERE l.observation_id=canonical_observations.id AND l.relation='attempt' AND p.kind='payment' AND p.rowid<=? AND json_extract(p.payload,'$.allSettledRoutesToLocal')=1)"),args.push(high);
 else if(q.subtype!==undefined)throw Error('Unsupported canonical subtype');
 const unknownDirectionRetained=!!((q.source||q.target||q.channel)&&store.one("SELECT 1 FROM canonical_observations WHERE rowid<=? AND (source_channel IS NULL OR target_channel IS NULL) AND (? IS NULL OR kind=?) LIMIT 1",high,q.kind??null,q.kind??null));
 const selected=store.all(`SELECT rowid cursor,* FROM canonical_observations WHERE ${clauses.join(' AND ')} ORDER BY rowid LIMIT ?`,...args,limit+1);
 const rows=selected.slice(0,limit).map(o=>{
  const p=JSON.parse(o.payload);
  const projection=o.kind==='native_htlc'?store.one("SELECT p.id,p.calculation_version,p.input_digest,p.coverage_ids,p.result FROM canonical_projection_revisions p JOIN canonical_evidence_links l ON l.reference_id=p.id WHERE l.observation_id=? AND l.relation='projection_input' AND p.name='native_htlc_diagnostics' ORDER BY p.rowid DESC LIMIT 1",o.id):null;
  const result=projection?JSON.parse(projection.result):null;
  const scalar=(value:any)=>value===null||typeof value==='boolean'||typeof value==='number'&&Number.isSafeInteger(value)||typeof value==='string'&&/^-?\d{1,30}(\.\d{1,6})?$/.test(value)?value:null;
  const comparison=result?{projectionId:projection.id,calculationVersion:projection.calculation_version,inputDigest:projection.input_digest,coverageIds:JSON.parse(projection.coverage_ids),lndg:{amountSat:scalar(result.lndg?.amountSat),failedOutCachedProxy:scalar(result.lndg?.failedOutCachedProxy),cachedForwardKnown:scalar(result.lndg?.cachedForwardKnown),legacyWireFailure:scalar(result.lndg?.legacyWireFailure),legacyFailureDetail:scalar(result.lndg?.legacyFailureDetail),instantaneousLiquidityQualified:false},lightningMate:{buckets:(result.lightningMate?.buckets??[]).slice(0,1).map((bucket:any)=>Object.fromEntries(['nativeFailureAttemptCount','liquidityCount','otherCount','unknownCauseCount','unknownAmountCount','converterDroppedCount','ambiguousIdentityCount','precisionDifferenceCount','knownLiquiditySats','liquiditySats','partial'].map(k=>[k,scalar(bucket[k])]))),eventMultiplicityQualified:false},financialQualified:false}:null;
  const policyFields=['timeLockDelta','minHtlcMsat','feeBaseMsat','feeRatePpm','disabled','maxHtlcMsat','lastUpdate','inboundFeeBaseMsat','inboundFeeRatePpm'];
  const policy=p.policy&&typeof p.policy==='object'?Object.fromEntries(policyFields.map(k=>[k,k==='disabled'?(typeof p.policy[k]==='boolean'?p.policy[k]:null):typeof p.policy[k]==='string'&&/^-?\d{1,20}$/.test(p.policy[k])?p.policy[k]:null])):null;
  return {id:o.id,nodeId:o.node_id,network:o.network,kind:o.kind,meaning:o.meaning,source:o.source,sourceVersion:o.source_version,sourceInstance:o.source_instance,originalId:o.original_id,occurredAt:o.occurred_at,acquiredAt:o.observed_at,sourceChannel:o.source_channel,targetChannel:o.target_channel,amountMsat:o.amount_msat,feeMsat:o.fee_msat,granularity:o.granularity,originalChecksum:o.original_digest,timestampNs:o.timestamp_ns,mutationTimeKnown:o.occurred_at!==null,temporalScope:o.occurred_at===null?'observed_acquisition':'source_event',calculationVersion:o.calculation_version,endpointScope:o.endpoint_scope,financialQualified:false,accountingAuthority:o.meaning==='booked_claim'?'original_receipt':'none',reconciliation:o.meaning==='lnd_effect'?'UNRECONCILED':'original_evidence',status:['UNKNOWN','INITIATED','IN_FLIGHT','SUCCEEDED','FAILED'].includes(p.status)?p.status:null,attemptRoute:o.kind==='payment_attempt'&&p.route?{sourceChannel:o.source_channel,targetChannel:o.target_channel,amountMsat:p.route.amountMsat??null,feeMsat:p.route.feeMsat??null,settled:p.status==='SUCCEEDED'}:undefined,allSettledRoutesToLocal:typeof p.allSettledRoutesToLocal==='boolean'?p.allSettledRoutesToLocal:null,externalIntent:'unknown',htlc:o.kind==='native_htlc'?{comparison,variant:['forward','link_fail','settle','forward_fail'].includes(p.native?.variant)?p.native.variant:null,eventMultiplicityQualified:false,demandQualified:false,revenueQualified:false}:undefined,policy:o.kind==='native_policy'?{direction:['outgoing','incoming'].includes(p.direction)?p.direction:null,policy,currentPolicyQualified:false}:undefined};
 });
 // Coverage is a separate bounded lineage list. No checkpoints/ACKs become history completeness.
 const coverage=coverageSummary(store);
 const next=selected.length>limit?Number(selected[limit-1]!.cursor):null;
 const heartbeat=store.get<{at:string;phase:string}>('nativeStream'),age=heartbeat?Date.now()-Date.parse(heartbeat.at):Infinity;
 return {rows,scopeEvidenceUnknown:unknownDirectionRetained,temporalValidity:{streamFresh:!!heartbeat&&heartbeat.phase==='subscribed'&&Number.isFinite(age)&&age>=0&&age<=30000,streamLastEvidenceAt:heartbeat?.at??null,replayQualified:false,historicalCompleteness:false},available:true,nextAfter:next,through:high,version:digest({query:q,through:high,ids:rows.map(r=>r.id)}),coverage,complete:false,sourceHistoryComplete:false,accountingAuthority:'none',note:'Retained observations include unresolved overlaps; amounts are not deduplicated financial totals',projectionLimits:{selected:rows.length,limit,truncated:next!==null,upstreamHistoryComplete:false},filterSemantics:'directional-canonical-v1'};
}

/** Refresh timestamps alone do not make a different provider capture. */
export function captureDigestOf(p:any):string{
 if(!p||typeof p!=='object'||Array.isArray(p))return digest(p);
 const {capturedAt:_capturedAt,coverage,...rest}=p;if(!coverage||typeof coverage!=='object')return digest(rest);
 const {start:_start,end:_end,...window}=coverage;return digest({...rest,coverage:window});
}
/** Content identity of a whole diagnostics value; the refresh time is ignored. */
export function diagnosticContentDigest(value:any):string{return digest(Object.fromEntries(Object.entries(value??{}).filter(([key])=>key!=='at').map(([key,p])=>[key,captureDigestOf(p)])));}
const diagnosticProviders=['lndg','lightningMate'];
const diagnosticCollections=['forwards','failures','failureRollups','rebalances'];
const captureKey=(provider:string,collection:string,captureDigest?:string)=>'canonicalDiagnosticLookup:'+digest({provider,collection,captureDigest:captureDigest??null});
/** Derived lookup only. Every hit is revalidated against the immutable original before use. */
export function indexDiagnosticCapture(store:Store,archiveId:string,diagnostics:any){
 const archive=store.one("SELECT rowid rid FROM canonical_original_archive WHERE id=? AND original_table='meta' AND original_id='diagnostics'",archiveId);if(!archive)return;
 for(const provider of diagnosticProviders){const p=diagnostics?.[provider];if(p?.status!=='qualified')continue;const captureDigest=captureDigestOf(p);
  for(const collection of diagnosticCollections){if(!Array.isArray(p[collection]))continue;for(const key of [captureKey(provider,collection),captureKey(provider,collection,captureDigest)]){const old=store.get<any>(key);if(!old||old.rowid<=archive.rid)store.run('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',key,JSON.stringify({archiveId,rowid:archive.rid}));}}
 }
}
function retainedDiagnostic(store:Store,provider:string,collection:string,captureDigest?:string):{capture?:any;archiveId?:string;searching?:boolean;lookupProgress?:{through:number;before:number}}{
 const key=captureKey(provider,collection,captureDigest),cached=store.get<any>(key);
 const decode=(id:string)=>{const a=store.one("SELECT id,raw_row,original_digest FROM canonical_original_archive WHERE id=? AND original_table='meta' AND original_id='diagnostics'",id);if(!a)return null;if(Buffer.byteLength(a.raw_row)>16777216||digest(a.raw_row)!==a.original_digest)throw Error('Original diagnostic digest mismatch');const raw=JSON.parse(a.raw_row);const diagnostics=JSON.parse(raw.value?.[1]??'null');const p=diagnostics?.[provider];return {a,diagnostics,p};};
 const matches=(p:any)=>p?.status==='qualified'&&Array.isArray(p[collection])&&(!captureDigest||captureDigestOf(p)===captureDigest);
 if(cached?.archiveId){const decoded=decode(cached.archiveId);if(decoded&&matches(decoded.p))return {capture:decoded.p,archiveId:decoded.a.id};}
 // Older archives may predate the derived index. Resume keyset work; a budget is never absence proof.
 const high=Number(store.one("SELECT coalesce(max(rowid),0) n FROM canonical_original_archive WHERE original_table='meta' AND original_id='diagnostics'").n),progressKey=key+':scan',saved=store.get<any>(progressKey);
 const progress=saved&&(!saved.complete||saved.through===high)?saved:{through:high,before:high+1,complete:false};if(progress.complete)return {};
 const candidates=store.all("SELECT rowid rid,id,length(CAST(raw_row AS BLOB)) bytes FROM canonical_original_archive WHERE original_table='meta' AND original_id='diagnostics' AND rowid<? AND rowid<=? ORDER BY rowid DESC LIMIT 201",progress.before,progress.through);
 const deadline=Date.now()+100,byteLimit=16777216;let bytes=0,examined=0;
 for(const candidate of candidates.slice(0,200)){
  if(examined&&(Date.now()>=deadline||bytes+candidate.bytes>byteLimit))break;
  if(candidate.bytes>byteLimit)throw Error('Original diagnostic archive bounds');
  bytes+=candidate.bytes;examined++;const decoded=decode(candidate.id);progress.before=Number(candidate.rid);
  if(!decoded)continue;indexDiagnosticCapture(store,candidate.id,decoded.diagnostics);
  if(matches(decoded.p)){store.set(progressKey,progress);return {capture:decoded.p,archiveId:decoded.a.id};}
 }
 progress.complete=examined===candidates.length&&candidates.length<=200;store.set(progressKey,progress);
 return progress.complete?{}:{searching:true,lookupProgress:{through:progress.through,before:progress.before}};
}

/** Native observations remain separate from retained adapter requests and booked accounting. */
export function canonicalDiagnostics(store:Store,q:CanonicalReadQuery&{provider?:string;collection?:string;diagnosticCaptureDigest?:string}={}) {
 const provider=q.provider??'native',collection=q.collection??'forwards';
 if(provider!=='native'){
  const legacy=store.get<any>('diagnostics');let p=legacy?.[provider];let retainedArchiveId:string|null=null;
  if(!diagnosticProviders.includes(provider)||!diagnosticCollections.includes(collection))return {unavailableEvidence:{available:false,rows:null,nextOffset:null,note:'Retained source capability unsupported'}};
  if(p?.status!=='qualified'||!Array.isArray(p[collection])||q.diagnosticCaptureDigest&&captureDigestOf(p)!==q.diagnosticCaptureDigest){const found=retainedDiagnostic(store,provider,collection,q.diagnosticCaptureDigest);if(found.searching)return {unavailableEvidence:{available:false,searching:true,lookupProgress:found.lookupProgress,rows:null,nextOffset:null,note:'Bounded archive lookup in progress; continue the same query. No absence or completion is implied'}};if(found.capture){p=found.capture;retainedArchiveId=found.archiveId!;}}
  if(p?.status!=='qualified'||!Array.isArray(p[collection])||q.diagnosticCaptureDigest&&captureDigestOf(p)!==q.diagnosticCaptureDigest)return {unavailableEvidence:{available:false,rows:null,nextOffset:null,note:'Retained source capability unavailable; unknown is not zero'}};
  const rows=p[collection].filter((row:any)=>{
   for(const key of ['source','target','channel'] as const)if(q[key]){const values=key==='channel'?[row.source,row.target]:[row[key]];if(!values.some(v=>{try{return channelScid(v)===channelScid(q[key]);}catch{return false;}}))return false;}
   const at=row.at??(row.day?row.day+'T00:00:00.000Z':null);return (!q.start||at&&at>=q.start)&&(!q.end||at&&at<q.end);
  });
  const unknown=!!((q.source||q.target||q.channel||q.start||q.end)&&p[collection].some((row:any)=>(q.source&&!row.source)||(q.target&&!row.target)||(q.channel&&!row.source&&!row.target)||((q.start||q.end)&&!row.at&&!row.day)));
  if(unknown)return {unavailableEvidence:{available:false,rows:null,nextOffset:null,note:'Retained request direction or event time is unknown; scoped completeness unavailable'}};
  const allowed=['id','at','day','source','target','amountMsat','feeMsat','missedFeeMsat','failure','wireFailure','distinctPaymentsUnknown','count','granularity','status','succeeded','actualCorridorUnknown','otherCount','imported','financialAuthority','authority'];
  const after=q.after??0,limit=q.limit??100000;if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>100000)throw Error('Diagnostic bounds');
  const selected=rows.slice(after,after+limit);const nextAfter=after+limit<rows.length?after+limit:null;
  const clean=selected.map((row:any)=>({...Object.fromEntries(allowed.filter(k=>row[k]!==undefined).map(k=>[k,row[k]])),provenance:{source:provider,sourceVersion:p.version??null,capturedAt:p.capturedAt??null,granularity:row.granularity??'source record',checksum:digest(row),externalIntent:collection==='rebalances'?'external_request_status':'not_applicable'}}));
  return {diagnostics:{[provider]:{status:p.status,version:p.version,capturedAt:p.capturedAt,coverage:p.coverage,captureComplete:p.captureComplete,captureCounts:p.captureCounts,[collection]:clean}},adapterFiltered:true,sourceMetadata:{providerCaptureDigest:captureDigestOf(p),nextAfter,through:rows.length,retainedArchiveId,sourceMutationTimeKnown:false,sourceLifecycle:retainedArchiveId?'retained_immutable_capture':'current_capture',source:provider,version:p.version,capturedAt:p.capturedAt,coverage:p.coverage,captureComplete:p.captureComplete,captureCounts:p.captureCounts,financialAuthority:false},projectionLimits:{selected:clean.length,limit,truncated:nextAfter!==null,upstreamHistoryComplete:p.coverage?.complete===true}};
 }
 if(collection==='failureRollups'){
  const page=nativeFailureRollups(store,q);if(!page.available)return {unavailableEvidence:{available:false,rows:null,nextOffset:null,note:page.note}};
  const {rows,...metadata}=page;
  return {diagnostics:{native:{status:store.get('nativeCollection')?.ok===true?'qualified':'unavailable',failureRollups:rows,countUnit:metadata.countUnit,semanticParityQualified:false,historicalIntentQualified:false}},adapterFiltered:true,sourceMetadata:metadata,projectionLimits:page.projectionLimits};
 }
 const kinds:Record<string,string>={forwards:'forward',failures:'native_htlc',policies:'native_policy',paymentAttempts:'payment_attempt',rebalances:'payment_attempt'};
 if(!kinds[collection])return {unavailableEvidence:{available:false,rows:null,nextOffset:null,note:'Native capability has no qualified event-multiplicity rollup'}};
 if(!store.get('nativeCollection')&&!store.one("SELECT 1 FROM canonical_observations WHERE kind IN ('forward','native_htlc','native_policy','payment_attempt') LIMIT 1"))return {unavailableEvidence:{available:false,rows:null,nextOffset:null,note:'Native acquisition unavailable; unknown is not zero'}};
 const page=canonicalRead(store,{...q,section:undefined,kind:kinds[collection],subtype:collection==='failures'?'failures':collection==='rebalances'?'circular_attempts':undefined,limit:q.limit??200});const rows=page.rows;
 // A failed acquisition marker is not an observed empty collection. Retained
 // positive observations remain readable, but absence under unavailable collection is unknown.
 if(store.get('nativeCollection')?.ok!==true&&!rows.length)return {unavailableEvidence:{available:false,rows:null,nextOffset:null,note:'Native acquisition unavailable and no matching observations retained; unknown is not zero'}};
 const {rows:ignored,...metadata}=page;
 return {diagnostics:{native:{status:store.get('nativeCollection')?.ok===true?'qualified':'unavailable',[collection]:rows,...metadata,source:'SatsSurge native LND observations',semanticParityQualified:false,historicalIntentQualified:false}},adapterFiltered:true,sourceMetadata:metadata,projectionLimits:page.projectionLimits};
}
export function unifiedDiagnostics(store:Store){
 const legacy=store.get<any>('diagnostics');
 const pages=Object.fromEntries(['forwards','failures','failureRollups','rebalances','paymentAttempts','policies'].map(collection=>[collection,canonicalDiagnostics(store,{provider:'native',collection,limit:100}) as any]));
 const native=Object.fromEntries(Object.entries(pages).map(([collection,page])=>[collection,page.diagnostics?.native?.[collection]??null]));
 const collectionMetadata=Object.fromEntries(Object.entries(pages).map(([collection,page])=>[collection,{available:!!page.diagnostics,selected:page.diagnostics?.native?.[collection]?.length??null,count:{value:page.diagnostics?.native?.[collection]?.length??null,exact:!!page.diagnostics&&page.projectionLimits?.truncated===false,unit:page.sourceMetadata?.rowUnit??'retained_rows'},nextAfter:page.sourceMetadata?.nextAfter??null,through:page.sourceMetadata?.through??null,projectionLimits:page.projectionLimits??null,countUnit:page.sourceMetadata?.countUnit??null,rowUnit:page.sourceMetadata?.rowUnit??null,revisionId:page.sourceMetadata?.revisionId??null,receiptRange:page.sourceMetadata?.receiptRange??null,queryRangeExhausted:page.sourceMetadata?.queryRangeExhausted??null,distinctCountScope:page.sourceMetadata?.distinctCountScope??null,detailQuery:{section:'diagnostics',provider:'native',collection}}]));
 const provider=(name:string)=>{
  const current=legacy?.[name];
  const pages=Object.fromEntries(diagnosticCollections.map(collection=>[collection,canonicalDiagnostics(store,{provider:name,collection}) as any]));
  const collections=Object.fromEntries(Object.entries(pages).map(([collection,page])=>[collection,page.diagnostics?.[name]?.[collection]??null]));
  // Each collection may come from a different immutable capture. Current availability
  // describes only the latest provider; it cannot date or qualify retained rows.
  const collectionMetadata=Object.fromEntries(Object.entries(pages).map(([collection,page])=>{
   const rows=collections[collection],metadata=page.sourceMetadata;
   return [collection,{available:Array.isArray(rows),selected:rows?.length??null,count:{value:rows?.length??null,exact:Array.isArray(rows)&&page.projectionLimits?.truncated===false},...metadata,captureStatus:page.diagnostics?.[name]?.status??null,projectionLimits:page.projectionLimits??null,unavailableEvidence:page.unavailableEvidence??null,detailQuery:{section:'diagnostics',provider:name,collection}}];
  }));
  return {status:current?.status??'unavailable',reason:current?.reason??(!current?'Current source capability unavailable':undefined),...collections,collectionMetadata,currentAvailability:{present:!!current,status:current?.status??'unavailable',version:current?.version??null,capturedAt:current?.capturedAt??null,coverage:current?.coverage??null,captureComplete:current?.captureComplete??null,captureCounts:current?.captureCounts??null,reason:current?.reason??null},financialAuthority:false};
 };
 return {at:legacy?.at??store.get('nativeCollection')?.at??null,lndg:provider('lndg'),lightningMate:provider('lightningMate'),native:{status:store.get('nativeCollection')?.ok===true?'qualified':'unavailable',...native,collectionMetadata,coverageComplete:false,sourceHistoryComplete:false,provenance:'native LND immutable observations'},archive:store.canonical.summary()};
}

/** Collection readiness does not qualify a financial scope. Recheck immutable lineage and original coverage at use time. */
export function canonicalEconomicEligibility(store:Store,q:{source:string;target:string;start:string;end:string}){
 const scope=digest({source:channelScid(q.source),target:channelScid(q.target),start:new Date(q.start).toISOString(),end:new Date(q.end).toISOString()});
 const row=store.one("SELECT * FROM canonical_projection_revisions WHERE name='economic_original_scope' AND scope=? ORDER BY rowid DESC LIMIT 1",scope),reasons:string[]=[];
 if(!row)return {eligible:false,scope,reasons:['scoped_projection_unavailable'],financialAuthority:'unchanged',nativeSameEffectQualified:false};
 const result=JSON.parse(row.result);if(result.source!==q.source||result.target!==q.target||result.start!==q.start||result.end!==q.end||result.accountingAuthority!=='existing_original_receipts'||result.nativeSameEffectQualified!==false)reasons.push('scoped_projection_contract_mismatch');
 const ids=JSON.parse(row.evidence_ids) as string[],coverageIds=JSON.parse(row.coverage_ids) as string[],lineageIds=JSON.parse(row.lineage_ids) as string[];
 if(!ids.length||ids.length>10000||coverageIds.length>1000||lineageIds.length>20000)return {eligible:false,scope,reasons:['scoped_lineage_bounds'],financialAuthority:'unchanged',nativeSameEffectQualified:false};
 const observations=ids.map(id=>store.one('SELECT * FROM canonical_observations WHERE id=?',id)),coverage=coverageIds.map(id=>store.one('SELECT * FROM canonical_coverage WHERE id=?',id)),lineage=ids.flatMap(id=>store.all("SELECT * FROM canonical_evidence_links WHERE observation_id=? AND relation<>'projection_input' ORDER BY id",id));
 if(observations.some(o=>!o)||coverage.some(c=>!c)||digest({observations,coverage,lineage})!==row.input_digest||digest(lineage.map(l=>l.id))!==digest(lineageIds))reasons.push('scoped_lineage_changed');
 // Parallel native observations cannot replace booked originals or become deduplicated totals.
 if(observations.some(o=>o?.meaning==='lnd_effect'))reasons.push('native_financial_effect_unqualified');
 for(const o of observations){if(!o)continue;const links=lineage.filter(l=>l.observation_id===o.id&&l.reference_table==='canonical_original_archive'&&['original','booked_receipt'].includes(l.relation));if(links.length!==1){reasons.push('original_receipt_missing');continue;}const a=store.one('SELECT * FROM canonical_original_archive WHERE id=?',links[0].reference_id);if(!a||digest(a.raw_row)!==a.original_digest||o.original_digest!==a.original_digest||o.id!==digest({archiveId:a.id}))reasons.push('original_receipt_digest_mismatch');else if(a.original_table==='events'){const raw=JSON.parse(a.raw_row),v=(k:string)=>raw[k]?.[1];if(v('type')!=='external_forward'||v('source')!==q.source||v('target')!==q.target||v('occurred_at')<q.start||v('occurred_at')>=q.end)reasons.push('original_event_scope_mismatch');}}
 let covered=false;for(const c of coverage){if(!c||c.status!=='complete'||c.scope!==scope||c.capability!=='economic_original_inputs')continue;const d=JSON.parse(c.details),a=store.one('SELECT raw_row,original_digest FROM canonical_original_archive WHERE id=? AND original_table=\'coverage\'',d.originalArchiveId??'');if(!a||digest(a.raw_row)!==a.original_digest)continue;const raw=JSON.parse(a.raw_row),v=(k:string)=>raw[k]?.[1];if(raw.complete?.[0]==='integer'&&v('complete')==='1'&&v('kind')==='LND forwards'&&v('start')<=q.start&&v('end')>=q.end&&c.start<=q.start&&c.end>=q.end)covered=true;}
 if(!covered)reasons.push('authoritative_original_coverage_unavailable');
 return {eligible:reasons.length===0,scope,reasons:[...new Set(reasons)],projectionId:row.id,inputDigest:row.input_digest,coverageIds,financialAuthority:'existing_original_receipts',nativeSameEffectQualified:false};
}

/** Trusted local producer for existing-original scope lineage. No native deduplication, authority toggle or owner/model API. */
export function prepareCanonicalEconomicScope(store:Store,q:{source:string;target:string;start:string;end:string}){
 const scope=digest({source:channelScid(q.source),target:channelScid(q.target),start:new Date(q.start).toISOString(),end:new Date(q.end).toISOString()});
 const produce=()=>{
  const model=new CanonicalModel(store.db),observedAt=new Date().toISOString(),ids:string[]=[],coverageIds:string[]=[];
  const coverageQuery=store.db.prepare("SELECT rowid rid,* FROM coverage WHERE kind='LND forwards' AND complete=1 AND start<=? AND end>=? ORDER BY start,end,id LIMIT 1");coverageQuery.setReadBigInts(true);const covered=coverageQuery.get(q.start,q.end);
  if(!covered)return {eligible:false,scope,reasons:['authoritative_original_coverage_unavailable']};
  const archive=(table:LegacyTable,raw:any)=>{const {rid,...row}=raw;const result=archiveOriginal(store.db,table,row,{nodeId:null,network:null,sourceInstance:'satssurge-economic-original-scope',sourceVersion:'schema6',observedAt,rowid:String(rid)});const observationId=digest({archiveId:result.id});ids.push(observationId);return result.id;};
  let total=0,bytes=0;const deadline=Date.now()+5000;
  for(const table of ['events','snapshots','ledger'] as const){let cursor:string|null=null;const clauses=table==='events'?"type='external_forward' AND source=? AND target=? AND occurred_at>=? AND occurred_at<?":table==='snapshots'?'at>=? AND at<=?':'at>=? AND at<?';const args=table==='events'?[q.source,q.target,q.start,q.end]:[q.start,q.end];
   while(true){const rows=boundedOriginalRows(store.db,table,clauses+(cursor===null?'':' AND rowid>?'),[...args,...(cursor===null?[]:[BigInt(cursor)])],'rowid',100,1048576);for(const raw of rows){if(++total>10000||Date.now()>deadline)throw Error('Scoped original projection bounds');cursor=String(raw.__canonical_rowid__);const {__canonical_rowid__,...row}=raw;bytes+=Buffer.byteLength(encodeOriginal(row));if(bytes>16777216)throw Error('Scoped original projection bytes');archive(table,{rid:__canonical_rowid__,...row});}if(rows.length<100)break;}
  }
  const originalArchiveId=archive('coverage',covered);coverageIds.push(model.appendCoverage({nodeId:null,network:null,capability:'economic_original_inputs',scope,source:'legacy:coverage',epoch:digest({scope,ids}),start:q.start,end:q.end,observedAt,status:'complete',details:{originalArchiveId,accountingAuthority:'existing_original_receipts',nativeSameEffectQualified:false}}));
  model.publishProjectionInTransaction({name:'economic_original_scope',scope,epoch:digest({scope,ids}),calculationVersion:'existing-economics-original-lineage-v1',observationIds:ids,coverageIds,result:{source:q.source,target:q.target,start:q.start,end:q.end,accountingAuthority:'existing_original_receipts',nativeSameEffectQualified:false}});
  return canonicalEconomicEligibility(store,q);
 };
 try{return store.db.isTransaction?produce():store.tx(produce);}catch{return {eligible:false,scope,reasons:['scoped_original_projection_bounds_or_conflict'],financialAuthority:'unchanged',nativeSameEffectQualified:false};}
}
