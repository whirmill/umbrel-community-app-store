import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fixture} from './pi-fixture.js';
import {Scheduler} from '../scheduler.js';
import {TelegramTurns} from '../telegram-turns.js';
import {ApplicationControl} from '../application-control.js';
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai/utils/event-stream';
import {BACKGROUND_CONTEXT as context} from '@earendil-works/chord/context';
import {now} from '../domain.js';
import type {CrashJob,Started} from './durable-recovery-fixture.js';

// Startup recovery acceptance: real Agent, Queue, Scheduler and Pi Durable over SQLite,
// a process killed mid-generation, and only the model boundary replaced.
type Fixture=ReturnType<typeof fixture>;
async function crash(directory:string,jobs:CrashJob[]):Promise<Record<string,Started>>{
 const child=fork(new URL('./durable-recovery-fixture.js',import.meta.url),['held-runs',directory,JSON.stringify(jobs)],{stdio:['ignore','ignore','pipe','ipc']});let errors='';child.stderr!.on('data',d=>errors+=d);
 try{return await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('fixture timeout '+errors)),10000);child.once('message',(m:any)=>{clearTimeout(timer);resolve(m.started);});child.once('exit',code=>{clearTimeout(timer);reject(Error('fixture exited '+code+' '+errors));});});}
 finally{if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}}
}
/** Every provider request names its run by marker and records whether that run owned its job at that moment. */
function reopen(directory:string,started:Record<string,Started>,hold=false){
 const f=fixture(directory,'state'),calls:{marker:string;owned:boolean}[]=[];
 f.agent.models.streamSimple=(_model,request,options)=>{
  const text=JSON.stringify(request.messages),marker=Object.keys(started).find(name=>text.includes('marker-'+name))??'unknown';
  calls.push({marker,owned:f.queue.get(started[marker]?.jobId??'')?.state==='running'});
  const stream=createAssistantMessageEventStream(),message:any={role:'assistant',api:'openai-responses',provider:'openai',model:'gpt-6.1-sol',timestamp:Date.now(),usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',content:[{type:'text',text:'Recovered answer '+marker}]};
  if(hold){const abort=()=>stream.push({type:'error',reason:'aborted',error:{...message,stopReason:'aborted',content:[]}});if(options?.signal?.aborted)queueMicrotask(abort);else options?.signal?.addEventListener('abort',abort,{once:true});}
  else queueMicrotask(()=>{stream.push({type:'start',partial:message});stream.push({type:'done',reason:'stop',message});});
  return stream;
 };
 return {f,calls};
}
/** Production order: queue recovery after the process lock, Agent.open, startup recovery, then pumps. */
async function startup(f:Fixture){f.queue.recoverAfterRestart();await f.agent.open();const scheduler=new Scheduler(f.queue,f.agent);await scheduler.recover();await scheduler.pump();return scheduler;}
async function settle(scheduler:Scheduler,condition:()=>boolean,ms=8000){
 const deadline=Date.now()+ms;
 while(!condition()){if(Date.now()>deadline)throw Error('recovery did not settle');await scheduler.pump();await new Promise(r=>setTimeout(r,10));}
}
const terminal=(f:Fixture,id:string)=>['completed','failed','cancelled'].includes(f.queue.get(id)!.state);
const status=async(f:Fixture,submission:string)=>(await (await (f.agent as any).harness.submission(Number(submission),context)).status(context));
async function close(f:Fixture|undefined,scheduler?:Scheduler){if(scheduler)await scheduler.drain(5000);if(f){await f.agent.close();f.store.close();}}

test('Stop accepted before SIGKILL: no provider request for the stopped turn after reopen; other recovered runs continue',{timeout:30000},async()=>{
 const directory=mkdtempSync(join(tmpdir(),'durable-recovery-stop-'));let f:Fixture|undefined,scheduler:Scheduler|undefined;
 try{
  const started=await crash(directory,[{name:'stopped',kind:'chat',telegram:true,stop:true},{name:'research',kind:'analysis'}]);
  const opened=reopen(directory,started);f=opened.f;scheduler=await startup(f);const queue=f.queue;
  await settle(scheduler,()=>terminal(f!,started.stopped!.jobId)&&terminal(f!,started.research!.jobId));
  const turns=new TelegramTurns(f.store,f.queue),original=await status(f,started.stopped!.submissionId);
  assert.equal(queue.get(started.stopped!.jobId)!.state,'failed');assert.equal(turns.get(started.stopped!.jobId)!.state,'interrupted');
  assert.equal(f.store.get<any>('telegramStop:stop-stopped').state,'idle_confirmed');
  assert.equal(original.status,'unanswered');assert.equal(original.reason,'aborted');
  assert.equal(queue.get(started.stopped!.jobId)!.submission_id,started.stopped!.submissionId);
  assert.deepEqual(opened.calls.filter(c=>c.marker==='stopped'),[]);
  assert.equal(queue.get(started.research!.jobId)!.state,'completed');assert.ok(opened.calls.some(c=>c.marker==='research'));
  assert.equal(existsSync(join(directory,'effects.jsonl')),false);
 }finally{await close(f,scheduler);rmSync(directory,{recursive:true,force:true});}
});

test('native submission committed before markSubmitted is recovered without a second submission next to another recovered run',{timeout:30000},async()=>{
 const directory=mkdtempSync(join(tmpdir(),'durable-recovery-unbound-'));let f:Fixture|undefined,scheduler:Scheduler|undefined;
 try{
  const started=await crash(directory,[{name:'financial',kind:'autonomy'},{name:'unbound',kind:'analysis',unbound:true}]);
  const opened=reopen(directory,started);f=opened.f;
  const before=f.queue.get(started.unbound!.jobId)!;assert.equal(before.submitted,0);assert.equal(before.submission_id,null);assert.equal(before.conversation_id,started.unbound!.conversationId);
  scheduler=await startup(f);
  await settle(scheduler,()=>terminal(f!,started.financial!.jobId)&&terminal(f!,started.unbound!.jobId));
  for(const name of ['financial','unbound']){
   const row=opened.f.queue.get(started[name]!.jobId)!;assert.equal(row.state,'completed',name);assert.equal(row.submission_id,started[name]!.submissionId,name);
   assert.equal(opened.calls.filter(c=>c.marker===name).length,1,name);
  }
  // Both recovered generations are attached before Durable resumes: no unowned provider request.
  assert.ok(opened.calls.every(c=>c.owned),JSON.stringify(opened.calls));
  const conversation=await (f.agent as any).harness.conversation(Number(started.unbound!.conversationId),context),entries=await conversation.entries({},200,undefined,context);
  assert.equal(entries.items.filter((e:any)=>JSON.stringify(e).includes('marker-unbound')).length,1,'one original input, no second submission');
  assert.equal(existsSync(join(directory,'effects.jsonl')),false);
 }finally{await close(f,scheduler);rmSync(directory,{recursive:true,force:true});}
});

for(const gate of ['disabled','model_unavailable','uncertain_operation','hard_deadline'] as const)test('recovered financial run the gates no longer admit is aborted natively, never replayed: '+gate,{timeout:30000},async()=>{
 const directory=mkdtempSync(join(tmpdir(),'durable-recovery-gate-'));let f:Fixture|undefined,scheduler:Scheduler|undefined;
 try{
  const started=await crash(directory,[{name:'held',kind:'autonomy'}]);
  const opened=reopen(directory,started);f=opened.f;
  if(gate==='disabled')f.store.set('enabled',false);
  if(gate==='model_unavailable')f.agent.available=async()=>false;
  if(gate==='hard_deadline'){const key='runBudget:'+started.held!.jobId;f.store.set(key,{...f.store.get<any>(key),started:Date.now()-181000});}
  if(gate==='uncertain_operation'){f.store.run('INSERT INTO decisions VALUES(?,?,?,?,?,?)','gate-decision',now(),'{}','{}','{}','planned');f.store.run('INSERT INTO operations VALUES(?,?,?,?,?,?,?)','gate-operation','gate-decision',now(),'uncertain',null,null,'{}');}
  scheduler=await startup(f);
  for(let i=0;i<5;i++){await scheduler.pump();await new Promise(r=>setTimeout(r,20));}
  await (f.agent as any).harness.waitForIdle(context);
  assert.deepEqual(opened.calls,[]);assert.equal(existsSync(join(directory,'effects.jsonl')),false);
  const row=f.queue.get(started.held!.jobId)!;assert.equal(row.submission_id,started.held!.submissionId);
  // Owner decision (#137): aborted before resume and finalized, no automatic replay.
  assert.equal(row.state,'failed');assert.equal(row.error,'Run interrupted at restart; no automatic replay');
  const native=await status(f,started.held!.submissionId);assert.equal(native.status,'unanswered');assert.equal(native.reason,'aborted');
 }finally{await close(f,scheduler);rmSync(directory,{recursive:true,force:true});}
});

test('late Stop after reopen ends the recovered Telegram turn through its runner',{timeout:30000},async()=>{
 const directory=mkdtempSync(join(tmpdir(),'durable-recovery-late-stop-'));let f:Fixture|undefined,scheduler:Scheduler|undefined;
 try{
  const started=await crash(directory,[{name:'late',kind:'chat',telegram:true}]);
  const opened=reopen(directory,started,true);f=opened.f;scheduler=await startup(f);
  await settle(scheduler,()=>opened.calls.some(c=>c.marker==='late'));
  const turns=new TelegramTurns(f.store,f.queue),id=started.late!.jobId;
  assert.equal((await turns.stop(id,'g',turns.get(id)!.version,'late-stop')).state,'received');
  await turns.dispatchStop('late-stop');assert.equal(f.store.get<any>('telegramStop:late-stop').state,'idle_confirmed');
  await settle(scheduler,()=>terminal(f!,id));
  assert.equal(f.queue.get(id)!.state,'failed');assert.equal(turns.get(id)!.state,'interrupted');assert.equal(f.store.get<any>('telegramTerminal:'+id).state,'interrupted');
  assert.ok(opened.calls.every(c=>c.owned),'every recovered provider request belongs to an owned run');
  assert.equal((await status(f,started.late!.submissionId)).status,'unanswered');
 }finally{await close(f,scheduler);rmSync(directory,{recursive:true,force:true});}
});

test('Telegram chat and /analyze sessions keep their conversations across a restart',{timeout:30000},async()=>{
 const directory=mkdtempSync(join(tmpdir(),'durable-recovery-session-'));let f:Fixture|undefined,scheduler:Scheduler|undefined;const requests:string[]=[];
 const open=async()=>{
  f=fixture(directory,'state');
  f.agent.models.streamSimple=(_model,request)=>{requests.push(JSON.stringify(request.messages));const stream=createAssistantMessageEventStream(),message:any={role:'assistant',api:'openai-responses',provider:'openai',model:'gpt-6.1-sol',timestamp:Date.now(),usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',content:[{type:'text',text:'Session answer'}]};queueMicrotask(()=>{stream.push({type:'start',partial:message});stream.push({type:'done',reason:'stop',message});});return stream;};
  f.store.set('telegramBinding',{generation:'g',chatId:42,userId:42,since:now()});scheduler=await startup(f);return f;
 };
 const run=async(name:string,analysis:boolean)=>{
  const turns=new TelegramTurns(f!.store,f!.queue),job=new ApplicationControl(f!.store,f!.queue).admit('session-'+name,'marker-'+name,'telegram',analysis);
  f!.store.set('jobTelegramGeneration:'+job.id,'g');turns.attach(job,'g',42);requests.length=0;
  await settle(scheduler!,()=>terminal(f!,job.id));assert.equal(f!.queue.get(job.id)!.state,'completed',name);
  return {job:f!.queue.get(job.id)!,key:turns.sessionKey(turns.get(job.id)!),request:requests.join('\n')};
 };
 try{
  await open();
  const chat=await run('chat-before',false),research=await run('research-before',true);
  // Persisted binding keys on the node: chat ':2', research ':0'.
  assert.equal(f!.store.get<any>(chat.key+':2')?.conversationId,chat.job.conversation_id);
  assert.equal(f!.store.get<any>(research.key+':0')?.conversationId,research.job.conversation_id);
  await close(f,scheduler);f=undefined;scheduler=undefined;
  await open();
  const chatAfter=await run('chat-after',false),researchAfter=await run('research-after',true);
  assert.equal(chatAfter.job.conversation_id,chat.job.conversation_id);assert.match(chatAfter.request,/marker-chat-before/);
  assert.equal(researchAfter.job.conversation_id,research.job.conversation_id);assert.match(researchAfter.request,/marker-research-before/);
 }finally{await close(f,scheduler);rmSync(directory,{recursive:true,force:true});}
});

test('native work no recovered job owns is aborted before Durable resumes',{timeout:30000},async()=>{
 const directory=mkdtempSync(join(tmpdir(),'durable-recovery-unowned-'));let f:Fixture|undefined,scheduler:Scheduler|undefined;
 try{
  const started=await crash(directory,[{name:'orphan',kind:'analysis'}]);
  const opened=reopen(directory,started);f=opened.f;
  // The app copy no longer names this run (e.g. it was finished or cancelled), but its native work is live.
  f.store.run("UPDATE jobs SET state='failed',error='fixture',run_token=NULL WHERE id=?",started.orphan!.jobId);
  scheduler=await startup(f);await (f.agent as any).harness.waitForIdle(context);
  assert.deepEqual(opened.calls,[]);
  const native=await status(f,started.orphan!.submissionId);assert.equal(native.status,'unanswered');assert.equal(native.reason,'aborted');
 }finally{await close(f,scheduler);rmSync(directory,{recursive:true,force:true});}
});
