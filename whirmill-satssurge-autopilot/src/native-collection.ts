import {randomUUID} from 'node:crypto';
import {CanonicalModel,digest} from './canonical-model.js';
import {LEGACY_TABLES,OriginalArchiveCapacityError} from './canonical-migration.js';
import {NativeHistoryCollector,type NativeHistorySource} from './native-history.js';
import {NativeHtlcCollector} from './native-htlc.js';
import {NativePolicyCollector,type NativePolicySource} from './native-policy.js';
import type {NativeStreamCallbacks,NativeStreamReceipt} from './native-lnd-source.js';
import type {Store} from './store.js';
export interface CollectionSource extends NativeHistorySource,NativePolicySource {
 listChannels():Promise<unknown>;
 subscribeHtlcEvents(callbacks:NativeStreamCallbacks,signal?:AbortSignal):Promise<NativeStreamReceipt>;
 subscribeChannelGraph(callbacks:NativeStreamCallbacks,signal?:AbortSignal):Promise<NativeStreamReceipt>;
 shutdown():void;
}
// Ordinary runtime archives include large retained state rows; generic migration/retention limits stay unchanged.
export const NATIVE_ARCHIVE_MAX_BYTES=4*1024*1024;
/** Bounded persisted windows survive restart; client instance labels never attest database epochs. */
export class NativeCollection {
 readonly model:CanonicalModel;readonly history:NativeHistoryCollector;readonly htlc:NativeHtlcCollector;readonly policy:NativePolicyCollector;
 private busy=false;
 constructor(readonly store:Store,readonly source:CollectionSource,readonly clock=()=>new Date().toISOString()){
  if(!store.canonical)throw Error('Canonical storage migration required');this.model=new CanonicalModel(store.db);this.history=new NativeHistoryCollector(this.model,source,clock);this.htlc=new NativeHtlcCollector(this.model);this.policy=new NativePolicyCollector(this.model,source,clock);
 }
 async tick(){
  if(this.busy)return;this.busy=true;
  try{
   // Archive one original table batch per tick, including every retained financial receipt.
   const index=this.store.get<number>('canonicalArchiveTable')??0,table=LEGACY_TABLES[index%LEGACY_TABLES.length]!,archiveAt=this.clock();
   let archiveReady=true;
   try{
    const page=this.store.canonical!.scan(table,{limit:200,maxBytes:NATIVE_ARCHIVE_MAX_BYTES,observedAt:archiveAt});
    this.store.set('canonicalArchiveTable',(index+1)%LEGACY_TABLES.length);
    this.store.set('canonicalArchiveProgress',{at:archiveAt,table,ok:true,...page,sourceHistoryComplete:false,sourceMutationTimeKnown:false});
   }catch(error){
    // Capacity holds this exact table/cursor; integrity and transaction failures still fail closed.
    if(!(error instanceof OriginalArchiveCapacityError))throw error;
    archiveReady=false;
    this.model.appendCoverage({nodeId:null,network:null,capability:'legacy_archive',scope:table,source:'legacy:'+table,epoch:randomUUID(),start:archiveAt,end:archiveAt,observedAt:archiveAt,status:'gap',details:{reason:'original_archive_byte_capacity',maxBytes:NATIVE_ARCHIVE_MAX_BYTES,cursorUnchanged:true,sourceHistoryComplete:false,sourceMutationTimeKnown:false,accountingAuthority:'none'}});
    this.store.set('canonicalArchiveProgress',{at:archiveAt,table,ok:false,error:'original_archive_byte_capacity',maxBytes:NATIVE_ARCHIVE_MAX_BYTES,cursorUnchanged:true,sourceHistoryComplete:false,sourceMutationTimeKnown:false});
   }
   const binding=await this.source.binding(),previous=this.store.get<any>('nativeAcquisitionBinding');
   if(previous&&digest(previous)!==digest(binding)){
    this.model.appendCoverage({...binding,capability:'native_acquisition',scope:'runtime_restart',source:'lnd.native',epoch:randomUUID(),start:this.clock(),end:this.clock(),observedAt:this.clock(),status:'gap',details:{reason:'client_binding_changed_resume_reopened',previousBindingDigest:digest(previous),sourceInstanceMeaning:'client_provenance_not_database_epoch',sourceHistoryComplete:false}});
    for(const kind of ['forwards','payments']){const window=this.store.get<any>('nativeWindow:'+kind);if(window&&!window.done)this.store.set('nativeWindow:'+kind,{...window,captureId:randomUUID()});}
    const refresh=this.store.get<any[]>('nativePaymentRefresh')??[];this.store.set('nativePaymentRefresh',refresh.map(w=>({...w,captureId:randomUUID()})));
   }
   this.store.set('nativeAcquisitionBinding',binding);
   for(const kind of ['forwards','payments'] as const){
    const key='nativeWindow:'+kind;let window=this.store.get<{captureId:string;startTime:string;endTime:string;done:boolean}>(key);
    if(!window||window.done){
     const end=BigInt(Math.floor(Date.parse(this.clock())/1000)-60),initial=BigInt(Math.floor(Date.parse(this.store.get<string>('historyStart')??this.store.get<string>('installedAt')??this.clock())/1000));
     const start=window?BigInt(window.endTime)+(kind==='payments'?1n:0n):initial;if(start>=end)continue;
     // Fixed one-hour windows bound subsequent work even on long histories.
     window={captureId:randomUUID(),startTime:String(start),endTime:String(start+3600n<end?start+3600n:end),done:false};this.store.set(key,window);
    }
    const result=await this.history.collect({...window,kind,pageSize:200,maxPages:1});
    if(result.error){this.store.set('nativeProgress:'+kind,{...result,at:this.clock(),accountingAuthority:'none'});throw Error('Native bounded history page failed');}
    if(result.pagesComplete){window.done=true;this.store.set(key,window);
     if(kind==='payments'&&this.store.one("SELECT 1 FROM canonical_observations WHERE kind='payment' AND json_extract(payload,'$.captureId')=? AND json_extract(payload,'$.status') NOT IN ('SUCCEEDED','FAILED') LIMIT 1",window.captureId)){
      const refresh=this.store.get<any[]>('nativePaymentRefresh')??[];
      if(refresh.length<32){refresh.push({startTime:window.startTime,endTime:window.endTime,captureId:randomUUID()});this.store.set('nativePaymentRefresh',refresh);}
      else this.model.appendCoverage({...binding,capability:'native_payment_refresh',scope:'pending_windows',source:'lnd.payments',epoch:window.captureId,start:this.clock(),end:this.clock(),observedAt:this.clock(),status:'gap',details:{reason:'bounded_refresh_capacity_exhausted',accountingAuthority:'none'}});
     }
    }
    this.store.set('nativeProgress:'+kind,{...result,at:this.clock(),accountingAuthority:'none'});
   }
   // Pending mutable outcomes get their own bounded durable refresh page; never replay effects.
   const refresh=this.store.get<{captureId:string;startTime:string;endTime:string}[]>('nativePaymentRefresh')??[];
   if(refresh.length){const pending=refresh[0]!,result=await this.history.collect({...pending,kind:'payments',pageSize:200,maxPages:1});
    if(result.error)throw Error('Native bounded pending refresh failed');
    if(result.pagesComplete){refresh.shift();if(this.store.one("SELECT 1 FROM canonical_observations WHERE kind='payment' AND json_extract(payload,'$.captureId')=? AND json_extract(payload,'$.status') NOT IN ('SUCCEEDED','FAILED') LIMIT 1",pending.captureId))refresh.push({...pending,captureId:randomUUID()});this.store.set('nativePaymentRefresh',refresh);}
   }
   // Round-robin policy batches; missing fields and both directions remain in the library receipts.
   const list=await this.source.listChannels() as {channels:{chan_id:string}[]};
   if(!Array.isArray(list.channels))throw Error('Native channel inventory unavailable');
   const cursor=this.store.get<number>('nativePolicyCursor')??0,channels=list.channels.slice(cursor,cursor+10).map(c=>String(c.chan_id));
   if(channels.length)await this.policy.snapshot({captureId:randomUUID(),channelIds:channels});
   this.store.set('nativePolicyCursor',cursor+10>=list.channels.length?0:cursor+10);
   this.store.set('nativeCollection',{at:this.clock(),ok:true,binding,legacyArchiveReady:archiveReady,sourceHistoryComplete:false,accountingAuthority:'none'});
  }catch{this.store.set('nativeCollection',{at:this.clock(),ok:false,sourceHistoryComplete:false,error:'Native acquisition unavailable; coverage remains unknown'});}finally{this.busy=false;}
 }
 async stream(signal:AbortSignal){
  const b=await this.source.binding(),epoch=randomUUID(),session=this.htlc.openEpoch(b,epoch,this.clock()),origin={binding:b,epoch,session};
  this.store.set('nativeStream',{at:this.clock(),phase:'awaiting_ack',acknowledged:false});
  await this.source.subscribeHtlcEvents({onReady:e=>{if(e.kind==='subscribed'){this.htlc.admitSubscribed({...origin,kind:'subscribed',at:e.observedAt});this.store.set('nativeStream',{at:e.observedAt,phase:'subscribed',acknowledged:true});}},onEvent:(e,o)=>{this.htlc.observe(e,o.observedAt,origin);this.store.set('nativeStream',{at:o.observedAt,phase:'subscribed',acknowledged:true});},onClose:r=>{this.store.set('nativeStream',{at:this.clock(),phase:'closed',acknowledged:r.subscribed});this.htlc.closeEpoch(signal.aborted?'shutdown':r.reason==='eof'?'disconnect':'source_error',this.clock(),origin);}},signal);
 }
 async graph(signal:AbortSignal){
  const b=await this.source.binding(),origin=this.policy.openEpoch(b,randomUUID(),this.clock());let index=0;
  await this.source.subscribeChannelGraph({onReady:e=>{this.policy.markReady(origin,e.observedAt);this.store.set('nativeGraph',{at:e.observedAt,phase:'transport_ready',transportReady:true,nativeAckObserved:false,durableEvents:0,replayQualified:false,sourceHistoryComplete:false});},onEvent:(e,o)=>{const receipt=this.policy.observeUpdate(e,origin,{observedAt:o.observedAt,receiptId:digest({session:o.session,index:index++})});const persisted=this.model.observation(receipt.observationId);if(!persisted||persisted.original_digest!==o.rawSourceChecksum)throw Error('Native graph durable provenance mismatch');this.store.set('nativeGraph',{at:o.observedAt,phase:'event_observed',transportReady:true,nativeAckObserved:false,durableEvents:index,lastObservationId:receipt.observationId,lastRawSourceChecksum:o.rawSourceChecksum,replayQualified:false,sourceHistoryComplete:false});},onClose:r=>{this.policy.closeEpoch(origin,this.clock(),signal.aborted?'shutdown':r.reason==='eof'?'disconnect':'source_error');this.store.set('nativeGraph',{...this.store.get<any>('nativeGraph'),at:this.clock(),phase:'closed',nativeAckObserved:false,reason:r.reason});}},signal);
 }

 shutdown(){this.source.shutdown();}
}
