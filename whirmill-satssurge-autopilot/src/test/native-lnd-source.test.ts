import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import * as grpc from '@grpc/grpc-js';
import {lndPackage,type NativeReadLimits} from '../lnd.js';
import {NativeLndSource,nativeRecordEvidence} from '../native-lnd-source.js';
import {decodeNativeForward} from '../native-htlc.js';
import {decodeRoutingPolicy} from '../native-policy.js';
import {digest,CanonicalModel} from '../canonical-model.js';
import {DatabaseSync} from 'node:sqlite';
import {migrateCanonical} from './native-canonical-fixture.js';
import {NativeHistoryCollector} from '../native-history.js';
import {nativeGrpcFixture,nativeCertificate,identity} from './native-grpc-fixture.js';
const peer='03'+'22'.repeat(32),big='9007199254740993',max='18446744073709551615';
const binding={nodeId:identity,network:'mainnet',sourceVersion:'0.21.3-beta',sourceInstance:'runtime-1'};
const info={identity_pubkey:identity,version:binding.sourceVersion,chains:[{chain:'bitcoin',network:'mainnet'}]};
const getInfo=(_c:any,cb:any)=>cb(null,info);
const forwardRequest={startTime:'100',endTime:'200',indexOffset:'0',numMaxEvents:2};
const paymentRequest={startTime:'100',endTime:'201',indexOffset:'0',maxPayments:2,reversed:true as const,includeIncomplete:true as const};
const policy={fee_base_msat:'0',fee_rate_milli_msat:'0',min_htlc:'0',max_htlc_msat:max,inbound_fee_base_msat:-2147483648,inbound_fee_rate_milli_msat:-1};
const htlc={incoming_channel_id:big,outgoing_channel_id:max,incoming_htlc_id:'0',outgoing_htlc_id:'0',timestamp_ns:'150000000001',event_type:'FORWARD',forward_event:{info:{incoming_amt_msat:big,outgoing_amt_msat:big}}};
function source(f:Awaited<ReturnType<typeof nativeGrpcFixture>>,limits:any={}){return new NativeLndSource({transport:f.client.nativeRead(),...binding,chain:'bitcoin',limits:{idleMs:1000,requestMs:1000,streamMs:2000,...limits}});}
const bounds:NativeReadLimits={deadlineMs:1000,bodyBytes:1000000,frameBytes:1000000,streamBytes:1000000,frames:20,idleMs:1000};
function codec(service:'Lightning'|'Router',method:string,row:unknown){const c=(service==='Lightning'?lndPackage.lnrpc.Lightning:lndPackage.routerrpc.Router).service[method];return c.responseDeserialize(c.responseSerialize(row));}

test('local stream closure cancels its held frame binding without changing prior failure or epoch',async t=>{
 for(const prior of [false,true])for(const kind of ['idle','budget','abort','shutdown'])await t.test(`${kind} prior=${prior}`,async()=>{
  let seed=prior,reads=0,hold=true,reply!:()=>void,entered!:()=>void;const started=new Promise<void>(r=>entered=r);
  const f=await nativeGrpcFixture({getInfo:(_c:any,cb:any)=>{if(seed){seed=false;cb({code:grpc.status.PERMISSION_DENIED});}else if(++reads===1||!hold)cb(null,info);else{reply=()=>cb(null,info);entered();}},walletBalance:(_c:any,cb:any)=>cb(null,{}),listChannels:(_c:any,cb:any)=>cb(null,{})},{subscribeHtlcEvents:(c:any)=>c.write({subscribed_event:{}})});
  const s=source(f,{idleMs:kind==='idle'?150:1000,streamMs:kind==='budget'?200:1000}),controller=new AbortController(),events:unknown[]=[];
  try{
   if(prior)await assert.rejects(f.client.nativeRead().getInfo(new AbortController().signal,bounds),/permission_denied/);
   const epoch=(f.client as any).failureEpoch,recover=f.client.beginCollection(),pending=s.subscribeHtlcEvents({onEvent:e=>events.push(e)},controller.signal);
   await started;assert.equal(f.client.transportStatus().activeCalls,2);if(kind==='abort')controller.abort();else if(kind==='shutdown')s.shutdown();
   const r=await pending;assert.equal(r.reason,kind==='idle'?'idle_timeout':kind==='budget'?'time_budget':kind==='shutdown'?'shutdown':'cancelled');assert.equal(r.frames,0);assert.equal(r.nativeAckObserved,false);assert.equal(r.subscribed,false);assert.equal(r.replayQualified,false);assert.equal(r.sourceHistoryComplete,false);assert.equal(f.client.transportStatus().activeCalls,0);assert.equal(f.client.transportStatus().failure,prior?'permission_denied':undefined);assert.equal((f.client as any).failureEpoch,epoch);
   hold=false;reply();await new Promise(r=>setTimeout(r,10));assert.deepEqual(events,[]);await f.client.snapshot();assert.equal(f.client.transportStatus().failure,prior?'permission_denied':undefined);recover();assert.equal(f.client.transportStatus().failure,undefined);
  }finally{s.shutdown();f.close();}
 });
});

test('independent binding aborts and unary deadlines remain latched',async t=>{
 for(const kind of ['ownerAbort','sourceShutdown','deadline'])await t.test(kind,async()=>{
  let entered!:()=>void;const started=new Promise<void>(r=>entered=r),f=await nativeGrpcFixture({getInfo:()=>entered()});const s=source(f,{requestMs:kind==='deadline'?80:1000}),controller=new AbortController();
  try{const pending=assert.rejects(s.binding(controller.signal),new RegExp(kind==='deadline'?'time_budget':kind==='sourceShutdown'?'shutdown':'cancelled'));await started;if(kind==='ownerAbort')controller.abort();else if(kind==='sourceShutdown')s.shutdown();await pending;assert.equal(f.client.transportStatus().failure,kind==='deadline'?'deadline':'cancelled');assert.equal((f.client as any).failureEpoch,1);assert.equal(f.client.transportStatus().activeCalls,0);}finally{s.shutdown();f.close();}
 });
});

test('stream binding cleanup does not exempt an independent unary sharing the owner abort signal',async()=>{
 let reads=0,hold=true,frameEntered!:()=>void,otherEntered!:()=>void;const frameStarted=new Promise<void>(r=>frameEntered=r),otherStarted=new Promise<void>(r=>otherEntered=r);
 const f=await nativeGrpcFixture({getInfo:(_c:any,cb:any)=>{if(++reads===1||!hold)cb(null,info);else if(reads===2)frameEntered();else otherEntered();},walletBalance:(_c:any,cb:any)=>cb(null,{}),listChannels:(_c:any,cb:any)=>cb(null,{})},{subscribeHtlcEvents:(c:any)=>c.write({subscribed_event:{}})}),s=source(f),owner=new AbortController();
 try{
  const stale=f.client.beginCollection(),stream=s.subscribeHtlcEvents({onEvent:()=>assert.fail('cancelled frame admitted')},owner.signal);await frameStarted;
  const independent=assert.rejects(f.client.nativeRead().getInfo(owner.signal,bounds),/cancelled/);await otherStarted;assert.equal(f.client.transportStatus().activeCalls,3);owner.abort();assert.equal((await stream).reason,'cancelled');await independent;assert.equal(f.client.transportStatus().failure,'cancelled');assert.equal((f.client as any).failureEpoch,1);assert.equal(f.client.transportStatus().activeCalls,0);
  hold=false;await f.client.snapshot();stale();assert.equal(f.client.transportStatus().failure,'cancelled');const recover=f.client.beginCollection();await f.client.snapshot();recover();assert.equal(f.client.transportStatus().failure,undefined);
 }finally{s.shutdown();f.close();}
});

test('remote errors in a stream frame binding remain latched and invalidate stale recovery epochs',async t=>{
 for(const [failure,code] of Object.entries({cancelled:grpc.status.CANCELLED,deadline:grpc.status.DEADLINE_EXCEEDED,authentication:grpc.status.UNAUTHENTICATED,permission_denied:grpc.status.PERMISSION_DENIED,unavailable:grpc.status.UNAVAILABLE,resource_limit:grpc.status.RESOURCE_EXHAUSTED,rpc_failure:grpc.status.UNKNOWN}))await t.test(failure,async()=>{
  let reads=0,fail=true;const f=await nativeGrpcFixture({getInfo:(_c:any,cb:any)=>++reads===1||!fail?cb(null,info):cb({code,details:'private binding diagnostics'}),walletBalance:(_c:any,cb:any)=>cb(null,{}),listChannels:(_c:any,cb:any)=>cb(null,{})},{subscribeHtlcEvents:(c:any)=>c.write({subscribed_event:{}})});const s=source(f);
  try{const stale=f.client.beginCollection(),r=await s.subscribeHtlcEvents({onEvent:()=>assert.fail('failed binding admitted an event')});assert.equal(r.frames,0);assert.equal(r.sourceHistoryComplete,false);assert.equal(f.client.transportStatus().failure,failure);assert.equal(f.client.transportStatus().failureContext?.method,'getInfo');assert.equal(f.client.transportStatus().failureContext?.grpcStatus,code);assert.equal(f.client.transportStatus().failureContext?.origin,'rpc');assert.ok(!JSON.stringify(f.client.transportStatus()).includes('private binding diagnostics'));assert.ok((f.client as any).failureEpoch>0);assert.equal(f.client.transportStatus().activeCalls,0);fail=false;await f.client.snapshot();stale();assert.equal(f.client.transportStatus().failure,failure);const recover=f.client.beginCollection();await f.client.snapshot();recover();assert.equal(f.client.transportStatus().failure,undefined);}finally{s.shutdown();f.close();}
 });
});

test('planned source stream boundaries retain exact incomplete receipts without a transport failure',async t=>{
 for(const kind of ['idle','budget','abort','shutdown','lndClose'])await t.test(kind,async()=>{
  const f=await nativeGrpcFixture({getInfo},{subscribeHtlcEvents:(c:any)=>c.write({subscribed_event:{}})});
  try{
   const s=source(f,{idleMs:kind==='idle'?80:1000,streamMs:kind==='budget'?120:1000}),controller=new AbortController();let entered!:()=>void;const ready=new Promise<void>(r=>entered=r);
   const pending=s.subscribeHtlcEvents({onReady:()=>entered(),onEvent:()=>assert.fail('ACK must not become an event')},controller.signal);
   if(kind==='abort'||kind==='shutdown'||kind==='lndClose'){await ready;if(kind==='abort')controller.abort();else if(kind==='shutdown')s.shutdown();else f.client.close();}
   const r=await pending;assert.equal(r.reason,kind==='idle'?'idle_timeout':kind==='budget'?'time_budget':kind==='shutdown'?'shutdown':'cancelled');assert.equal(r.nativeAckObserved,true);assert.equal(r.subscribed,true);assert.equal(r.transportReady,true);assert.equal(r.frames,1);assert.equal(r.filtered,0);assert.equal(r.replayQualified,false);assert.equal(r.sourceHistoryComplete,false);assert.equal(f.client.transportStatus().failure,undefined);assert.equal(f.client.transportStatus().activeCalls,0);s.shutdown();
  }finally{f.close();}
 });
});

test('malformed binding and callback failures remain transport failures with retained source gap reasons',async t=>{
 for(const kind of ['malformed','binding','callback','overflow'])await t.test(kind,async()=>{
  let reads=0;const f=await nativeGrpcFixture({getInfo:(_c:any,cb:any)=>cb(null,kind==='binding'&&++reads>1?{...info,identity_pubkey:peer}:info)},{subscribeHtlcEvents:(c:any)=>{c.write({subscribed_event:{}});c.write(kind==='malformed'?{...htlc,settle_event:{preimage:Buffer.alloc(32)}}:htlc);}});
  try{const s=source(f,kind==='overflow'?{frames:1}:{}),r=await s.subscribeHtlcEvents({onEvent:()=>{if(kind==='callback')throw Error('private fixture callback');}});assert.equal(r.reason,kind==='malformed'?'malformed_response':kind==='binding'?'binding_mismatch':kind==='callback'?'callback_error':'size_limit');assert.equal(f.client.transportStatus().failure,kind==='overflow'?'resource_limit':'acquisition_failure');assert.equal(f.client.transportStatus().failureContext?.method,'subscribeHtlcEvents');assert.equal(f.client.transportStatus().failureContext?.origin,'local_acquisition');if(kind!=='overflow')assert.equal(f.client.transportStatus().failureContext?.reason,r.reason);assert.ok(!JSON.stringify(f.client.transportStatus()).includes('private fixture callback'));assert.equal(r.sourceHistoryComplete,false);assert.equal(r.replayQualified,false);assert.equal(f.client.transportStatus().activeCalls,0);s.shutdown();}finally{f.close();}
 });
});

test('closed native capability exposes only exact read RPCs and rejects unbounded or extra request fields',async()=>{
 const f=await nativeGrpcFixture({getInfo});try{const cap=f.client.nativeRead();assert.equal(Object.isFrozen(cap),true);assert.deepEqual(Object.keys(cap).sort(),['forwardingHistory','getChanInfo','getInfo','listChannels','listPayments','subscribeChannelGraph','subscribeHtlcEvents'].sort());for(const name of ['sendPaymentV2','addInvoice','updateChannelPolicy','unary','stream','request'])assert.equal((cap as any)[name],undefined);
 assert.throws(()=>cap.forwardingHistory({start_time:'0',end_time:'1',index_offset:0,num_max_events:0},new AbortController().signal,bounds),/resource_limit/);
 assert.throws(()=>cap.forwardingHistory({start_time:'0',end_time:'1',index_offset:0,num_max_events:1,endpoint:'secret'} as any,new AbortController().signal,bounds),/resource_limit/);assert.equal(f.seen.length,0);
 assert.throws(()=>new NativeLndSource({transport:{...cap,sendPaymentV2:()=>{}} as any,...binding,chain:'bitcoin'}),/invalid_config/);
 }finally{f.close();}
});

test('real proto codec distinguishes optional presence and oneofs from valid scalar zero',()=>{
 const raw=codec('Lightning','ForwardingHistory',{forwarding_events:[{timestamp_ns:'150000000001',chan_id_in:big,chan_id_out:max,incoming_htlc_id:'0'}]});assert.equal(raw.forwarding_events[0].incoming_htlc_id,'0');assert.equal(raw.forwarding_events[0].outgoing_htlc_id,undefined);assert.equal(raw.forwarding_events[0].fee_msat,'0');
 const ack=codec('Router','SubscribeHtlcEvents',{subscribed_event:{}});assert.deepEqual(ack.subscribed_event,{});assert.equal(ack.forward_event,undefined);assert.equal(ack.incoming_htlc_id,'0');
 const decoded=decodeNativeForward(codec('Router','SubscribeHtlcEvents',htlc))!;assert.equal(decoded.incomingHtlcId,'0');assert.equal(decoded.outgoingHtlcId,'0');assert.equal(decoded.incomingTimelock,'0');assert.equal(decoded.incomingMsat,big);assert.equal(decoded.timestampNs,'150000000001');
 const p=decodeRoutingPolicy(codec('Lightning','GetChanInfo',{node1_policy:policy}).node1_policy);assert.deepEqual(p.missingFields,[]);assert.equal(p.policy!.inboundFeeBaseMsat,'-2147483648');assert.equal(p.policy!.inboundFeeRatePpm,'-1');
});

test('bound unary pages preserve ns/msat precision, optional circuit zeros, raw decoded checksums and secret allowlist',async()=>{
 const payment={payment_index:big,payment_hash:'a'.repeat(64),status:'SUCCEEDED',creation_time_ns:'150000000001',value_msat:big,fee_msat:'0',payment_preimage:'fixture-preimage',payment_request:'fixture-secret-request',htlcs:[{attempt_id:'0',status:'SUCCEEDED',attempt_time_ns:'150000000001',resolve_time_ns:'150000000999',preimage:Buffer.alloc(32,7),route:{total_amt_msat:big,total_fees_msat:'0',hops:[{chan_id:big,pub_key:peer,custom_records:{'65536':Buffer.from('fixture-custom')}},{chan_id:max,pub_key:identity,amt_to_forward_msat:big}]}}]};
 const rawForward={timestamp:'150',timestamp_ns:'150000000001',chan_id_in:big,chan_id_out:max,amt_in_msat:big,amt_out_msat:big,incoming_htlc_id:'0',outgoing_htlc_id:'0'};
 const f=await nativeGrpcFixture({getInfo,forwardingHistory:(_c:any,cb:any)=>cb(null,{forwarding_events:[rawForward],last_offset_index:1}),listPayments:(_c:any,cb:any)=>cb(null,{payments:[payment],first_index_offset:big,last_index_offset:big}),getChanInfo:(_c:any,cb:any)=>cb(null,{channel_id:big,node1_pub:identity,node2_pub:peer,node1_policy:policy,node2_policy:policy}),listChannels:(_c:any,cb:any)=>cb(null,{channels:[{chan_id:big}]})});
 try{const s=source(f),fp:any=await s.forwardPage(forwardRequest),pp:any=await s.paymentPage(paymentRequest),p=pp.payments[0];assert.equal(p.value_msat,big);assert.equal(fp.forwarding_events[0].incoming_htlc_id,'0');assert.equal(nativeRecordEvidence(fp.forwarding_events[0],binding)?.rawSourceChecksum,digest(codec('Lightning','ForwardingHistory',{forwarding_events:[rawForward]}).forwarding_events[0]));
 const proof=nativeRecordEvidence(p,binding)!;assert.equal(proof.rawSourceChecksum,digest(codec('Lightning','ListPayments',{payments:[payment]}).payments[0]));assert.equal(proof.allSettledRoutesToLocal,true);assert.equal(proof.rawAttemptChecksums.length,1);assert.equal(nativeRecordEvidence({...p},binding),null);assert.equal(nativeRecordEvidence(p,{...binding,sourceInstance:'other'}),null);
 const text=JSON.stringify(pp);for(const secret of ['fixture-preimage','fixture-secret-request','fixture-custom','pub_key','custom_records','preimage','payment_request'])assert.equal(text.includes(secret),false,secret);
 assert.equal((await s.getChanInfo(big) as any).node1_policy.inbound_fee_base_msat,-2147483648);assert.equal((await s.listChannels() as any).channels[0].active,false);
 assert.equal(f.seen.filter(v=>v.method==='getInfo').length,8);assert.equal(f.seen.find(v=>v.method==='listPayments')!.request.creation_date_end,'201');assert.ok(f.seen.every(v=>v.token==='010203'));
 p.value_msat='1';assert.equal(nativeRecordEvidence(p,binding),null);s.shutdown();assert.equal(f.client.transportStatus().activeCalls,0);
 }finally{f.close();}
});

test('native empty decoded pages retain zero offsets without claiming source completeness',async()=>{
 const f=await nativeGrpcFixture({getInfo,forwardingHistory:(_c:any,cb:any)=>cb(null,{}),listPayments:(_c:any,cb:any)=>cb(null,{})});try{const s=source(f);assert.deepEqual(await s.forwardPage(forwardRequest),{last_offset_index:0,forwarding_events:[]});assert.deepEqual(await s.paymentPage(paymentRequest),{first_index_offset:'0',last_index_offset:'0',payments:[]});s.shutdown();}finally{f.close();}
});

test('binding is checked before and after acquisition, including network/version/identity drift',async t=>{
 for(const field of ['identity','network','version'])await t.test(field,async()=>{let reads=0;const f=await nativeGrpcFixture({getInfo:(_c:any,cb:any)=>{reads++;cb(null,reads===1?info:field==='identity'?{...info,identity_pubkey:peer}:field==='version'?{...info,version:'changed'}:{...info,chains:[{chain:'bitcoin',network:'testnet'}]});},forwardingHistory:(_c:any,cb:any)=>cb(null,{})});try{const s=source(f);await assert.rejects(s.forwardPage(forwardRequest),/binding_mismatch/);assert.equal(f.client.transportStatus().activeCalls,0);s.shutdown();}finally{f.close();}});
});

test('HTLC requires actual ACK and excludes SEND secrets while preserving forward zero timelocks',async()=>{
 const f=await nativeGrpcFixture({getInfo},{subscribeHtlcEvents:(c:any)=>{c.write({subscribed_event:{}});c.write({event_type:'SEND',settle_event:{preimage:Buffer.alloc(32,7)}});c.write(htlc);c.end();}});
 try{const s=source(f),events:any[]=[],origins:any[]=[],ready:any[]=[];const receipt=await s.subscribeHtlcEvents({onReady:o=>{ready.push(o);},onEvent:(e,o)=>{events.push(e);origins.push(o);}});assert.equal(receipt.reason,'eof');assert.equal(receipt.nativeAckObserved,true);assert.equal(receipt.subscribed,true);assert.equal(receipt.filtered,1);assert.equal(receipt.frames,3);assert.equal(ready[0].kind,'subscribed');assert.equal(events.length,1);assert.equal(events[0].forward_event.info.incoming_timelock,0);assert.equal(origins[0].rawSourceChecksum,digest(codec('Router','SubscribeHtlcEvents',htlc)));assert.equal(receipt.sourceHistoryComplete,false);assert.equal(receipt.replayQualified,false);assert.equal(f.client.transportStatus().activeCalls,0);s.shutdown();}finally{f.close();}
});

test('missing ACK, ambiguous oneof, missing nested info and source drift fail closed',async t=>{
 for(const [name,event] of Object.entries({missingAck:htlc,ambiguous:{...htlc,settle_event:{preimage:Buffer.alloc(32)}},missingInfo:{...htlc,forward_event:{}}}))await t.test(name,async()=>{const f=await nativeGrpcFixture({getInfo},{subscribeHtlcEvents:(c:any)=>{if(name!=='missingAck')c.write({subscribed_event:{}});c.write(event);c.end();}});try{const s=source(f),events:any[]=[];const r=await s.subscribeHtlcEvents({onEvent:e=>{events.push(e);}});assert.equal(r.reason,name==='missingAck'?'not_subscribed':'malformed_response');assert.deepEqual(events,[]);assert.equal(f.client.transportStatus().activeCalls,0);s.shutdown();}finally{f.close();}});
});

test('Graph captures only local directional updates and transport readiness never becomes native ACK',async()=>{
 const update={chan_id:big,advertising_node:identity,connecting_node:peer,routing_policy:policy};const f=await nativeGrpcFixture({getInfo,subscribeChannelGraph:(c:any)=>{c.write({channel_updates:[{...update,advertising_node:peer,connecting_node:'03'+'33'.repeat(32)},update]});c.end();}});
 try{const s=source(f),events:any[]=[],ready:any[]=[];const r=await s.subscribeChannelGraph({onReady:o=>{ready.push(o);},onEvent:e=>{events.push(e);}});assert.equal(r.reason,'eof');assert.equal(r.transportReady,true);assert.equal(r.nativeAckObserved,false);assert.equal(r.subscribed,false);assert.equal(r.filtered,1);assert.equal(events.length,1);assert.equal(events[0].routing_policy.inbound_fee_rate_milli_msat,-1);assert.equal(ready[0].kind,'transport_ready');s.shutdown();}finally{f.close();}
});

test('stream callback exceptions and async callbacks close with a safe callback_error receipt',async t=>{
 for(const callback of [()=>{throw Error('private-secret');},async()=>{throw Error('private-secret');}])await t.test('callback',async()=>{const f=await nativeGrpcFixture({getInfo},{subscribeHtlcEvents:(c:any)=>{c.write({subscribed_event:{}});c.write(htlc);}});try{const s=source(f);const r=await s.subscribeHtlcEvents({onEvent:callback});assert.equal(r.reason,'callback_error');assert.equal(JSON.stringify(r).includes('private-secret'),false);assert.equal(f.client.transportStatus().activeCalls,0);s.shutdown();}finally{f.close();}});
});

test('frame/count/aggregate byte bounds abort streams and release shared leases',async t=>{
 for(const [name,limits] of Object.entries({frame:{frameBytes:30},count:{frames:1},total:{streamBytes:400}}))await t.test(name,async()=>{const f=await nativeGrpcFixture({getInfo},{subscribeHtlcEvents:(c:any)=>{c.write({subscribed_event:{}});c.write(htlc);c.write(htlc);}});try{const s=source(f,limits),r=await s.subscribeHtlcEvents({onEvent:()=>{}});assert.equal(r.reason,'size_limit');assert.equal(f.client.transportStatus().activeCalls,0);s.shutdown();}finally{f.close();}});
});

test('deadline/auth/permission/server failures expose closed categories without service payloads',async t=>{
 for(const [name,code] of Object.entries({authentication:grpc.status.UNAUTHENTICATED,permission_denied:grpc.status.PERMISSION_DENIED,unavailable:grpc.status.UNAVAILABLE,source_error:grpc.status.UNKNOWN}))await t.test(name,async()=>{const f=await nativeGrpcFixture({getInfo:(_c:any,cb:any)=>cb({code,details:'private-secret-macaroon'})});try{const s=source(f);await assert.rejects(s.binding(),e=>String(e).includes(name)&&!String(e).includes('private-secret'));assert.equal(f.client.transportStatus().activeCalls,0);s.shutdown();}finally{f.close();}});
 const f=await nativeGrpcFixture({getInfo},{subscribeHtlcEvents:()=>{}});try{const s=source(f,{streamMs:80,idleMs:1000}),r=await s.subscribeHtlcEvents({onEvent:()=>{}});assert.equal(r.reason,'time_budget');assert.equal(f.client.transportStatus().activeCalls,0);s.shutdown();}finally{f.close();}
});

test('source cancellation/shutdown and Lnd.close settle streams and unary work without retained channels',async t=>{
 for(const kind of ['abort','shutdown','lndClose'])await t.test(kind,async()=>{let entered!:()=>void;const started=new Promise<void>(r=>entered=r);const f=await nativeGrpcFixture({getInfo},{subscribeHtlcEvents:(c:any)=>{c.sendMetadata(new grpc.Metadata());entered();}});try{const s=source(f),controller=new AbortController(),p=s.subscribeHtlcEvents({onEvent:()=>{}},controller.signal);await started;if(kind==='abort')controller.abort();else if(kind==='shutdown')s.shutdown();else f.client.close();const r=await p;assert.equal(r.reason,kind==='shutdown'?'shutdown':'cancelled');assert.equal(f.client.transportStatus().activeCalls,0);if(kind==='lndClose')assert.equal(f.client.transportStatus().activeChannels,0);s.shutdown();}finally{f.close();}});
 let entered!:()=>void;const started=new Promise<void>(r=>entered=r),f=await nativeGrpcFixture({getInfo:()=>entered()});try{const s=source(f),p=s.binding();await started;s.shutdown();await assert.rejects(p,/shutdown/);assert.equal(f.client.transportStatus().activeCalls,0);}finally{f.close();}
});

test('source concurrency admission spans entire acquisition and does not consume another lease',async()=>{
 let entered!:()=>void;const started=new Promise<void>(r=>entered=r),f=await nativeGrpcFixture({getInfo:()=>entered()});try{const s=source(f,{concurrent:1}),p=s.binding();await started;await assert.rejects(s.binding(),/size_limit/);assert.equal(f.client.transportStatus().activeCalls,1);s.shutdown();await assert.rejects(p,/shutdown/);assert.equal(f.client.transportStatus().activeCalls,0);}finally{f.close();}
});

test('certificate reload preserves old subscription while new bound acquisition uses the renewed generation',async()=>{
 let entered!:()=>void;const started=new Promise<void>(r=>entered=r),f=await nativeGrpcFixture({getInfo,listChannels:(_c:any,cb:any)=>cb(null,{})},{subscribeHtlcEvents:(c:any)=>{c.write({subscribed_event:{}});entered();}});
 try{const s=source(f),controller=new AbortController(),p=s.subscribeHtlcEvents({onEvent:()=>{}},controller.signal);await started;const oldDigest=f.client.transportStatus().certificateDigest,next=nativeCertificate(f.dir,'renewed');f.rotate(next);writeFileSync(f.ca,next.cert);await s.listChannels();assert.notEqual(f.client.transportStatus().certificateDigest,oldDigest);assert.equal(f.client.transportStatus().activeChannels,2);controller.abort();assert.equal((await p).reason,'cancelled');assert.equal(f.client.transportStatus().activeCalls,0);assert.equal(f.client.transportStatus().activeChannels,1);s.shutdown();}finally{f.close();}
});

function modelFixture(){const db=new DatabaseSync(':memory:');db.exec('PRAGMA user_version=6');migrateCanonical(db);return {db,model:new CanonicalModel(db)};}
test('real codec inclusive second windows preserve exact ns boundaries and complete full-page continuation without source-coverage promotion',async()=>{
 const event=(ns:string)=>({timestamp_ns:ns,chan_id_in:'1',chan_id_out:'2',amt_in_msat:'1001',amt_out_msat:'1000',fee_msat:'1',incoming_htlc_id:'0',outgoing_htlc_id:'0'});
 const f=await nativeGrpcFixture({getInfo,forwardingHistory:(c:any,cb:any)=>cb(null,c.request.index_offset===0?{forwarding_events:[event('100000000000'),event('200000000000')],last_offset_index:2}:{forwarding_events:[],last_offset_index:2})}),m=modelFixture();
 try{const s=source(f),collector=new NativeHistoryCollector(m.model,s),r={captureId:'boundary-forwards',kind:'forwards' as const,startTime:'100',endTime:'200',pageSize:2,maxPages:1};
 const first=await collector.collect(r);assert.equal(first.error,undefined);assert.equal(first.pagesComplete,false);assert.equal(first.nextOffset,'2');const second=await collector.collect(r);assert.equal(second.pagesComplete,true);assert.equal(second.sourceHistoryComplete,false);
 const rows=m.db.prepare('SELECT * FROM canonical_observations').all() as any[];assert.deepEqual(rows.map(v=>v.timestamp_ns),['100000000000','200000000000']);assert.equal(rows[1].occurred_at,'1970-01-01T00:03:20.000Z');assert.ok(rows.every(v=>JSON.parse(v.payload).financialQualified===false));assert.equal(f.seen.filter(v=>v.method==='forwardingHistory')[1]!.request.index_offset,2);s.shutdown();
 }finally{m.db.close();f.close();}
});
test('real codec reversed payment continuation retains pending outcomes, zero attempt IDs and inclusive fixed consumer window',async()=>{
 const payment=(index:string,ns:string,status:string)=>({payment_index:index,payment_hash:'a'.repeat(64),creation_time_ns:ns,status,value_msat:'1000',fee_msat:'0',htlcs:[{attempt_id:'0',status:'IN_FLIGHT',attempt_time_ns:ns}]});
 const f=await nativeGrpcFixture({getInfo,listPayments:(c:any,cb:any)=>cb(null,c.request.index_offset==='0'?{payments:[payment('2','201999999999','IN_FLIGHT'),payment('1','100000000000','FAILED')],first_index_offset:'1',last_index_offset:'2'}:{})}),m=modelFixture();
 try{const s=source(f),collector=new NativeHistoryCollector(m.model,s),r={captureId:'boundary-payments',kind:'payments' as const,startTime:'100',endTime:'201',pageSize:2,maxPages:1};const first=await collector.collect(r);assert.equal(first.error,undefined);assert.equal(first.pagesComplete,false);assert.equal(first.nextOffset,'1');const second=await collector.collect(r);assert.equal(second.pagesComplete,true);assert.equal(second.sourceHistoryComplete,false);
 const rows=m.db.prepare("SELECT * FROM canonical_observations WHERE kind='payment'").all() as any[];assert.equal(rows.length,2);assert.ok(rows.every(v=>v.fee_msat===null&&JSON.parse(v.payload).costAuthority==='unknown'));assert.equal(rows[0].timestamp_ns,'201999999999');const requests=f.seen.filter(v=>v.method==='listPayments');assert.deepEqual(requests.map(v=>v.request.index_offset),['0','1']);assert.ok(requests.every(v=>v.request.creation_date_end==='201'&&v.request.include_incomplete===true));s.shutdown();
 }finally{m.db.close();f.close();}
});
test('real-codec window violation and mutable forward offset stall preserve the prior checkpoint and explicit gap',async()=>{
 let phase='first';const row={timestamp_ns:'150000000001',chan_id_in:'1',chan_id_out:'2',amt_in_msat:'1',amt_out_msat:'1',fee_msat:'0'};
 const f=await nativeGrpcFixture({getInfo,forwardingHistory:(_c:any,cb:any)=>cb(null,phase==='first'?{forwarding_events:[row],last_offset_index:1}:phase==='outside'?{forwarding_events:[{...row,timestamp_ns:'200000000001'}],last_offset_index:1}:{forwarding_events:[row],last_offset_index:1})}),m=modelFixture();
 try{const s=source(f),collector=new NativeHistoryCollector(m.model,s),r={captureId:'mutable-forwards',kind:'forwards' as const,startTime:'100',endTime:'200',pageSize:1,maxPages:1},first=await collector.collect(r);phase='stalled';const stalled=await collector.collect(r);assert.equal(stalled.error,'malformed_page');assert.equal(stalled.checkpointId,first.checkpointId);assert.equal(stalled.nextOffset,'1');phase='outside';const outside=await collector.collect({...r,captureId:'outside'});assert.equal(outside.error,'malformed_page');assert.equal(outside.checkpointId,null);assert.equal(m.db.prepare('SELECT count(*) n FROM canonical_observations').get()!.n,1);assert.equal(m.db.prepare("SELECT count(*) n FROM canonical_coverage WHERE status='gap'").get()!.n,2);s.shutdown();
 }finally{m.db.close();f.close();}
});
test('idle stream and unary response byte limits are closed incomplete failures',async()=>{
 const f=await nativeGrpcFixture({getInfo},{subscribeHtlcEvents:(c:any)=>c.sendMetadata(new grpc.Metadata())});try{const s=source(f,{idleMs:30,streamMs:1000}),r=await s.subscribeHtlcEvents({onEvent:()=>{}});assert.equal(r.reason,'idle_timeout');assert.equal(r.sourceHistoryComplete,false);assert.equal(f.client.transportStatus().activeCalls,0);s.shutdown();const tiny=source(f,{bodyBytes:20});await assert.rejects(tiny.binding(),/size_limit/);tiny.shutdown();assert.equal(f.client.transportStatus().activeCalls,0);}finally{f.close();}
});

test('empty stream EOF and invalid channel messages never fabricate ACK, identity or source completeness',async()=>{
 const f=await nativeGrpcFixture({getInfo,getChanInfo:(_c:any,cb:any)=>cb(null,{channel_id:big,node1_pub:identity}),subscribeChannelGraph:(c:any)=>c.end()},{subscribeHtlcEvents:(c:any)=>c.end()});
 try{const s=source(f);const h=await s.subscribeHtlcEvents({onEvent:()=>assert.fail('unexpected HTLC')});assert.equal(h.frames,0);assert.equal(h.subscribed,false);assert.equal(h.nativeAckObserved,false);assert.equal(h.sourceHistoryComplete,false);const g=await s.subscribeChannelGraph({onEvent:()=>assert.fail('unexpected graph')});assert.equal(g.nativeAckObserved,false);assert.equal(g.sourceHistoryComplete,false);await assert.rejects(s.getChanInfo(big),/binding_mismatch/);s.shutdown();assert.equal(f.client.transportStatus().activeCalls,0);}finally{f.close();}
});

test('shared transport call cap constrains native binding while the subscription holds its lease',async()=>{
 const f=await nativeGrpcFixture({getInfo},{subscribeHtlcEvents:(c:any)=>{c.write({subscribed_event:{}});c.write(htlc);}},{maxCalls:1});try{const s=source(f),r=await s.subscribeHtlcEvents({onEvent:()=>assert.fail('unbound frame')});assert.equal(r.reason,'size_limit');assert.equal(r.subscribed,false);assert.equal(f.client.transportStatus().activeCalls,0);s.shutdown();}finally{f.close();}
});

test('actual native transport rejects falsy readiness and frame callback throws',async t=>{
 for(const phase of ['ready','frame'])for(const value of [undefined,null,0,false,''])await t.test(`${phase} ${String(value)}`,async()=>{
  const f=await nativeGrpcFixture({getInfo},{subscribeHtlcEvents:(c:any)=>{c.sendMetadata(new grpc.Metadata());c.write({subscribed_event:{}});}});
  try{
   const cap=f.client.nativeRead(),controller=new AbortController();
   await assert.rejects(cap.subscribeHtlcEvents(async()=>{if(phase==='frame')throw value;},()=>{if(phase==='ready')throw value;},controller.signal,bounds),/acquisition_failure/);
   assert.equal(f.client.transportStatus().failure,'acquisition_failure');assert.equal(f.client.transportStatus().failureContext?.origin,'local_acquisition');assert.equal(f.client.transportStatus().failureContext?.reason,'callback_error');assert.equal(f.client.transportStatus().activeCalls,0);
  }finally{f.close();}
 });
});
