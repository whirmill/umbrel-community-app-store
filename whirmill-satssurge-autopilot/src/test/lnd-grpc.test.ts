import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import * as grpc from '@grpc/grpc-js';
import {Lnd,lndPackage,grpcTarget} from '../lnd.js';
import {hash,json} from '../domain.js';
const identity='02'+'11'.repeat(32),peer='03'+'22'.repeat(32),big='9007199254740993';
const limits={unaryMs:1500,paymentMs:1500,maxChannels:4,maxCalls:64,historyBytes:128*1024*1024,streamBytes:32*1024*1024};
function certificate(dir:string,name:string,days='365',san='IP:127.0.0.1') {
 const key=join(dir,name+'.key'),cert=join(dir,name+'.pem'),csr=join(dir,name+'.csr');
 execFileSync('openssl',['req','-new','-newkey','rsa:2048','-nodes','-keyout',key,'-out',csr,'-subj','/CN=isolated-fixture','-addext','subjectAltName='+san],{stdio:'ignore'});
 execFileSync('openssl',['x509','-req','-in',csr,'-signkey',key,'-out',cert,'-days',days,'-copy_extensions','copy'],{stdio:'ignore'});
 return {key:readFileSync(key),cert:readFileSync(cert),path:cert};
}
async function fixture(lightning:any={},router:any={},override:Partial<typeof limits>={}) {
 const dir=mkdtempSync(join(tmpdir(),'satssurge-grpc-')),pair=certificate(dir,'one');
 const ca=join(dir,'tls.cert'),read=join(dir,'read'),write=join(dir,'write');writeFileSync(ca,pair.cert);writeFileSync(read,Buffer.from('010203','hex'));writeFileSync(write,Buffer.from('040506','hex'));
 const seen:{method:string;request:any;token:any}[]=[];
 const wrap=(methods:any)=>Object.fromEntries(Object.entries(methods).map(([name,handler])=>[name,(call:any,callback:any)=>{seen.push({method:name,request:call.request,token:call.metadata.get('macaroon')[0]});(handler as any)(call,callback);}])) ;
 const server=new grpc.Server();server.addService(lndPackage.lnrpc.Lightning.service,wrap(lightning));server.addService(lndPackage.routerrpc.Router.service,wrap(router));
 const credentials=grpc.ServerCredentials.createSsl(null,[{private_key:pair.key,cert_chain:pair.cert}],false);
 const port=await new Promise<number>((resolve,reject)=>server.bindAsync('127.0.0.1:0',credentials,(e,p)=>e?reject(e):resolve(p)));
 const client=new Lnd('127.0.0.1:'+port,ca,read,write,{...limits,...override});
 return {dir,pair,server,client,ca,read,write,seen,port,rotate:(next:ReturnType<typeof certificate>)=>(credentials as any).updateSecureContextOptions({key:next.key,cert:next.cert}),close:()=>{client.close();server.forceShutdown();rmSync(dir,{recursive:true,force:true});}};
}
const route={hops:[{chan_id:big,pub_key:peer},{chan_id:'18446744073709551614',pub_key:identity}]};
const payment={status:'SUCCEEDED',fee_msat:big,value_sat:'123',payment_index:big,htlcs:[{status:'SUCCEEDED',route}]};
test('native TLS unary/stream methods preserve exact longs, enum/bytes and restricted method metadata',async()=>{
 const f=await fixture({getInfo:(_c:any,cb:any)=>cb(null,{identity_pubkey:identity,synced_to_chain:true,synced_to_graph:true}),walletBalance:(_c:any,cb:any)=>cb(null,{}),listChannels:(_c:any,cb:any)=>cb(null,{channels:[{chan_id:big,channel_point:'aa:1',remote_pubkey:peer,capacity:big,local_balance:'0',remote_balance:big,local_constraints:{chan_reserve_sat:'1'},pending_htlcs:[{amount:'2'}]}]}),getChanInfo:(_c:any,cb:any)=>cb(null,{node1_pub:identity,node1_policy:{fee_base_msat:'0',fee_rate_milli_msat:'50',time_lock_delta:80,min_htlc:'1',max_htlc_msat:big}}),forwardingHistory:(_c:any,cb:any)=>cb(null,{forwarding_events:[{chan_id_in:big,chan_id_out:'18446744073709551614',amt_in_msat:big,amt_out_msat:'10',fee_msat:'2',timestamp_ns:'1790000000000000001'}]}),listPayments:(_c:any,cb:any)=>cb(null,{payments:[payment]}),addInvoice:(_c:any,cb:any)=>cb(null,{r_hash:Buffer.alloc(32,7),payment_request:'fixture-only'}),updateChannelPolicy:(_c:any,cb:any)=>cb(null,{})},{sendPaymentV2:(c:any)=>{c.write({status:'IN_FLIGHT'});c.write(payment);c.end();},trackPaymentV2:(c:any)=>{c.write(payment);c.end();},subscribeHtlcEvents:(c:any)=>{c.write({timestamp_ns:big,incoming_channel_id:big,event_type:'FORWARD',forward_event:{info:{outgoing_amt_msat:'10'}}});c.end();}});
 try {
  const snap=await f.client.snapshot();assert.equal(snap.confirmedSat,'0');assert.equal(snap.channels[0]?.id,big);assert.equal(snap.channels[0]?.pendingSat,'2');assert.equal(snap.channels[0]?.maxMsat,big);
  const forwards=await f.client.forwards(100,200);assert.equal(forwards[0].chan_id_in,big);assert.equal((await f.client.payments())[0].payment_index,big);
  assert.deepEqual(await f.client.invoice('123','fixture'),{hash:'07'.repeat(32),request:'fixture-only'});
  const sent=await f.client.send('fixture-only',big,peer,'100');assert.equal(sent.source,big);assert.equal(sent.target,'18446744073709551614');assert.equal(sent.feeMsat,big);assert.equal((await f.client.track('07'.repeat(32)))?.status,'SUCCEEDED');
  await f.client.updateFee(snap.channels[0]!,55);
  const writes=['addInvoice','updateChannelPolicy','sendPaymentV2'];for(const row of f.seen)assert.equal(row.token,writes.includes(row.method)?'040506':'010203',row.method);
  const send=f.seen.find(r=>r.method==='sendPaymentV2')!.request;assert.equal(send.outgoing_chan_ids[0],big);assert.equal(Buffer.from(send.last_hop_pubkey,'base64').toString('hex'),peer);assert.equal(send.fee_limit_msat,'100');assert.equal(send.allow_self_payment,true);
  const policy=f.seen.find(r=>r.method==='updateChannelPolicy')!.request;assert.equal(policy.chan_point.funding_txid_str,'aa');assert.equal(policy.chan_point.output_index,1);assert.equal(policy.max_htlc_msat,big);assert.equal(policy.min_htlc_msat_specified,true);
  const legacy={timestamp_ns:'1790000000000000001',chan_id_in:big,chan_id_out:'18446744073709551614',amt_in_msat:big,amt_out_msat:'10',fee_msat:'2'};
  const id=(r:any)=>hash(json([r.timestamp_ns??r.timestamp,r.chan_id_in,r.chan_id_out,r.amt_in_msat,r.amt_out_msat,r.fee_msat]));assert.equal(id(forwards[0]),id(legacy));
 }finally{f.close();}
});
test('empty repeated responses and named zero enum preserve gateway falsey defaults',async()=>{
 const f=await fixture({getInfo:(_c:any,cb:any)=>cb(null,{identity_pubkey:identity}),walletBalance:(_c:any,cb:any)=>cb(null,{}),listChannels:(_c:any,cb:any)=>cb(null,{}),listPayments:(_c:any,cb:any)=>cb(null,{}),forwardingHistory:(_c:any,cb:any)=>cb(null,{})});
 try{assert.deepEqual((await f.client.snapshot()).channels,[]);assert.equal((await f.client.snapshot()).confirmedSat,'0');assert.deepEqual(await f.client.payments(),[]);assert.deepEqual(await f.client.forwards(0,1),[]);const codec=lndPackage.routerrpc.Router.service.TrackPaymentV2;assert.equal(codec.responseDeserialize(codec.responseSerialize({})).status,'UNKNOWN');}finally{f.close();}
});
test('payment deadline and missing track response remain uncertain with no mutation replay and sanitized errors',async()=>{
 let sends=0;const f=await fixture({}, {sendPaymentV2:()=>{sends++;},trackPaymentV2:(c:any)=>c.emit('error',{code:grpc.status.NOT_FOUND,details:'private payload https://credential.invalid'})},{paymentMs:120});
 try{await assert.rejects(f.client.send('fixture',big,peer,'1'),/deadline/);assert.equal(sends,1);await assert.rejects(f.client.track('07'.repeat(32)),e=>!String(e).includes('credential')&&String(e).includes('rpc_failure'));assert.equal(sends,1);}finally{f.close();}
});
test('unary error categories survive inspection without exposing service diagnostics',async()=>{
 const f=await fixture({walletBalance:(_c:any,cb:any)=>cb({code:grpc.status.PERMISSION_DENIED,details:'macaroon secret URL https://private.invalid'})});
 try{await assert.rejects((f.client as any).unary('lightning','walletBalance',{}),/permission_denied/);assert.equal(f.client.transportStatus().failure,'permission_denied');assert.ok(!JSON.stringify(f.client.transportStatus()).includes('private'));}finally{f.close();}
});
test('channel event cancellation settles its own read stream and releases resources',async()=>{
 const f=await fixture({subscribeChannelEvents:(c:any)=>{c.write({type:'OPEN_CHANNEL',open_channel:{chan_id:big}});}});try{const signal=new AbortController(),events:any[]=[];const promise=f.client.channelEvents(e=>{events.push(e);signal.abort();},signal.signal);await assert.rejects(promise,/cancelled/);assert.equal(events[0].open_channel.chan_id,big);assert.equal(f.seen[0]!.token,'010203');assert.equal(f.client.transportStatus().activeCalls,0);}finally{f.close();}
});
test('certificate reload preserves existing delayed unary and payment calls exactly once',async()=>{
 let finishUnary:(()=>void)|undefined,finishPayment!:()=>void;let enteredUnary!:()=>void,enteredPayment!:()=>void;const unaryStarted=new Promise<void>(r=>enteredUnary=r),paymentStarted=new Promise<void>(r=>enteredPayment=r);let count=0;
 const f=await fixture({walletBalance:(_c:any,cb:any)=>{if(finishUnary){cb(null,{confirmed_balance:'123'});return;}finishUnary=()=>cb(null,{confirmed_balance:big});enteredUnary();}},{sendPaymentV2:(c:any)=>{count++;finishPayment=()=>{c.write(payment);c.end();};enteredPayment();}});
 try{const unary=(f.client as any).unary('lightning','walletBalance',{}),sending=f.client.send('fixture',big,peer,'1');await Promise.all([unaryStarted,paymentStarted]);const next=certificate(f.dir,'next');f.rotate(next);writeFileSync(f.ca,next.cert);assert.equal(f.client.transportStatus().activeChannels,2);assert.equal(f.client.transportStatus().activeCalls,2);assert.equal((await (f.client as any).unary('lightning','walletBalance',{})).confirmed_balance,'123');finishUnary!();finishPayment();assert.equal((await unary).confirmed_balance,big);assert.equal((await sending).status,'SUCCEEDED');assert.equal(count,1);assert.equal(f.client.transportStatus().activeChannels,1);}finally{f.close();}
});
test('invalid replacement retains valid channel but reports closed category, strict target and cert validity',async()=>{
 const f=await fixture({walletBalance:(_c:any,cb:any)=>cb(null,{confirmed_balance:'1'})});
 try{assert.equal((await (f.client as any).unary('lightning','walletBalance',{})).confirmed_balance,'1');writeFileSync(f.ca,'invalid replacement');assert.equal(f.client.transportStatus().failure,'certificate_invalid');assert.equal((await (f.client as any).unary('lightning','walletBalance',{})).confirmed_balance,'1');assert.equal(f.client.transportStatus().warning,'unavailable');
  const mismatch=certificate(f.dir,'mismatch','365','DNS:other.invalid');writeFileSync(f.ca,mismatch.cert);assert.equal(f.client.transportStatus().failure,'endpoint_mismatch');
  writeFileSync(f.ca,readFileSync(new URL('../../src/test/fixtures/lnd-expired.cert-fixture',import.meta.url)));assert.equal(f.client.transportStatus().warning,'expired');assert.equal(f.client.transportStatus().failure,'certificate_expired');
  const cold=new Lnd('127.0.0.1:'+f.port,f.ca,f.read,f.write,limits);await assert.rejects((cold as any).unary('lightning','walletBalance',{}),/certificate_expired/);cold.close();
  for(const target of ['https://127.0.0.1:8080','dns:node:10009','node:10009/path','user:pass@node:10009','node:0','node:65536'])assert.throws(()=>grpcTarget(target));
 }finally{f.close();}
});
test('certificate advance warning separates 30 and 7 day thresholds',async()=>{
 const f=await fixture();try{for(const [days,warning] of [['20','expires_30d'],['5','expires_7d']] as const){writeFileSync(f.ca,certificate(f.dir,'days'+days,days).cert);assert.equal(f.client.transportStatus().warning,warning);}}finally{f.close();}
});
test('REST-shaped HTLC objects retain exact hashes for default fields, oneofs, uint64 and bytes',()=>{
 const codec=lndPackage.routerrpc.Router.service.SubscribeHtlcEvents;
 const base={incoming_channel_id:big,outgoing_channel_id:'18446744073709551614',incoming_htlc_id:'0',outgoing_htlc_id:'0',timestamp_ns:'1790000000000000001',event_type:'FORWARD'};
 const events=[{...base,settle_event:{preimage:Buffer.alloc(32,3).toString('base64')}},{...base,forward_event:{info:{incoming_timelock:0,outgoing_timelock:0,incoming_amt_msat:'0',outgoing_amt_msat:big}}},{...base,link_fail_event:{info:null,wire_failure:'RESERVED',failure_detail:'UNKNOWN',failure_string:''}},{...base,subscribed_event:{}}];
 for(const rest of events){const decoded=codec.responseDeserialize(codec.responseSerialize(rest));assert.deepEqual(decoded,rest);assert.equal(hash(json(decoded)),hash(json(rest)));assert.equal((decoded as any).event,undefined);}
});
test('pagination keeps uint64 continuation and fails closed when offsets stall',async()=>{
 const f=await fixture({listPayments:(c:any,cb:any)=>cb(null,c.request.index_offset==='0'?{payments:Array.from({length:1000},()=>payment),last_index_offset:big}:{payments:[]}),forwardingHistory:(c:any,cb:any)=>cb(null,c.request.index_offset===0?{forwarding_events:Array.from({length:1000},()=>({chan_id_in:big})),last_offset_index:1000}:{forwarding_events:[]})});
 try{assert.equal((await f.client.payments()).length,1000);assert.equal(f.seen.filter(r=>r.method==='listPayments')[1]?.request.index_offset,big);assert.equal((await f.client.forwards(1,2)).length,1000);assert.equal(f.seen.filter(r=>r.method==='forwardingHistory')[1]?.request.index_offset,1000);(f.client as any).unary=async()=>({payments:Array.from({length:1000},()=>payment),last_index_offset:'0'});await assert.rejects(f.client.payments(),/stalled/);}finally{f.close();}
});
test('silent subscriptions stay open and client shutdown drains active calls',async()=>{
 const silent=await fixture({subscribeChannelEvents:()=>{}},{subscribeHtlcEvents:()=>{}});
 try{let settled=false;const cap=silent.client.nativeRead(),bounds={deadlineMs:100,idleMs:100,bodyBytes:1000000,frameBytes:1000000,streamBytes:1000000,frames:1};
  const streams=[silent.client.channelEvents(()=>{},new AbortController().signal),cap.subscribeHtlcEvents(async()=>{},()=>{},new AbortController().signal,bounds)].map(p=>p.finally(()=>{settled=true;}));
  await new Promise(r=>setTimeout(r,400));assert.equal(settled,false);assert.equal(silent.client.transportStatus().activeCalls,2);
  silent.client.close();for(const p of streams)await assert.rejects(p,/cancelled/);assert.equal(silent.client.transportStatus().failure,undefined);
 }finally{silent.close();}
 let finish!:()=>void,entered!:()=>void;const started=new Promise<void>(r=>entered=r);
 const f=await fixture({walletBalance:(_c:any,cb:any)=>{finish=()=>cb(null,{confirmed_balance:'1'});entered();}});
 try{const result=(f.client as any).unary('lightning','walletBalance',{});await started;f.client.close();assert.equal(f.client.transportStatus().activeCalls,1);finish();assert.equal((await result).confirmed_balance,'1');assert.equal(f.client.transportStatus().activeChannels,0);await assert.rejects((f.client as any).unary('lightning','walletBalance',{}),/cancelled/);}finally{f.close();}
});
test('mixed snapshot callbacks preserve permission failure until an error-free full collection recovery',async()=>{
 let fail=true;let finishWallet!:()=>void,finishList!:()=>void;let entered!:()=>void;const started=new Promise<void>(r=>entered=r);
 const f=await fixture({getInfo:(_c:any,cb:any)=>{if(fail){cb({code:grpc.status.PERMISSION_DENIED,details:'private raw detail'});entered();}else cb(null,{identity_pubkey:identity});},walletBalance:(_c:any,cb:any)=>{if(fail)finishWallet=()=>cb(null,{confirmed_balance:'1'});else cb(null,{});},listChannels:(_c:any,cb:any)=>{if(fail)finishList=()=>cb(null,{});else cb(null,{});}});
 try{const result=f.client.snapshot();const rejected=assert.rejects(result,/permission_denied/);await started;await rejected;while(!finishWallet||!finishList)await new Promise(r=>setTimeout(r,1));finishWallet();finishList();await new Promise(r=>setTimeout(r,20));assert.equal(f.client.transportStatus().failure,'permission_denied');fail=false;const recover=f.client.beginCollection();await f.client.snapshot();assert.equal(f.client.transportStatus().failure,'permission_denied');recover();assert.equal(f.client.transportStatus().failure,undefined);}finally{f.close();}
});
test('native response frame and history/stream aggregate limits fail closed without replay',async()=>{
 const f=await fixture({getInfo:(_c:any,cb:any)=>cb(null,{identity_pubkey:identity,alias:'x'.repeat(33*1024*1024)}),listPayments:(_c:any,cb:any)=>cb(null,{payments:[payment]})},{sendPaymentV2:(c:any)=>{c.write({...payment,payment_request:'x'.repeat(600)});c.write({...payment,payment_request:'y'.repeat(600)});c.end();}},{historyBytes:100,streamBytes:1000});
 try{await assert.rejects((f.client as any).unary('lightning','getInfo',{}),/resource_limit/);assert.equal(f.client.transportStatus().failure,'resource_limit');await assert.rejects(f.client.payments(),/resource_limit/);await assert.rejects(f.client.send('fixture',big,peer,'1'),/resource_limit/);assert.equal(f.seen.filter(r=>r.method==='sendPaymentV2').length,1);}finally{f.close();}
});
test('channel and active-call caps preserve held calls and recover after release',async()=>{
 let finish!:()=>void,entered!:()=>void;const started=new Promise<void>(r=>entered=r);const f=await fixture({walletBalance:(_c:any,cb:any)=>{finish=()=>cb(null,{});entered();}},{},{maxCalls:1,maxChannels:1});
 try{const held=(f.client as any).unary('lightning','walletBalance',{});await started;await assert.rejects((f.client as any).unary('lightning','walletBalance',{}),/resource_limit/);const next=certificate(f.dir,'bounded-next');f.rotate(next);writeFileSync(f.ca,next.cert);assert.equal(f.client.transportStatus().activeChannels,1);assert.equal(f.client.transportStatus().failure,'resource_limit');finish();await held;assert.equal(f.client.transportStatus().activeChannels,1);assert.equal(f.client.transportStatus().certificateDigest,new (await import('node:crypto')).X509Certificate(next.cert).fingerprint256.replaceAll(':','').toLowerCase());}finally{f.close();}
});
test('unavailable SendPayment stream is never replayed; tracking uses original hash',async()=>{
 let sends=0;const f=await fixture({}, {sendPaymentV2:(c:any)=>{sends++;c.emit('error',{code:grpc.status.UNAVAILABLE,details:'synthetic service failure'});},trackPaymentV2:(c:any)=>{c.write(payment);c.end();}});
 try{await assert.rejects(f.client.send('fixture',big,peer,'1'),/unavailable/);assert.equal((await f.client.track('07'.repeat(32)))?.status,'SUCCEEDED');assert.equal(sends,1);assert.equal(Buffer.from(f.seen.find(r=>r.method==='trackPaymentV2')!.request.payment_hash,'base64').toString('hex'),'07'.repeat(32));}finally{f.close();}
});

test('planned native read boundaries retain prior transport failure and collection epoch',async t=>{
 for(const priorFailure of [false,true])for(const kind of ['abort','shutdown'])await t.test(`${kind} prior=${priorFailure}`,async()=>{
  let denied=priorFailure;const quiet=(c:any)=>c.sendMetadata(new grpc.Metadata());
  const f=await fixture({getInfo:(_c:any,cb:any)=>cb(null,{identity_pubkey:identity}),walletBalance:(_c:any,cb:any)=>denied?cb({code:grpc.status.PERMISSION_DENIED}):cb(null,{}),listChannels:(_c:any,cb:any)=>cb(null,{}),subscribeChannelGraph:quiet},{subscribeHtlcEvents:quiet});
  try{
   if(priorFailure)await assert.rejects((f.client as any).unary('lightning','walletBalance',{}),/permission_denied/);denied=false;
   const epoch=(f.client as any).failureEpoch,recover=f.client.beginCollection();
   const bounds={deadlineMs:1000,idleMs:1000,bodyBytes:1000000,frameBytes:1000000,streamBytes:1000000,frames:20};
   const controllers=[new AbortController(),new AbortController()];let ready=0,started!:()=>void;const bothReady=new Promise<void>(r=>started=r);
   const cap=f.client.nativeRead(),pending=[cap.subscribeHtlcEvents,cap.subscribeChannelGraph].map((subscribe,i)=>assert.rejects(subscribe(async()=>{},()=>{if(++ready===2)started();},controllers[i]!.signal,bounds),e=>String(e).includes('cancelled')));
   await bothReady;if(kind==='abort')controllers.forEach(c=>c.abort());else f.client.close();
   await Promise.all(pending);assert.equal(f.client.transportStatus().activeCalls,0);assert.equal(f.client.transportStatus().failure,priorFailure?'permission_denied':undefined);assert.equal((f.client as any).failureEpoch,epoch);
   if(kind!=='shutdown'){await f.client.snapshot();assert.equal(f.client.transportStatus().failure,priorFailure?'permission_denied':undefined);recover();assert.equal(f.client.transportStatus().failure,undefined);}else assert.equal(f.client.transportStatus().activeChannels,0);
  }finally{f.close();}
 });
});

test('remote read stream status codes still latch failures before the local boundary',async t=>{
 for(const [failure,code] of Object.entries({cancelled:grpc.status.CANCELLED,deadline:grpc.status.DEADLINE_EXCEEDED,unavailable:grpc.status.UNAVAILABLE,authentication:grpc.status.UNAUTHENTICATED,permission_denied:grpc.status.PERMISSION_DENIED,resource_limit:grpc.status.RESOURCE_EXHAUSTED,rpc_failure:grpc.status.UNKNOWN}))await t.test(failure,async()=>{
  const remote=(c:any)=>c.emit('error',{code,details:'private fixture diagnostics'}),f=await fixture({subscribeChannelGraph:remote,subscribeChannelEvents:remote},{subscribeHtlcEvents:remote});
  try{
   const bounds={deadlineMs:1000,idleMs:1000,bodyBytes:1000000,frameBytes:1000000,streamBytes:1000000,frames:20},cap=f.client.nativeRead();
   for(const subscribe of [cap.subscribeHtlcEvents,cap.subscribeChannelGraph]){const epoch=(f.client as any).failureEpoch;await assert.rejects(subscribe(async()=>{},()=>{},new AbortController().signal,bounds),e=>String(e).includes(failure)&&!String(e).includes('private'));assert.equal(f.client.transportStatus().failure,failure);assert.equal((f.client as any).failureEpoch,epoch+1);}
   await assert.rejects(f.client.channelEvents(()=>{},new AbortController().signal),new RegExp(failure));assert.equal(f.client.transportStatus().failure,failure);assert.equal(f.client.transportStatus().activeCalls,0);
  }finally{f.close();}
 });
});

test('local channel event abort and shutdown retain prior failure while payment errors stay latched',async t=>{
 for(const kind of ['abort','shutdown'])await t.test(kind,async()=>{
  let entered!:()=>void;const started=new Promise<void>(r=>entered=r),f=await fixture({walletBalance:(_c:any,cb:any)=>cb({code:grpc.status.PERMISSION_DENIED}),subscribeChannelEvents:(c:any)=>{c.write({type:'ACTIVE_CHANNEL',active_channel:{output_index:1}});entered();}});
  try{await assert.rejects((f.client as any).unary('lightning','walletBalance',{}),/permission_denied/);const epoch=(f.client as any).failureEpoch,controller=new AbortController(),pending=f.client.channelEvents(()=>{},controller.signal),settled=assert.rejects(pending,/cancelled/);await started;if(kind==='abort')controller.abort();else if(kind==='shutdown')f.client.close();await settled;assert.equal(f.client.transportStatus().failure,'permission_denied');assert.equal((f.client as any).failureEpoch,epoch);assert.equal(f.client.transportStatus().activeCalls,0);}finally{f.close();}
 });
 const f=await fixture({}, {sendPaymentV2:(c:any)=>c.emit('error',{code:grpc.status.CANCELLED}),trackPaymentV2:(c:any)=>c.emit('error',{code:grpc.status.DEADLINE_EXCEEDED})});
 try{await assert.rejects(f.client.send('fixture',big,peer,'1'),/cancelled/);assert.equal(f.client.transportStatus().failure,'cancelled');await assert.rejects(f.client.track('07'.repeat(32)),/deadline/);assert.equal(f.client.transportStatus().failure,'deadline');assert.equal(f.seen.filter(v=>v.method==='sendPaymentV2').length,1);assert.equal(f.seen.filter(v=>v.method==='trackPaymentV2').length,1);assert.equal(f.client.transportStatus().activeCalls,0);}finally{f.close();}
});
test('a failed SendPaymentV2 carries the LND failure reason into the outcome',async()=>{
 const f=await fixture({},{sendPaymentV2:(c:any)=>{c.write({status:'FAILED',fee_msat:'0',value_sat:'1000',failure_reason:'FAILURE_REASON_NO_ROUTE',htlcs:[]});c.end();}});
 try{const r=await f.client.send('fixture',big,peer,'1');assert.equal(r.status,'FAILED');assert.equal(r.reason,'FAILURE_REASON_NO_ROUTE');}finally{f.close();}
});
