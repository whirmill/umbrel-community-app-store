import {randomUUID} from 'node:crypto';
import {digest} from './canonical-model.js';
import type {NativeLndRead,NativeReadLimits} from './lnd.js';
import type {NativeHistorySource,NativeHistoryBinding,ForwardPageRequest,PaymentPageRequest} from './native-history.js';
import {NATIVE_POLICY_CONTRACT,type NativePolicySource} from './native-policy.js';
import {decodeNativeForward} from './native-htlc.js';
export type NativeSourceErrorCode='invalid_config'|'invalid_request'|'binding_mismatch'|'source_error'|'malformed_response'|'size_limit'|'idle_timeout'|'time_budget'|'cancelled'|'shutdown'|'callback_error'|'not_subscribed'|'authentication'|'permission_denied'|'certificate_error'|'unavailable';
export class NativeLndSourceError extends Error {constructor(readonly code:NativeSourceErrorCode){super('Native read-only LND: '+code);}}
export interface NativeLndSourceOptions {
 transport:NativeLndRead;nodeId:string;network:string;chain:string;sourceVersion:string;sourceInstance:string;
 limits?:Partial<{bodyBytes:number;frameBytes:number;streamBytes:number;frames:number;idleMs:number;requestMs:number;streamMs:number;concurrent:number}>;
}
export interface NativeStreamOrigin {rawSourceChecksum?:string;allowlistedChecksum?:string;checksumScope?:'raw_lnd_htlc_event'|'raw_lnd_graph_directional_update';binding:NativeHistoryBinding;session:string;observedAt:string;scope:'client_subscription_not_database_epoch'}
export interface NativeStreamReceipt {session:string;reason:NativeSourceErrorCode|'eof';transportReady:boolean;subscribed:boolean;nativeAckObserved:boolean;frames:number;filtered:number;replayQualified:false;sourceHistoryComplete:false}
export interface NativeStreamCallbacks {
 onReady?(origin:NativeStreamOrigin&{kind:'transport_ready'|'subscribed'}):void;
 onEvent(event:unknown,origin:NativeStreamOrigin):void;
 onClose?(receipt:NativeStreamReceipt):void;
}
interface NativeRecordEvidence {rawSourceChecksum:string;allowlistedChecksum:string;nodeId:string;network:string;sourceVersion:string;sourceInstance:string;allSettledRoutesToLocal:boolean|null;checksumScope:'raw_lnd_payment_response_record'|'raw_lnd_forward_response_record';rawAttemptChecksums:string[];}
const paymentEvidence=new WeakMap<object,NativeRecordEvidence>();
/** Evidence only for unmodified rows created by this adapter, never a caller's proof-shaped JSON. */
export function nativeRecordEvidence(value:unknown,binding:NativeHistoryBinding):NativeRecordEvidence|null {
 if(!value||typeof value!=='object')return null;const e=paymentEvidence.get(value);return e&&e.nodeId===binding.nodeId&&e.network===binding.network&&e.sourceVersion===binding.sourceVersion&&e.sourceInstance===binding.sourceInstance&&digest(value)===e.allowlistedChecksum?{...e,rawAttemptChecksums:[...e.rawAttemptChecksums]}:null;
}
interface BoundNativeEvidence {rawSourceChecksum:string;allowlistedChecksum:string;binding:NativeHistoryBinding;checksumScope:'raw_lnd_htlc_event'|'raw_lnd_graph_directional_update'|'raw_lnd_channel_info';}
const boundEvidence=new WeakMap<object,BoundNativeEvidence>();
export function nativeBoundEvidence(value:unknown,binding:NativeHistoryBinding):BoundNativeEvidence|null {if(!value||typeof value!=='object')return null;const e=boundEvidence.get(value);return e&&digest(e.binding)===digest(binding)&&digest(value)===e.allowlistedChecksum?{...e,binding:{...e.binding}}:null;}
const fail=(code:NativeSourceErrorCode):never=>{throw new NativeLndSourceError(code);};
function object(v:unknown):Record<string,any>{if(!v||typeof v!=='object'||Array.isArray(v))return fail('malformed_response');return v as Record<string,any>;}
function label(v:unknown):string{if(typeof v!=='string'||!v||v.length>128||/[\x00-\x1f]/.test(v))return fail('invalid_config');return v;}
function pub(v:unknown):string{if(typeof v!=='string'||!/^(02|03)[a-f0-9]{64}$/.test(v))return fail('binding_mismatch');return v;}
function uint(v:unknown,max=18446744073709551615n):string{if(typeof v==='number'&&Number.isSafeInteger(v)&&max<=4294967295n)v=String(v);if(typeof v!=='string'||!/^\d{1,20}$/.test(v)||BigInt(v)>max)return fail('invalid_request');return BigInt(v).toString();}
function pick(r:Record<string,any>,keys:string[]):Record<string,any>{const out:Record<string,any>={};for(const k of keys)if(r[k]!==undefined)out[k]=r[k];return out;}
const policyFields=['time_lock_delta','min_htlc','fee_base_msat','fee_rate_milli_msat','disabled','max_htlc_msat','last_update','inbound_fee_base_msat','inbound_fee_rate_milli_msat'];
function policy(v:unknown):unknown{return v==null?v:pick(object(v),policyFields);}
function paymentRow(raw:unknown,binding:NativeHistoryBinding):unknown {
 const r=object(raw),out=pick(r,['payment_index','payment_hash','status','creation_time_ns','value_msat','fee_msat']);
 if(r.htlcs!==undefined&&!Array.isArray(r.htlcs))return fail('malformed_response');if((r.htlcs?.length??0)>1000)return fail('size_limit');
 let settled=0,unknown=false,nonlocal=false;
 out.htlcs=(r.htlcs??[]).map((v:unknown)=>{const a=object(v),clean=pick(a,['attempt_id','status','attempt_time_ns','resolve_time_ns']);
  if(a.route!=null){const route=object(a.route);if(route.hops!=null&&(!Array.isArray(route.hops)||route.hops.length>1000))return fail('malformed_response');clean.route=pick(route,['total_amt_msat','total_fees_msat']);if(route.hops!=null)clean.route.hops=route.hops.map((h:unknown)=>pick(object(h),['chan_id','amt_to_forward_msat','fee_msat','expiry']));}
  if(a.status==='SUCCEEDED'){settled++;const hops=a.route?.hops,last=Array.isArray(hops)?hops.at(-1):null,destination=last?.pub_key;if(typeof destination!=='string'||!/^(02|03)[a-f0-9]{64}$/.test(destination)||!hops?.length)unknown=true;else if(destination!==binding.nodeId)nonlocal=true;}
  return clean;
 });
 const e:NativeRecordEvidence={rawSourceChecksum:digest(r),allowlistedChecksum:digest(out),...binding,allSettledRoutesToLocal:r.status==='SUCCEEDED'&&settled>0?(nonlocal?false:unknown?null:true):null,checksumScope:'raw_lnd_payment_response_record',rawAttemptChecksums:(r.htlcs??[]).map((a:unknown)=>digest(a))};paymentEvidence.set(out,e);return out;
}

/** Uses only the existing Lnd read capability; owns bounded acquisition cancellation, never credentials/channels. */
export class NativeLndSource implements NativeHistorySource,NativePolicySource {
 readonly contract=NATIVE_POLICY_CONTRACT;
 #transport:NativeLndRead;#binding:NativeHistoryBinding;#chain:string;#closed=false;
 #active=new Set<AbortController>();
 #limits={bodyBytes:4*1024*1024,frameBytes:256*1024,streamBytes:32*1024*1024,frames:100000,idleMs:30000,requestMs:20000,streamMs:300000,concurrent:4};
 constructor(options:NativeLndSourceOptions){
  const methods=['getInfo','forwardingHistory','listPayments','getChanInfo','listChannels','subscribeHtlcEvents','subscribeChannelGraph'];
  if(!options.transport||methods.some(k=>typeof (options.transport as any)[k]!=='function')||Object.keys(options.transport).some(k=>!methods.includes(k)))fail('invalid_config');
  this.#transport=options.transport;this.#binding={nodeId:pub(options.nodeId),network:label(options.network),sourceVersion:label(options.sourceVersion),sourceInstance:label(options.sourceInstance)};this.#chain=label(options.chain);
  this.#limits={...this.#limits,...options.limits};
  const ceilings={bodyBytes:32*1024*1024,frameBytes:1024*1024,streamBytes:256*1024*1024,frames:1000000,idleMs:60000,requestMs:120000,streamMs:1200000,concurrent:4};
  for(const [key,value] of Object.entries(this.#limits))if(!Object.hasOwn(ceilings,key)||!Number.isSafeInteger(value)||value<1||value>ceilings[key as keyof typeof ceilings])fail('invalid_config');
 }
 shutdown():void{this.#closed=true;for(const controller of this.#active)controller.abort();}
 #bounds(stream=false):NativeReadLimits{return {deadlineMs:stream?this.#limits.streamMs:this.#limits.requestMs,bodyBytes:this.#limits.bodyBytes,frameBytes:this.#limits.frameBytes,streamBytes:this.#limits.streamBytes,frames:this.#limits.frames,idleMs:this.#limits.idleMs};}
 #error(e:unknown):NativeLndSourceError {
  if(e instanceof NativeLndSourceError)return e;
  if((e as any)?.code==='idle_timeout'||(e as any)?.code==='time_budget')return new NativeLndSourceError((e as any).code);
  const category=(e as any)?.category;
  const code:NativeSourceErrorCode=category==='resource_limit'?'size_limit':category==='deadline'?'time_budget':category==='cancelled'?(this.#closed?'shutdown':'cancelled'):category==='authentication'?'authentication':category==='permission_denied'?'permission_denied':category==='unavailable'?'unavailable':typeof category==='string'&&(category.startsWith('certificate_')||category==='endpoint_mismatch')?'certificate_error':'source_error';
  return new NativeLndSourceError(code);
 }
 async #operation<T>(fn:(signal:AbortSignal)=>Promise<T>,signal?:AbortSignal):Promise<T>{
  if(this.#closed)fail('shutdown');if(signal?.aborted)fail('cancelled');if(this.#active.size>=this.#limits.concurrent)fail('size_limit');
  const controller=new AbortController(),abort=()=>controller.abort();this.#active.add(controller);signal?.addEventListener('abort',abort,{once:true});
  try{return await fn(controller.signal);}catch(e){throw this.#error(e);}finally{controller.abort();this.#active.delete(controller);signal?.removeEventListener('abort',abort);}
 }
 async #bindingRead(signal:AbortSignal):Promise<NativeHistoryBinding>{
  if(this.#closed)fail('shutdown');if(signal.aborted)fail('cancelled');
  const info=object(await this.#transport.getInfo(signal,this.#bounds())),chains=info.chains;
  if(pub(info.identity_pubkey)!==this.#binding.nodeId||info.version!==this.#binding.sourceVersion||!Array.isArray(chains)||chains.length!==1||chains[0]?.chain!==this.#chain||chains[0]?.network!==this.#binding.network)fail('binding_mismatch');return {...this.#binding};
 }
 binding(signal?:AbortSignal):Promise<NativeHistoryBinding>{return this.#operation(s=>this.#bindingRead(s),signal);}
 #window(r:{startTime:string;endTime:string}){const start=uint(r.startTime,253402300799n),end=uint(r.endTime,253402300799n);if(BigInt(start)>BigInt(end))fail('invalid_request');return {start,end};}
 async forwardPage(r:ForwardPageRequest):Promise<unknown>{
  const w=this.#window(r),offset=uint(r.indexOffset,4294967295n);if(!Number.isSafeInteger(r.numMaxEvents)||r.numMaxEvents<1||r.numMaxEvents>1000)fail('invalid_request');
  return this.#operation(async signal=>{await this.#bindingRead(signal);const page=object(await this.#transport.forwardingHistory({start_time:w.start,end_time:w.end,index_offset:Number(offset),num_max_events:r.numMaxEvents},signal,this.#bounds()));await this.#bindingRead(signal);
   if(!Array.isArray(page.forwarding_events)||page.forwarding_events.length>r.numMaxEvents)fail('malformed_response');
   return {last_offset_index:page.last_offset_index,forwarding_events:page.forwarding_events.map((v:unknown)=>{const raw=object(v),clean=pick(raw,['timestamp','timestamp_ns','chan_id_in','chan_id_out','amt_in_msat','amt_out_msat','fee_msat','incoming_htlc_id','outgoing_htlc_id']);paymentEvidence.set(clean,{rawSourceChecksum:digest(raw),allowlistedChecksum:digest(clean),...this.#binding,allSettledRoutesToLocal:null,checksumScope:'raw_lnd_forward_response_record',rawAttemptChecksums:[]});return clean;})};
  });
 }
 async paymentPage(r:PaymentPageRequest):Promise<unknown>{
  const w=this.#window(r),offset=uint(r.indexOffset);if(w.start!=='0'&&w.end!=='0'&&BigInt(w.start)>=BigInt(w.end))fail('invalid_request');if(r.reversed!==true||r.includeIncomplete!==true||!Number.isSafeInteger(r.maxPayments)||r.maxPayments<1||r.maxPayments>1000)fail('invalid_request');
  return this.#operation(async signal=>{const b=await this.#bindingRead(signal),page=object(await this.#transport.listPayments({creation_date_start:w.start,creation_date_end:w.end,omit_hops:false,index_offset:offset,max_payments:String(r.maxPayments),reversed:true,include_incomplete:true},signal,this.#bounds()));await this.#bindingRead(signal);if(!Array.isArray(page.payments)||page.payments.length>r.maxPayments)fail('malformed_response');return {first_index_offset:page.first_index_offset,last_index_offset:page.last_index_offset,payments:page.payments.map((v:unknown)=>paymentRow(v,b))};});
 }
 async getChanInfo(channelId:string):Promise<unknown>{const id=uint(channelId);return this.#operation(async signal=>{const b=await this.#bindingRead(signal),r=object(await this.#transport.getChanInfo(id,signal,this.#bounds()));await this.#bindingRead(signal);if(uint(r.channel_id)!==id||(pub(r.node1_pub)===b.nodeId)===(pub(r.node2_pub)===b.nodeId))fail('binding_mismatch');const clean={channel_id:id,node1_pub:r.node1_pub,node2_pub:r.node2_pub,node1_policy:policy(r.node1_policy),node2_policy:policy(r.node2_policy)};boundEvidence.set(clean,{rawSourceChecksum:digest(r),allowlistedChecksum:digest(clean),binding:b,checksumScope:'raw_lnd_channel_info'});return clean;});}
 async listChannels():Promise<unknown>{return this.#operation(async signal=>{await this.#bindingRead(signal);const r=object(await this.#transport.listChannels(signal,this.#bounds()));await this.#bindingRead(signal);if(!Array.isArray(r.channels))fail('malformed_response');if(r.channels.length>1000)fail('size_limit');return {channels:r.channels.map((v:unknown)=>pick(object(v),['chan_id','active','private']))};});}
 #notify(fn:((...args:any[])=>void)|undefined,...args:any[]):void{if(!fn)return;let result:any;try{result=fn(...args);}catch{fail('callback_error');}if(result&&typeof result.then==='function'){void Promise.resolve(result).catch(()=>{});fail('callback_error');}}
 async #subscription(kind:'htlc'|'graph',callbacks:NativeStreamCallbacks,signal?:AbortSignal):Promise<NativeStreamReceipt>{
  const session=randomUUID();let b:NativeHistoryBinding,transportReady=false,subscribed=false,frames=0,filtered=0,reason:NativeStreamReceipt['reason']='eof';
  const origin=():NativeStreamOrigin=>({binding:{...b},session,observedAt:new Date().toISOString(),scope:'client_subscription_not_database_epoch'});
  try{await this.#operation(async boundedSignal=>{
   const fence=()=>{if(this.#closed)fail('shutdown');if(boundedSignal.aborted)fail('cancelled');};
   b=await this.#bindingRead(boundedSignal);let frameError:NativeLndSourceError|undefined;
   const ready=()=>{try{transportReady=true;if(kind==='graph')this.#notify(callbacks.onReady,{...origin(),kind:'transport_ready'});}catch(e){frameError=this.#error(e);throw e;}};
   const frame=async(raw:unknown)=>{try{
   await this.#bindingRead(boundedSignal);fence();frames++;const r=object(raw);
   if(kind==='htlc'){
    if(['subscribed_event','forward_event','link_fail_event','settle_event','forward_fail_event','final_htlc_event'].filter(k=>r[k]!=null).length!==1)fail('malformed_response');
    if(r.subscribed_event!==undefined&&r.subscribed_event!==null){if(subscribed||Object.keys(object(r.subscribed_event)).length||['forward_event','link_fail_event','settle_event','forward_fail_event','final_htlc_event'].some(k=>r[k]!=null))fail('malformed_response');subscribed=true;this.#notify(callbacks.onReady,{...origin(),kind:'subscribed'});return;}
    if(!subscribed)fail('not_subscribed');const record=(()=>{try{return decodeNativeForward(r);}catch{return fail('malformed_response');}})();if(!record){filtered++;return;}
    const clean=pick(r,['incoming_channel_id','outgoing_channel_id','incoming_htlc_id','outgoing_htlc_id','timestamp_ns','event_type']);
    const variant={forward:'forward_event',link_fail:'link_fail_event',settle:'settle_event',forward_fail:'forward_fail_event'}[record.variant],detail=object(r[variant]);clean[variant]=pick(detail,['wire_failure','failure_detail']);if(detail.info!=null)clean[variant].info=pick(object(detail.info),['incoming_timelock','outgoing_timelock','incoming_amt_msat','outgoing_amt_msat']);if(record.failureStringPresent)clean[variant].failure_string='present';boundEvidence.set(clean,{rawSourceChecksum:digest(r),allowlistedChecksum:digest(clean),binding:b,checksumScope:'raw_lnd_htlc_event'});this.#notify(callbacks.onEvent,clean,{...origin(),rawSourceChecksum:digest(r),allowlistedChecksum:digest(clean),checksumScope:'raw_lnd_htlc_event'});
   }else{
    if(r.channel_updates!==undefined&&!Array.isArray(r.channel_updates))fail('malformed_response');if((r.channel_updates?.length??0)>1000)fail('size_limit');
    for(const v of r.channel_updates??[]){fence();const update=object(v),local=update.advertising_node===b.nodeId||update.connecting_node===b.nodeId;if(!local){filtered++;continue;}if((pub(update.advertising_node)===b.nodeId)===(pub(update.connecting_node)===b.nodeId))fail('binding_mismatch');const clean=pick(update,['chan_id','advertising_node','connecting_node']);clean.routing_policy=policy(update.routing_policy);boundEvidence.set(clean,{rawSourceChecksum:digest(update),allowlistedChecksum:digest(clean),binding:b,checksumScope:'raw_lnd_graph_directional_update'});this.#notify(callbacks.onEvent,clean,{...origin(),rawSourceChecksum:digest(update),allowlistedChecksum:digest(clean),checksumScope:'raw_lnd_graph_directional_update'});fence();}
   }

   }catch(e){frameError=this.#error(e);throw e;}};
   try{await this.#transport[kind==='htlc'?'subscribeHtlcEvents':'subscribeChannelGraph'](frame,ready,boundedSignal,this.#bounds(true));}catch(e){throw frameError??e;}
   await this.#bindingRead(boundedSignal);
  },signal);}catch(e){reason=this.#error(e).code;}
  const receipt:NativeStreamReceipt={session,reason,transportReady,subscribed,nativeAckObserved:kind==='htlc'&&subscribed,frames,filtered,replayQualified:false,sourceHistoryComplete:false};try{this.#notify(callbacks.onClose,receipt);}catch{receipt.reason='callback_error';}return receipt;
 }
 subscribeHtlcEvents(callbacks:NativeStreamCallbacks,signal?:AbortSignal):Promise<NativeStreamReceipt>{return this.#subscription('htlc',callbacks,signal);}
 subscribeChannelGraph(callbacks:NativeStreamCallbacks,signal?:AbortSignal):Promise<NativeStreamReceipt>{return this.#subscription('graph',callbacks,signal);}
}
