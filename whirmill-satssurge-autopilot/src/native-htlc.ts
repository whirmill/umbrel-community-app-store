import {nativeBoundEvidence} from './native-lnd-source.js';
import {randomUUID} from 'node:crypto';
import {channelScid} from './diagnostics.js';
import {CanonicalModel,digest,stable,type Coverage} from './canonical-model.js';
import type {NativeHistoryBinding} from './native-history.js';

export type HtlcBinding=NativeHistoryBinding;
export type HtlcVariant='forward'|'link_fail'|'settle'|'forward_fail';
export type HtlcGapReason='disconnect'|'shutdown'|'source_error'|'restart_without_replay'|'binding_mismatch'|'malformed_event'|'not_subscribed'|'unknown_event'|'conflicting_duplicate'|'cross_epoch_circuit'|'missing_converter_fields'|'session_mismatch'|'contradictory_circuit';
export interface HtlcSessionOrigin {binding:HtlcBinding;epoch:string;session:string}
export interface SubscribedAck extends HtlcSessionOrigin {kind:'subscribed';at:string}
export interface HtlcCircuit {incomingChannelId:string;outgoingChannelId:string;incomingHtlcId:string;outgoingHtlcId:string}
export interface NativeForwardRecord extends HtlcCircuit {
 variant:HtlcVariant;timestampNs:string;incomingMsat:string|null;outgoingMsat:string|null;
 wireFailure:string|null;failureDetail:string|null;rawWireFailure:string|null;rawFailureDetail:string|null;incomingTimelock:string|null;outgoingTimelock:string|null;failureStringPresent:boolean;forwardFailDetailPresent:boolean;converterDropReasons:string[];
}
interface CacheEntry {circuitKey:string;observationId:string;epoch:string;session:string;processingAt:string;bindingDigest:string;ambiguous?:boolean}
interface EpochState {binding:HtlcBinding;epoch:string;session:string;openedAt:string;lastProcessingAt:string;phase:'awaiting_ack'|'subscribed'|'closed';cache:CacheEntry[];ackAt:string|null}
export interface ObserveResult {accepted:boolean;financialQualified?:false;observationScope?:string;eventMultiplicityQualified?:false;ignored?:boolean;duplicate?:boolean;observationId?:string;projectionId?:string;reason?:HtlcGapReason}
const CALCULATION='native-forward-diagnostics-record-match-v2';
const UINT64=18446744073709551615n;
const obj=(v:unknown):Record<string,any>=>{if(!v||typeof v!=='object'||Array.isArray(v))throw Error('Malformed native HTLC observable');return v as Record<string,any>;};
const exact=(v:unknown):string=>{if(typeof v!=='string'||!/^\d{1,20}$/.test(v)||BigInt(v)>UINT64)throw Error('Exact native uint64 required');return BigInt(v).toString();};
const optional=(v:unknown):string|null=>v===undefined||v===null?null:exact(v);
const label=(v:unknown):string=>{if(typeof v!=='string'||!v||v.length>128)throw Error('Bounded provenance label required');return v;};
const utc=(v:string):string=>{if(!/^\d{4}-\d\d-\d\dT.*Z$/.test(v)||!Number.isFinite(Date.parse(v)))throw Error('UTC processing timestamp required');return new Date(v).toISOString();};
function binding(b:HtlcBinding):HtlcBinding{return {nodeId:label(b.nodeId),network:label(b.network),sourceVersion:label(b.sourceVersion),sourceInstance:label(b.sourceInstance)};}
const failureDetails:Record<string,string>=Object.fromEntries(['UNKNOWN','NO_DETAIL','ONION_DECODE','LINK_NOT_ELIGIBLE','ON_CHAIN_TIMEOUT','HTLC_EXCEEDS_MAX','INSUFFICIENT_BALANCE','INCOMPLETE_FORWARD','HTLC_ADD_FAILED','FORWARDS_DISABLED','INVOICE_CANCELED','INVOICE_UNDERPAID','INVOICE_EXPIRY_TOO_SOON','INVOICE_NOT_OPEN','MPP_INVOICE_TIMEOUT','ADDRESS_MISMATCH','SET_TOTAL_MISMATCH','SET_TOTAL_TOO_LOW','SET_OVERPAID','UNKNOWN_INVOICE','INVALID_KEYSEND','MPP_IN_PROGRESS','CIRCULAR_ROUTE','INVOICE_ALREADY_SETTLED','HTLC_INVOICE_TYPE_MISMATCH','AMP_ERROR','AMP_RECONSTRUCTION','EXTERNAL_VALIDATION_FAILED'].map((name,i)=>[name,String(i)]));
const wireFailures:Record<string,string>={RESERVED:'0',TEMPORARY_CHANNEL_FAILURE:'15'};
const wireNames=['RESERVED','INCORRECT_OR_UNKNOWN_PAYMENT_DETAILS','INCORRECT_PAYMENT_AMOUNT','FINAL_INCORRECT_CLTV_EXPIRY','FINAL_INCORRECT_HTLC_AMOUNT','FINAL_EXPIRY_TOO_SOON','INVALID_REALM','EXPIRY_TOO_SOON','INVALID_ONION_VERSION','INVALID_ONION_HMAC','INVALID_ONION_KEY','AMOUNT_BELOW_MINIMUM','FEE_INSUFFICIENT','INCORRECT_CLTV_EXPIRY','CHANNEL_DISABLED','TEMPORARY_CHANNEL_FAILURE','REQUIRED_NODE_FEATURE_MISSING','REQUIRED_CHANNEL_FEATURE_MISSING','UNKNOWN_NEXT_PEER','TEMPORARY_NODE_FAILURE','PERMANENT_NODE_FAILURE','PERMANENT_CHANNEL_FAILURE','EXPIRY_TOO_FAR','MPP_TIMEOUT','INVALID_ONION_PAYLOAD','INVALID_ONION_BLINDING','INTERNAL_FAILURE','UNKNOWN_FAILURE','UNREADABLE_FAILURE'];
function code(v:unknown,names:Record<string,string>,knownNames=Object.keys(names)):{raw:string|null;normalized:string|null}{
 if(v===undefined||v===null)return {raw:null,normalized:null};
 if(typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=4294967295)return {raw:String(v),normalized:String(v)};
 if(typeof v==='string'&&/^\d{1,10}$/.test(v)&&BigInt(v)<=4294967295n)return {raw:v,normalized:BigInt(v).toString()};
 if(typeof v==='string'&&/^[A-Z][A-Z_0-9]{0,63}$/.test(v)&&knownNames.includes(v))return {raw:v,normalized:names[v]??null};
 throw Error('Malformed native failure code');
}
function timelock(v:unknown):string|null {if(v===undefined||v===null)return null;if(typeof v==='number'&&Number.isSafeInteger(v)&&v>=0)v=String(v);const parsed=exact(v);if(BigInt(parsed)>4294967295n)throw Error('Native uint32 timelock required');return parsed;}
function eventType(v:unknown):string|null {if(v==='FORWARD'||v===3)return 'FORWARD';if(v==='SEND'||v===1)return 'SEND';if(v==='RECEIVE'||v===2)return 'RECEIVE';if(v==='UNKNOWN'||v===0)return 'UNKNOWN';return null;}
function identifier(v:unknown):string {if(typeof v==='number'&&Number.isSafeInteger(v)&&v>=0)v=String(v);return exact(v);}
function circuitKey(r:HtlcCircuit):string{return digest({incomingChannelId:r.incomingChannelId,outgoingChannelId:r.outgoingChannelId,incomingHtlcId:r.incomingHtlcId,outgoingHtlcId:r.outgoingHtlcId});}
/** Decode allowlisted FORWARD observables only. SEND/RECEIVE are excluded before reading their private payload. */
export function decodeNativeForward(value:unknown):NativeForwardRecord|null {
 const r=obj(value);if(eventType(r.event_type)==='SEND'||eventType(r.event_type)==='RECEIVE')return null;
 if(eventType(r.event_type)!=='FORWARD')throw Error('Unknown HTLC event type');
 const variants=[['forward_event','forward'],['link_fail_event','link_fail'],['settle_event','settle'],['forward_fail_event','forward_fail']] as const;
 const present=variants.filter(([field])=>r[field]!==undefined&&r[field]!==null);if(present.length!==1)throw Error('Native HTLC variant must be explicit');
 const [field,variant]=present[0]!,detail=obj(r[field]),info=(variant==='forward'||variant==='link_fail')&&detail.info!==undefined?obj(detail.info):null,wire=code(variant==='link_fail'?detail.wire_failure:undefined,wireFailures,wireNames),failure=code(variant==='link_fail'?detail.failure_detail:undefined,failureDetails);
 const converterDropReasons:string[]=[];
 for(const key of ['incoming_channel_id','outgoing_channel_id','incoming_htlc_id','outgoing_htlc_id'])if(!r[key])converterDropReasons.push(key+'_falsy');
 if(variant==='forward'||variant==='link_fail'){
  if(!info)converterDropReasons.push('missing_info');
  else {for(const key of ['incoming_amt_msat','outgoing_amt_msat'])if(!info[key])converterDropReasons.push(key+'_missing');for(const key of ['incoming_timelock','outgoing_timelock'])if(info[key]===undefined||info[key]===null)converterDropReasons.push(key+'_unknown');}
 }
 if(variant==='link_fail'){if(!detail.failure_detail)converterDropReasons.push('failure_detail_falsy');if(!detail.failure_string)converterDropReasons.push('failure_description_missing');}
 return {variant,timestampNs:exact(r.timestamp_ns),incomingChannelId:identifier(r.incoming_channel_id),outgoingChannelId:identifier(r.outgoing_channel_id),incomingHtlcId:identifier(r.incoming_htlc_id),outgoingHtlcId:identifier(r.outgoing_htlc_id),incomingMsat:info?optional(info.incoming_amt_msat):null,outgoingMsat:info?optional(info.outgoing_amt_msat):null,wireFailure:wire.normalized,failureDetail:failure.normalized,rawWireFailure:wire.raw,rawFailureDetail:failure.raw,incomingTimelock:info?timelock(info.incoming_timelock):null,outgoingTimelock:info?timelock(info.outgoing_timelock):null,failureStringPresent:variant==='link_fail'&&typeof detail.failure_string==='string'&&detail.failure_string.length>0,forwardFailDetailPresent:variant==='forward_fail',converterDropReasons};
}

/** Caller supplies adapter provenance and actual subscription ACK. No RPC, replay, financial booking or secret storage. */
export class NativeHtlcCollector {
 private active:{scope:string;checkpointId:string}|undefined;
 readonly cacheLimit:number;readonly cacheTtlMs:number;
 constructor(readonly model:CanonicalModel,options:{cacheLimit?:number;cacheTtlMs?:number}={}){this.cacheLimit=options.cacheLimit??256;this.cacheTtlMs=options.cacheTtlMs??300000;if(!Number.isSafeInteger(this.cacheLimit)||this.cacheLimit<1||this.cacheLimit>1024||!Number.isSafeInteger(this.cacheTtlMs)||this.cacheTtlMs<1||this.cacheTtlMs>3600000)throw Error('Bounded HTLC cache required');}
 private latest(scope:string){return this.model.db.prepare("SELECT * FROM canonical_coverage WHERE capability='htlc_epoch_checkpoint' AND scope=? AND status='checkpoint' ORDER BY rowid DESC LIMIT 1").get(scope) as any;}
 private state():{state:EpochState;row:any}{if(!this.active)throw Error('Open a fresh subscription epoch before admission');const row=this.latest(this.active.scope);if(!row||row.id!==this.active.checkpointId)throw Error('HTLC epoch ownership changed');return {state:JSON.parse(row.details),row};}
 private originMatches(state:EpochState,origin:HtlcSessionOrigin):boolean {return !!origin&&origin.session===state.session&&origin.epoch===state.epoch&&stable(binding(origin.binding))===stable(state.binding);}
 private coverage(state:EpochState,scope:string,at:string,status:Coverage['status'],details:unknown,capability='native_htlc_stream',start=at){return this.model.appendCoverage({...state.binding,capability,scope,source:'lnd.htlc',epoch:state.epoch,start,end:at,observedAt:at,status,details});}
 private checkpoint(scope:string,state:EpochState,old?:any){return this.model.appendCoverage({...state.binding,capability:'htlc_epoch_checkpoint',scope,source:'lnd.htlc',epoch:state.epoch,start:state.lastProcessingAt,end:state.lastProcessingAt,observedAt:state.lastProcessingAt,status:'checkpoint',details:state,supersedes:old?.id??null});}
 openEpoch(provenance:HtlcBinding,epoch:string,at:string):string {
  const b=binding(provenance),e=label(epoch),processing=utc(at),scope='htlc:'+digest({nodeId:b.nodeId,network:b.network});
  const old=this.latest(scope),previous:EpochState|null=old?JSON.parse(old.details):null;
  if(previous&&processing<previous.lastProcessingAt)throw Error('HTLC processing time cannot regress');
  const state:EpochState={binding:b,epoch:e,session:randomUUID(),openedAt:processing,lastProcessingAt:processing,phase:'awaiting_ack',ackAt:null,cache:(previous?.cache??[]).slice(-this.cacheLimit)};
  const id=this.model.transaction(()=>{
   if(previous&&previous.phase!=='closed')this.coverage(previous,scope,processing,'gap',{reason:'restart_without_replay',replayQualified:false,sourceHistoryComplete:false},'native_htlc_stream',previous.lastProcessingAt);
   this.coverage(state,scope,processing,'gap',{reason:'not_subscribed',sourceHistoryComplete:false,snapshotFrozen:false});
   return this.checkpoint(scope,state,old);
  });this.active={scope,checkpointId:id};return state.session;
 }
 admitSubscribed(ack:SubscribedAck):string {
  const {state,row}=this.state();if(!this.originMatches(state,ack))throw Error('Subscription session binding mismatch');const at=utc(ack.at);if(at<state.lastProcessingAt)throw Error('HTLC processing time cannot regress');
  if(ack.kind!=='subscribed'||ack.epoch!==state.epoch||stable(binding(ack.binding))!==stable(state.binding)||state.phase==='closed'){throw Error('Subscription ACK binding mismatch');}
  if(state.phase==='subscribed')return row.id;
  const next={...state,phase:'subscribed' as const,ackAt:at,lastProcessingAt:at};const id=this.model.transaction(()=>{
   this.coverage(next,this.active!.scope,at,'gap',{reason:'startup_before_ack',sourceHistoryComplete:false,replayQualified:false},'native_htlc_events',state.openedAt);
   this.coverage(next,this.active!.scope,at,'ready',{subscriptionAcknowledged:true,binding:next.binding,session:next.session,sourceHistoryComplete:false,snapshotFrozen:false});
   return this.checkpoint(this.active!.scope,next,row);
  });this.active!.checkpointId=id;return id;
 }
 readiness(at:string):{qualified:boolean;reasons:string[];coverageIds:string[]}{if(!this.active)return {qualified:false,reasons:['fresh_subscription_ack_required'],coverageIds:[]};const {state}=this.state();if(state.phase!=='subscribed')return {qualified:false,reasons:['fresh_subscription_ack_required'],coverageIds:[]};return this.model.readinessRequirement({...state.binding,capability:'native_htlc_stream',scope:this.active.scope,epoch:state.epoch,at:utc(at),maxAgeMs:8640000000000000});}
 gap(reason:HtlcGapReason,at:string,origin:HtlcSessionOrigin):string {const allowed:HtlcGapReason[]=['disconnect','shutdown','source_error','restart_without_replay','binding_mismatch','malformed_event','not_subscribed','unknown_event','conflicting_duplicate','cross_epoch_circuit','missing_converter_fields','session_mismatch','contradictory_circuit'];if(!allowed.includes(reason))throw Error('Sanitized HTLC gap reason required');const {state}=this.state();if(!this.originMatches(state,origin))throw Error('Subscription session binding mismatch');const processing=utc(at);if(processing<state.lastProcessingAt)throw Error('HTLC processing time cannot regress');let receipt='';const {row}=this.state(),next={...state,lastProcessingAt:processing};const checkpoint=this.model.transaction(()=>{receipt=this.coverage(state,this.active!.scope,processing,'gap',{reason,sourceHistoryComplete:false,snapshotFrozen:false,replayQualified:false},'native_htlc_events',state.lastProcessingAt);return this.checkpoint(this.active!.scope,next,row);});this.active!.checkpointId=checkpoint;return receipt;}
 closeEpoch(reason:'disconnect'|'shutdown'|'source_error',at:string,origin:HtlcSessionOrigin):string {if(!['disconnect','shutdown','source_error'].includes(reason))throw Error('Sanitized disconnect reason required');const {state,row}=this.state();if(!this.originMatches(state,origin))throw Error('Subscription session binding mismatch');const processing=utc(at);if(processing<state.lastProcessingAt)throw Error('HTLC processing time cannot regress');if(state.phase==='closed')return row.id;const next={...state,phase:'closed' as const,lastProcessingAt:processing};const id=this.model.transaction(()=>{this.coverage(next,this.active!.scope,processing,'gap',{reason,replayQualified:false,sourceHistoryComplete:false},'native_htlc_stream',state.lastProcessingAt);this.coverage(next,this.active!.scope,processing,'gap',{reason,replayQualified:false,sourceHistoryComplete:false},'native_htlc_events',state.lastProcessingAt);return this.checkpoint(this.active!.scope,next,row);});this.active!.checkpointId=id;return id;}
 /** Cache availability qualifies observed diagnostic metadata only, never financial event identity. */
 cachedForward(circuit:HtlcCircuit,at:string):{known:boolean;reason:string;financialQualified:false;observationScope:string;observationId?:string;record?:NativeForwardRecord}{const {state}=this.state(),processing=utc(at),key=circuitKey(circuit),entry=state.cache.find(c=>c.circuitKey===key);if(!entry)return {financialQualified:false,observationScope:'same_client_session_diagnostic_cache',known:false,reason:'cold_cache'};if(entry.ambiguous)return {financialQualified:false,observationScope:'same_client_session_diagnostic_cache',known:false,reason:'contradictory_circuit',observationId:entry.observationId};if(entry.epoch!==state.epoch||entry.session!==state.session||entry.bindingDigest!==digest(state.binding))return {financialQualified:false,observationScope:'same_client_session_diagnostic_cache',known:false,reason:'epoch_or_session_mismatch'};const age=Date.parse(processing)-Date.parse(entry.processingAt);if(age<0||age>this.cacheTtlMs)return {financialQualified:false,observationScope:'same_client_session_diagnostic_cache',known:false,reason:'stale_cache'};const observation=this.model.observation(entry.observationId);if(!observation)return {financialQualified:false,observationScope:'same_client_session_diagnostic_cache',known:false,reason:'missing_cache_evidence'};const record=JSON.parse(observation.payload).native as NativeForwardRecord;if(record.incomingMsat===null||record.outgoingMsat===null)return {financialQualified:false,observationScope:'same_client_session_diagnostic_cache',known:false,reason:'missing_forward_amounts',observationId:entry.observationId};return {financialQualified:false,observationScope:'same_client_session_diagnostic_cache',known:true,reason:'observed_forward_info',observationId:entry.observationId,record};}
 observe(value:unknown,at:string,options:{binding:HtlcBinding;epoch:string;session:string;beforeCheckpoint?:()=>void;liquiditySnapshot?:HtlcLiquiditySnapshot;snapshotMaxAgeMs?:number}):ObserveResult {
  let envelope:Record<string,any>|null;try{envelope=obj(value);}catch{envelope=null;}if(envelope&&(eventType(envelope.event_type)==='SEND'||eventType(envelope.event_type)==='RECEIVE'))return {accepted:false,ignored:true};
  const {state,row}=this.state();if(options.session!==state.session)return {accepted:false,reason:'session_mismatch'};
  if(!this.originMatches(state,options))return {accepted:false,reason:'binding_mismatch'};
  const processing=utc(at);if(processing<state.lastProcessingAt)throw Error('HTLC processing time cannot regress');
  if(!envelope){this.gap('malformed_event',processing,options);return {accepted:false,reason:'malformed_event'};}
  if(state.phase!=='subscribed'){this.gap('not_subscribed',processing,options);return {accepted:false,reason:'not_subscribed'};}
  let native:NativeForwardRecord;try{const decoded=decodeNativeForward(value);if(!decoded)return {accepted:false,ignored:true};native=decoded;}catch{this.gap(eventType(envelope.event_type)==='FORWARD'?'malformed_event':'unknown_event',processing,options);return {accepted:false,reason:eventType(envelope.event_type)==='FORWARD'?'malformed_event':'unknown_event'};}
  const key=circuitKey(native),eventKey=digest({binding:state.binding,epoch:state.epoch,session:state.session,circuit:key,variant:native.variant,timestampNs:native.timestampNs}),checksum=nativeBoundEvidence(value,state.binding)?.rawSourceChecksum??digest(native),originalId='htlc:'+eventKey;
  const existing=this.model.db.prepare('SELECT * FROM canonical_observations WHERE source_instance=? AND original_id=? AND original_digest=? LIMIT 1').get(state.binding.sourceInstance,originalId,checksum) as any;
  if(existing)return {accepted:true,duplicate:true,observationId:existing.id,financialQualified:false,observationScope:'identical_client_observation_payload',eventMultiplicityQualified:false};
  const contradiction=!!this.model.db.prepare('SELECT id FROM canonical_observations WHERE source_instance=? AND original_id=? LIMIT 1').get(state.binding.sourceInstance,originalId);
  const crossEpoch=!!this.model.db.prepare("SELECT id FROM canonical_observations WHERE node_id=? AND network=? AND kind='native_htlc' AND json_extract(payload,'$.circuitKey')=? AND json_extract(payload,'$.native.variant')=? AND json_extract(payload,'$.session')<>? LIMIT 1").get(state.binding.nodeId,state.binding.network,key,native.variant,state.session);
  const currentEntry=state.cache.find(e=>e.circuitKey===key&&e.session===state.session&&e.epoch===state.epoch&&e.bindingDigest===digest(state.binding));
  // Retained originals, rather than the bounded diagnostic cache, determine
  // same-session contradictions. The existing corridor index narrows these reads;
  // the metadata probe returns one witness and links are streamed without an array.
  const retainedWhere="o.node_id=? AND o.network=? AND o.kind='native_htlc' AND o.source_instance=? AND o.source_version=? AND o.source_channel=? AND o.target_channel=? AND json_extract(o.payload,'$.session')=? AND json_extract(o.payload,'$.circuitKey')=?";
  const retainedArgs=[state.binding.nodeId,state.binding.network,state.binding.sourceInstance,state.binding.sourceVersion,channelScid(native.incomingChannelId),channelScid(native.outgoingChannelId),state.session,key];
  const metadataFields=['incomingMsat','outgoingMsat','incomingTimelock','outgoingTimelock'] as const;
  const differingKnown=metadataFields.map(field=>`(json_extract(o.payload,'$.native.${field}') IS NOT NULL AND ? IS NOT NULL AND json_extract(o.payload,'$.native.${field}')<>?)`).join(' OR ');
  const metadataWitness=native.variant==='forward'?this.model.db.prepare(`SELECT o.id FROM canonical_observations o INDEXED BY canonical_observation_corridor WHERE ${retainedWhere} AND json_extract(o.payload,'$.native.variant')='forward' AND (${differingKnown}) LIMIT 1`).get(...retainedArgs,...metadataFields.flatMap(field=>[native[field],native[field]])) as {id:string}|undefined:undefined;
  const metadataConflict=!!metadataWitness;
  const durableConflict=!!this.model.db.prepare(`SELECT o.id FROM canonical_observations o INDEXED BY canonical_observation_corridor JOIN canonical_evidence_links l ON l.observation_id=o.id WHERE ${retainedWhere} AND l.relation='ambiguous' AND json_extract(l.details,'$.reason') IN ('contradictory_circuit','conflicting_duplicate') LIMIT 1`).get(...retainedArgs);
  const circuitConflict=durableConflict||metadataConflict||!!currentEntry?.ambiguous;
  const uncertainty=contradiction?'conflicting_duplicate':circuitConflict?'contradictory_circuit':crossEpoch?'cross_epoch_circuit':null;
  const cached=native.variant==='forward_fail'?this.cachedForward(native,processing):null;
  const delta=native.incomingMsat!==null&&native.outgoingMsat!==null?(BigInt(native.incomingMsat)-BigInt(native.outgoingMsat)).toString():null;
  let nextCache=state.cache.filter(e=>e.circuitKey!==key);const id=digest({eventKey,checksum}),next:EpochState={...state,lastProcessingAt:processing,cache:currentEntry&&(circuitConflict||contradiction)?[...nextCache,{...currentEntry,ambiguous:true}].slice(-this.cacheLimit):nextCache};
  let projectionId:string|undefined;
  const checkpointId=this.model.transaction(()=>{
   if(this.latest(this.active!.scope)?.id!==row.id)throw Error('HTLC epoch ownership changed');
   this.model.observe({...state.binding,id,kind:'native_htlc',meaning:'lnd_effect',source:'lnd.htlc',originalId,batchId:state.session,occurredAt:new Date(Number(BigInt(native.timestampNs)/1000000n)).toISOString(),observedAt:processing,originalTimestamp:native.timestampNs,timestampNs:native.timestampNs,granularity:'native nanoseconds',sourceChannel:native.incomingChannelId,targetChannel:native.outgoingChannelId,amountMsat:native.outgoingMsat,feeMsat:null,signedFeeDeltaMsat:delta,originalDigest:nativeBoundEvidence(value,state.binding)?.rawSourceChecksum??checksum,payload:{rawSourceChecksum:nativeBoundEvidence(value,state.binding)?.rawSourceChecksum??null,allowlistedChecksum:nativeBoundEvidence(value,state.binding)?.allowlistedChecksum??null,native,circuitKey:key,epoch:state.epoch,session:state.session,processingAt:processing,checksumScope:nativeBoundEvidence(value,state.binding)?.checksumScope??'allowlisted_native_observables',identityQualified:uncertainty===null,identityScope:'same_client_session_observation',financialQualified:false,eventMultiplicityQualified:false,sourceHistoryComplete:false,snapshotFrozen:false}});
   if(circuitConflict||contradiction){
    // Attach immutable ambiguity to the actual entities previously qualified by
    // these originals. A null entity link alone cannot invalidate effects().
    for(const prior of this.model.db.prepare(`SELECT DISTINCT o.id,l.entity_id FROM canonical_observations o INDEXED BY canonical_observation_corridor JOIN canonical_evidence_links l ON l.observation_id=o.id WHERE ${retainedWhere} AND (l.relation='same_effect' OR (l.relation='ambiguous' AND l.method='record_match_v2')) AND l.entity_id IS NOT NULL`).iterate(...retainedArgs) as Iterable<{id:string;entity_id:string}>){
     this.model.link({observationId:prior.id,entityId:prior.entity_id,relation:'ambiguous',method:CALCULATION,details:{reason:'contradictory_circuit',identityQualified:false}});
    }
   }
   if(uncertainty)this.model.link({observationId:id,relation:'ambiguous',method:CALCULATION,details:{reason:uncertainty,identityQualified:false}});
   else this.model.identify(id,{namespace:'htlc_circuit',key:[digest({sourceInstance:state.binding.sourceInstance,epoch:state.epoch,session:state.session}),native.incomingChannelId,native.incomingHtlcId,native.outgoingChannelId,native.outgoingHtlcId,native.variant==='forward_fail'?'downstream_fail':native.variant,native.timestampNs].join(':')});
   const gapId=uncertainty?this.coverage(state,this.active!.scope,processing,'gap',{reason:uncertainty,sourceHistoryComplete:false,snapshotFrozen:false},'native_htlc_events',state.lastProcessingAt):null;
   const coverageId=this.coverage(state,this.active!.scope,processing,'partial',{nativeVariant:native.variant,eventCount:1,externalPaymentCount:null,demandQualified:false,revenueQualified:false,sourceHistoryComplete:false,snapshotFrozen:false},'native_htlc_events',state.lastProcessingAt);
   const diagnostic={observationId:id,binding:state.binding,epoch:state.epoch,processingAt:processing,record:native,identityQualified:uncertainty===null,identityScope:'same_client_session_observation',financialQualified:false,eventMultiplicityQualified:false};
   const converterCoverage=this.coverage(state,this.active!.scope,processing,'partial',{calculationVersion:'lightningmate-0.7.7-native-exact-record-match-v2',converterAccepted:native.converterDropReasons.length===0,missingFields:native.converterDropReasons,sourceHistoryComplete:false,sourceInstanceMeaning:'client_provenance_not_database_epoch'},'lightningmate_converter',state.lastProcessingAt);
   const result={calculationVersion:CALCULATION,nativeVariant:native.variant,processingDay:processing.slice(0,10),eventTimestampNs:native.timestampNs,outgoingChannelId:native.outgoingChannelId,feeDeltaMsat:delta,feeDeltaMeaning:'signed_native_amount_difference_not_revenue',identityQualified:uncertainty===null,identityScope:'same_client_session_observation',financialQualified:false,eventMultiplicityQualified:false,downstreamCachedForward:cached,lightningMate:lightningMateProjection([diagnostic]),lndg:lndgFailureProjection(native,diagnostic,{snapshot:options.liquiditySnapshot,snapshotMaxAgeMs:options.snapshotMaxAgeMs,cachedForward:cached??undefined}),sourceInstanceMeaning:'client_provenance_not_database_epoch',externalPaymentCount:null,demandQualified:false,revenueQualified:false,profitQualified:false,sourceHistoryComplete:false};
   projectionId=this.model.publishProjectionInTransaction({name:'native_htlc_diagnostics',scope:this.active!.scope,epoch:state.epoch,calculationVersion:CALCULATION,observationIds:[id,...(cached?.observationId?[cached.observationId]:[]),...(metadataWitness?[metadataWitness.id]:[])],coverageIds:[coverageId,converterCoverage,...(gapId?[gapId]:[])],result});
   if(native.variant==='forward'&&!uncertainty)next.cache=[...nextCache,{circuitKey:key,observationId:id,epoch:state.epoch,session:state.session,processingAt:processing,bindingDigest:digest(state.binding)}].slice(-this.cacheLimit);
   options.beforeCheckpoint?.();return this.checkpoint(this.active!.scope,next,row);
  });this.active!.checkpointId=checkpointId;return {accepted:true,observationId:id,projectionId,financialQualified:false,observationScope:'same_client_session_observation',eventMultiplicityQualified:false,...(uncertainty?{reason:uncertainty}:{})};
 }
}

export const HTLC_COMPATIBILITY_SOURCES={lnd:'572b561bf05f03dfe6135110970c4d858c3482dc',lightningMate:'43df62bf82c83b35cc7f9a5a6a653ebd5a51d1b7',converter:'c6c35356f9470380286f5ccd2eb25db9fa5e7b73',lndg:'558ca42911c90db4afb393b6dedced84ffa7a0c3',converterHelperSha256:'4d643db0723452c2610e6e1a9146dbc9e3c63e6a1d230cc9a83d68a1f35d7f82'};
const MAX_SAFE=9007199254740991n;
/** Explicit legacy FLOAT truncation comparison. Native values stay exact; equality is never inferred from magnitude alone. */
export function htlcAmountArithmetic(msat:string){const n=BigInt(exact(msat)),floor=(n/1000n).toString(),legacy=BigInt(Math.trunc(Number(n)/1000)).toString(),convertedTokens=BigInt(Number(n/1000n)).toString();return {nativeFloorSat:floor,legacyPythonFloatTruncSat:n<=MAX_SAFE?legacy:null,legacyNumberApproximationSat:legacy,legacyFloatPrecisionDifference:legacy!==floor,converterAmountSat:convertedTokens,converterAmountPrecisionDifference:convertedTokens!==floor,converterAmountInputSafe:n/1000n<=MAX_SAFE,legacyInputExact:n<=MAX_SAFE};}
function signedDecimal(n:bigint):string {const negative=n<0n,a=negative?-n:n,whole=a/1000n,rest=a%1000n;return (negative?'-':'')+whole+(rest?'.'+rest.toString().padStart(3,'0').replace(/0+$/,''):'');}
function decimalEqualsMsat(text:string,msat:bigint):boolean{const match=/^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(text);if(!match)return false;const fraction=match[3]??'',power=Number(match[4]??0)-fraction.length+3,integer=BigInt(match[2]!+fraction)*(match[1]==='-'?-1n:1n);return power>=0?integer*10n**BigInt(power)===msat:integer===msat*10n**BigInt(-power);}
export function htlcFeeEstimate(incomingMsat:string|null,outgoingMsat:string|null){if(incomingMsat===null||outgoingMsat===null)return {known:false,deltaMsat:null,quotedSat:null,legacyFloatSat:null,precisionDifference:null,realizedFeeMsat:null};const delta=BigInt(exact(incomingMsat))-BigInt(exact(outgoingMsat)),inputExact=delta>=-MAX_SAFE&&delta<=MAX_SAFE,legacy=inputExact?String(Number(delta)/1000):null;return {known:true,deltaMsat:delta.toString(),quotedSat:signedDecimal(delta),legacyFloatSat:legacy,precisionDifference:legacy===null?true:!decimalEqualsMsat(legacy,delta),realizedFeeMsat:null};}
export interface HtlcDiagnosticInput {observationId:string;binding:HtlcBinding;epoch:string;processingAt:string;record:NativeForwardRecord;identityQualified:boolean} // Observation grouping within the supplied client session only; never financial identity.
/** Exact, bounded attempt buckets. Converter drops are separate from native evidence and never imply absent demand. */
export function lightningMateProjection(inputs:HtlcDiagnosticInput[]){
 if(!Array.isArray(inputs)||inputs.length>1000)throw Error('Bounded HTLC projection input required');
 const buckets=new Map<string,any>(),seen=new Set<string>();
 for(const input of inputs){if(seen.has(input.observationId))continue;seen.add(input.observationId);const r=input.record;if(r.variant!=='link_fail'&&r.variant!=='forward_fail')continue;const processing=utc(input.processingAt),key=digest({nodeId:input.binding.nodeId,network:input.binding.network,day:processing.slice(0,10),outChannel:r.outgoingChannelId});
  let bucket=buckets.get(key);if(!bucket){bucket={nodeId:input.binding.nodeId,network:input.binding.network,day:processing.slice(0,10),outChannel:r.outgoingChannelId,nativeFailureAttemptCount:0,liquidityCount:0,otherCount:0,unknownCauseCount:0,unknownAmountCount:0,converterDroppedCount:0,ambiguousIdentityCount:0,precisionDifferenceCount:0,knownLiquiditySats:null as string|null,liquiditySats:null as string|null,sourceObservationIds:[],rawCodes:[]};buckets.set(key,bucket);}
  bucket.nativeFailureAttemptCount++;bucket.sourceObservationIds.push(input.observationId);bucket.rawCodes.push({observationId:input.observationId,timestampNs:r.timestampNs,wireFailure:r.rawWireFailure,failureDetail:r.rawFailureDetail});
  if(!input.identityQualified){bucket.ambiguousIdentityCount++;continue;}
  if(r.converterDropReasons.length){bucket.converterDroppedCount++;if(r.outgoingMsat===null)bucket.unknownAmountCount++;continue;}
  if(r.variant==='link_fail'&&r.failureDetail==='6'){
   bucket.liquidityCount++;
   if(r.outgoingMsat===null){bucket.unknownAmountCount++;continue;}
   const arithmetic=htlcAmountArithmetic(r.outgoingMsat);if(arithmetic.converterAmountPrecisionDifference||!arithmetic.converterAmountInputSafe)bucket.precisionDifferenceCount++;
   bucket.knownLiquiditySats=(BigInt(bucket.knownLiquiditySats??'0')+BigInt(arithmetic.nativeFloorSat)).toString();
  }else {bucket.otherCount++;if(r.variant==='link_fail'&&(r.failureDetail===null||r.failureDetail==='0'))bucket.unknownCauseCount++;}
 }
 for(const bucket of buckets.values()){bucket.partial=!!(bucket.unknownAmountCount||bucket.converterDroppedCount||bucket.ambiguousIdentityCount||bucket.precisionDifferenceCount||bucket.unknownCauseCount);bucket.liquiditySats=bucket.partial?null:bucket.knownLiquiditySats;}
 return {calculationVersion:'lightningmate-0.7.7-native-exact-record-match-v2',sourceContract:HTLC_COMPATIBILITY_SOURCES,buckets:[...buckets.values()],historicalMissingAmountDefaultSat:'0',historicalDefaultMeaning:'legacy_missing_value_fallback_not_observed_amount',financialQualified:false,accountingAuthority:'none',identityScope:'client_observation_grouping',eventMultiplicityQualified:false,countMeaning:'native_forward_failure_observations_not_unique_external_payments',sourceHistoryComplete:false,demandQualified:false,profitQualified:false};
}
export interface HtlcLiquiditySnapshot {binding:HtlcBinding;epoch:string;outgoingChannelId:string;observedAt:string;localBalanceSat:string;reserveSat:string;pendingOutboundSat:string}
const signed=(v:string):bigint=>{if(typeof v!=='string'||! /^-?\d{1,20}$/.test(v)||BigInt(v)>UINT64||BigInt(v)<-UINT64)throw Error('Exact signed cached balance required');return BigInt(v);};
function cachedLiquidity(record:NativeForwardRecord,context:{binding:HtlcBinding;epoch:string;processingAt:string},snapshot:HtlcLiquiditySnapshot|undefined,maxAgeMs:number){
 if(!snapshot)return {known:false,reason:'missing_snapshot',availableSat:null,pendingSat:null,totalSat:null};
 try{if(!Number.isSafeInteger(maxAgeMs)||maxAgeMs<1||maxAgeMs>3600000)throw Error('Bounded snapshot freshness required');if(stable(binding(snapshot.binding))!==stable(binding(context.binding))||snapshot.epoch!==context.epoch||identifier(snapshot.outgoingChannelId)!==record.outgoingChannelId)return {known:false,reason:'snapshot_binding_or_epoch_mismatch',availableSat:null,pendingSat:null,totalSat:null};const age=Date.parse(utc(context.processingAt))-Date.parse(utc(snapshot.observedAt));if(age<0||age>maxAgeMs)return {known:false,reason:'stale_snapshot',availableSat:null,pendingSat:null,totalSat:null};const net=signed(snapshot.localBalanceSat)-signed(snapshot.reserveSat),available=net>0n?net:0n,pending=signed(snapshot.pendingOutboundSat);return {known:true,reason:'time_qualified_cached_proxy',availableSat:available.toString(),pendingSat:pending.toString(),totalSat:(available+pending).toString(),snapshotEvidence:{binding:binding(snapshot.binding),epoch:snapshot.epoch,outgoingChannelId:record.outgoingChannelId,observedAt:utc(snapshot.observedAt),localBalanceSat:signed(snapshot.localBalanceSat).toString(),reserveSat:signed(snapshot.reserveSat).toString(),pendingOutboundSat:pending.toString()}};}catch{return {known:false,reason:'malformed_snapshot',availableSat:null,pendingSat:null,totalSat:null};}
}
/** Reproduces the pinned local-failure formula with explicit exact arithmetic/version differences and cached-snapshot qualification. */
export function lndgFailureProjection(record:NativeForwardRecord,context:{binding:HtlcBinding;epoch:string;processingAt:string},options:{snapshot?:HtlcLiquiditySnapshot;snapshotMaxAgeMs?:number;cachedForward?:ReturnType<NativeHtlcCollector['cachedForward']>}={}){
 const processing=utc(context.processingAt),local=record.variant==='link_fail',downstream=record.variant==='forward_fail',cache=options.cachedForward;
 const amounts=local?record:downstream&&cache?.known?cache.record??null:null;
 const msat=amounts?(local?amounts.outgoingMsat:amounts.incomingMsat):null,arithmetic=msat===null?null:htlcAmountArithmetic(msat),fee=htlcFeeEstimate(amounts?.incomingMsat??null,amounts?.outgoingMsat??null),liquidity=cachedLiquidity(record,context,options.snapshot,options.snapshotMaxAgeMs??300000);
 const wireKnown=record.wireFailure!==null||record.rawWireFailure!==null,detailKnown=record.failureDetail!==null;
 let failedOut:boolean|null=null;if(local&&wireKnown&&detailKnown){if(record.wireFailure!=='15'||record.failureDetail!=='6')failedOut=false;else if(arithmetic&&liquidity.known)failedOut=BigInt(arithmetic.nativeFloorSat)>BigInt(liquidity.totalSat!);}
 if(downstream)failedOut=false;
 return {calculationVersion:'lndg-1.11.1-native-exact-record-match-v2',sourceContract:HTLC_COMPATIBILITY_SOURCES,applicable:local||downstream,processingAt:processing,amountSat:arithmetic?.nativeFloorSat??null,amountArithmetic:arithmetic,feeEstimate:fee,rawWireFailure:record.rawWireFailure,rawFailureDetail:record.rawFailureDetail,legacyWireFailure:downstream?'99':record.wireFailure,legacyFailureDetail:downstream?'99':record.failureDetail,legacySentinelMeaning:downstream?'cached_downstream_failure_not_native_wire_code':null,cachedForwardKnown:downstream?cache?.known??false:null,cachedForwardReason:downstream?cache?.reason??'cold_cache':null,liquiditySnapshot:liquidity,failedOutCachedProxy:failedOut,instantaneousLiquidityQualified:false,legacyArithmeticEquivalent:arithmetic?arithmetic.legacyInputExact&&!arithmetic.legacyFloatPrecisionDifference&&fee.precisionDifference===false:false,legacyCatchAllUnmatchedForwardVariantsQualified:false,financialQualified:false,accountingAuthority:'none',identityScope:'client_observation_grouping',eventMultiplicityQualified:false,countMeaning:'failure_observations_not_unique_external_payments',realizedRevenueMsat:null,profitQualified:false,sourceHistoryComplete:false};
}
