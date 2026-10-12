import {nativeBoundEvidence} from './native-lnd-source.js';
import {randomUUID} from 'node:crypto';
import {CanonicalModel,digest,stable} from './canonical-model.js';
import {channelScid} from './diagnostics.js';
import type {NativeHistoryBinding} from './native-history.js';

export const NATIVE_POLICY_CONTRACT='lnd-572b561b-v1';
const CALCULATION='native-policy-history-v1',SOURCE='lnd.policy';
export type PolicyDirection='outgoing'|'incoming';
export type PolicyErrorCode='unsupported_source'|'binding_mismatch'|'identity_mismatch'|'malformed_policy'|'source_error'|'stale_session'|'not_ready'|'receipt_conflict'|'concurrent_capture';
export class NativePolicyError extends Error {constructor(readonly code:PolicyErrorCode){super('Native policy: '+code);}}
export interface NativePolicySource {contract:typeof NATIVE_POLICY_CONTRACT;binding():NativeHistoryBinding|Promise<NativeHistoryBinding>;getChanInfo(channelId:string):Promise<unknown>}
export interface RoutingPolicy {
 timeLockDelta:string|null;minHtlcMsat:string|null;feeBaseMsat:string|null;feeRatePpm:string|null;disabled:boolean|null;
 maxHtlcMsat:string|null;lastUpdate:string|null;inboundFeeBaseMsat:string|null;inboundFeeRatePpm:string|null;
}
export interface PolicyOrigin {binding:NativeHistoryBinding;epoch:string;session:string}
interface PolicyState extends PolicyOrigin {phase:'awaiting_ready'|'ready'|'closed';at:string}
interface DirectionRecord {nativeEvidence?:ReturnType<typeof nativeBoundEvidence>;channelId:string;direction:PolicyDirection;policy:RoutingPolicy|null;originalDigest:string;missingFields:string[]}
interface PolicyReceipt {observationId:string;projectionId:string;channelId:string;direction:PolicyDirection}
const object=(v:unknown):Record<string,any>=>{if(!v||typeof v!=='object'||Array.isArray(v))throw new NativePolicyError('malformed_policy');return v as Record<string,any>;};
const label=(v:unknown):string=>{if(typeof v!=='string'||!v||v.length>128)throw new NativePolicyError('malformed_policy');return v;};
const utc=(v:string):string=>{if(!/^\d{4}-\d\d-\d\dT.*Z$/.test(v)||!Number.isFinite(Date.parse(v)))throw new NativePolicyError('malformed_policy');return new Date(v).toISOString();};
function integer(v:unknown,min:bigint,max:bigint,numberAllowed=false):string {
 if(numberAllowed&&typeof v==='number'&&Number.isSafeInteger(v))v=String(v);
 if(typeof v!=='string'||! /^-?\d{1,20}$/.test(v)||BigInt(v)<min||BigInt(v)>max)throw new NativePolicyError('malformed_policy');return BigInt(v).toString();
}
const uint64=(v:unknown)=>integer(v,0n,18446744073709551615n);
const pub=(v:unknown):string=>{if(typeof v!=='string'||! /^(02|03)[a-f0-9]{64}$/.test(v))throw new NativePolicyError('identity_mismatch');return v;};
function bind(v:unknown):NativeHistoryBinding {const b=object(v);return {nodeId:pub(b.nodeId),network:label(b.network),sourceInstance:label(b.sourceInstance),sourceVersion:label(b.sourceVersion)};}
const fields={time_lock_delta:'timeLockDelta',min_htlc:'minHtlcMsat',fee_base_msat:'feeBaseMsat',fee_rate_milli_msat:'feeRatePpm',disabled:'disabled',max_htlc_msat:'maxHtlcMsat',last_update:'lastUpdate',inbound_fee_base_msat:'inboundFeeBaseMsat',inbound_fee_rate_milli_msat:'inboundFeeRatePpm'} as const;
/** REST policy field names/types pinned to LND572b561b. Missing fields stay unknown, including booleans. */
export function decodeRoutingPolicy(value:unknown):{policy:RoutingPolicy|null;missingFields:string[];originalDigest:string} {
 if(value===undefined||value===null)return {policy:null,missingFields:Object.keys(fields),originalDigest:digest(null)};
 const raw=object(value),policy={} as RoutingPolicy,original:Record<string,unknown>={},missingFields:string[]=[];
 for(const [key,target] of Object.entries(fields)){
  const v=raw[key];original[key]=v??null;
  if(v===undefined||v===null){(policy as any)[target]=null;missingFields.push(key);continue;}
  let parsed:string|boolean;
  if(key==='disabled'){if(typeof v!=='boolean')throw new NativePolicyError('malformed_policy');parsed=v;}
  else if(key.startsWith('inbound_'))parsed=integer(v,-2147483648n,2147483647n,true);
  else if(key==='last_update'||key==='time_lock_delta')parsed=integer(v,0n,4294967295n,true);
  else if(key==='max_htlc_msat')parsed=uint64(v);
  else parsed=integer(v,-9223372036854775808n,9223372036854775807n);
  (policy as any)[target]=parsed;
 }
 return {policy,missingFields,originalDigest:digest(original)};
}
function snapshotDirections(raw:unknown,channelId:string,nodeId:string):DirectionRecord[] {
 const r=object(raw);if(uint64(r.channel_id)!==channelId)throw new NativePolicyError('identity_mismatch');
 const n1=pub(r.node1_pub),n2=pub(r.node2_pub),local1=n1===nodeId,local2=n2===nodeId;
 if(local1===local2)throw new NativePolicyError('identity_mismatch');
 return (['outgoing','incoming'] as const).map(direction=>({channelId,direction,...decodeRoutingPolicy(r[(direction==='outgoing')===local1?'node1_policy':'node2_policy'])}));
}
function updateDirection(raw:unknown,nodeId:string):DirectionRecord {
 const r=object(raw),channelId=uint64(r.chan_id),advertising=pub(r.advertising_node),connecting=pub(r.connecting_node);
 if((advertising===nodeId)===(connecting===nodeId))throw new NativePolicyError('identity_mismatch');
 return {channelId,direction:advertising===nodeId?'outgoing':'incoming',...decodeRoutingPolicy(r.routing_policy)};
}

/** Caller owns the migrated connection and read-only transport. No RPC construction or financial methods. */
export class NativePolicyCollector {
 private active:{scope:string;checkpointId:string}|undefined;
 constructor(readonly model:CanonicalModel,readonly source:NativePolicySource,readonly clock=()=>new Date().toISOString()){}
 private async readBinding(){if(this.source.contract!==NATIVE_POLICY_CONTRACT)throw new NativePolicyError('unsupported_source');let raw:unknown;try{raw=await this.source.binding();}catch{throw new NativePolicyError('source_error');}try{return bind(raw);}catch{throw new NativePolicyError('binding_mismatch');}}
 private checkpoint(capability:string,scope:string){return this.model.db.prepare("SELECT * FROM canonical_coverage WHERE capability=? AND scope=? AND status='checkpoint' ORDER BY rowid DESC LIMIT 1").get(capability,scope) as any;}
 private coverage(b:NativeHistoryBinding,capability:string,scope:string,epoch:string,start:string,end:string,status:'partial'|'gap'|'ready',details:unknown){return this.model.appendCoverage({...b,capability,scope,source:SOURCE,epoch,start,end,observedAt:end,status,details});}
 private prior(b:NativeHistoryBinding,channelId:string,direction:PolicyDirection){return this.model.db.prepare("SELECT * FROM canonical_observations WHERE node_id=? AND network=? AND kind='native_policy' AND source_instance=? AND source_version=? AND source_channel=? AND json_extract(payload,'$.direction')=? ORDER BY rowid DESC LIMIT 1").get(b.nodeId,b.network,b.sourceInstance,b.sourceVersion,channelScid(channelId),direction) as any;}
 private persist(b:NativeHistoryBinding,r:DirectionRecord,receiptId:string,epoch:string,start:string,end:string,mode:'snapshot'|'graph_update'):PolicyReceipt {
  const originalDigest=r.nativeEvidence?.rawSourceChecksum??r.originalDigest;
  const previous=this.prior(b,r.channelId,r.direction),old=previous?JSON.parse(previous.payload):null;
  if(previous&&end<previous.observed_at)throw new NativePolicyError('malformed_policy');
  const changedFields=old?Object.values(fields).filter(field=>(old.policy?.[field]??null)!==(r.policy?.[field]??null)):[];
  const policyKnown=r.policy!==null&&r.missingFields.length===0,scope='policy:'+digest({binding:b,channelId:r.channelId,direction:r.direction});
  const payload={contract:NATIVE_POLICY_CONTRACT,mode,channelId:r.channelId,direction:r.direction,policy:r.policy,missingFields:r.missingFields,policyKnown,operationalChannelStateQualified:false,checksumScope:r.nativeEvidence?.checksumScope??'allowlisted_original_policy_fields',allowlistedChecksum:r.nativeEvidence?.allowlistedChecksum??r.originalDigest,epochMeaning:'local_capture_or_subscription_label_not_global_graph_epoch',acquisitionInterval:{start,end},previousObservationId:previous?.id??null,changedFields,changeInterval:previous&&changedFields.length&&mode==='snapshot'&&old.mode==='snapshot'?{start:old.acquisitionInterval.start<start?old.acquisitionInterval.start:start,end}:null,remoteTimestampMeaning:'source_advertised_last_update_not_observed_mutation',sourceHistoryComplete:false,snapshotFrozen:false};
  const id=digest({binding:b,receiptId,channelId:r.channelId,direction:r.direction,originalDigest});
  this.model.observe({...b,id,kind:'native_policy',meaning:'lnd_effect',source:SOURCE,originalId:receiptId+':'+r.channelId+':'+r.direction,batchId:receiptId,occurredAt:null,observedAt:end,originalTimestamp:r.policy?.lastUpdate??null,granularity:mode==='snapshot'?'bounded_snapshot_interval':'untimestamped_graph_advertisement',calculationVersion:CALCULATION,sourceChannel:r.channelId,originalDigest,payload});
  if(previous)this.model.link({observationId:id,referenceTable:'canonical_observations',referenceId:previous.id,relation:'original',method:CALCULATION,details:{predecessor:true}});
  const coverageId=this.coverage(b,'native_policy_evidence',scope,epoch,start,end,'partial',{mode,policyKnown,missingFields:r.missingFields,sourceHistoryComplete:false,snapshotFrozen:false,remoteMutationTimeQualified:false,replayQualified:false});
  const latest=this.model.db.prepare('SELECT id FROM canonical_projection_revisions WHERE name=? AND scope=? ORDER BY rowid DESC LIMIT 1').get('native_policy_state',scope) as any;
  const projectionId=this.model.publishProjectionInTransaction({name:'native_policy_state',scope,epoch,calculationVersion:CALCULATION,observationIds:[id,...(previous?[previous.id]:[])],coverageIds:[coverageId],supersedes:latest?.id??null,result:payload});
  return {observationId:id,projectionId,channelId:r.channelId,direction:r.direction};
 }
 async snapshot(request:{captureId:string;channelIds:string[];beforeCheckpoint?:()=>void}):Promise<{receipts:PolicyReceipt[];checkpointId:string;sourceHistoryComplete:false;snapshotFrozen:false}> {
  const captureId=label(request.captureId);if(!Array.isArray(request.channelIds)||request.channelIds.length<1||request.channelIds.length>100)throw new NativePolicyError('malformed_policy');
  const channels=request.channelIds.map(uint64);if(new Set(channels).size!==channels.length)throw new NativePolicyError('malformed_policy');
  const b=await this.readBinding(),scope='policy_snapshot:'+digest({binding:b,captureId}),query={binding:b,channels,contract:NATIVE_POLICY_CONTRACT},old=this.checkpoint('native_policy_snapshot_checkpoint',scope);
  if(old){const state=JSON.parse(old.details);if(stable(state.query)!==stable(query))throw new NativePolicyError('receipt_conflict');return {...state.result};}
  const start=utc(this.clock()),records:DirectionRecord[]=[];
  try{for(const channel of channels){if(stable(await this.readBinding())!==stable(b))throw new NativePolicyError('binding_mismatch');let raw:unknown;try{raw=await this.source.getChanInfo(channel);}catch{throw new NativePolicyError('source_error');}if(stable(await this.readBinding())!==stable(b))throw new NativePolicyError('binding_mismatch');records.push(...snapshotDirections(raw,channel,b.nodeId).map(r=>({...r,nativeEvidence:nativeBoundEvidence(raw,b)})));}}
  catch(error){const code=error instanceof NativePolicyError?error.code:'malformed_policy',end=utc(this.clock());this.model.transaction(()=>this.coverage(b,'native_policy_snapshot',scope,captureId,start,end,'gap',{code,sourceHistoryComplete:false,snapshotFrozen:false,replayQualified:false}));throw new NativePolicyError(code);}
  const end=utc(this.clock());if(end<start)throw new NativePolicyError('malformed_policy');
  return this.model.transaction(()=>{
   if(this.checkpoint('native_policy_snapshot_checkpoint',scope))throw new NativePolicyError('concurrent_capture');
   const receipts=records.map(r=>this.persist(b,r,captureId,captureId,start,end,'snapshot'));
   const detail={query,result:{receipts,checkpointId:'',sourceHistoryComplete:false as const,snapshotFrozen:false as const}};
   // ID is explicit to retain an idempotent result without a self-referential digest.
   const checkpointId=digest({capability:'native_policy_snapshot_checkpoint',scope,captureId});detail.result.checkpointId=checkpointId;
   request.beforeCheckpoint?.();this.model.appendCoverage({...b,id:checkpointId,capability:'native_policy_snapshot_checkpoint',scope,source:SOURCE,epoch:captureId,start:end,end,observedAt:end,status:'checkpoint',details:detail});return detail.result;
  });
 }
 openEpoch(provenance:NativeHistoryBinding,epoch:string,at:string):PolicyOrigin {
  if(this.source.contract!==NATIVE_POLICY_CONTRACT)throw new NativePolicyError('unsupported_source');const b=bind(provenance),e=label(epoch),time=utc(at),scope='policy_stream:'+digest({nodeId:b.nodeId,network:b.network}),old=this.checkpoint('native_policy_stream_checkpoint',scope),previous:PolicyState|null=old?JSON.parse(old.details):null;
  if(previous&&time<previous.at)throw new NativePolicyError('malformed_policy');const state:PolicyState={binding:b,epoch:e,session:randomUUID(),phase:'awaiting_ready',at:time};
  const checkpointId=this.model.transaction(()=>{if(previous&&previous.phase!=='closed')this.coverage(previous.binding,'native_policy_stream',scope,previous.epoch,previous.at,time,'gap',{reason:'restart_without_replay',replayQualified:false,sourceHistoryComplete:false});this.coverage(b,'native_policy_stream',scope,e,time,time,'gap',{reason:'not_ready',replayQualified:false,sourceHistoryComplete:false});return this.writeState(scope,state,old);});this.active={scope,checkpointId};return {binding:b,epoch:e,session:state.session};
 }
 private writeState(scope:string,state:PolicyState,old?:any){return this.model.appendCoverage({...state.binding,capability:'native_policy_stream_checkpoint',scope,source:SOURCE,epoch:state.epoch,start:state.at,end:state.at,observedAt:state.at,status:'checkpoint',details:state,supersedes:old?.id??null});}
 private state(origin:PolicyOrigin,at:string){if(this.source.contract!==NATIVE_POLICY_CONTRACT)throw new NativePolicyError('unsupported_source');if(!this.active)throw new NativePolicyError('stale_session');const row=this.checkpoint('native_policy_stream_checkpoint',this.active.scope);if(!row||row.id!==this.active.checkpointId)throw new NativePolicyError('stale_session');const state=JSON.parse(row.details) as PolicyState;if(origin.session!==state.session||origin.epoch!==state.epoch||stable(bind(origin.binding))!==stable(state.binding))throw new NativePolicyError('stale_session');const time=utc(at);if(time<state.at)throw new NativePolicyError('malformed_policy');return {state,row,time};}
 markReady(origin:PolicyOrigin,at:string):void {const {state,row,time}=this.state(origin,at);if(state.phase==='closed')throw new NativePolicyError('stale_session');if(state.phase==='ready')return;const next={...state,phase:'ready' as const,at:time};const id=this.model.transaction(()=>{this.coverage(state.binding,'native_policy_stream',this.active!.scope,state.epoch,time,time,'ready',{readOnlyTransportReady:true,nativeSubscriptionAckAvailable:false,replayQualified:false,sourceHistoryComplete:false});return this.writeState(this.active!.scope,next,row);});this.active!.checkpointId=id;}
 closeEpoch(origin:PolicyOrigin,at:string,reason:'disconnect'|'shutdown'|'source_error'):void {if(!['disconnect','shutdown','source_error'].includes(reason))throw new NativePolicyError('malformed_policy');const {state,row,time}=this.state(origin,at);if(state.phase==='closed')return;const next={...state,phase:'closed' as const,at:time};const id=this.model.transaction(()=>{this.coverage(state.binding,'native_policy_stream',this.active!.scope,state.epoch,state.at,time,'gap',{reason,replayQualified:false,sourceHistoryComplete:false});return this.writeState(this.active!.scope,next,row);});this.active!.checkpointId=id;}
 observeUpdate(value:unknown,origin:PolicyOrigin,request:{receiptId:string;observedAt:string;beforeCheckpoint?:()=>void}):PolicyReceipt {
  const {state,row,time}=this.state(origin,request.observedAt);if(state.phase!=='ready')throw new NativePolicyError('not_ready');const receiptId=state.session+':'+label(request.receiptId);let record:DirectionRecord;
  try{record=updateDirection(value,state.binding.nodeId);}catch(error){this.model.transaction(()=>this.coverage(state.binding,'native_policy_stream',this.active!.scope,state.epoch,state.at,time,'gap',{reason:error instanceof NativePolicyError?error.code:'malformed_policy',replayQualified:false,sourceHistoryComplete:false}));throw error;}
  record.nativeEvidence=nativeBoundEvidence(value,state.binding);if(record.nativeEvidence)record.originalDigest=record.nativeEvidence.rawSourceChecksum;
  const old=this.model.db.prepare("SELECT * FROM canonical_observations WHERE source_instance=? AND original_id=? AND kind='native_policy' LIMIT 1").get(state.binding.sourceInstance,receiptId+':'+record.channelId+':'+record.direction) as any;
  if(old){if(old.original_digest!==record.originalDigest)throw new NativePolicyError('receipt_conflict');const projection=this.model.db.prepare("SELECT p.id FROM canonical_projection_revisions p JOIN canonical_evidence_links l ON l.reference_id=p.id WHERE l.observation_id=? AND l.relation='projection_input' ORDER BY p.rowid LIMIT 1").get(old.id) as any;return {observationId:old.id,projectionId:projection.id,channelId:record.channelId,direction:record.direction};}
  const next={...state,at:time};let receipt!:PolicyReceipt;const checkpointId=this.model.transaction(()=>{receipt=this.persist(state.binding,record,receiptId,state.epoch,time,time,'graph_update');this.coverage(state.binding,'native_policy_stream',this.active!.scope,state.epoch,state.at,time,'partial',{reason:'untimestamped_nonreplayable_advertisement',replayQualified:false,sourceHistoryComplete:false});request.beforeCheckpoint?.();return this.writeState(this.active!.scope,next,row);});this.active!.checkpointId=checkpointId;return receipt;
 }
 readiness(at:string,maxAgeMs=300000):{qualified:boolean;reasons:string[]} {if(this.source.contract!==NATIVE_POLICY_CONTRACT)return {qualified:false,reasons:['unsupported_source']};if(!this.active)return {qualified:false,reasons:['fresh_transport_ready_required']};const row=this.checkpoint('native_policy_stream_checkpoint',this.active.scope);if(!row||row.id!==this.active.checkpointId)return {qualified:false,reasons:['session_ownership_changed']};const state=JSON.parse(row.details) as PolicyState;const time=utc(at);if(!Number.isSafeInteger(maxAgeMs)||maxAgeMs<0)throw new NativePolicyError('malformed_policy');const fresh=time>=state.at&&Date.parse(time)-Date.parse(state.at)<=maxAgeMs;return {qualified:state.phase==='ready'&&fresh,reasons:state.phase!=='ready'?['fresh_transport_ready_required']:fresh?[]:['stale_transport_readiness']};}
 policyState(b:NativeHistoryBinding,channelId:string,direction:PolicyDirection):{known:boolean;policy:RoutingPolicy|null;observationId:string|null;observedAt:string|null;sourceHistoryComplete:false;operationalChannelStateQualified:false;currentPolicyQualified:false} {const provenance=bind(b);if(!['outgoing','incoming'].includes(direction))throw new NativePolicyError('malformed_policy');const row=this.prior(provenance,uint64(channelId),direction),payload=row?JSON.parse(row.payload):null;return {known:payload?.policyKnown===true,policy:payload?.policy??null,observationId:row?.id??null,observedAt:row?.observed_at??null,sourceHistoryComplete:false,operationalChannelStateQualified:false,currentPolicyQualified:false};}
}
