import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../store.js';
import {Queue} from '../queue.js';
import {Scheduler,ModelUnavailable} from '../scheduler.js';

function ready(path=':memory:'){const s=new Store(path);s.set('bootstrapReady',true);return {s,q:new Queue(s)};}
test('queue atomically admits duplicates and refuses ID payload conflicts',()=>{
  const {s,q}=ready();const a=q.enqueue({requestId:'user:one',kind:'chat',payload:{message:'read'}});
  assert.equal(q.enqueue({requestId:'user:one',kind:'chat',payload:{message:'read'}}).id,a.id);
  assert.throws(()=>q.enqueue({requestId:'user:one',kind:'chat',payload:{message:'write'}}),/conflicts/);
  const first=q.claim('coordinator','owner');assert.equal(first?.id,a.id);assert.equal(q.claim('coordinator','second'),undefined);
  assert.equal(q.finish(a.id,'wrong','completed','bad'),false);assert.equal(q.finish(a.id,first!.run_token!,'completed',{answer:'ok'}),true);
  assert.equal(q.get(a.id)?.state,'completed');s.close();
});
test('restart retains queue and reacquires original durable submission',()=>{
  const dir=mkdtempSync(join(tmpdir(),'surge-queue-')),path=join(dir,'state.sqlite');let {s,q}=ready(path);
  const job=q.enqueue({requestId:'crash:one',kind:'chat',payload:{message:'review'}});const claimed=q.claim('coordinator','old')!;
  q.bindConversation(job.id,claimed.run_token!,'15');q.markSubmitted(job.id,claimed.run_token!,'29');s.close();
  ({s,q}=ready(path));q.recoverAfterRestart();assert.equal(q.get(job.id)?.state,'waiting');assert.equal(q.get(job.id)?.submission_id,'29');
  const recovered=q.claim('coordinator','new')!;assert.equal(recovered.id,job.id);assert.notEqual(recovered.run_token,claimed.run_token);
  assert.equal(q.finish(job.id,claimed.run_token!,'completed',{}),false);assert.equal(recovered.attempts,2);s.close();rmSync(dir,{recursive:true});
});
test('pause and backpressure are explicit; event bursts coalesce',()=>{
  const {s}=ready(),q=new Queue(s,2);const a=q.enqueue({requestId:'event:1',kind:'events',payload:{message:'events'},coalesceKey:'event-corridor'});
  assert.equal(q.enqueue({requestId:'event:2',kind:'events',payload:{message:'new events'},coalesceKey:'event-corridor'}).id,a.id);
  q.enqueue({requestId:'user:1',kind:'chat',payload:{message:'chat'}});assert.throws(()=>q.enqueue({requestId:'user:2',kind:'chat',payload:{message:'chat'}}),/full/);
  s.set('enabled',false);assert.equal(q.claim('coordinator','owner'),undefined);assert.equal(q.cancel(a.id),true);assert.equal(q.get(a.id)?.state,'cancelled');s.close();
});
test('aged maintenance is not starved by new user requests',()=>{
  const {s,q}=ready();const old='2026-10-08T00:00:00Z',current='2026-10-08T04:00:00Z';
  const task=q.enqueue({requestId:'scheduled',kind:'autonomy',payload:{message:'review'}},old);q.enqueue({requestId:'chat',kind:'chat',payload:{message:'hello'}},current);
  assert.equal(q.claim('coordinator','owner',current)?.id,task.id);s.close();
});
test('pool is bounded to two analysts and one coordinator during concurrent pump calls',async()=>{
  const {s,q}=ready();for(let n=0;n<3;n++)q.enqueue({requestId:'a:'+n,kind:'analysis',payload:{message:'read'}});
  q.enqueue({requestId:'chat',kind:'chat',payload:{message:'read'}});
  let release!:()=>void;const gate=new Promise<void>(r=>release=r);let analysts=0,coordinator=0;
  const pump=new Scheduler(q,{available:async()=>true,runJob:async(_job,slot)=>{if(slot===undefined)coordinator++;else analysts++;await gate;return {answer:'done'};}});
  await Promise.all([pump.pump(),pump.pump(),pump.pump()]);assert.equal(analysts,2);assert.equal(coordinator,1);
  pump.stop();release();await new Promise(r=>setTimeout(r,10));assert.equal(q.list().filter(j=>j.state==='completed').length,3);s.close();
});
test('missing quota retains admitted requests and recovery never steals a running lease',async()=>{
  const {s,q}=ready();const task=q.enqueue({requestId:'quota',kind:'chat',payload:{message:'read'}});
  let available=false;const scheduler=new Scheduler(q,{available:async()=>available,runJob:async()=>{throw new ModelUnavailable('quota');}});
  await scheduler.pump();assert.equal(q.get(task.id)?.state,'queued');available=true;await scheduler.pump();await new Promise(r=>setTimeout(r,10));
  assert.equal(q.get(task.id)?.state,'waiting');assert.equal(q.get(task.id)?.wait_reason,'model_unavailable');scheduler.stop();s.close();
});

test('scheduled backlog defers work without crashing and event bursts use a single receipt',()=>{
  const {s}=ready();s.event({id:'fwd:one',at:new Date().toISOString(),type:'external_forward',source:'1',target:'2',amountMsat:'1000',feeMsat:'1'});
  const q=new Queue(s,1),scheduler=new Scheduler(q,{available:async()=>false,runJob:async()=>({})});
  scheduler.tick();assert.equal(q.list().length,1);assert.match(s.get<any>('queueBackpressure').reason,/deferred/);assert.equal(s.get('queuedEventCursor'),undefined);
  scheduler.stop();s.close();
  const second=ready(),q2=second.q;
  second.s.event({id:'fwd:one',at:new Date().toISOString(),type:'external_forward',source:'1',target:'2',amountMsat:'1000',feeMsat:'1'});
  const scheduler2=new Scheduler(q2,{available:async()=>false,runJob:async()=>({})});scheduler2.tick();scheduler2.tick();
  assert.equal(q2.list().filter(j=>j.lane==='coordinator').length,1);assert.equal(q2.list().filter(j=>j.lane==='analyst').length,1);assert.equal(second.s.get('queuedEventCursor'),undefined);scheduler2.stop();second.s.close();
});

test('uncertain financial sends defer autonomy while owner chat remains available',()=>{
  const {s,q}=ready();s.run('INSERT INTO decisions VALUES(?,?,?,?,?,?)','financial','2026-10-09T00:00:00Z','{}','{}','{}','observing');s.run('INSERT INTO operations VALUES(?,?,?,?,?,?,?)','send','financial','2026-10-09T00:00:00Z','uncertain',null,null,'{}');
  q.enqueue({requestId:'auto',kind:'autonomy',payload:{message:'act'}});const chat=q.enqueue({requestId:'owner',kind:'chat',payload:{message:'report status'}});
  const claimed=q.claim('coordinator','single')!;assert.equal(claimed.id,chat.id);q.finish(chat.id,claimed.run_token!,'completed',{answer:'Reconciling prior send'});assert.equal(q.claim('coordinator','single'),undefined);assert.equal(s.one('SELECT state FROM operations').state,'uncertain');s.close();
});

test('shutdown during availability check cannot claim a new job',async()=>{
  const {s,q}=ready();const job=q.enqueue({requestId:'shutdown-race',kind:'chat',payload:{message:'read'}});
  let release!:(value:boolean)=>void;const availability=new Promise<boolean>(r=>release=r);
  let executions=0;const scheduler=new Scheduler(q,{available:()=>availability,runJob:async()=>{executions++;return {};}});
  const pumping=scheduler.pump();scheduler.stop();release(true);await pumping;
  assert.equal(executions,0);assert.equal(q.get(job.id)?.state,'queued');scheduler.tick();assert.equal(q.list().length,1);s.close();
});

test('drain retains original submission receipt and waits without admitting the next job',async()=>{
  const {s,q}=ready();const first=q.enqueue({requestId:'drain-first',kind:'chat',payload:{message:'read'}},new Date(Date.now()-1000).toISOString());
  const second=q.enqueue({requestId:'drain-second',kind:'chat',payload:{message:'read'}});
  let release!:()=>void;const gate=new Promise<void>(r=>release=r);
  const scheduler=new Scheduler(q,{available:async()=>true,runJob:async(job)=>{
    q.bindConversation(job.id,job.run_token!,'15');q.markSubmitted(job.id,job.run_token!,'29');await gate;return {answer:'done'};
  }});
  await scheduler.pump();assert.equal(await scheduler.drain(1),false);
  assert.equal(q.get(first.id)?.state,'running');assert.equal(q.get(first.id)?.submission_id,'29');
  release();assert.equal(await scheduler.drain(100),true);
  assert.equal(q.get(first.id)?.state,'completed');assert.equal(q.get(second.id)?.state,'queued');s.close();
});

test('changing the selected model preserves queued and duplicate receipts',()=>{
  const {s,q}=ready();s.set('model','gpt-6.1-sol');s.set('thinkingLevel','low');
  const original=q.enqueue({requestId:'model-original',kind:'chat',payload:{message:'read'}});
  s.set('model','other-model');s.set('thinkingLevel','high');
  assert.equal(q.enqueue({requestId:'model-original',kind:'chat',payload:{message:'read'}}).id,original.id);
  assert.equal(s.get(`jobModel:${original.id}`),'gpt-6.1-sol');assert.equal(s.get(`jobThinkingLevel:${original.id}`),'low');
  const next=q.enqueue({requestId:'model-next',kind:'chat',payload:{message:'read'}});
  assert.equal(s.get(`jobModel:${next.id}`),'other-model');assert.equal(s.get(`jobThinkingLevel:${next.id}`),'high');
  assert.equal(q.get(original.id)?.submitted,0);s.close();
});
