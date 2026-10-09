import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../store.js';
import {Queue} from '../queue.js';
import {OwnerSessions} from '../owner-auth.js';
import {mergeEvents,mergeHistory,mergeJobs,pendingSubmission,pendingKey,validChatPayload} from '../ui-client.js';
import {now} from '../domain.js';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {readFileSync} from 'node:fs';

test('coalescing a running or submitted waiting job persists a successor while queued bursts remain bounded',()=>{
 const s=new Store(':memory:');s.set('enabled',true);s.set('bootstrapReady',true);const q=new Queue(s);
 const input={kind:'events' as const,coalesceKey:'lightning-events',payload:{message:'read latest'}};
 const a=q.enqueue({...input,requestId:'one'});const running=q.claim('coordinator','owner')!;
 const b=q.enqueue({...input,requestId:'two'});assert.notEqual(a.id,b.id);assert.equal(q.enqueue({...input,requestId:'three'}).id,b.id);
 q.markSubmitted(running.id,running.run_token!,'original');q.wait(running.id,running.run_token!,'restart_recovery');
 q.cancel(b.id);const c=q.enqueue({...input,requestId:'four'});assert.notEqual(c.id,a.id);assert.equal(q.get(a.id)?.submission_id,'original');s.close();
});
test('unsubmitted original recovery and model-unavailable wait preserve a queued successor without index conflict',()=>{
 for(const recovery of ['restart','model']){
  const s=new Store(':memory:');s.set('enabled',true);s.set('bootstrapReady',true);const q=new Queue(s);
  const input={kind:'events' as const,coalesceKey:'observations',payload:{message:'latest'}};
  const original=q.enqueue({...input,requestId:'original'});const active=q.claim('coordinator','owner')!;
  const next=q.enqueue({...input,requestId:'successor'});
  if(recovery==='restart')assert.doesNotThrow(()=>q.recoverAfterRestart());else assert.equal(q.wait(active.id,active.run_token!,'model_unavailable','2020-01-01T00:00:00Z'),true);
  assert.equal(q.get(original.id)?.state,'waiting');assert.equal(q.get(next.id)?.state,'queued');assert.doesNotThrow(()=>q.releaseWaiting());
  assert.equal(q.list().length,2);assert.equal(q.get(original.id)?.state,'queued');assert.equal(q.get(next.id)?.state,'queued');s.close();
 }
});
test('cumulative text snapshots compact with monotonic cursor and bounded older details',()=>{
 let p:any={jobs:{},events:[],cursor:0};for(let n=1;n<=200;n++)p=mergeEvents(p,[{id:n,job_id:'x',at:now(),type:'text',data:{text:'x'.repeat(n*64)}}]);
 assert.equal(p.events.length,1);assert.equal(p.events[0].data.text.length,12800);p=mergeEvents(p,[{id:1,job_id:'x',at:now(),type:'text',data:{text:'old'}}]);assert.equal(p.events[0].id,200);assert.equal(p.cursor,200);
 const many=Array.from({length:150000},(_,n)=>({id:n+201,job_id:'x',at:now(),type:'tool_result',data:{callId:String(n)}}));p=mergeEvents(p,many);assert.equal(p.events.length,10000);assert.equal(p.cursor,150200);assert.equal(p.truncatedEvents,true);
});
test('UTF8 payload limits reject before pending storage while uncertain submissions preserve their nonce',()=>{
 const m=new Map<string,string>();const storage={getItem:(k:string)=>m.get(k)??null,setItem:(k:string,v:string)=>{m.set(k,v);},removeItem:(k:string)=>{m.delete(k);}};
 assert.equal(validChatPayload('🙂'.repeat(5000)),false);assert.throws(()=>pendingSubmission(storage,'x'.repeat(17000),'chat',()=> 'rejected'));assert.equal(m.has(pendingKey),false);
 const p=pendingSubmission(storage,'accepted','chat',()=> 'original');assert.equal(pendingSubmission(storage,'accepted','chat',()=> 'new').requestId,p.requestId);assert.throws(()=>pendingSubmission(storage,'changed','chat',()=> 'new'));
});
test('revocation invalidates copied bearer while other owner sessions remain valid',()=>{
 const s=new OwnerSessions(),a=s.issue(),b=s.issue();s.revoke('Bearer '+a);assert.equal(s.accepts('Bearer '+a),false);assert.equal(s.accepts('Bearer '+b),true);
});
test('SIGTERM drains a synthetic running scheduler job and entrypoint exec preserves the flock',async()=>{
 assert.match(readFileSync('Dockerfile','utf8'),/CMD \["flock","--no-fork","-n"/);
 const code=`import {Store} from './dist/store.js';import {Queue} from './dist/queue.js';import {Scheduler} from './dist/scheduler.js';const s=new Store(':memory:');s.set('enabled',true);s.set('bootstrapReady',true);const q=new Queue(s);q.enqueue({requestId:'drain',kind:'chat',payload:{message:'mock'}});let release;const scheduler=new Scheduler(q,{available:async()=>true,runJob:()=>new Promise(r=>{release=r;console.log('READY')})});process.once('SIGTERM',async()=>{setTimeout(()=>release({answer:'settled'}),30);const drained=await scheduler.drain(1000);console.log('DRAINED:'+drained+':'+q.list()[0].state);s.close();});await scheduler.pump();`;
 const child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','pipe','pipe']});let out='';
 const ready=new Promise<void>(r=>child.stdout.on('data',chunk=>{out+=String(chunk);if(out.includes('READY'))r();}));
 try{await ready;child.kill('SIGTERM');const [status]=await once(child,'exit');assert.equal(status,0);assert.match(out,/DRAINED:true:completed/);}finally{if(child.exitCode===null)child.kill('SIGKILL');}
});

test('paged history cache stays bounded, keeps active receipts and selected older page across status refresh',()=>{
 let p:any={jobs:{active:{id:'active',kind:'chat',state:'running',request_id:'original',submission_id:'submission'}},events:[],cursor:700};
 for(let page=0;page<12;page++){
  const jobs=Array.from({length:50},(_,n)=>({id:'history:'+String(600-page*50-n),history_id:600-page*50-n,kind:'chat',state:'completed',created_at:new Date(1700000000000+(600-page*50-n)*1000).toISOString()}));
  p=mergeHistory(p,{jobs,events:[],cursor:700});
  p=mergeJobs(p,Array.from({length:40},(_,n)=>({id:'history:'+String(600-n),history_id:600-n,kind:'chat',state:'completed'})));
  assert.ok(Object.keys(p.jobs).length<=251);assert.equal(p.jobs[jobs.at(-1)!.id].id,jobs.at(-1)!.id);assert.equal(p.jobs.active.submission_id,'submission');assert.equal(p.cursor,700);
 }
 assert.equal(p.truncatedHistory,true);
 const reset=mergeHistory(p,{jobs:[{id:'recent',kind:'chat',state:'completed'}],events:[],cursor:700},true);assert.equal(reset.truncatedHistory,false);assert.equal(reset.jobs.recent!.id,'recent');assert.equal(reset.jobs.active!.submission_id,'submission');
});

test('history reset retains a low replay cursor for an old active job absent from newest 50 rows',()=>{
 const stale:any={jobs:{old:{id:'old',request_id:'original',submission_id:'original-submission',kind:'chat',state:'running'}},events:[],cursor:10};
 const page=Array.from({length:50},(_,n)=>({id:'new:'+n,kind:'chat',state:'completed'}));
 let p=mergeHistory(stale,{jobs:page,events:[],cursor:100},true);assert.equal(p.cursor,10);assert.equal(p.jobs.old!.state,'running');
 p=mergeEvents(p,[{id:50,job_id:'old',at:now(),type:'job',data:{state:'completed'}}]);assert.equal(p.jobs.old!.state,'completed');assert.equal(p.jobs.old!.submission_id,'original-submission');assert.equal(p.cursor,50);
});
