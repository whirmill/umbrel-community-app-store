import {FollowUps} from '../follow-up.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../store.js';
import {Queue} from '../queue.js';
import {AutomaticAdmission} from '../automatic-admission.js';
import {ReviewWaits} from '../review-waits.js';
import {EvidenceViews} from '../evidence-views.js';
import {evidenceSource} from '../evidence-source.js';
import {Research,REQUIRED_RESEARCH} from '../research.js';
import {publicJob} from '../public-job.js';
import {analystFeed} from '../analysis-feed.js';
import {accountingPartition} from '../accounting.js';
import {scrub,hash,MANDATE} from '../domain.js';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const scope='0x0x1->0x0x2';
function event(s:Store,i:number,type='external_forward',source='1',target='2',baseline=false){s.event({id:type+':'+i,at:'2026-01-01T00:00:00Z',type,source,target,amountMsat:'1000',feeMsat:'2',baseline});}
function terminal(s:Store,id:string){s.run("UPDATE jobs SET state='completed' WHERE id=?",id);}
test('atomic gate: four ingresses, true48h due consumed once, midrun late forwards, exact corridor and rolling quota',()=>{
 const s=new Store(':memory:'),q=new Queue(s);let time=Date.parse('2026-10-09T00:00:00Z');const a=new AutomaticAdmission(q,()=>time),w=new ReviewWaits(s,()=>time);
 const first=a.admit(scope,'analyst')!;for(let i=0;i<4;i++)assert.equal(a.admit('1->2','analyst'),undefined);
 w.register({scope,origin:'agent:'+first.id,evidenceIds:[],missing:['48h'],dueAt:new Date(time+48*3600000).toISOString()});terminal(s,first.id);
 time+=25*3600000;assert.equal(a.admit(scope,'analyst'),undefined,'No daily early trigger');
 time+=23*3600000;const due=a.admit(scope,'analyst')!;assert.ok(due);terminal(s,due.id);assert.equal(a.admit(scope,'analyst'),undefined);
 for(let i=0;i<9;i++)event(s,i);assert.equal(a.admit(scope,'analyst'),undefined);event(s,9,'external_forward','1','3');assert.equal(a.admit(scope,'analyst'),undefined);event(s,10);const late=a.admit(scope,'analyst')!;assert.ok(late);
 event(s,20,'manual_policy');assert.equal(a.admit(scope,'analyst'),undefined);terminal(s,late.id);const manual=a.admit(scope,'analyst')!;assert.ok(manual);terminal(s,manual.id);
 event(s,21,'manual_policy');const fourth=a.admit(scope,'analyst')!;assert.ok(fourth);terminal(s,fourth.id);event(s,22,'manual_policy');assert.equal(a.admit(scope,'analyst'),undefined);
 const owner=q.enqueue({requestId:'owner',kind:'chat',origin:'owner',payload:{message:'owner'}});s.set('bootstrapReady',true);assert.equal(q.claim('coordinator','test')!.id,owner.id);
 time+=86400000;assert.ok(a.admit(scope,'analyst'),'Pending overflow admits on exact24h boundary');s.close();
});
test('baseline, duplicate, retention never replace monotonic ingestion; queuefull/crash keep admission pending',()=>{
 const s=new Store(':memory:'),q=new Queue(s,1),a=new AutomaticAdmission(q);event(s,1,'manual_policy','1','2',true);
 const first=a.admit(scope,'analyst')!;event(s,2,'manual_policy');event(s,2,'manual_policy');assert.equal(s.one('SELECT count(*) n FROM event_ingestion').n,2);
 terminal(s,first.id);q.enqueue({requestId:'owner',kind:'chat',payload:{}});const before=s.one('SELECT * FROM automatic_scopes WHERE scope=?',scope);assert.throws(()=>a.admit(scope,'analyst'),/Queue full/);assert.deepEqual(s.one('SELECT * FROM automatic_scopes WHERE scope=?',scope),before);
 s.run("UPDATE jobs SET state='completed'");const original=q.enqueueWithinTransaction.bind(q);q.enqueueWithinTransaction=()=>{throw Error('mock crash before commit');};assert.throws(()=>a.admit(scope,'analyst'),/mock crash/);assert.deepEqual(s.one('SELECT * FROM automatic_scopes WHERE scope=?',scope),before);q.enqueueWithinTransaction=original;assert.ok(a.admit(scope,'analyst'));
 s.retain('2026-10-09T00:00:00Z');assert.equal(s.one('SELECT count(*) n FROM events').n,0);event(s,2,'manual_policy');assert.equal(s.one('SELECT count(*) n FROM event_ingestion').n,2);event(s,3,'manual_policy');assert.ok(s.one('SELECT max(sequence) n FROM event_ingestion').n>2);s.close();
});
test('103-row immutable pages inherit full query, durable restart and semantic coverage digest',()=>{
 const s=new Store(':memory:');for(let i=0;i<103;i++)event(s,i);
 let v=new EvidenceViews(Date.now,900000,4e6,16e6,s);const query={section:'corridor_events' as const,source:'1',target:'2',start:'2025-01-01',end:'2027-01-01'};
 let p:any=v.page('job',evidenceSource(s,query),query);assert.equal(p.total,103);assert.equal(p.summary.groups[0].feeMsat,'206');const cursor=p.cursor,version=p.version;const seen=new Set(p.rows.map((r:any)=>r.id));
 v=new EvidenceViews(Date.now,900000,4e6,16e6,s);
 while(p.nextOffset!==null){p=v.page('job',{}, {section:'corridor_events',cursor,offset:p.nextOffset});for(const r of p.rows)seen.add(r.id);assert.equal(p.version,version);}
 assert.equal(seen.size,103);assert.throws(()=>v.page('other',{}, {section:'corridor_events',cursor}),/another job/);assert.throws(()=>v.page('job',{}, {section:'corridor_events',cursor,source:'3'}),/another query/);
 s.run('INSERT INTO coverage VALUES(?,?,?,?,?,?)','c','2025-01-01','2027-01-01','LND forwards',1,'{}');const fresh:any=v.page('job',evidenceSource(s,query),query);assert.notEqual(fresh.version,version,'Coverage is semantic material');assert.throws(()=>evidenceSource(s,{section:'coverage',channel:'1'}),/Unsupported/);s.close();
});
test('required manifest, repeated page no progress, bounded fresh analyst segments, refresh truth and read-only admission',()=>{
 const s=new Store(':memory:'),q=new Queue(s),r=new Research(s);let j=q.enqueue({requestId:'research',kind:'autonomy',origin:'scheduler',purpose:'economic',payload:{}});r.initialize(j);r.state(j);r.state(j);assert.equal(r.get(j.id).progress,1);
 const p={available:true,total:103,offset:0,nextOffset:20,rows:[{id:'a'}],version:'semantic',cursor:'random1'};
 r.page(j,{section:'channels'},p);const progress=r.get(j.id).progress;r.page(j,{section:'channels',cursor:'random2'},p);assert.equal(r.get(j.id).progress,progress);
 terminal(s,j.id);const next=r.continue(q,q.get(j.id)!)!;assert.equal(r.continue(q,q.get(j.id)!)!.id,next.id);assert.equal(next.lane,'analyst');assert.equal(next.submitted,0);assert.equal(next.conversation_id,null);assert.equal(s.get('jobCapability:'+next.id),'read_only_research');
 r.initialize(next);r.page(next,{section:'channels',offset:20},{...p,offset:20,nextOffset:40});terminal(s,next.id);const third=r.continue(q,q.get(next.id)!)!;r.initialize(third);r.page(third,{section:'channels',offset:40},{...p,offset:40,nextOffset:60});terminal(s,third.id);assert.equal(r.status(third.id).researchStatus,'blocked');assert.equal(r.continue(q,q.get(third.id)!),undefined);
 assert.equal(publicJob(s,q.get(third.id)).researchStatus,'blocked');assert.equal(analystFeed(s)[0]!.complete,false);assert.ok(REQUIRED_RESEARCH.includes('alternatives'));s.close();
});
test('two axes exact ledger partition preserves2322358revenue10705169cost; annotations never book costs; nested secrets scrub',()=>{
 const s=new Store(':memory:');s.ledger({id:'routing',at:'2026-10-09',classification:'revenue',amountMsat:'364358',category:'routing'});s.ledger({id:'swap',at:'2026-10-09',classification:'revenue',amountMsat:'1958000',details:{scope:'swap'}});s.ledger({id:'cost',at:'2026-10-09',classification:'expense',amountMsat:'10705169'});
 const before=s.stats();assert.equal(before.cumulative.revenueMsat,'2322358');assert.equal(before.cumulative.costMsat,'10705169');assert.equal(before.accounting.sectors.routing!.revenueMsat,'364358');assert.equal(before.accounting.sectors.swap!.revenueMsat,'1958000');assert.equal(before.accounting.routingContributionMsat,null);
 s.annotateLedger('cost','swap','verified','original swap receipt');s.annotateLedger('cost','routing','shared','correction receipt');assert.deepEqual(s.stats().cumulative,before.cumulative);assert.deepEqual(s.budget(),before.budget);s.set('subscriptionCostMsat','0');s.set('historicalCoverageComplete',true);assert.equal(s.stats().partial,true);
 assert.doesNotMatch(JSON.stringify(scrub({nested:JSON.stringify({secret:'SYNTHETIC',oauth:{token:'SYNTHETIC2'}})})),/SYNTHETIC/);s.close();
});
test('authentic0.4.0 DDL migration preserves ledger, mandate, enabled, reservations, receipt and durable IDs; idempotent reopen',()=>{
 const dir=mkdtempSync(join(tmpdir(),'migration040-')),path=join(dir,'operational.sqlite');try{
  const db=new DatabaseSync(path);db.exec(readFileSync('src/test/fixtures/schema-040.sql','utf8'));assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,4);
  db.prepare('INSERT INTO meta VALUES(?,?)').run('enabled','false');db.prepare('INSERT INTO meta VALUES(?,?)').run('mandate',JSON.stringify(MANDATE));db.prepare('INSERT INTO ledger VALUES(?,?,?,?,?,?,?,?)').run('original','2026-10-09','expense','0','ordinary',null,null,'{}');
  db.prepare('INSERT INTO decisions VALUES(?,?,?,?,?,?)').run('decision','2026-10-09',JSON.stringify({category:'ordinary',source:'1',target:'2',evidenceIds:[]}),JSON.stringify({benefitMsat:'10'}),JSON.stringify(MANDATE),'observing');
  db.prepare('INSERT INTO operations VALUES(?,?,?,?,?,?,?)').run('uncertain-operation','decision','2026-10-09','uncertain','synthetic-hash',null,'{}');
  db.prepare('INSERT INTO reservations VALUES(?,?,?,?,?,?,?,?,?)').run('uncertain-operation','2026-10-09','10','100','ordinary','1','2','corridor',1);
  db.prepare('INSERT INTO jobs(id,request_id,kind,lane,priority,payload,payload_digest,scope,state,created_at,updated_at,submitted,conversation_id,submission_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('old-job','old-request','autonomy','coordinator',0,'{}',hash('{}'),'','waiting','2026-10-09','2026-10-09',1,'42','43');db.prepare('INSERT INTO job_events VALUES(?,?,?,?,?)').run('accepted','old-job','2026-10-09','accepted',JSON.stringify({origin:'scheduler',purpose:'economic'}));db.close();
  let s=new Store(path);assert.equal(s.get('enabled'),false);assert.deepEqual(s.get('mandate'),MANDATE);assert.equal(s.one('SELECT * FROM operations').payment_hash,'synthetic-hash');assert.equal(s.one('SELECT * FROM operations').state,'uncertain');assert.equal(s.one('SELECT * FROM reservations').active,1);assert.equal(s.budget().cumulativeMsat,'10');const old=s.one('SELECT * FROM jobs WHERE id=?','old-job');assert.equal(old.submission_id,'43');assert.equal(old.conversation_id,'42');assert.equal(s.one('SELECT * FROM ledger').amount_msat,'0');assert.equal(new AutomaticAdmission(new Queue(s)).admit('node','coordinator'),undefined);const generation=s.one('SELECT generation FROM automatic_scopes').generation;s.close();s=new Store(path);assert.equal(s.one('SELECT generation FROM automatic_scopes').generation,generation);assert.deepEqual(s.one('SELECT * FROM jobs WHERE id=?','old-job'),old);s.close();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('narrow interval and changed page cannot certify full manifest; elapsed/usage freezes after terminal budget',()=>{
 const s=new Store(':memory:'),q=new Queue(s),r=new Research(s),j=q.enqueue({requestId:'scope-proof',kind:'analysis',scope,origin:'scheduler',purpose:'economic',payload:{}});r.initialize(j);
 const narrow=r.query(j,{section:'corridor_events',start:'2026-10-08T00:00:00Z'});r.page(j,narrow,{available:true,total:0,rows:[],offset:0,nextOffset:null,version:'narrow'});assert.ok(r.status(j.id).researchGaps.some((g:any)=>g.section.startsWith('corridor_events:')));
 const full=r.query(j,{section:'corridor_events'});r.page(j,full,{available:true,changed:true,rows:[],nextOffset:null,version:'changed'});assert.ok(r.status(j.id).researchGaps.some((g:any)=>g.section.startsWith('corridor_events:')));assert.equal(r.status(j.id).researchStatus,'partial');
 s.set('runBudget:'+j.id,{started:0,calls:12,hardMs:180000,researchCalls:12,endedMs:8000,usage:{input:1,output:2}});assert.equal(r.status(j.id).researchProgress!.aggregate.elapsedMs,8000);assert.equal(r.status(j.id).researchProgress!.aggregate.calls,12);s.close();
});

test('first automatic generation honors owner48h future wait and admits mature due exactlyonce',()=>{const s=new Store(':memory:'),q=new Queue(s);let time=Date.parse('2026-10-09T00:00:00Z');const waits=new ReviewWaits(s,()=>time),a=new AutomaticAdmission(q,()=>time);waits.register({scope,origin:'owner',evidenceIds:[],missing:['48h'],dueAt:new Date(time+48*3600000).toISOString()});assert.equal(a.admit(scope,'analyst'),undefined);time+=25*3600000;assert.equal(a.admit(scope,'analyst'),undefined);time+=23*3600000;const due=a.admit(scope,'analyst')!;assert.ok(due);terminal(s,due.id);assert.equal(a.admit(scope,'analyst'),undefined);s.close();});

test('manual-trigger successor preserves unconsumed48h deadline; mature owned successor renews with CAS',()=>{const s=new Store(':memory:'),q=new Queue(s);let time=Date.parse('2026-10-09T00:00:00Z');const a=new AutomaticAdmission(q,()=>time),f=new FollowUps(s,()=>time),waits=new ReviewWaits(s,()=>time);const submitted=(id:string)=>{s.run("UPDATE jobs SET submitted=1,submission_id=? WHERE id=?",'submission:'+id,id);return q.get(id)!;};const first=a.admit(scope,'analyst')!;const original=new Date(time+48*3600000).toISOString();f.record(submitted(first.id),{outcome:'wait',scope,dueAt:original,evidenceIds:[],missing:['48h']});terminal(s,first.id);time+=3600000;event(s,100,'manual_policy');const manual=a.admit(scope,'analyst')!;f.record(submitted(manual.id),{outcome:'wait',scope,dueAt:new Date(time+48*3600000).toISOString(),evidenceIds:[],missing:['48h']});assert.equal(waits.get(scope)!.dueAt,original);terminal(s,manual.id);time+=47*3600000;const mature=a.admit(scope,'analyst')!;const fresh=new Date(time+48*3600000).toISOString();f.record(submitted(mature.id),{outcome:'wait',scope,dueAt:fresh,evidenceIds:[],missing:['next interval']});assert.equal(waits.get(scope)!.dueAt,fresh);assert.equal(waits.get(scope)!.consumedTrigger,null);f.record(submitted(first.id),{outcome:'no_wait',scope,evidenceIds:[],missing:[]});assert.equal(waits.get(scope)!.dueAt,fresh);s.close();});

test('node automatic wait is independent of corridor deadlines; ingestion reads aggregate only pending relevant sequences',()=>{
 const s=new Store(':memory:'),q=new Queue(s);let time=Date.parse('2026-10-09T00:00:00Z');const a=new AutomaticAdmission(q,()=>time),waits=new ReviewWaits(s,()=>time);
 waits.register({scope,origin:'owner',evidenceIds:[],missing:['48h'],dueAt:new Date(time+48*3600000).toISOString()});const node=a.admit('node','coordinator')!;assert.ok(node,'Corridor wait does not block first node review');terminal(s,node.id);assert.equal(a.admit(scope,'analyst'),undefined);
 time+=49*3600000;assert.equal(a.admit('node','coordinator'),undefined,'Mature corridor deadline is not a node trigger');assert.ok(a.admit(scope,'analyst'));
 const original=s.all.bind(s);s.all=(sql:string,...args:any[])=>{assert.ok(!sql.includes('FROM event_ingestion'),'Historical signal rows must never materialize');return original(sql,...args);};for(let i=0;i<10;i++)event(s,200+i);assert.ok(a.admit('node','coordinator'));s.close();
});
