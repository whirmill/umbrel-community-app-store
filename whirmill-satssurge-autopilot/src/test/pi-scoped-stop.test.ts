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
import {BACKGROUND_CONTEXT as context,withAbortSignal} from '@earendil-works/chord/context';
const nativeBase=import.meta.resolve('@earendil-works/pi-durable');
const {admitSubmission}=await import(new URL('./harness/submissions.js',nativeBase).href);
const {LiveDoc}=await import(new URL('./harness/live.js',nativeBase).href);
const {InboxDoc}=await import(new URL('./harness/inbox.js',nativeBase).href);
const {AgentDoc}=await import(new URL('./harness/agent.js',nativeBase).href);
async function crashed(directory:string,mode='active-correction-crash'){
 const child=fork(new URL('./telegram-restart-fixture.js',import.meta.url),[mode,directory],{stdio:['ignore','ignore','pipe','ipc']});let errors='';child.stderr!.on('data',d=>errors+=d);
 try{return await new Promise<any>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('fixture timeout '+errors)),8000);child.once('message',async m=>{clearTimeout(timer);const exited=once(child,'exit');child.kill('SIGKILL');await exited;resolve(m);});child.once('exit',code=>{clearTimeout(timer);if(code!==null)reject(Error('fixture exited '+code+' '+errors));});});}
 finally{if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}}
}
async function outside(h:any){
 const ids=[];
 for(const name of ['financial','analyst','abort-marked']){
  const c=await h.createConversation({ownership:{kind:'ownerless'},agent:{model:{provider:'openai',modelId:'gpt-6.1-sol'},thinkingLevel:'high',extensions:[{name:name==='analyst'?'satssurge_analyst_0':'satssurge'}]}},context);
  const sid=await h.commit((tx:any)=>admitSubmission(tx,c.id,{type:'input',content:'Independent '+name,requestId:'outside-'+name},Date.now(),{followUp:'all',steer:'all'}),context);
  const task=(await h.inspect(context)).tasks.find((t:any)=>t.record.conversationId===c.id).record;
  if(name==='abort-marked')await h.abortTask(task.id,context);
  ids.push({conversation:c.id,submission:sid,task:task.id});
 }
 return ids;
}
async function snapshot(h:any,ids:any[]){return Promise.all(ids.map(async i=>({task:await h.getTask(i.task,context),submission:await (await h.submission(i.submission,context)).status(context),entries:await (await h.conversation(i.conversation,context)).entries({},100,undefined,context),docs:await h.commit(async(tx:any)=>({live:JSON.parse(JSON.stringify(await tx.doc(LiveDoc,i.conversation))),inbox:JSON.parse(JSON.stringify(await tx.doc(InboxDoc,i.conversation))),agent:JSON.parse(JSON.stringify(await tx.doc(AgentDoc,i.conversation)))}),context)})));}
for(const edge of ['offline','original-before-bind','second-crash','stale','unknown-binding','timeout','deferred','deferred-second-crash'] as const)test('native recovered Stop scope: '+edge,{timeout:15000},async()=>{
 const directory=mkdtempSync(join(tmpdir(),'pi-scoped-'+edge+'-'));let f:ReturnType<typeof fixture>|undefined;
 try{
  const ready=await crashed(directory,edge==='original-before-bind'?'original-before-bind-crash':'active-correction-crash');f=fixture(directory,'state');await f.agent.open();f.queue.recoverAfterRestart();let h=(f.agent as any).harness;
  const independent=await outside(h),future=f.queue.enqueue({requestId:'future-'+edge,kind:'chat',payload:{message:'later'}});
  // Normalize reopen before recording preservation baseline.
  await f.agent.close();f.store.close();f=fixture(directory,'state');await f.agent.open();h=(f.agent as any).harness;
  const baseline=await snapshot(h,independent),turns=new TelegramTurns(f.store,f.queue),original=f.queue.get(ready.jobId)!;
  const budget=f.store.get('runBudget:'+ready.jobId),operations=f.store.all('SELECT * FROM operations'),decisions=f.store.all('SELECT * FROM decisions');
  let providerCalls=0;f.agent.available=async()=>false;f.agent.models.streamSimple=()=>{providerCalls++;throw Error('Forbidden provider');};f.agent.models.cancelDeferred=async()=>{providerCalls++;throw Error('Forbidden remote cancel');};
  if(edge==='stale'){const t=turns.get(ready.jobId)!;t.version++;turns.save(t);}
  if(edge==='unknown-binding'){const t=turns.get(ready.jobId)!;delete t.conversationId;turns.save(t);f!.store.run('DELETE FROM meta WHERE key=?','conversationIntent:'+ready.jobId);}
  if(edge==='timeout')h.cancelConversationScoped=async(_id:number,ctx:any)=>{await new Promise((_,reject)=>ctx.abortSignal.addEventListener('abort',()=>reject(Error('fixture native wait timeout')),{once:true}));};
  if(edge.startsWith('deferred')){
   const generation=(await h.inspect(context)).tasks.find((t:any)=>String(t.record.conversationId)===original.conversation_id&&t.record.kind==='pi.generation').record;
   // Fixture a persisted provider deferred checkpoint; built-in abort remains original.
   await h.commit(async(tx:any)=>{const r=await tx.task(generation.id);tx.setTask({...r,state:{status:'pending',checkpoint:{phase:'poll',attempt:1,model:{provider:'openai',modelId:'gpt-6.1-sol'},handle:{id:'fixture-deferred'},cutoff:1}}});},context);
  }
  if(edge.includes('second-crash')){
   await f.agent.close();f.store.close();
   const killed=await crashed(directory,'scoped-terminal-crash');assert.equal(killed.type,'native-idle');assert.equal(killed.turn.state,'stop_requested');
   f=fixture(directory,'state');await f.agent.open();h=(f.agent as any).harness;f.agent.available=async()=>false;f.agent.models.streamSimple=()=>{providerCalls++;throw Error('Forbidden replay');};
  }
  const scheduler=new Scheduler(f.queue,f.agent);await Promise.all([scheduler.pump(),scheduler.dispatchTelegram()]);scheduler.stop();
  const recovered=new TelegramTurns(f.store,f.queue).get(ready.jobId)!;
  const pending=['stale','unknown-binding','timeout'].includes(edge);
  assert.equal(recovered.state,pending?'stop_requested':'interrupted');assert.equal(recovered.closed,!pending);
  assert.deepEqual(recovered.submissions,ready.submissions);if(edge==='original-before-bind'){assert.equal(original.submission_id,null);assert.equal(original.conversation_id,null);assert.equal(f.queue.get(ready.jobId)!.submission_id,ready.submissions[0]);assert.ok(f.queue.get(ready.jobId)!.conversation_id);const c=new TelegramTurns(f.store,f.queue).correction('unplaced-at-original-crash')!;assert.equal(c.state,'withdrawn');assert.equal(c.withdrawResult,'stop_before_native_submission');}else{assert.equal(f.queue.get(ready.jobId)!.submission_id,original.submission_id);assert.equal(f.queue.get(ready.jobId)!.conversation_id,original.conversation_id);}
  assert.equal(f.queue.get(future.id)!.state,'queued');assert.equal(providerCalls,0);assert.equal(existsSync(join(directory,'effects.jsonl')),false);
  assert.deepEqual(await snapshot(h,independent),baseline);assert.equal((await h.inspect(context)).scheduling,'paused');
  assert.deepEqual(f.store.get('runBudget:'+ready.jobId),budget);assert.deepEqual(f.store.all('SELECT * FROM operations'),operations);assert.deepEqual(f.store.all('SELECT * FROM decisions'),decisions);
  if(edge.startsWith('deferred'))assert.equal(f.store.get('telegramTerminal:'+ready.jobId).remoteCancellation,'unknown');
  if(!pending){const terminal=f.store.get('telegramTerminal:'+ready.jobId);await f.agent.recoverTelegramStops();assert.deepEqual(f.store.get('telegramTerminal:'+ready.jobId),terminal);const sub=await h.submission(Number(ready.submissions.at(-1)),context);assert.equal((await sub.status(context)).status,'unanswered');}
 }finally{if(f){await f.agent.close();f.store.close();}rmSync(directory,{recursive:true,force:true});}
});

test('pinned scoped patch reproduces digests, is idempotent, and rejects drift before writes',async()=>{
 const {readFileSync,writeFileSync,mkdirSync,copyFileSync}=await import('node:fs'),{createHash}=await import('node:crypto'),{execFileSync}=await import('node:child_process');
 const directory=mkdtempSync(join(tmpdir(),'pi-patch-proof-')); // dist/test -> application root
 const appDirectory=new URL('../../',import.meta.url);
 const manifest=JSON.parse(readFileSync(new URL('scripts/pi-scoped-stop-patch.json',appDirectory),'utf8'));
 try{
  mkdirSync(join(directory,'scripts'),{recursive:true});for(const file of ['pi-scoped-stop-patch.json','pi-scoped-stop-patch.mjs'])copyFileSync(new URL('scripts/'+file,appDirectory),join(directory,'scripts',file));
  const pkg=join(directory,'node_modules/@earendil-works/pi-durable');mkdirSync(pkg,{recursive:true});writeFileSync(join(pkg,'package.json'),JSON.stringify({version:'1.1.0'}));
  for(const entry of [...manifest.guards,...manifest.files]){const target=join(pkg,entry.file);mkdirSync(join(target,'..'),{recursive:true});let text=readFileSync(new URL('node_modules/@earendil-works/pi-durable/'+entry.file,appDirectory),'utf8');if(entry.changes)for(const [before,after] of [...entry.changes].reverse())text=text.replace(after,before);writeFileSync(target,text);}
  const run=()=>execFileSync(process.execPath,[join(directory,'scripts/pi-scoped-stop-patch.mjs')],{stdio:'pipe'});
  run();for(const e of manifest.files)assert.equal(createHash('sha256').update(readFileSync(join(pkg,e.file))).digest('hex'),e.patched);run();
  const first=manifest.files[0],second=manifest.files[1],before=readFileSync(join(pkg,first.file),'utf8');writeFileSync(join(pkg,second.file),'unsupported drift');assert.throws(run,/Unsupported Pi Durable input/);assert.equal(readFileSync(join(pkg,first.file),'utf8'),before);
 }finally{rmSync(directory,{recursive:true,force:true});}
});

test('scoped cancellation refuses globally enabled harness without pausing it',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'pi-scoped-running-')),f=fixture(directory,'state');
 try{await f.agent.open();const h=(f.agent as any).harness;h.resume();await assert.rejects(h.cancelConversationScoped(0,context),/requires a paused/);assert.equal((await h.inspect(context)).scheduling,'running');assert.equal(existsSync(join(directory,'effects.jsonl')),false);}
 finally{await f.agent.close();f.store.close();rmSync(directory,{recursive:true,force:true});}
});

for(const edge of ['legacy','atomic-crash','write-failure','generation','version','conversation','patch','submission','reused-session'] as const)test('native scoped Stop terminal receipt boundary: '+edge,{timeout:15000},async()=>{
 const directory=mkdtempSync(join(tmpdir(),'pi-stop-terminal-'+edge+'-'));let f:ReturnType<typeof fixture>|undefined;
 try{
  const ready=await crashed(directory);
  if(edge!=='write-failure'){
   const killed=await crashed(directory,edge==='atomic-crash'?'atomic-stop-transaction-crash':'app-terminal-before-stop-crash');
   assert.equal(killed.type,edge==='atomic-crash'?'atomic-before-stop-write':'app-terminal');
   if(edge!=='atomic-crash')assert.equal(killed.stop.state,'received');
  }
  f=fixture(directory,'state');await f.agent.open();f.queue.recoverAfterRestart();const h=(f.agent as any).harness,turns=new TelegramTurns(f.store,f.queue),key='telegramStop:active-crash-stop';
  let calls=0;f.agent.available=async()=>false;f.agent.models.streamSimple=()=>{calls++;throw Error('No provider');};
  const original=turns.get(ready.jobId)!,terminal=f.store.get<any>('telegramTerminal:'+ready.jobId);
  if(terminal){f.queue.reconcileTelegramTerminals();assert.equal(f.queue.get(ready.jobId)!.state,'failed');}
  const set=f.store.set.bind(f.store);
  if(edge==='write-failure'){
   f.store.set=(key:string,value:any)=>{if(key.startsWith('telegramStop:')&&value.state==='idle_confirmed')throw Error('injected receipt write failure');return set(key,value);};
   await f.agent.recoverTelegramStops();assert.equal(turns.get(ready.jobId)!.closed,false);assert.equal(f.store.get('telegramTerminal:'+ready.jobId),undefined);assert.equal(f.store.get<any>(key).state,'received');f.store.set=set;
  }
  if(edge==='atomic-crash'){assert.equal(original.closed,false);assert.equal(terminal,undefined);}
  if(edge==='generation'){const r=f.store.get<any>(key);r.generation='different';f.store.set(key,r);}
  if(edge==='version'){const r=f.store.get<any>(key);r.version++;f.store.set(key,r);}
  if(edge==='conversation'){const t=turns.get(ready.jobId)!;t.conversationId='987654321';turns.save(t);}
  if(edge==='patch'){terminal.nativeCancellation.patch='untrusted';f.store.set('telegramTerminal:'+ready.jobId,terminal);}
  if(edge==='submission'){terminal.submissionIds=[ready.submissions[0]];f.store.set('telegramTerminal:'+ready.jobId,terminal);}
  let future:any,before:any;
  if(edge==='reused-session'){
   const id=Number(original.conversationId);future=await h.commit((tx:any)=>admitSubmission(tx,id,{type:'input',content:'later reused turn',requestId:'later-reused-session'},Date.now(),{followUp:'all',steer:'all'}),context);
   before=await (await h.submission(future,context)).status(context);h.cancelConversationScoped=()=>{throw Error('Historical reconciliation must never abort current session');};
  }
  // Confirm every matching accepted receipt; mismatched identities remain pending.
  f.store.set('telegramStop:matching-second',{...f.store.get<any>(key)});
  const budget=f.store.get('runBudget:'+ready.jobId),operations=f.store.all('SELECT * FROM operations');
  await Promise.all([f.agent.recoverTelegramStops(),f.agent.recoverTelegramStops()]);
  const rejected=['generation','version','conversation','patch','submission'].includes(edge);
  assert.equal(f.store.get<any>(key).state,rejected?'received':'idle_confirmed');assert.equal(f.store.get<any>('telegramStop:matching-second').state,rejected?'received':'idle_confirmed');
  assert.equal(calls,0);assert.deepEqual(f.store.get('runBudget:'+ready.jobId),budget);assert.deepEqual(f.store.all('SELECT * FROM operations'),operations);assert.equal(existsSync(join(directory,'effects.jsonl')),false);
  if(edge==='reused-session')assert.deepEqual(await (await h.submission(future,context)).status(context),before);
  const after=f.store.get('telegramTerminal:'+ready.jobId);await f.agent.recoverTelegramStops();assert.deepEqual(f.store.get('telegramTerminal:'+ready.jobId),after);
  if(terminal)assert.deepEqual(f.store.get('telegramTerminal:'+ready.jobId),terminal);
 }finally{if(f){await f.agent.close();f.store.close();}rmSync(directory,{recursive:true,force:true});}
});

test('native ToolTask children abort bottom-up without executing or replaying tools',{timeout:15000},async()=>{
 const directory=mkdtempSync(join(tmpdir(),'pi-stop-native-tools-'));let f:ReturnType<typeof fixture>|undefined;
 try{
  const ready=await crashed(directory);f=fixture(directory,'state');await f.agent.open();f.queue.recoverAfterRestart();const h=(f.agent as any).harness;
  const {ToolTask}=await import(new URL('./harness/tool.js',nativeBase).href),{AssistantEntry}=await import(new URL('./entries.js',nativeBase).href);
  const original=f.queue.get(ready.jobId)!,target=(await h.inspect(context)).tasks.find((t:any)=>String(t.record.conversationId)===original.conversation_id&&t.record.kind==='pi.generation').record;
  const independent=await outside(h),foreign=(await h.getTask(independent[0]!.task,context));
  const child=async(owner:any,callId:string)=>h.commit(async(tx:any)=>{
   const entry=await tx.appendEntry(AssistantEntry,owner.conversationId,{model:[{role:'assistant',api:'openai-responses',provider:'openai',model:'gpt-6.1-sol',timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'toolUse',content:[{type:'toolCall',id:callId,name:'execute_decision',arguments:{}}]}]});
   return tx.createTask(ToolTask,{assistant:entry.id,callId},{ownership:{kind:'task',taskId:owner.id}});
  },context);
  const owned=await child(target,'target-native-tool'),unrelated=await child(foreign,'outside-native-tool');
  independent.push({conversation:foreign.conversationId,submission:independent[0]!.submission,task:unrelated});
  const baseline=await snapshot(h,independent),ownedBefore=await h.getTask(owned,context);let calls=0;
  f.agent.models.streamSimple=()=>{calls++;throw Error('No model');};f.agent.available=async()=>false;
  await f.agent.recoverTelegramStops();const ended=await h.getTask(owned,context),generation=await h.getTask(target.id,context);
  assert.equal(ended.id,ownedBefore.id);assert.equal(ended.owner,ownedBefore.owner);assert.equal(ended.state.status,'terminal');assert.equal(ended.state.outcome.status,'aborted');assert.equal(generation.state.outcome.status,'aborted');
  const receipt=f.store.get<any>('telegramTerminal:'+ready.jobId);assert.ok(receipt.nativeCancellation.taskIds.includes(owned));assert.deepEqual(receipt.submissionIds,ready.submissions);
  const entries=await (await h.conversation(Number(original.conversation_id),context)).entries({},100,undefined,context);
  const toolResult=entries.items.find((entry:any)=>entry.id===ended.state.outcome.result.entryId);assert.equal(toolResult.kind,'pi.tool-result');assert.match(JSON.stringify(toolResult),/aborted/);
  assert.deepEqual(await snapshot(h,independent),baseline);assert.equal(calls,0);assert.equal(existsSync(join(directory,'effects.jsonl')),false);assert.equal((await h.inspect(context)).scheduling,'paused');
 }finally{if(f){await f.agent.close();f.store.close();}rmSync(directory,{recursive:true,force:true});}
});
