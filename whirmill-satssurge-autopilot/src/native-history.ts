import {nativeRecordEvidence} from './native-lnd-source.js';
import {CanonicalModel,digest,stable,type Observation} from './canonical-model.js';

/** Acquisition contract reviewed against LND 572b561b. No generic RPC or effect methods. */
export const NATIVE_HISTORY_CONTRACT='lnd-572b561b-v1';
export interface NativeHistoryBinding {nodeId:string;network:string;sourceVersion:string;sourceInstance:string}
export interface HistoryWindow {startTime:string;endTime:string}
export interface ForwardPageRequest extends HistoryWindow {indexOffset:string;numMaxEvents:number}
export interface PaymentPageRequest extends HistoryWindow {indexOffset:string;maxPayments:number;reversed:true;includeIncomplete:true}
export interface NativeHistorySource {
 binding():NativeHistoryBinding|Promise<NativeHistoryBinding>;
 forwardPage(request:ForwardPageRequest):Promise<unknown>;
 paymentPage(request:PaymentPageRequest):Promise<unknown>;
}
export interface CaptureRequest extends HistoryWindow {captureId:string;kind:'forwards'|'payments';pageSize?:number;maxPages?:number;beforeCheckpoint?:()=>void}
export interface CaptureProgress {checkpointId:string|null;pages:number;nextOffset:string;pagesComplete:boolean;sourceHistoryComplete:false;error?:HistoryErrorCode}
type HistoryErrorCode='binding_mismatch'|'query_mismatch'|'malformed_page'|'source_error'|'concurrent_capture'|'page_commit_failed';
export class NativeHistoryError extends Error {constructor(readonly code:HistoryErrorCode){super('Native history acquisition: '+code);}}
const UINT64=18446744073709551615n,UINT32=4294967295n,MAX_SECONDS=253402300799n;
function exact(v:unknown,max=UINT64):string {if(max<=UINT32&&typeof v==='number'&&Number.isSafeInteger(v)&&v>=0)v=String(v);if(typeof v!=='string'||!/^\d{1,20}$/.test(v)||BigInt(v)>max)throw new NativeHistoryError('malformed_page');return BigInt(v).toString();}
function optional(v:unknown):string|null{return v===undefined||v===null?null:exact(v);}
function object(v:unknown):Record<string,any>{if(!v||typeof v!=='object'||Array.isArray(v))throw new NativeHistoryError('malformed_page');return v as Record<string,any>;}
function label(v:unknown):string{if(typeof v!=='string'||!v||v.length>128)throw new NativeHistoryError('malformed_page');return v;}
function timestamp(ns:string|null):string|null{return ns===null?null:new Date(Number(BigInt(ns)/1000000n)).toISOString();}
function status(v:unknown,attempt=false):string{if(typeof v!=='string'||!(attempt?['IN_FLIGHT','SUCCEEDED','FAILED']:['UNKNOWN','INITIATED','IN_FLIGHT','SUCCEEDED','FAILED']).includes(v))throw new NativeHistoryError('malformed_page');return v;}
interface Prepared {row:Omit<Observation,'nodeId'|'network'|'sourceVersion'|'sourceInstance'|'source'|'batchId'|'observedAt'>;identities:{namespace:'payment_index'|'payment_hash'|'payment_attempt'|'htlc_circuit';key:string}[]}
interface Checkpoint {query:unknown;nextOffset:string;pages:number;pagesComplete:boolean;highWater:string|null;lastRowDigests:string[];observedAt:string;queryDigest:string;sourceHistoryComplete:false;snapshotFrozen:false}

/** Caller owns schema migration/connection/executor fence. Each fetched page is committed atomically. */
export class NativeHistoryCollector {
 constructor(readonly model:CanonicalModel,readonly source:NativeHistorySource,readonly clock=()=>new Date().toISOString()){}
 private checkpoint(scope:string){return this.model.db.prepare("SELECT * FROM canonical_coverage WHERE capability='native_history' AND scope=? AND status='checkpoint' ORDER BY rowid DESC LIMIT 1").get(scope) as any;}
 async collect(request:CaptureRequest):Promise<CaptureProgress>{
  const captureId=label(request.captureId);if(!['forwards','payments'].includes(request.kind))throw new NativeHistoryError('query_mismatch');
  const start=exact(request.startTime,MAX_SECONDS),end=exact(request.endTime,MAX_SECONDS);if(BigInt(start)>BigInt(end))throw new NativeHistoryError('query_mismatch');
  const pageSize=request.pageSize??1000,maxPages=request.maxPages??1;
  if(!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>1000||!Number.isSafeInteger(maxPages)||maxPages<1||maxPages>100)throw new NativeHistoryError('query_mismatch');
  const binding=await this.readBinding(),scope='native:'+captureId+':'+request.kind;
  const query={contract:NATIVE_HISTORY_CONTRACT,kind:request.kind,startTime:start,endTime:end,pageSize,binding};
  let old=this.checkpoint(scope),state:Checkpoint=old?JSON.parse(old.details):{query,nextOffset:'0',pages:0,pagesComplete:false,highWater:null,lastRowDigests:[],observedAt:this.clock(),queryDigest:digest(query),sourceHistoryComplete:false,snapshotFrozen:false};
  if(stable(state.query)!==stable(query))throw new NativeHistoryError('query_mismatch');
  const progress=(error?:HistoryErrorCode):CaptureProgress=>({checkpointId:old?.id??null,pages:state.pages,nextOffset:state.nextOffset,pagesComplete:state.pagesComplete,sourceHistoryComplete:false,...(error?{error}:{})});
  for(let budget=0;budget<maxPages&&!state.pagesComplete;budget++){
   let phase:'fetch'|'validate'|'commit'='fetch';
   try{
    if(stable(await this.readBinding())!==stable(binding))throw new NativeHistoryError('binding_mismatch');
    const raw=await(request.kind==='forwards'?this.source.forwardPage({startTime:start,endTime:end,indexOffset:state.nextOffset,numMaxEvents:pageSize}):this.source.paymentPage({startTime:start,endTime:end,indexOffset:state.nextOffset,maxPayments:pageSize,reversed:true,includeIncomplete:true}));
    if(stable(await this.readBinding())!==stable(binding))throw new NativeHistoryError('binding_mismatch');
    phase='validate';const page=object(raw),rows=page[request.kind==='forwards'?'forwarding_events':'payments'];
    if(!Array.isArray(rows)||rows.length>pageSize)throw new NativeHistoryError('malformed_page');
    const checksums=rows.map((row:unknown)=>nativeRecordEvidence(row,binding)?.rawSourceChecksum??digest(object(row))),observedAt=this.clock(),pageNumber=state.pages+1;
    let nextOffset:string,highWater=state.highWater;
    if(request.kind==='forwards'){
     nextOffset=exact(page.last_offset_index,UINT32);
     if(BigInt(nextOffset)!==BigInt(state.nextOffset)+BigInt(rows.length))throw new NativeHistoryError('malformed_page');
    }else{
     const indices=rows.map((r:any)=>exact(r.payment_index));if(new Set(indices).size!==indices.length)throw new NativeHistoryError('malformed_page');
     const min=indices.reduce((a,b)=>BigInt(a)<BigInt(b)?a:b,indices[0]??'0'),max=indices.reduce((a,b)=>BigInt(a)>BigInt(b)?a:b,indices[0]??'0');
     if(exact(page.first_index_offset)!==min||exact(page.last_index_offset)!==max||indices.some(i=>BigInt(i)===0n||(state.nextOffset!=='0'&&BigInt(i)>=BigInt(state.nextOffset))||(highWater!==null&&BigInt(i)>BigInt(highWater))))throw new NativeHistoryError('malformed_page');
     nextOffset=rows.length?min:state.nextOffset;if(highWater===null)highWater=rows.length?max:'0';
    }
    const batchId=digest({scope,queryDigest:state.queryDigest,pageNumber,offset:state.nextOffset});
    const prepared=rows.flatMap((r:unknown,i:number)=>this.prepare(request.kind,object(r),{captureId,pageNumber,row:i,checksum:checksums[i]!,binding,window:{startTime:start,endTime:end}}));
    const overlaps=checksums.some(d=>state.lastRowDigests.includes(d));
    const next:Checkpoint={...state,nextOffset,pages:pageNumber,pagesComplete:rows.length<pageSize,highWater,lastRowDigests:checksums,observedAt};
    phase='commit';const checkpointId=this.model.transaction(()=>{
     if((this.checkpoint(scope)?.id??null)!==(old?.id??null))throw new NativeHistoryError('concurrent_capture');
     let paymentObservation:string|null=null,continuityConflict=false;const evidenceIds:string[]=[];
     for(const p of prepared){const id=this.model.observe({...p.row,id:digest({batchId,originalId:p.row.originalId,originalDigest:p.row.originalDigest}),...binding,source:'lnd.'+request.kind,batchId,observedAt});evidenceIds.push(id);
      if(p.row.kind==='payment')paymentObservation=id;
      else if(p.row.kind==='payment_attempt'&&paymentObservation)this.model.link({observationId:id,referenceTable:'canonical_observations',referenceId:paymentObservation,relation:'attempt',method:'record_match_v2',details:{accountingAuthority:'none',financialQualified:false}});
      for(const identity of p.identities){const candidate=this.model.identify(id,identity);
       if(identity.namespace==='payment_index'||identity.namespace==='payment_attempt')continuityConflict=this.matchRecord(id,candidate.entityId)||continuityConflict;
      }
      if(!p.identities.length)this.model.link({observationId:id,relation:'ambiguous',method:'record_match_v2',details:{version:2,fingerprint:null,scope:'retained_window_observation',accountingAuthority:'none',financialQualified:false,reason:'missing_native_circuit_identity',windowOffsetIsGlobalIdentity:false}});
     }
     this.model.appendCoverage({...binding,capability:'native_history',scope,source:'lnd.'+request.kind,epoch:captureId,start:new Date(Number(BigInt(start)*1000n)).toISOString(),end:new Date(Number(BigInt(end)*1000n)).toISOString(),observedAt,status:'partial',details:{query,pageNumber,rows:rows.length,batchId,checksums,pagesComplete:next.pagesComplete,sourceHistoryComplete:false,snapshotFrozen:false,financialQualified:false,accountingAuthority:'none',sourceInstanceMeaning:'client_provenance_not_database_epoch',reason:continuityConflict?'durable_record_continuity_conflict':overlaps?'possible_page_shift_or_duplicate':'retained_query_only',paginationSafety:request.kind==='forwards'?'mutable_window_offset':'creation_index_high_water_mutable_status'}});
     this.model.publishProjectionInTransaction({name:'native_history_record_capture',scope,epoch:captureId,calculationVersion:'record_match_v2',observationIds:evidenceIds,coverageIds:[],result:{pageNumber,continuityConflict,financialQualified:false,accountingAuthority:'none',sourceHistoryComplete:false,snapshotFrozen:false}});
     request.beforeCheckpoint?.();
     return this.model.appendCoverage({...binding,capability:'native_history',scope,source:'lnd.'+request.kind,epoch:captureId,start:observedAt,end:observedAt,observedAt,status:'checkpoint',details:next,supersedes:old?.id??null});
    });
    state=next;old=this.model.db.prepare('SELECT * FROM canonical_coverage WHERE id=?').get(checkpointId);
   }catch(error){
    const code=error instanceof NativeHistoryError?error.code:phase==='fetch'?'source_error':phase==='commit'?'page_commit_failed':'malformed_page';
    // Separate failure receipt never advances checkpoint or certifies a failed page. Raw backend errors are excluded.
    const at=this.clock();this.model.transaction(()=>this.model.appendCoverage({...binding,capability:'native_history',scope,source:'lnd.'+request.kind,epoch:captureId,start:new Date(Number(BigInt(start)*1000n)).toISOString(),end:new Date(Number(BigInt(end)*1000n)).toISOString(),observedAt:at,status:'gap',details:{code,query,nextOffset:state.nextOffset,pages:state.pages,sourceHistoryComplete:false,snapshotFrozen:false}}));
    return progress(code);
   }
  }
  return progress();
 }
 /** Candidate matching does not verify server incarnation or financial effects. */
 private matchRecord(id:string,entityId:string):boolean {
  const current=this.model.observation(id),c=JSON.parse(current.payload);
  let durable=!!this.model.db.prepare("SELECT 1 FROM canonical_evidence_links WHERE entity_id=? AND relation='conflict' AND method='record_match_v2' LIMIT 1").get(entityId);
  const knownDifferent=(a:any,b:any):boolean=>{if(a==null||b==null)return false;if(Array.isArray(a)&&Array.isArray(b))return a.length!==b.length||a.some((v,i)=>knownDifferent(v,b[i]));if(typeof a==='object'&&typeof b==='object')return Object.keys(a).some(k=>k in b&&knownDifferent(a[k],b[k]));return a!==b;};
  const regression=(a:string,b:string)=>a==='UNKNOWN'||b==='UNKNOWN'?false:['SUCCEEDED','FAILED'].includes(a)?a!==b:a==='IN_FLIGHT'&&b==='INITIATED';
  for(const prior of this.model.db.prepare("SELECT DISTINCT o.* FROM canonical_observations o JOIN canonical_evidence_links l ON l.observation_id=o.id WHERE l.entity_id=? AND (l.relation='same_effect' OR (l.relation='ambiguous' AND l.method='record_match_v2')) AND o.id<>?").iterate(entityId,id) as Iterable<any>){
   const p=JSON.parse(prior.payload),payment=current.kind==='payment';
   this.model.link({observationId:id,referenceTable:'canonical_observations',referenceId:prior.id,relation:'original',method:'record_match_v2',details:{version:2,priorObservationDigest:digest(prior),fingerprint:p.recordFingerprint??null,scope:'record_comparison_input',accountingAuthority:'none',financialQualified:false}});
   const coreConflict=payment?knownDifferent(p.paymentHash,c.paymentHash)||knownDifferent(p.creationTimeNs,c.creationTimeNs):knownDifferent(p.parentCore,c.parentCore);
   const immutableConflict=coreConflict||knownDifferent(prior.amount_msat,current.amount_msat)||(!payment&&(knownDifferent(p.attemptTimeNs,c.attemptTimeNs)||knownDifferent(p.route,c.route)));
   const statusConflict=!coreConflict&&regression(p.status,c.status);
   const feeConflict=!coreConflict&&p.status==='SUCCEEDED'&&c.status==='SUCCEEDED'&&knownDifferent(prior.fee_msat,current.fee_msat);
   // Terminal resolution is immutable once known; unset/zero values may enrich.
   const resolutionConflict=!payment&&!coreConflict&&['SUCCEEDED','FAILED'].includes(p.status)&&['SUCCEEDED','FAILED'].includes(c.status)&&p.resolveTimeNs!=null&&c.resolveTimeNs!=null&&BigInt(p.resolveTimeNs)>0n&&BigInt(c.resolveTimeNs)>0n&&p.resolveTimeNs!==c.resolveTimeNs;
   if(immutableConflict||statusConflict||feeConflict||resolutionConflict){durable=true;const reason=coreConflict?'record_core_identity_conflict':immutableConflict?'immutable_record_metadata_conflict':statusConflict?'status_progression_conflict':feeConflict?'settled_fee_conflict':'terminal_resolution_time_conflict';
    for(const observationId of [prior.id,id])this.model.link({observationId,entityId,relation:'conflict',method:'record_match_v2',details:{version:2,fingerprint:observationId===id?c.recordFingerprint??null:p.recordFingerprint??null,conflictingFingerprint:observationId===id?p.recordFingerprint??null:c.recordFingerprint??null,scope:'unverified_record_candidate',reason,accountingAuthority:'none',financialQualified:false}});
   }
  }
  this.model.link({observationId:id,entityId,relation:'ambiguous',method:'record_match_v2',details:{version:2,fingerprint:c.recordFingerprint??null,scope:'unverified_record_candidate',continuityConflict:durable,candidateIncomplete:c.recordFingerprint===null,accountingAuthority:'none',financialQualified:false}});
  return durable;
 }
 private async readBinding():Promise<NativeHistoryBinding>{let raw:unknown;try{raw=await this.source.binding();}catch{throw new NativeHistoryError('source_error');}try{const b=object(raw);return {nodeId:label(b.nodeId),network:label(b.network),sourceVersion:label(b.sourceVersion),sourceInstance:label(b.sourceInstance)};}catch{throw new NativeHistoryError('binding_mismatch');}}
 private prepare(kind:'forwards'|'payments',r:Record<string,any>,context:{captureId:string;pageNumber:number;row:number;checksum:string;binding:NativeHistoryBinding;window:HistoryWindow}):Prepared[]{
  const provenance={financialQualified:false,accountingAuthority:'none',sourceInstanceMeaning:'client_provenance_not_database_epoch',contract:NATIVE_HISTORY_CONTRACT,captureId:context.captureId,page:context.pageNumber,row:context.row,originalDigest:context.checksum,queryWindow:context.window};
  const originalId=context.captureId+':'+context.pageNumber+':'+context.row;
  if(kind==='forwards'){
   const incoming=exact(r.chan_id_in),outgoing=exact(r.chan_id_out),ns=optional(r.timestamp_ns),seconds=r.timestamp===undefined?null:exact(r.timestamp,MAX_SECONDS);
   if(ns===null&&seconds===null)throw new NativeHistoryError('malformed_page');
   const occurred=ns??(BigInt(seconds!)*1000000000n).toString();const sec=BigInt(occurred)/1000000000n;
   if(BigInt(occurred)<BigInt(context.window.startTime)*1000000000n||BigInt(occurred)>BigInt(context.window.endTime)*1000000000n)throw new NativeHistoryError('malformed_page');
   const amountIn=exact(r.amt_in_msat),amountOut=exact(r.amt_out_msat),fee=exact(r.fee_msat);
   if(BigInt(amountIn)-BigInt(amountOut)!==BigInt(fee))throw new NativeHistoryError('malformed_page');
   const inHtlc=optional(r.incoming_htlc_id),outHtlc=optional(r.outgoing_htlc_id),qualified=ns!==null&&inHtlc!==null&&outHtlc!==null;
   const sourceEvidence=nativeRecordEvidence(r,context.binding);
   const payload={...provenance,checksumScope:sourceEvidence?.checksumScope??'caller_original_record',allowlistedChecksum:sourceEvidence?.allowlistedChecksum??null,amountInMsat:amountIn,amountOutMsat:amountOut,feeMsat:fee,sourceChannel:incoming,targetChannel:outgoing,timestampNs:ns,incomingHtlcId:inHtlc,outgoingHtlcId:outHtlc,identityQualified:qualified,sourceSnapshotFrozen:false};
   return [{row:{kind:'forward',meaning:'lnd_effect',originalId,originalDigest:context.checksum,occurredAt:timestamp(occurred),originalTimestamp:ns??seconds,timestampNs:ns,granularity:ns?'native nanoseconds':'native seconds',sourceChannel:incoming,targetChannel:outgoing,amountMsat:amountOut,feeMsat:fee,payload},identities:qualified?[{namespace:'htlc_circuit',key:[digest(context.binding.sourceInstance),incoming,inHtlc,outgoing,outHtlc,'forward',ns].join(':')}]:[]}];
  }
  const index=exact(r.payment_index),paymentStatus=status(r.status),creation=optional(r.creation_time_ns),value=optional(r.value_msat),reportedFee=optional(r.fee_msat);
  const correlation=r.payment_hash===undefined?null:r.payment_hash;if(correlation!==null&&(typeof correlation!=='string'||!/^[a-f0-9]{64}$/.test(correlation)))throw new NativeHistoryError('malformed_page');
  if(creation!==null){const sec=BigInt(creation)/1000000000n;if(sec<BigInt(context.window.startTime)||sec>BigInt(context.window.endTime))throw new NativeHistoryError('malformed_page');}
  const attempts=r.htlcs??[];if(!Array.isArray(attempts)||attempts.length>1000)throw new NativeHistoryError('malformed_page');
  const sourceEvidence=nativeRecordEvidence(r,context.binding);
  const settledRouteEndpoints=attempts.filter((a:any)=>a.status==='SUCCEEDED').map((a:any)=>{const hops=a.route?.hops;return {sourceChannel:Array.isArray(hops)&&hops.length?hops[0]?.chan_id??null:null,targetChannel:Array.isArray(hops)&&hops.length?hops.at(-1)?.chan_id??null:null};});
  const recordFingerprint=correlation!==null&&creation!==null?digest({nodeId:context.binding.nodeId,network:context.binding.network,paymentIndex:index,paymentHash:correlation,creationTimeNs:creation}):null;
  const identifiers=[{namespace:'payment_index' as const,key:index},...(correlation?[{namespace:'payment_hash' as const,key:correlation}]:[])];
  const result:Prepared[]=[{row:{kind:'payment',meaning:'lnd_effect',originalId:'payment:'+index+':'+originalId,originalDigest:context.checksum,occurredAt:timestamp(creation),originalTimestamp:creation,timestampNs:creation,granularity:creation?'native nanoseconds':'unknown',endpointScope:'aggregate',amountMsat:value,feeMsat:paymentStatus==='SUCCEEDED'?reportedFee:null,payload:{...provenance,recordFingerprint,allSettledRoutesToLocal:sourceEvidence?.allSettledRoutesToLocal??null,settledRouteEndpoints,checksumScope:sourceEvidence?.checksumScope??'caller_original_record',allowlistedChecksum:sourceEvidence?.allowlistedChecksum??null,paymentIndex:index,paymentHash:correlation,status:paymentStatus,creationTimeNs:creation,reportedFeeMsat:reportedFee,costAuthority:paymentStatus==='SUCCEEDED'&&reportedFee!==null?'observed_settled_not_booked':'unknown',statusSnapshotFrozen:false}},identities:identifiers}];
  const seen=new Set<string>();
  for(const [attemptRow,raw] of attempts.entries()){const a=object(raw),attempt=exact(a.attempt_id);if(seen.has(attempt))throw new NativeHistoryError('malformed_page');seen.add(attempt);const attemptStatus=status(a.status,true),attemptTime=optional(a.attempt_time_ns),resolveTime=optional(a.resolve_time_ns);let route:any=null,sourceChannel:string|null=null,targetChannel:string|null=null;
   if(a.route!==undefined&&a.route!==null){const v=object(a.route),hops=v.hops??null;if(hops!==null&&(!Array.isArray(hops)||hops.length>1000))throw new NativeHistoryError('malformed_page');route={amountMsat:optional(v.total_amt_msat),feeMsat:optional(v.total_fees_msat),hops:hops===null?null:hops.map((hop:unknown)=>{const h=object(hop);return {channelId:exact(h.chan_id),amountMsat:optional(h.amt_to_forward_msat),feeMsat:optional(h.fee_msat),expiry:h.expiry===undefined?null:exact(h.expiry,UINT32)};})};sourceChannel=route.hops?.[0]?.channelId??null;targetChannel=route.hops?.at(-1)?.channelId??null;}
   const ns=resolveTime!==null&&BigInt(resolveTime)>0n?resolveTime:attemptTime;result.push({row:{kind:'payment_attempt',meaning:'lnd_effect',originalId:'attempt:'+index+':'+attempt+':'+originalId,originalDigest:sourceEvidence?.rawAttemptChecksums[attemptRow]??digest(a),occurredAt:timestamp(ns),originalTimestamp:ns,timestampNs:ns,granularity:ns?'native nanoseconds':'unknown',sourceChannel,targetChannel,amountMsat:route?.amountMsat??null,feeMsat:attemptStatus==='SUCCEEDED'?route?.feeMsat??null:null,payload:{...provenance,recordFingerprint:recordFingerprint===null?null:digest({parentFingerprint:recordFingerprint,attemptId:attempt}),parentCore:{paymentHash:correlation,creationTimeNs:creation},parentFingerprint:recordFingerprint,originalDigest:sourceEvidence?.rawAttemptChecksums[attemptRow]??digest(a),checksumScope:sourceEvidence?'raw_lnd_attempt_response_record':'caller_original_record',paymentOriginalDigest:context.checksum,paymentIndex:index,attemptId:attempt,status:attemptStatus,attemptTimeNs:attemptTime,resolveTimeNs:resolveTime,route,costAuthority:attemptStatus==='SUCCEEDED'&&route?.feeMsat!==null&&route?.feeMsat!==undefined?'observed_settled_not_booked':'quote_or_unknown'}},identities:[{namespace:'payment_attempt',key:index+':'+attempt}]});
  }
  return result;
 }
}
