import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store,UI_TEXT_FRAME_RETENTION_MS} from '../store.js';
import {CanonicalModel} from '../canonical-model.js';
import {NativeCollection} from '../native-collection.js';
import {NATIVE_POLICY_CONTRACT} from '../native-policy.js';
import {NATIVE_DELIVERY_ROLLUP_VERSION} from '../native-failure-aggregate.js';
const identity='02'+'a'.repeat(64),peer=(i:number)=>'03'+i.toString(16).padStart(64,'0');
const binding={nodeId:identity,network:'mainnet',sourceVersion:'0.21.4-beta',sourceInstance:'synthetic-growth'};
const channels=Array.from({length:12},(_,i)=>String(800000000000000000n+BigInt(i)));
const policy=(fee:number)=>({time_lock_delta:80,min_htlc:'1000',fee_base_msat:'0',fee_rate_milli_msat:String(fee),disabled:false,max_htlc_msat:'990000000',last_update:1760000000,inbound_fee_base_msat:0,inbound_fee_rate_milli_msat:0});
const counts=(s:Store)=>Object.fromEntries(['canonical_observations','canonical_evidence_links','canonical_coverage','canonical_projection_revisions','canonical_original_archive'].map(t=>[t,Number(s.one('SELECT count(*) n FROM '+t).n)]));
/** Twelve channels, minute snapshots and one native tick per minute: the node's per-cycle writers without any LND activity. */
function node(s:Store,start:string){
 let t=Date.parse(start);const fees=new Map<string,number>(),clock=()=>new Date(t).toISOString(),calls:{method:string;request:any}[]=[];
 const source:any={contract:NATIVE_POLICY_CONTRACT,binding:()=>binding,shutdown(){},
  forwardPage:async(request:any)=>{calls.push({method:'forwards',request});return {forwarding_events:[],last_offset_index:request.indexOffset};},
  paymentPage:async(request:any)=>{calls.push({method:'payments',request});return {payments:[],first_index_offset:'0',last_index_offset:'0'};},
  listChannels:async()=>({channels:channels.map(chan_id=>({chan_id}))}),
  getChanInfo:async(id:string)=>({channel_id:id,chan_point:'00'.repeat(32)+':0',capacity:'5000000',node1_pub:identity,node2_pub:peer(Number(BigInt(id)%1000n)),node1_policy:policy(fees.get(id)??100),node2_policy:policy(200)})};
 const native=new NativeCollection(s,source,clock);
 const snapshot=()=>({at:clock(),identity,synced:true,confirmedSat:'900000',channels:channels.map((id,i)=>({id,point:'00'.repeat(32)+':'+i,peer:peer(i),alias:'peer-'+i,active:true,capacitySat:'5000000',localSat:'2500000',remoteSat:'2400000',reserveSat:'50000',pendingSat:'0',baseMsat:'0',ppm:fees.get(id)??100,cltv:80,minMsat:'1000',maxMsat:'990000000'}))});
 return {calls,fees,clock,async tick(){s.saveSnapshot(snapshot());await native.tick();assert.equal(s.get('nativeCollection').ok,true);t+=60_000;}};
}

test('unchanged minute cycles append only the bounded archive scan; policy changes and every original stay recorded',async()=>{
 const s=new Store(':memory:');try{
  s.set('historyStart','2026-10-25T00:00:00.000Z');const n=node(s,'2026-10-25T01:00:00.000Z');
  for(let i=0;i<20;i++)await n.tick();
  const before=counts(s),requests=n.calls.length;
  for(let i=0;i<10;i++)await n.tick();
  const after=counts(s),grown=Object.fromEntries(Object.entries(after).map(([k,v])=>[k,v-before[k]!]));
  // One legacy-scan checkpoint per tick and no empty history windows; new minute snapshots reach the archive with one observation and link each.
  assert.equal(grown.canonical_coverage,10);assert.equal(grown.canonical_projection_revisions,0);
  assert.equal(grown.canonical_observations,grown.canonical_original_archive);assert.equal(grown.canonical_evidence_links,grown.canonical_original_archive);
  assert.equal(n.calls.length,requests);
  const checkpoint=JSON.parse(s.one("SELECT details FROM canonical_coverage WHERE capability='legacy_ingestion' ORDER BY rowid DESC LIMIT 1").details);
  assert.equal(checkpoint.rowDigests,undefined);assert.match(checkpoint.scanDigest,/^[0-9a-f]{64}$/);
  // The next fifteen-minute history window opens once per kind.
  for(let i=0;i<6;i++)await n.tick();
  assert.deepEqual(n.calls.slice(requests).map(c=>c.method).sort(),['forwards','payments']);
  n.fees.set(channels[3]!,150);const policies=Number(s.one("SELECT count(*) n FROM canonical_observations WHERE kind='native_policy'").n);
  for(let i=0;i<2;i++)await n.tick();
  const changed=s.all("SELECT payload FROM canonical_observations WHERE kind='native_policy' ORDER BY rowid").slice(policies).map(r=>JSON.parse(r.payload));
  assert.deepEqual(changed.map(p=>[p.channelId,p.direction,p.changedFields]),[[channels[3],'outgoing',['feeRatePpm']]]);
 }finally{s.close();}
});

test('finished jobs drop superseded streaming text frames after a day and keep their final text and tool records',()=>{
 const s=new Store(':memory:');try{
  const at='2026-10-25T12:00:00.000Z',old=new Date(Date.parse(at)-UI_TEXT_FRAME_RETENTION_MS-1).toISOString(),recent=new Date(Date.parse(at)-60_000).toISOString();
  const job=(id:string,state:string,finished:string|null)=>s.run("INSERT INTO jobs(id,request_id,kind,lane,priority,payload,payload_digest,scope,state,created_at,updated_at,finished_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",id,'r-'+id,'chat','coordinator',1,'{}','d','node',state,old,old,finished);
  job('done','completed',old);job('failed','failed',old);job('fresh','completed',recent);job('running','running',null);
  const frames=(id:string)=>{for(let i=1;i<=40;i++)s.run('INSERT INTO ui_events(job_id,at,type,data) VALUES(?,?,?,?)',id,old,'text',JSON.stringify({text:'x'.repeat(i*100)}));s.run('INSERT INTO ui_events(job_id,at,type,data,event_key) VALUES(?,?,?,?,?)',id,old,'tool_call','{"toolCallId":"c"}','call:c');};
  for(const id of ['done','failed','fresh','running'])frames(id);
  const rows=(id:string)=>s.all('SELECT type,data FROM ui_events WHERE job_id=? ORDER BY id',id);
  assert.equal(s.pruneUiEvents(at,50),50);assert.equal(s.pruneUiEvents(at),28);assert.equal(s.pruneUiEvents(at),0);
  for(const id of ['done','failed'])assert.deepEqual(rows(id).map(r=>[r.type,r.type==='text'?JSON.parse(r.data).text.length:0]),[['text',4000],['tool_call',0]]);
  for(const id of ['fresh','running'])assert.equal(rows(id).length,41);
 }finally{s.close();}
});

test('offline prune removes only redundant revisions and stale frames, keeps guards and financial records, and refuses cited revisions',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'prune-redundant-')),path=join(dir,'operational.sqlite');let s=new Store(path);
 const run=(mode:string)=>JSON.parse(execFileSync('python3',['-c','import sys,json;sys.path.insert(0,"scripts");from prune_redundant_history import prune;print(json.dumps(prune(sys.argv[1],apply=sys.argv[2]=="apply")))',path,mode],{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
 try{
  const model=new CanonicalModel(s.db),at='2026-10-20T00:00:00.000Z',receipt=(i:number)=>model.appendCoverage({...binding,capability:'synthetic_receipt',scope:'r',source:'lnd.htlc',epoch:'e',start:at,end:at,observedAt:at,status:'partial',details:{i}});
  const receipts=[receipt(1),receipt(2)],third=receipt(3);
  // Pre-fix rollups: the same receipt selection republished under moving range ends.
  const rollup=(coverageIds:string[],through:number)=>model.publishProjection({name:'native_failure_delivery_rollups',scope:'all',epoch:'through:'+through,calculationVersion:NATIVE_DELIVERY_ROLLUP_VERSION,observationIds:[],coverageIds,result:{through}});
  const kept=rollup(receipts,10);for(let i=11;i<40;i++)rollup(receipts,i);const distinct=rollup([...receipts,third],41);
  const empty=Array.from({length:20},(_,i)=>model.publishProjection({name:'native_history_record_capture',scope:'native:w'+i+':forwards',epoch:'w'+i,calculationVersion:'record_match_v2',observationIds:[],coverageIds:[],result:{pageNumber:1}}));
  const observation=model.observe({...binding,kind:'forward',meaning:'lnd_effect',source:'lnd.forwards',originalId:'f',batchId:'b',occurredAt:at,observedAt:at,granularity:'native nanoseconds',payload:{}});
  const captured=model.publishProjection({name:'native_history_record_capture',scope:'native:full:forwards',epoch:'full',calculationVersion:'record_match_v2',observationIds:[observation],coverageIds:[],result:{pageNumber:1}});
  s.run("INSERT INTO jobs(id,request_id,kind,lane,priority,payload,payload_digest,scope,state,created_at,updated_at,finished_at) VALUES('j','r','chat','coordinator',1,'{}','d','node','completed',?,?,?)",at,at,at);
  for(let i=1;i<=5;i++)s.run("INSERT INTO ui_events(job_id,at,type,data) VALUES('j',?,'text',?)",at,JSON.stringify({text:'frame '+i}));
  s.ledger({id:'fwd:kept',at,classification:'revenue',amountMsat:'1000',category:'routing'});
  const revisions=()=>new Set(s.all('SELECT id FROM canonical_projection_revisions').map(r=>r.id));const before=revisions();
  s.run("INSERT INTO decisions VALUES('d',?,?,'{}','{}','planned')",at,JSON.stringify({evidenceIds:[empty[0]]}));s.close();
  assert.throws(()=>run('apply'),(e:any)=>/Unexpected references/.test(String(e.stderr)));s=new Store(path);assert.deepEqual(revisions(),before);s.run("DELETE FROM decisions WHERE id='d'");s.close();
  const dry=run('dry');assert.deepEqual([dry.rollupRevisionsRemoved,dry.emptyHistoryCaptureRevisionsRemoved,dry.uiTextFramesRemoved,dry.applied],[29,20,4,false]);
  s=new Store(path);assert.deepEqual(revisions(),before);s.close();
  assert.equal(run('apply').applied,true);
  s=new Store(path);
  const after=revisions();assert.equal(after.size,before.size-49);for(const id of [kept,distinct,captured])assert.ok(after.has(id));for(const id of empty)assert.equal(after.has(id),false);
  assert.deepEqual(s.all("SELECT data FROM ui_events WHERE job_id='j'").map(r=>JSON.parse(r.data).text),['frame 5']);
  assert.equal(s.one("SELECT amount_msat FROM ledger WHERE id='fwd:kept'").amount_msat,'1000');assert.ok(s.one('SELECT id FROM canonical_observations WHERE id=?',observation));
  assert.equal(s.db.prepare('PRAGMA foreign_key_check').all().length,0);
  assert.throws(()=>s.run('DELETE FROM canonical_projection_revisions WHERE id=?',kept),/Immutable/);
  assert.deepEqual(run('dry'),{rollupRevisionsRemoved:0,emptyHistoryCaptureRevisionsRemoved:0,revisionBytesRemoved:0,uiTextFramesRemoved:0,uiTextBytesRemoved:0,applied:false});
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});
