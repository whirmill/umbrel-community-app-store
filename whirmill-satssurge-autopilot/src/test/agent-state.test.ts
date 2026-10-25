import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fixture as piFixture} from './pi-fixture.js';
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai/utils/event-stream';
import {stateSummary,statePage,STATE_PAGE_BYTES} from '../agent-state.js';
import {Store} from '../store.js';
function fixture(){return {enabled:false,budget:{remainingMsat:'19294831'},pnl30:{netMsat:'-8391975'},partial:true,snapshot:{at:'2026-10-09T00:00:00Z',identity:'node',synced:true,confirmedSat:'502858',channels:Array.from({length:10},(_,i)=>({id:String(i),localSat:'250000'}))},diagnostics:{at:'now',lndg:{status:'qualified',coverage:{complete:false},failures:Array.from({length:201},(_,i)=>({id:String(i),distinctPaymentsUnknown:true,amountMsat:'900719925474099300'}))},lightningMate:{status:'unavailable'}},competition:{status:'qualified',coverage:'graph only',channels:Array.from({length:10},(_,i)=>({id:String(i),alias:'peer'+i,status:'partial',quotes:[{amountSat:'100000',ourFeeMsat:'40000'}],alternativesTruncated:true,alternatives:Array.from({length:100},(_,j)=>({id:String(j),ppm:'200'}))}))},decisions:[],operations:[],evaluations:[],evaluationWindows:[],coverage:[],claims:[],holds:[]};}
test('large live-shaped state retains accounting and coverage with bounded discoverable details',()=>{
  const s=fixture(),summary:any=stateSummary(s);
  assert.ok(Buffer.byteLength(JSON.stringify(s))>STATE_PAGE_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify(summary))<STATE_PAGE_BYTES);
  assert.equal(summary.pnl30.netMsat,'-8391975');assert.equal(summary.partial,true);
  assert.equal(summary.diagnostics.lndg.counts.failures,201);
  assert.equal(summary.diagnostics.lightningMate.counts.failures,null);
  assert.equal(summary.competition.channelCount,10);
  const p=statePage(s,{section:'competition'});
  assert.equal(p.rows.length,10);assert.equal(p.rows[9].quotes[0].ourFeeMsat,'40000');assert.equal(p.rows[9].availableAlternativeRows,100);
  assert.equal(p.rows[9].alternatives,undefined);
});
test('all diagnostic rows are recoverable exactly once without truncation and preserve exact integers',()=>{
  const s=fixture(),found:string[]=[];let offset=0,version:string|undefined;
  do{const p=statePage(s,{section:'diagnostics',provider:'lndg',collection:'failures',offset,version});
    assert.ok(Buffer.byteLength(JSON.stringify(p))<=STATE_PAGE_BYTES);
    assert.equal(p.metadata.coverage.complete,false);assert.equal(p.total,201);
    for(const r of p.rows){found.push(r.id);assert.equal(r.amountMsat,'900719925474099300');}
    version=p.version;offset=p.nextOffset;
  }while(offset!==null);
  assert.deepEqual(found,Array.from({length:201},(_,i)=>String(i)));
});
test('continuation rejects changed source instead of mixing acquisition versions or treating unknown as zero',()=>{
  const s=fixture();const a=statePage(s,{section:'diagnostics',provider:'lndg',collection:'failures'});
  assert.throws(()=>statePage(s,{section:'diagnostics',provider:'lndg',collection:'failures',offset:20}));
  s.diagnostics.lndg.failures[0]!.amountMsat='10';
  const b=statePage(s,{section:'diagnostics',provider:'lndg',collection:'failures',offset:20,version:a.version});
  assert.equal(b.changed,true);assert.equal(b.restartOffset,0);assert.deepEqual(b.rows,[]);
  const absent=statePage(s,{section:'diagnostics',provider:'lightningMate',collection:'failures'});assert.equal(absent.available,false);assert.equal(absent.total,null);
  const edges=statePage(s,{section:'competition_alternatives',channel:'9'});assert.equal(edges.metadata.alternativesTruncated,true);assert.equal(edges.total,100);
  assert.throws(()=>statePage(s,{section:'channels',offset:-1}));
});

test('summary exposes only public TLS inspection fields with independent evidence time and unchanged finance',()=>{
 const s:any=fixture(),transport={transport:'grpc-tls',warning:'healthy',failure:'authentication',inspectedAt:'2025-01-01T00:00:00Z',certificateDigest:'a'.repeat(64),validFrom:'2024-01-01T00:00:00Z',validTo:'2025-02-01T00:00:00Z'};
 s.lndTransport={...transport,endpoint:'private-host:10009',error:'private error detail',macaroon:'private credential',oauth:{state:'private oauth'},activeChannels:9,activeCalls:8,extra:'private future field'};
 const summary:any=stateSummary(s);assert.deepEqual(summary.lndTransport,transport);assert.equal(summary.snapshot.at,s.snapshot.at);assert.notEqual(summary.lndTransport.inspectedAt,summary.snapshot.at);assert.deepEqual(summary.budget,s.budget);assert.deepEqual(summary.pnl30,s.pnl30);assert.equal(summary.enabled,false);assert.equal(summary.partial,true);assert.equal(JSON.stringify(summary).includes('private'),false);
 assert.equal(summary.lndTransport.warning,'healthy');assert.equal(summary.lndTransport.failure,'authentication');assert.equal(summary.lndTransport.fresh,undefined);
});
test('summary retains missing and unavailable transport evidence as explicit unknown without snapshot inference',()=>{
 const s:any=fixture();assert.equal((stateSummary(s) as any).lndTransport,null);
 s.lndTransport={transport:'grpc-tls',warning:'unavailable'};
 assert.deepEqual((stateSummary(s) as any).lndTransport,{transport:'grpc-tls',warning:'unavailable',failure:null,inspectedAt:null,certificateDigest:null,validFrom:null,validTo:null});
 s.lndTransport={};assert.deepEqual((stateSummary(s) as any).lndTransport,{transport:null,warning:null,failure:null,inspectedAt:null,certificateDigest:null,validFrom:null,validTo:null});assert.equal(s.snapshot.synced,true);
});

test('actual analyst node_state reads stored transport through its public projection without effects',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'analyst-transport-')),f=piFixture(dir,'analyst');let observed:any;
 try{
  const transport={transport:'grpc-tls',warning:'unavailable',failure:'certificate_expired',inspectedAt:'2025-01-01T00:00:00Z',certificateDigest:'b'.repeat(64),validFrom:'2024-01-01T00:00:00Z',validTo:'2024-12-31T00:00:00Z'};
  f.store.set('lndTransport',{...transport,endpoint:'private host',error:'private detail',macaroon:'private credential'});assert.equal((f.store.stats() as any).lndTransport,undefined);
  f.agent.models.streamSimple=(_model,request)=>{
   const results=request.messages.filter((m:any)=>m.role==='toolResult');if(results.length){assert.equal((results[0] as any).toolName,'node_state_analyst_2');observed=JSON.parse((results[0] as any).content[0].text);}
   const stream=createAssistantMessageEventStream(),message:any={role:'assistant',api:'openai-responses',provider:'openai',model:'gpt-6.1-sol',timestamp:Date.now(),usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:results.length?'stop':'toolUse',content:results.length?[{type:'text',text:'Stored public transport inspected; current health unknown.'}]:[{type:'toolCall',id:'transport-fixture',name:'node_state_analyst_2',arguments:{}}]};
   queueMicrotask(()=>{stream.push({type:'start',partial:message});stream.push({type:'done',reason:message.stopReason,message});});return stream;
  };
  await f.agent.open();f.queue.enqueue({requestId:'public-transport',kind:'analysis',scope:'node',payload:{message:'Inspect persisted public transport'}});await f.agent.runJob(f.queue.claim('analyst','fixture')!,2);
  assert.deepEqual(observed.lndTransport,transport);assert.equal(JSON.stringify(observed).includes('private'),false);assert.equal(observed.lndTransport.fresh,undefined);assert.equal(existsSync(join(dir,'effects.jsonl')),false);assert.equal(f.store.one('SELECT count(*) n FROM operations').n,0);assert.equal(f.store.one('SELECT count(*) n FROM ledger').n,0);
 }finally{await f.agent.close();f.store.close();rmSync(dir,{recursive:true});}
});


test('owner transport context projects only closed diagnostic fields',()=>{
 const s:any=fixture();s.lndTransport={failure:'acquisition_failure',failureContext:{failureAt:'2027-01-12T21:59:00.000Z',origin:'local_acquisition',method:'subscribeHtlcEvents',reason:'callback_error',grpcStatus:99,details:'private-secret',nodeId:'private-node'}};
 const transport=(stateSummary(s) as any).lndTransport;assert.deepEqual(transport.failureContext,{failureAt:'2027-01-12T21:59:00.000Z',origin:'local_acquisition',method:'subscribeHtlcEvents',reason:'callback_error'});assert.ok(!JSON.stringify(transport).includes('private'));
});

test('agent state separates routing from owner-classified startup costs over 30 days',()=>{
 const s=new Store(':memory:');try{
  const at=new Date().toISOString(),add=(id:string,classification:string,category:string,msat:string)=>s.run('INSERT INTO ledger VALUES(?,?,?,?,?,?,?,?)',id,at,classification,msat,category,null,null,'{}');
  add('fee-1','revenue','routing','1452662');add('rebalance-1','expense','manual_rebalance','3787035');add('txfee-1','expense','historical','6209134');
  s.annotateLedger('rebalance-1','other','verified','Owner manual initial balancing at startup');s.annotateLedger('txfee-1','other','verified','Owner channel opens and liquidity purchase at startup');
  const summary:any=stateSummary(s.stats());
  assert.equal(summary.pnl30.netMsat,'-8543507');
  assert.deepEqual(summary.accounting30.sectors.routing,{revenueMsat:'1452662',costMsat:'0',netMsat:'1452662'});
  assert.equal(summary.accounting30.sectors.other.costMsat,'9996169');
  assert.equal(summary.accounting30.unassignedCosts,false);
 }finally{s.close();}
});
