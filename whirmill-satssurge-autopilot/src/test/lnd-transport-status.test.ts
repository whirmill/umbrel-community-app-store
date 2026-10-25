import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../store.js';
import {Queue} from '../queue.js';
import {ApplicationControl} from '../application-control.js';
import {Telegram} from '../telegram.js';
import {Collector} from '../collector.js';
import {execFileSync} from 'node:child_process';
import * as grpc from '@grpc/grpc-js';
import {Lnd,lndPackage,safeLndFailureContext} from '../lnd.js';
import type {LndTransportStatus} from '../lnd.js';
const at='2027-01-12T22:00:00.000Z';
function status(warning:LndTransportStatus['warning']='expires_30d',digest='publicdigest'):LndTransportStatus{return {transport:'grpc-tls',inspectedAt:at,certificateDigest:digest,validFrom:'2026-01-01T00:00:00.000Z',validTo:'2027-02-01T00:00:00.000Z',warning,activeChannels:1,activeCalls:0};}
function fixture(call:any=async()=>({message_id:1})) {
 const dir=mkdtempSync(join(tmpdir(),'lnd-status-'));const s=new Store(join(dir,'operational.sqlite'));const q=new Queue(s);const c=new ApplicationControl(s,q);const t=new Telegram(s,c,dir,{call});
 s.set('telegramConfigured',true);s.set('telegramBinding',{generation:'one',userId:42,chatId:42,since:at});
 return {dir,s,q,c,t,close:()=>{t.stop();s.close();rmSync(dir,{recursive:true,force:true});}};
}
const capture=(t:Telegram,time=at)=>(t as any).captureLndTransport(time);
test('collector failure persists sanitized transport state and preserves last valid snapshot/mandate',async()=>{
 const s=new Store(':memory:'),dir=mkdtempSync(join(tmpdir(),'lnd-collector-')),gate=join(dir,'gate');const saved={at,identity:'self',synced:true,confirmedSat:'500001',channels:[]};s.saveSnapshot(saved);s.set('expectedIdentity','self');s.set('bootstrapReady',true);const mandate=s.get('mandate');
 writeFileSync(gate,JSON.stringify({schema:1,at:new Date().toISOString(),...Object.fromEntries(['fee','rebalance','channel','sell','autoclose','relist','reprice','size','maxHTLC','lsp','lndgAF','lndgAR','lndgAutopilot','loop'].map(k=>[k,false]))}));
 const transport={...status('expired'),failure:'certificate_expired' as const};const node:any={snapshot:async()=>{throw Error('private subject SAN https://sensitive.invalid credential');},transportStatus:()=>transport};const collector=new Collector(s,node,{reconcile:async()=>{}} as any,gate);
 try{await collector.collect();assert.equal(s.get('bootstrapReady'),false);assert.equal(s.get('collector').ok,false);assert.deepEqual(s.get('snapshot'),saved);assert.deepEqual(s.get('lndTransport'),transport);assert.deepEqual(s.get('mandate'),mandate);assert.ok(!JSON.stringify(s.get('collector')).includes('sensitive'));assert.equal(collector.busy,false);}finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
test('warnings deduplicate across restart, stages/certificate/generation change get separate receipts',()=>{
 const f=fixture();try{f.s.set('lndTransport',status());capture(f.t);capture(f.t);assert.equal(f.s.all("SELECT * FROM telegram_outbox WHERE event_id LIKE 'lnd-transport:%'").length,1);f.t.stop();const restarted=new Telegram(f.s,f.c,f.dir,{call:async()=>({message_id:1})});restarted.recover();capture(restarted);assert.equal(f.s.all("SELECT * FROM telegram_outbox WHERE event_id LIKE 'lnd-transport:%'").length,1);
  f.s.set('lndTransport',status('expires_7d'));capture(restarted);f.s.set('lndTransport',status('expires_7d','renewed'));capture(restarted);f.t.revoke();f.s.set('telegramBinding',{generation:'two',userId:42,chatId:42,since:at});capture(restarted);const rows=f.s.all("SELECT * FROM telegram_outbox WHERE event_id LIKE 'lnd-transport:%'");assert.equal(rows.length,4);assert.equal(rows.filter(r=>r.generation==='one'&&r.status==='cancelled').length,3);assert.equal(rows[3]?.generation,'two');restarted.stop();
 }finally{f.close();}
});
test('advance warnings respect quiet hours, expired/authentication alerts are critical',async()=>{
 const sent:any[]=[];const f=fixture(async(method:string,body:any)=>{sent.push({method,body});return {message_id:sent.length};});try{f.s.set('lndTransport',status('expires_30d'));capture(f.t);await f.t.deliver(at);assert.equal(sent.length,0);f.s.set('lndTransport',{...status('expired'),failure:'certificate_expired'});capture(f.t);await f.t.deliver(at);assert.equal(sent.length,1);assert.match(sent[0].body.text,/certificate_expired/);f.s.set('lndTransport',{...status('healthy'),failure:'authentication'});capture(f.t);await f.t.deliver(at);assert.equal(sent.length,2);await f.t.deliver('2027-01-13T08:00:00.000Z');assert.equal(sent.length,3);assert.match(sent[2].body.text,/expires_30d/);}finally{f.close();}
});
test('healthy reset allows a new episode after bounded recurrence interval without warning flaps',()=>{
 const f=fixture();try{f.s.set('lndTransport',status());capture(f.t);f.s.set('lndTransport',status('healthy'));capture(f.t);f.s.set('lndTransport',status());capture(f.t,'2027-01-12T22:01:00.000Z');assert.equal(f.s.all("SELECT * FROM telegram_outbox WHERE event_id LIKE 'lnd-transport:%'").length,1);capture(f.t,'2027-01-12T22:11:00.000Z');assert.equal(f.s.all("SELECT * FROM telegram_outbox WHERE event_id LIKE 'lnd-transport:%'").length,2);}finally{f.close();}
});
test('uncertain certificate alert delivery survives restart without automatic replay and honors rate gate',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;throw Error('isolated timeout private URL');});try{f.s.set('lndTransport',status('expired'));capture(f.t);f.s.set('telegramRateLimitUntil',Date.parse('2027-01-12T22:05:00Z'));await f.t.deliver(at);assert.equal(calls,0);await f.t.deliver('2027-01-12T22:06:00Z');assert.equal(calls,1);assert.equal(f.s.one("SELECT status FROM telegram_outbox WHERE event_id LIKE 'lnd-transport:%'").status,'uncertain');f.t.recover();capture(f.t,'2027-01-12T22:20:00Z');await f.t.deliver('2027-01-12T22:20:00Z');assert.equal(calls,1);assert.ok(!f.s.one("SELECT error FROM telegram_outbox WHERE event_id LIKE 'lnd-transport:%'").error.includes('private'));}finally{f.close();}
});
test('TLS expiry is persisted before a delayed reconciliation and bootstrap fails closed during that wait',async()=>{
 const s=new Store(':memory:');let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>entered=r),held=new Promise<void>(r=>release=r);const dir=mkdtempSync(join(tmpdir(),'lnd-status-before-')),gate=join(dir,'gate');writeFileSync(gate,JSON.stringify({schema:1,at:new Date().toISOString(),...Object.fromEntries(['fee','rebalance','channel','sell','autoclose','relist','reprice','size','maxHTLC','lsp','lndgAF','lndgAR','lndgAutopilot','loop'].map(k=>[k,false]))}));const node:any={transportStatus:()=>({...status('expired'),failure:'certificate_expired'}),snapshot:async()=>{throw Error('isolated failure');}};s.set('bootstrapReady',true);const collector=new Collector(s,node,{reconcile:async()=>{entered();await held;}} as any,gate);
 try{const collecting=collector.collect();await started;assert.equal(s.get('lndTransport').failure,'certificate_expired');assert.equal(s.get('bootstrapReady'),false);assert.equal(collector.busy,true);release();await collecting;assert.equal(collector.busy,false);}finally{release();s.close();rmSync(dir,{recursive:true,force:true});}
});

test('full collection readiness and blockers use the recovered latest transport while scoped finance stays held',async()=>{
 for(const lateFailure of [false,true]){
  const s=new Store(':memory:');let transport:LndTransportStatus={...status('healthy'),failure:'deadline'},reconciled=0,recovered=0,nativeTicks=0;
  s.set('appControlContract',{schema:1,scope:'apps-only'});s.set('expectedIdentity','self');s.set('historicalLedgerImported',true);s.set('enabled',false);s.set('maintenanceClaim',{owner:'original'});s.set('bootstrapReady',true);const mandate=s.get('mandate');
  const node:any={transportStatus:()=>transport,beginCollection:()=>()=>{recovered++;transport={...status('healthy')};},snapshot:async()=>({at:new Date().toISOString(),identity:'self',synced:true,confirmedSat:'600000',channels:[]}),payments:async()=>[],forwards:async()=>[]};
  const native:any={tick:async()=>{nativeTicks++;if(lateFailure)transport={...transport,failure:'unavailable'};}};
  const collector=new Collector(s,node,{reconcile:async()=>{reconciled++;assert.equal(s.get('lndTransport').failure,'deadline');assert.equal(s.get('bootstrapReady'),false);}} as any,'/synthetic-unavailable-gate',native);
  try{
   await collector.collect();assert.equal(reconciled,1);assert.equal(recovered,1);assert.equal(nativeTicks,1);assert.equal(s.get('collector').ok,true);assert.equal(s.get('lndTransport').failure,lateFailure?'unavailable':undefined);assert.equal(s.get('operationalReadiness').ready,!lateFailure);
   assert.equal(s.get<string[]>('blockers')!.includes('Native LND gRPC/acquisition requires attention'),lateFailure);assert.ok(s.get<string[]>('blockers')!.includes('Live automation interlock unavailable'));assert.equal(s.get('bootstrapReady'),false);assert.equal(s.get('operationalReadiness').financialEligible,false);assert.equal(s.get('automationProof').state,'unknown');assert.equal(s.get('maintenanceClaim').owner,'original');assert.equal(s.get('enabled'),false);assert.deepEqual(s.get('mandate'),mandate);assert.equal(s.one('SELECT count(*) n FROM operations').n,0);
  }finally{s.close();}
 }
});

for(const failure of ['permission_denied','unavailable'] as const)test(`healthy collection followed by HTLC ${failure} blocks dispatch until full native recovery`,async()=>{
 const dir=mkdtempSync(join(tmpdir(),'collector-stream-readiness-')),s=new Store(':memory:'),server=new grpc.Server();let node:Lnd|undefined;
 const identity='02'+'11'.repeat(32),key=join(dir,'fixture.key'),ca=join(dir,'tls.cert'),read=join(dir,'read'),write=join(dir,'write'),gate=join(dir,'gate');
 try {
  execFileSync('openssl',['req','-new','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',ca,'-days','365','-subj','/CN=isolated-fixture','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
  writeFileSync(read,Buffer.from('010203','hex'));writeFileSync(write,Buffer.from('040506','hex'));
  writeFileSync(gate,JSON.stringify({schema:1,at:new Date().toISOString(),...Object.fromEntries(['fee','rebalance','channel','sell','autoclose','relist','reprice','size','maxHTLC','lsp','lndgAF','lndgAR','lndgAutopilot','loop'].map(k=>[k,false]))}));
  server.addService(lndPackage.lnrpc.Lightning.service,{getInfo:(_c:any,cb:any)=>cb(null,{identity_pubkey:identity,synced_to_chain:true,synced_to_graph:true}),walletBalance:(_c:any,cb:any)=>cb(null,{confirmed_balance:'500001'}),listChannels:(_c:any,cb:any)=>cb(null,{}),listPayments:(_c:any,cb:any)=>cb(null,{}),forwardingHistory:(_c:any,cb:any)=>cb(null,{})});
  server.addService(lndPackage.routerrpc.Router.service,{subscribeHtlcEvents:(c:any)=>c.emit('error',{code:failure==='permission_denied'?grpc.status.PERMISSION_DENIED:grpc.status.UNAVAILABLE,details:'isolated sensitive diagnostics'} )});
  const port=await new Promise<number>((resolve,reject)=>server.bindAsync('127.0.0.1:0',grpc.ServerCredentials.createSsl(null,[{private_key:readFileSync(key),cert_chain:readFileSync(ca)}],false),(error,p)=>error?reject(error):resolve(p)));
  node=new Lnd('127.0.0.1:'+port,ca,read,write);
  s.set('enabled',true);s.set('expectedIdentity',identity);s.set('historicalLedgerImported',true);
  const collector=new Collector(s,node,{reconcile:async()=>{}} as any,gate);
  await collector.collect();assert.equal(s.get('bootstrapReady'),true);s.assertDispatchReady();
  s.run('INSERT INTO decisions VALUES(?,?,?,?,?,?)','original-decision',new Date().toISOString(),'{}','{}','{}','planned');
  for(const state of ['uncertain','in_flight'])s.run('INSERT INTO operations VALUES(?,?,?,?,?,?,?)','original-'+state,'original-decision',new Date().toISOString(),state,'original-hash-'+state,null,JSON.stringify({originalReceipt:state}));
  const original=s.all('SELECT * FROM operations ORDER BY id'),saved=s.get('snapshot');s.set('blockers',['Existing unrelated blocker']);
  await assert.rejects(collector.stream(new AbortController().signal),new RegExp(failure));
  assert.equal(s.get('lndTransport').failure,failure);assert.equal(s.get('bootstrapReady'),false);assert.throws(()=>s.assertDispatchReady(),/Bootstrap/);
  assert.deepEqual(s.get('snapshot'),saved);assert.deepEqual(s.get('blockers'),['Existing unrelated blocker']);assert.deepEqual(s.all('SELECT * FROM operations ORDER BY id'),original);
  // Successful sibling/read callbacks alone do not clear the native failure epoch or gate.
  await node.snapshot();assert.equal(node.transportStatus().failure,failure);assert.equal(s.get('bootstrapReady'),false);
  s.set('integrityBlocker','Original integrity hold');await collector.collect();assert.equal(s.get('lndTransport').failure,undefined);assert.equal(s.get('bootstrapReady'),false);assert.ok(s.get<string[]>('blockers')!.includes('Original integrity hold'));
  s.set('integrityBlocker',null);await collector.collect();assert.equal(s.get('bootstrapReady'),true);s.assertDispatchReady();assert.deepEqual(s.all('SELECT * FROM operations ORDER BY id'),original);
 }finally{node?.close();server.forceShutdown();s.close();rmSync(dir,{recursive:true,force:true});}
});


test('noncertificate failures report bounded RPC/acquisition context without implying TLS failure',()=>{
 for(const failure of ['rpc_failure','acquisition_failure'] as const){
  const f=fixture();try{f.s.set('lndTransport',{...status('healthy'),failure,failureContext:{failureAt:'2027-01-12T21:59:00.000Z',origin:failure==='rpc_failure'?'rpc':'local_acquisition',method:'subscribeHtlcEvents',grpcStatus:2,reason:'callback_error',details:'private-secret',nodeId:'private-node'}});capture(f.t);assert.equal(f.s.all("SELECT * FROM telegram_outbox WHERE event_id LIKE 'lnd-transport:%'").length,0);for(let m=1;m<=10;m++)capture(f.t,new Date(Date.parse(at)+m*60000).toISOString());const content=JSON.stringify(f.s.one("SELECT * FROM telegram_outbox WHERE event_id LIKE 'lnd-transport:%'"));assert.ok(content.includes('2027-01-12T21:59:00.000Z'));assert.ok(content.includes('subscribeHtlcEvents'));assert.ok(!content.includes('gRPC TLS'));assert.ok(!content.includes('Certificato'));assert.ok(!content.includes('private-secret'));assert.ok(!content.includes('private-node'));}finally{f.close();}
 }
 assert.deepEqual(safeLndFailureContext({failureAt:at,origin:'rpc',method:'private-rpc',grpcStatus:99,reason:'private-secret',details:'private-secret'}),{failureAt:at,origin:'rpc'});
 assert.equal(safeLndFailureContext({failureAt:'private-secret',origin:'rpc'}),undefined);
 assert.equal(safeLndFailureContext({failureAt:at,origin:'private-secret'}),undefined);
});

const transientRows=(f:any)=>f.s.all("SELECT event_id,text FROM telegram_outbox WHERE event_id LIKE 'lnd-transport%' ORDER BY rowid");
test('a transient LND failure that recovers within ten minutes sends nothing',()=>{
 const f=fixture();try{
  f.s.set('lndTransport',{...status('healthy'),failure:'deadline',failureContext:{failureAt:at,origin:'rpc',method:'getInfo',grpcStatus:4}});capture(f.t);capture(f.t,'2027-01-12T22:05:00.000Z');
  f.s.set('lndTransport',status('healthy'));capture(f.t,'2027-01-12T22:06:00.000Z');
  f.s.set('lndTransport',{...status('healthy'),failure:'cancelled'});capture(f.t,'2027-01-12T22:20:00.000Z');capture(f.t,'2027-01-12T22:29:00.000Z');
  assert.deepEqual(transientRows(f),[]);
 }finally{f.close();}
});
const minute=(m:number)=>new Date(Date.parse(at)+m*60000).toISOString();
const every=(f:any,from:number,to:number,transport:any)=>{f.s.set('lndTransport',transport);for(let m=from;m<=to;m++)capture(f.t,minute(m));};
const failing=(failure:string)=>({...status('healthy'),failure});
test('a persistent transient LND failure alerts once across kinds and reports recovery once after sustained health',()=>{
 const f=fixture();try{
  every(f,0,5,{...failing('deadline'),failureContext:{failureAt:at,origin:'rpc',method:'getInfo',grpcStatus:4}});every(f,6,11,failing('rpc_failure'));every(f,12,25,failing('unavailable'));
  let rows=transientRows(f);assert.equal(rows.length,1);assert.match(rows[0].text,/^LND non risponde correttamente da 10 minuti \(rpc_failure\)\. SatsSurge riprova/);assert.doesNotMatch(rows[0].text,/richiede attenzione|Ultimo errore/);
  every(f,26,29,status('healthy'));assert.equal(transientRows(f).length,1);
  every(f,30,32,status('healthy'));rows=transientRows(f);assert.equal(rows.length,2);assert.equal(rows[1].text,'Collegamento a LND ripristinato dopo 26 minuti.');
  assert.equal(f.s.one("SELECT kind FROM telegram_outbox WHERE event_id LIKE 'lnd-transport-recovered:%'").kind,'critical');
 }finally{f.close();}
});
test('an intermittent failure that never stays healthy for five minutes still alerts once, without a storm',()=>{
 const f=fixture();try{
  for(let m=0;m<40;m++){f.s.set('lndTransport',m%3===0?failing('cancelled'):status('healthy'));capture(f.t,minute(m));}
  assert.equal(transientRows(f).length,1);
 }finally{f.close();}
});
test('an observation gap starts a new outage instead of counting as downtime',()=>{
 const f=fixture();try{every(f,0,2,failing('cancelled'));every(f,180,185,failing('deadline'));assert.deepEqual(transientRows(f),[]);}finally{f.close();}
});
test('recovery during an active certificate warning is reported once and the warning is not sent again',()=>{
 const f=fixture();try{
  f.s.set('lndTransport',status('expires_30d'));capture(f.t);
  every(f,1,12,{...status('expires_30d'),failure:'deadline'});every(f,13,20,status('expires_30d'));
  const rows=transientRows(f);assert.equal(rows.length,3);assert.match(rows[0].text,/expires_30d/);assert.match(rows[1].text,/^LND non risponde/);assert.match(rows[2].text,/^Collegamento a LND ripristinato/);
 }finally{f.close();}
});
test('a transient LND failure does not raise the immediate blocker message; authentication still does',()=>{
 const f=fixture();try{
  f.s.set('lndTransport',failing('deadline'));f.s.set('blockers',['Native LND gRPC/acquisition requires attention']);f.t.capture(at);
  assert.equal(f.s.all("SELECT * FROM telegram_outbox WHERE event_id LIKE 'blockers:%'").length,0);
  f.s.set('lndTransport',failing('authentication'));f.t.capture(minute(1));
  assert.match(f.s.one("SELECT text FROM telegram_outbox WHERE event_id LIKE 'blockers:%'").text,/Native LND gRPC/);
 }finally{f.close();}
});
