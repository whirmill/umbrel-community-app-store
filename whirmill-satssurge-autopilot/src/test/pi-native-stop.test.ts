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
import {BACKGROUND_CONTEXT as context} from '@earendil-works/chord/context';
const nativeBase=import.meta.resolve('@earendil-works/pi-durable');
const {admitSubmission}=await import(new URL('./harness/submissions.js',nativeBase).href);

// Stops of turns interrupted by a crash use stock Durable 1.1.0 only: abortTask/abortSubmission
// commit marks while scheduling is paused, then resume() runs abort handlers, never the turn.
type Fixture=ReturnType<typeof fixture>;
async function crashed(directory:string,mode='active-correction-crash'){
 const child=fork(new URL('./telegram-restart-fixture.js',import.meta.url),[mode,directory],{stdio:['ignore','ignore','pipe','ipc']});let errors='';child.stderr!.on('data',d=>errors+=d);
 try{return await new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('fixture timeout '+errors)),8000);child.once('message',async m=>{clearTimeout(timer);const exited=once(child,'exit');child.kill('SIGKILL');await exited;resolve(m);});child.once('exit',code=>{clearTimeout(timer);if(code!==null)reject(Error('fixture exited '+code+' '+errors));});});}
 finally{if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}}
}
/** Native work that no job owns: an input placed in its own conversation. */
async function outside(h:any){
 const ids=[];
 for(const name of ['financial','analyst']){
  const c=await h.createConversation({ownership:{kind:'ownerless'},agent:{model:{provider:'openai',modelId:'gpt-6.1-sol'},thinkingLevel:'high',extensions:[{name:name==='analyst'?'satssurge-analyst':'satssurge'}]}},context);
  const sid=await h.commit((tx:any)=>admitSubmission(tx,c.id,{type:'input',content:'Independent '+name,requestId:'outside-'+name},Date.now(),{followUp:'all',steer:'all'}),context);
  const task=(await h.inspect(context)).tasks.find((t:any)=>t.record.conversationId===c.id).record;
  ids.push({conversation:c.id,submission:sid,task:task.id});
 }
 return ids;
}
function reopen(directory:string){
 const f=fixture(directory,'state');let calls=0;
 f.agent.models.streamSimple=()=>{calls++;throw Error('Forbidden provider');};
 f.agent.models.cancelDeferred=async()=>{calls++;throw Error('Forbidden remote cancel');};
 return {f,calls:()=>calls};
}
async function settled(f:Fixture,jobId:string){
 const deadline=Date.now()+8000;
 while(!['completed','failed','cancelled'].includes(f.queue.get(jobId)!.state)){if(Date.now()>deadline)throw Error('recovered turn did not settle');await new Promise(r=>setTimeout(r,10));}
}
const status=async(h:any,id:unknown)=>(await (await h.submission(Number(id),context)).status(context));

test('startup abort marks end native ToolTask children bottom-up without executing or replaying tools',{timeout:20000},async()=>{
 const directory=mkdtempSync(join(tmpdir(),'pi-stop-native-tools-'));let f:Fixture|undefined,scheduler:Scheduler|undefined;
 try{
  const ready=await crashed(directory);const opened=reopen(directory);f=opened.f;f.queue.recoverAfterRestart();await f.agent.open();const h=(f.agent as any).harness;
  const {ToolTask}=await import(new URL('./harness/tool.js',nativeBase).href),{AssistantEntry}=await import(new URL('./entries.js',nativeBase).href);
  const original=f.queue.get(ready.jobId)!,target=(await h.inspect(context)).tasks.find((t:any)=>String(t.record.conversationId)===original.conversation_id&&t.record.kind==='pi.generation').record;
  const independent=await outside(h),foreign=await h.getTask(independent[0]!.task,context);
  const child=async(owner:any,callId:string)=>h.commit(async(tx:any)=>{
   const entry=await tx.appendEntry(AssistantEntry,owner.conversationId,{model:[{role:'assistant',api:'openai-responses',provider:'openai',model:'gpt-6.1-sol',timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'toolUse',content:[{type:'toolCall',id:callId,name:'execute_decision',arguments:{}}]}]});
   return tx.createTask(ToolTask,{assistant:entry.id,callId},{ownership:{kind:'task',taskId:owner.id}});
  },context);
  const owned=await child(target,'target-native-tool'),unrelated=await child(foreign,'outside-native-tool'),ownedBefore=await h.getTask(owned,context);
  scheduler=new Scheduler(f.queue,f.agent);await scheduler.recover();await settled(f,ready.jobId);await h.waitForIdle(context);
  const ended=await h.getTask(owned,context),generation=await h.getTask(target.id,context);
  assert.equal(ended.id,ownedBefore.id);assert.equal(ended.owner,ownedBefore.owner);assert.equal(ended.state.status,'terminal');assert.equal(ended.state.outcome.status,'aborted');assert.equal(generation.state.outcome.status,'aborted');
  const entries=await (await h.conversation(Number(original.conversation_id),context)).entries({},100,undefined,context);
  const toolResult=entries.items.find((entry:any)=>entry.id===ended.state.outcome.result.entryId);assert.equal(toolResult.kind,'pi.tool-result');assert.match(JSON.stringify(toolResult),/aborted/);
  // Unowned native work is swept before resume as well: aborted, never run.
  assert.equal((await h.getTask(unrelated,context)).state.outcome.status,'aborted');
  for(const i of independent){assert.equal((await h.getTask(i.task,context)).state.outcome.status,'aborted');const sub=await status(h,i.submission);assert.equal(sub.status,'unanswered');assert.equal(sub.reason,'aborted');}
  const turns=new TelegramTurns(f.store,f.queue);assert.equal(turns.get(ready.jobId)!.state,'interrupted');assert.equal(f.store.get<any>('telegramStop:active-crash-stop').state,'idle_confirmed');
  assert.deepEqual(turns.get(ready.jobId)!.submissions,ready.submissions);assert.equal(turns.correction('active-at-crash')!.state,'failed');
  assert.equal(opened.calls(),0);assert.equal(existsSync(join(directory,'effects.jsonl')),false);assert.equal((await h.inspect(context)).scheduling,'running');
 }finally{if(scheduler)await scheduler.drain(5000);if(f){await f.agent.close();f.store.close();}rmSync(directory,{recursive:true,force:true});}
});

test('Stop accepted before markSubmitted binds the native original by request ID and withdraws the unplaced correction',{timeout:20000},async()=>{
 const directory=mkdtempSync(join(tmpdir(),'pi-stop-before-bind-'));let f:Fixture|undefined,scheduler:Scheduler|undefined;
 try{
  const ready=await crashed(directory,'original-before-bind-crash');const opened=reopen(directory);f=opened.f;
  const before=f.store.one('SELECT * FROM jobs WHERE id=?',ready.jobId);assert.equal(before.conversation_id,null);assert.equal(before.submission_id,null);
  f.queue.recoverAfterRestart();await f.agent.open();scheduler=new Scheduler(f.queue,f.agent);await scheduler.recover();await settled(f,ready.jobId);
  const h=(f.agent as any).harness,turns=new TelegramTurns(f.store,f.queue),job=f.queue.get(ready.jobId)!;
  assert.equal(job.state,'failed');assert.equal(job.submission_id,ready.submissions[0]);assert.ok(job.conversation_id);
  assert.equal(turns.get(ready.jobId)!.state,'interrupted');assert.equal(f.store.get<any>('telegramStop:active-crash-stop').state,'idle_confirmed');
  const correction=turns.correction('unplaced-at-original-crash')!;assert.equal(correction.state,'withdrawn');assert.equal(correction.withdrawResult,'stop_before_native_submission');
  const sub=await status(h,ready.submissions[0]);assert.equal(sub.status,'unanswered');assert.equal(sub.reason,'aborted');
  assert.equal(opened.calls(),0);assert.equal(existsSync(join(directory,'effects.jsonl')),false);
 }finally{if(scheduler)await scheduler.drain(5000);if(f){await f.agent.close();f.store.close();}rmSync(directory,{recursive:true,force:true});}
});

test('a crash after startup abort marks and before resume recovers the same Stop without provider requests',{timeout:20000},async()=>{
 const directory=mkdtempSync(join(tmpdir(),'pi-stop-second-crash-'));let f:Fixture|undefined,scheduler:Scheduler|undefined;
 try{
  const ready=await crashed(directory);assert.equal((await crashed(directory,'startup-recovery-crash')).type,'marked');
  const opened=reopen(directory);f=opened.f;f.queue.recoverAfterRestart();await f.agent.open();scheduler=new Scheduler(f.queue,f.agent);await scheduler.recover();await settled(f,ready.jobId);
  const turns=new TelegramTurns(f.store,f.queue);
  assert.equal(f.queue.get(ready.jobId)!.state,'failed');assert.equal(turns.get(ready.jobId)!.state,'interrupted');assert.equal(f.store.get<any>('telegramTerminal:'+ready.jobId).state,'interrupted');
  assert.equal(f.store.get<any>('telegramStop:active-crash-stop').state,'idle_confirmed');assert.deepEqual(turns.get(ready.jobId)!.submissions,ready.submissions);
  assert.equal(opened.calls(),0);assert.equal(existsSync(join(directory,'effects.jsonl')),false);
 }finally{if(scheduler)await scheduler.drain(5000);if(f){await f.agent.close();f.store.close();}rmSync(directory,{recursive:true,force:true});}
});

test('a turn closed before its Stop receipt was confirmed is confirmed once its conversation is idle',{timeout:20000},async()=>{
 const directory=mkdtempSync(join(tmpdir(),'pi-stop-closed-'));let f:Fixture|undefined,scheduler:Scheduler|undefined;
 try{
  const ready=await crashed(directory);let opened=reopen(directory);f=opened.f;f.queue.recoverAfterRestart();await f.agent.open();
  // Previous binary: native idle reached and the app terminal committed, then a crash before the receipt.
  let h=(f.agent as any).harness;for(const t of (await h.inspect(context)).tasks)await h.abortTask(t.record.id,context);h.resume();await h.waitForIdle(context);
  const turns=new TelegramTurns(f.store,f.queue);turns.finalize(ready.jobId,'interrupted',{reason:'owner_stop_native_idle',submissionIds:ready.submissions});
  const terminal=f.store.get('telegramTerminal:'+ready.jobId);assert.equal(f.store.get<any>('telegramStop:active-crash-stop').state,'received');
  await f.agent.close();f.store.close();
  opened=reopen(directory);f=opened.f;f.queue.recoverAfterRestart();await f.agent.open();scheduler=new Scheduler(f.queue,f.agent);await scheduler.recover();await scheduler.drain(5000);scheduler=undefined;
  assert.equal(f.store.get<any>('telegramStop:active-crash-stop').state,'idle_confirmed');assert.deepEqual(f.store.get('telegramTerminal:'+ready.jobId),terminal);
  assert.equal(f.queue.get(ready.jobId)!.state,'failed');h=(f.agent as any).harness;assert.equal((await h.inspect(context)).tasks.length,0);
  assert.equal(opened.calls(),0);
 }finally{if(scheduler)await scheduler.drain(5000);if(f){await f.agent.close();f.store.close();}rmSync(directory,{recursive:true,force:true});}
});
