import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store,UI_TEXT_FRAME_RETENTION_MS} from '../store.js';
import {CanonicalModel} from '../canonical-model.js';
import {NativeCollection} from '../native-collection.js';
import {NATIVE_POLICY_CONTRACT,NativePolicyCollector} from '../native-policy.js';
import {NativeLndSource} from '../native-lnd-source.js';
import {NATIVE_DELIVERY_ROLLUP_VERSION} from '../native-failure-aggregate.js';
import {RUNTIME_ARCHIVE_TABLES} from '../canonical-runtime.js';
import {decodeOriginal} from '../canonical-migration.js';
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

test('retention archives every node-sized snapshot byte-exactly before deleting it and keeps pinned, linked, recent and oversized ones',()=>{
 const s=new Store(':memory:');try{
  const at='2026-10-25T00:00:00.000Z',t0=Date.parse('2026-06-01T00:00:00.000Z'),inserted=new Map<string,string>();
  const snapshotRow=(i:number,extra:any={})=>JSON.stringify({at:new Date(t0+i*60000).toISOString(),identity,synced:true,confirmedSat:'900000',channels:channels.map((id,k)=>({id,point:'00'.repeat(32)+':'+k,peer:peer(k),alias:'peer-'+k,active:true,capacitySat:'5000000',localSat:String(2500000+i),remoteSat:'2400000',reserveSat:'50000',pendingSat:'0',baseMsat:'0',ppm:100,cltv:80,minMsat:'1000',maxMsat:'990000000'})),...extra});
  for(let i=0;i<450;i++){const content=snapshotRow(i);inserted.set('s'+i,content);s.run('INSERT INTO snapshots VALUES(?,?,?)','s'+i,new Date(t0+i*60000).toISOString(),content);}
  assert.ok(Number(s.one('SELECT avg(length(content)) n FROM snapshots').n)>4000);
  s.run('INSERT INTO snapshots VALUES(?,?,?)','pinned',new Date(t0).toISOString(),snapshotRow(0,{pinned:true}));
  s.run('INSERT INTO snapshots VALUES(?,?,?)','linked',new Date(t0).toISOString(),snapshotRow(0));s.run("INSERT INTO decisions VALUES('d',?,'{}','{}','{}','observing')",at);s.run("INSERT INTO operations VALUES('o','d',?,'SUCCEEDED',NULL,NULL,'{\"snapshotId\":\"linked\"}')",at);
  s.run('INSERT INTO snapshots VALUES(?,?,?)','recent',at,snapshotRow(1));
  for(let i=0;i<500;i++)s.event({id:'e'+i,at:new Date(t0).toISOString(),type:'external_forward',source:'1',target:'2',amountMsat:'1000',feeMsat:'1',details:{note:'x'.repeat(800)}});
  const archived=()=>new Map(s.all("SELECT original_id,raw_row FROM canonical_original_archive WHERE original_table='snapshots'").map(r=>[r.original_id,r.raw_row]));
  for(let call=0;call<30;call++){
   s.retain(at);
   // Invariant after every batch: a snapshot is either still in place or archived with its exact original row.
   const present=new Set(s.all('SELECT id FROM snapshots').map(r=>r.id)),copies=archived();
   for(const [id,content] of inserted)if(!present.has(id)){assert.ok(copies.has(id),id);const original=decodeOriginal(copies.get(id)!);assert.equal(original.content,content);assert.equal(original.id,id);}
  }
  assert.deepEqual(s.all('SELECT id FROM snapshots ORDER BY id').map(r=>r.id),['linked','pinned','recent']);assert.equal(archived().size,450);assert.equal(s.one('SELECT count(*) n FROM events').n,0);
  s.run('INSERT INTO snapshots VALUES(?,?,?)','huge',new Date(t0).toISOString(),snapshotRow(2,{padding:'y'.repeat(60000)}));s.run('INSERT INTO snapshots VALUES(?,?,?)','after-huge',new Date(t0).toISOString(),snapshotRow(3));
  for(let call=0;call<4;call++)s.canonical.retain(at,{maxBytes:50000});
  assert.ok(s.one("SELECT id FROM snapshots WHERE id='huge'"));assert.equal(archived().has('huge'),false);assert.equal(s.one("SELECT id FROM snapshots WHERE id='after-huge'"),undefined);assert.ok(archived().has('after-huge'));
 }finally{s.close();}
});

test('the minute archive scan leaves snapshots to retention and still reaches every other original table',async()=>{
 const s=new Store(':memory:');try{
  s.set('historyStart','2026-10-25T00:00:00.000Z');const n=node(s,'2026-10-25T01:00:00.000Z');
  for(let i=0;i<RUNTIME_ARCHIVE_TABLES.length*2;i++)await n.tick();
  const scopes=s.all("SELECT DISTINCT json_extract(details,'$.table') t FROM canonical_coverage WHERE capability='legacy_ingestion'").map(r=>r.t).sort();
  assert.deepEqual(scopes,[...RUNTIME_ARCHIVE_TABLES].sort());
  assert.equal(s.one("SELECT count(*) n FROM canonical_original_archive WHERE original_table='snapshots' AND source_instance='satssurge-operational-originals'").n,0);
  assert.ok(Number(s.one('SELECT count(*) n FROM snapshots').n)>=RUNTIME_ARCHIVE_TABLES.length*2);
  assert.equal(s.canonical.summary().runtimeScansComplete,true);
 }finally{s.close();}
});

test('oversized snapshot is passed over by its own size even when an event becomes eligible on every call',()=>{
 const s=new Store(':memory:');try{
  const at='2026-10-25T00:00:00.000Z',old='2026-06-01T00:00:00.000Z';
  s.run('INSERT INTO snapshots VALUES(?,?,?)','huge',old,JSON.stringify({padding:'y'.repeat(30000)}));s.run('INSERT INTO snapshots VALUES(?,?,?)','after-huge',old,'{}');
  for(let call=0;call<4;call++){s.event({id:'late-'+call,at:old,type:'external_forward',source:'1',target:'2',amountMsat:'1000',feeMsat:'1',details:{note:'x'.repeat(2000)}});s.canonical.retain(at,{maxBytes:50000});}
  assert.ok(s.one("SELECT id FROM snapshots WHERE id='huge'"));assert.equal(s.one("SELECT id FROM snapshots WHERE id='after-huge'"),undefined);
  assert.ok(s.one("SELECT id FROM canonical_original_archive WHERE original_table='snapshots' AND original_id='after-huge'"));assert.equal(s.one("SELECT id FROM canonical_original_archive WHERE original_id='huge'"),undefined);
  assert.equal(s.one('SELECT count(*) n FROM events').n,0);
 }finally{s.close();}
});

test('production NativeLndSource policy reuse keys on the whole raw ChanInfo checksum',async()=>{
 const s=new Store(':memory:');let raw:any={channel_id:'1',chan_point:'00'.repeat(32)+':0',capacity:'5000000',last_update:1760000000,node1_pub:identity,node2_pub:peer(1),node1_policy:policy(100),node2_policy:policy(200)};
 const transport:any={getInfo:async()=>({identity_pubkey:identity,version:binding.sourceVersion,chains:[{chain:'bitcoin',network:'mainnet'}]}),getChanInfo:async()=>raw,forwardingHistory:async()=>({}),listPayments:async()=>({}),listChannels:async()=>({}),subscribeChannelGraph:async()=>{},subscribeHtlcEvents:async()=>{}};
 const source=new NativeLndSource({transport,...binding,chain:'bitcoin'});let t=Date.parse('2026-10-25T00:00:00.000Z');
 try{
  const collector=new NativePolicyCollector(new CanonicalModel(s.db),source,()=>new Date(t+=1000).toISOString());
  const rows=()=>s.all("SELECT payload FROM canonical_observations WHERE kind='native_policy' ORDER BY rowid").map(r=>JSON.parse(r.payload));
  const first=await collector.snapshot({captureId:'c0',channelIds:['1']});assert.ok(rows().every(p=>p.checksumScope==='raw_lnd_channel_info'));const before=counts(s);
  for(let i=1;i<=3;i++){const r=await collector.snapshot({captureId:'c'+i,channelIds:['1']});assert.equal(r.checkpointId,null);assert.ok(r.receipts.every(x=>x.unchanged===true));assert.deepEqual(r.receipts.map(x=>x.observationId),first.receipts.map(x=>x.observationId));}
  assert.deepEqual(counts(s),before);
  // The peer's direction changes the raw checksum shared by both directions: both are re-recorded, only one has changed fields.
  raw={...raw,node2_policy:policy(250)};const changed=await collector.snapshot({captureId:'peer',channelIds:['1']});assert.ok(changed.receipts.every(x=>x.unchanged===undefined));
  assert.deepEqual(rows().slice(-2).map(p=>[p.direction,p.changedFields]),[['outgoing',[]],['incoming',['feeRatePpm']]]);
  // Fields outside the policy allowlist still change the raw response checksum.
  raw={...raw,capacity:'6000000'};await collector.snapshot({captureId:'capacity',channelIds:['1']});assert.deepEqual(rows().slice(-2).map(p=>p.changedFields),[[],[]]);
  const steady=counts(s);await collector.snapshot({captureId:'steady',channelIds:['1']});assert.deepEqual(counts(s),steady);
 }finally{source.shutdown();s.close();}
});
