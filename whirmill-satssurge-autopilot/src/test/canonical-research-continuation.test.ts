import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../store.js';
import {Queue,type Job} from '../queue.js';
import {Research} from '../research.js';
import {EvidenceViews,boundedEvidenceEnvelope,type EvidenceQuery} from '../evidence-views.js';
import {evidenceSource} from '../evidence-source.js';
import {digest} from '../canonical-model.js';
const at='2026-10-12T10:00:00.000Z',key='diagnostics:lightningMate:rebalances';
const target:EvidenceQuery={section:'diagnostics',provider:'lightningMate',collection:'rebalances'};
function context(path:string){const s=new Store(path);return {s,queue:new Queue(s),research:new Research(s),views:new EvidenceViews(Date.now,300000,4*1024*1024,16*1024*1024,s)};}
type Context=ReturnType<typeof context>;
function consume(c:Context,job:Job,input:EvidenceQuery){const q=c.research.query(job,input),raw=c.views.page(c.research.get(job.id).researchId,q.cursor?{}:evidenceSource(c.s,q),q),{page,result}=boundedEvidenceEnvelope(raw,{phase:'research'},'_analyst');assert.ok(Buffer.byteLength(JSON.stringify(result))<=12000);c.research.page(job,q,page);return page;}
function setup(c:Context,found:boolean,unavailable=405){
 const capture={status:'qualified',version:'0.7.7',capturedAt:at,failures:[],...(found?{rebalances:Array.from({length:405},(_,i)=>({id:'old-'+i,at,status:'requested',source:'1',target:'2',privateToken:'synthetic-private'}))}:{})};c.s.set('enabled',false);c.s.set('snapshot',{at,channels:[]});c.s.set('diagnostics',{at,lightningMate:capture});
 for(let i=0;i<unavailable;i++)c.s.set('diagnostics',{at:new Date(Date.parse(at)+1000+i*1000).toISOString(),lightningMate:{status:'unavailable'},lndg:{status:'qualified',version:'1.11.1',capturedAt:at,forwards:[],failures:[],failureRollups:[],rebalances:[]}});
 const job=c.queue.enqueue({requestId:'canonical-search-'+found,kind:'analysis',origin:'scheduler',purpose:'economic',payload:{}});c.research.initialize(job);c.research.state(job);c.research.alternatives(job,{wait:'observe',priceChange:'read only',smallerRebalance:'read only',proposedAction:'hold'});
 for(const required of c.research.get(job.id).required){if(['state_budget','alternatives',key].includes(required))continue;const [section,provider,collection]=required.split(':');let q:any={section,...(provider?{provider,collection}:{})};for(let n=0;n<1000;n++){const page=consume(c,job,q);if(!page.nextCall)break;q=page.nextCall.query;}assert.equal(c.research.get(job.id).sections[required].done,true,required);c.views.release(job.id);}
 c.s.run("DELETE FROM meta WHERE key LIKE 'canonicalDiagnosticLookup:%'");return {job,capture};
}
function terminalContinuation(c:Context,job:Job){c.s.run("UPDATE jobs SET state='completed' WHERE id=?",job.id);assert.equal(c.research.status(job.id).researchStatus,'partial');const next=c.research.continue(c.queue,c.queue.get(job.id)!)!;assert.ok(next);assert.equal(c.research.continue(c.queue,c.queue.get(job.id)!)!.id,next.id);assert.equal(c.s.get('jobCapability:'+next.id),'read_only_research');c.research.initialize(next);return next;}
test('R4 actual consumers: pending lookup persists across reopen and terminal continuation before finding pinned pages',()=>{
 const dir=mkdtempSync(join(tmpdir(),'research-search-found-')),path=join(dir,'operational.sqlite');let c=context(path);let owner:string|undefined;
 try{const {job,capture}=setup(c,true);owner=job.id;const initial=consume(c,job,target);assert.equal(initial.searching,true);assert.equal(initial.available,false);assert.equal(c.research.get(job.id).sections[key].done,false);assert.deepEqual(c.research.get(job.id).sections[key].nextCall,initial.nextCall);assert.equal(c.research.get(job.id).sections[key].processedPreviousChunks,0);let next=terminalContinuation(c,job);c.s.close();c=context(path);let q=c.research.get(next.id).sections[key].nextCall.query;
 const pending=consume(c,next,q);assert.equal(pending.searching,true);assert.notEqual(pending.nextCall.query.sourceCursor,initial.nextCall.query.sourceCursor);assert.equal(c.research.get(next.id).sections[key].processedPreviousChunks,0);next=terminalContinuation(c,next);q=c.research.get(next.id).sections[key].nextCall.query;c.s.close();c=context(path);
 const ids:string[]=[];let firstDigest:string|undefined,found=false;for(let n=0;n<1000;n++){const page=consume(c,next,q);if(page.available){found=true;firstDigest??=page.metadata.providerCaptureDigest;ids.push(...page.rows.map((r:any)=>r.id));assert.equal(c.research.get(next.id).sections[key].sourceChainQualified,true);assert.equal(JSON.stringify(page).includes('synthetic-private'),false);if(ids.length===page.rows.length)c.s.set('diagnostics',{at:'2026-10-12T12:00:00Z',lightningMate:{status:'qualified',version:'0.7.7',capturedAt:'2026-10-12T12:00:00Z',rebalances:[{id:'replacement'}]}});}if(!page.nextCall)break;q=page.nextCall.query;if(q.offset===0)c.views.release(owner);}
 assert.equal(found,true);assert.equal(firstDigest,digest(capture));assert.deepEqual(ids,capture.rebalances!.map(r=>r.id));const record=c.research.get(next.id).sections[key];assert.equal(record.done,true);assert.equal(record.sourceChainQualified,true);assert.equal(record.processedPreviousChunks,2);assert.equal(c.research.status(next.id).researchStatus,'complete');assert.equal(c.s.one('SELECT count(*) n FROM operations').n,0);assert.equal(c.s.get('enabled'),false);
 }finally{if(owner)c.views.release(owner);c.s.close();rmSync(dir,{recursive:true});}
});
test('R4 actual consumers: pending lookup becomes exhausted unknown after reopen, never before all batches',()=>{
 const dir=mkdtempSync(join(tmpdir(),'research-search-empty-')),path=join(dir,'operational.sqlite');let c=context(path);let owner:string|undefined;
 try{const {job}=setup(c,false);owner=job.id;let page=consume(c,job,target);assert.equal(page.searching,true);let next=terminalContinuation(c,job);c.s.close();c=context(path);page=consume(c,next,c.research.get(next.id).sections[key].nextCall.query);assert.equal(page.searching,true);assert.equal(c.research.get(next.id).sections[key].done,false);next=terminalContinuation(c,next);c.s.close();c=context(path);page=consume(c,next,c.research.get(next.id).sections[key].nextCall.query);assert.equal(page.searching,undefined);assert.equal(page.available,false);assert.equal(page.rows,null);const record=c.research.get(next.id).sections[key];assert.equal(record.done,true);assert.equal(record.available,false);assert.equal(record.sourceChainQualified,true);assert.equal(record.processedPreviousChunks,0);assert.equal(record.nextCall,null);assert.equal(c.research.status(next.id).researchStatus,'complete');assert.ok(c.research.status(next.id).researchGaps.some((g:any)=>g.section===key));c.s.run("UPDATE jobs SET state='completed' WHERE id=?",next.id);assert.equal(c.research.continue(c.queue,c.queue.get(next.id)!),undefined);
 }finally{if(owner)c.views.release(owner);c.s.close();rmSync(dir,{recursive:true});}
});
test('lookup continuations reject altered scope/position and stale order without crediting processed data',()=>{
 const c=context(':memory:');let owner:string|undefined;try{const {job}=setup(c,true);owner=job.id;const first=consume(c,job,target),saved=c.research.get(job.id),progress=saved.progress;
 c.research.page(job,target,first);assert.equal(c.research.get(job.id).progress,progress,'Identical pending receipt replay is not progress');
 assert.throws(()=>evidenceSource(c.s,{...first.nextCall.query,collection:'failures'}),/scope/);
 assert.throws(()=>c.research.page(job,target,{...first,nextCall:{...first.nextCall,query:{...first.nextCall.query,provider:'lndg'}}}),/scope/);
 assert.throws(()=>c.research.page(job,target,{...first,nextCall:{...first.nextCall,query:{...first.nextCall.query,sourceCursor:Buffer.from(JSON.stringify({scopeHash:'wrong',after:0,through:0,lookupProgress:first.lookupProgress})).toString('base64url')}}}),/position/);
 assert.equal(c.research.get(job.id).progress,progress);const second=consume(c,job,first.nextCall.query);assert.equal(second.searching,true);assert.notEqual(second.nextCall.query.sourceCursor,first.nextCall.query.sourceCursor);
 const stale=consume(c,job,first.nextCall.query);assert.equal(stale.available,true);const record=c.research.get(job.id).sections[key];assert.equal(record.sourceChainQualified,false);assert.equal(record.done,false);assert.equal(record.processedPreviousChunks,0);assert.match(record.reason,/saved order/);
 }finally{if(owner)c.views.release(owner);c.s.close();}
});
test('real view capacity, changed version and expiry remain incomplete and distinct from archive absence',()=>{
 const c=context(':memory:');let owner:string|undefined;try{const job=c.queue.enqueue({requestId:'view-limits',kind:'analysis',origin:'scheduler',purpose:'economic',payload:{}});owner=job.id;c.research.initialize(job);c.s.set('snapshot',{at,channels:[{id:'1'}]});const q:EvidenceQuery={section:'channels'},source=evidenceSource(c.s,q);
 const capacity=new EvidenceViews(Date.now,300000,1,1).page(job.id,source,q);assert.equal((capacity as any).capacity,true);c.research.page(job,q,capacity);assert.equal(c.research.get(job.id).sections.channels.done,false);assert.equal(c.research.get(job.id).sections.channels.lookupPending,false);
 const changed=c.views.page(job.id,source,{...q,version:'unknown-version'});assert.equal((changed as any).changed,true);c.research.page(job,{...q,version:'unknown-version'},changed);assert.equal(c.research.get(job.id).sections.channels.done,false);
 let clock=Date.now();const expiring=new EvidenceViews(()=>clock,1),first:any=expiring.page(job.id,source,q);clock+=2;const expired:any=expiring.page(job.id,{}, {...q,cursor:first.cursor});assert.equal(expired.expired,true);c.research.page(job,{...q,cursor:first.cursor},expired);assert.equal(c.research.get(job.id).sections.channels.done,false);assert.equal(c.research.get(job.id).sections.channels.available,false);assert.equal(c.research.get(job.id).sections.channels.nextCall,null);expiring.release(job.id);
 }finally{if(owner)c.views.release(owner);c.s.close();}
});
test('pending lookup respects the existing aggregate research cap without declaring completion',()=>{
 const c=context(':memory:');let owner:string|undefined;try{const {job}=setup(c,false);owner=job.id;const page=consume(c,job,target);assert.equal(page.searching,true);c.s.set('runBudget:'+job.id,{calls:72,researchCalls:36,started:Date.now(),hardMs:180000,endedMs:100,usage:{available:false}});c.s.run("UPDATE jobs SET state='completed' WHERE id=?",job.id);assert.equal(c.research.status(job.id).researchStatus,'blocked');assert.equal(c.research.get(job.id).sections[key].done,false);assert.deepEqual(c.research.get(job.id).sections[key].nextCall,page.nextCall);assert.equal(c.research.continue(c.queue,c.queue.get(job.id)!),undefined);
 }finally{if(owner)c.views.release(owner);c.s.close();}
});
