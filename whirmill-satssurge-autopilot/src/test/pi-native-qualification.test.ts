import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {fauxAssistantMessage} from '@earendil-works/pi-ai/providers/faux';
import {CompactionEntry,InboxDoc,watchEvents} from '@earendil-works/pi-durable';
import {context,DEFAULT_COMPACTION_POLICY,nativeFixture,settle,rows,summaryRequest,Plan} from './pi-native-qualification-fixture.js';

test('native 1.1 default threshold compaction preserves history, identities and complete usage on reopen',{timeout:20000},async()=>{
  assert.deepEqual(DEFAULT_COMPACTION_POLICY,{enabled:true,reserveTokens:16384,keepRecentTokens:20000,backgroundTokens:32768});
  const dir=mkdtempSync(join(tmpdir(),'surge-native-default-'));const f=await nativeFixture(dir);
  const events=await watchEvents(f.harness,f.root.id,context);const starts:boolean[]=[];events.start(async batch=>{for(const e of batch)if(e.type==='compaction_start')starts.push(e.blocking);});
  try{
    const original=await settle(f,'default-1');assert.equal(original.outcome.status,'done');
    assert.equal((await rows(f,'entries')).filter(e=>JSON.parse(e.record).kind==='pi.compaction').length,0);
    const old=await rows(f,'entries');const receipts=[original];
    for(let i=2;i<=4;i++)receipts.push(await settle(f,'default-'+i));
    const entries=await rows(f,'entries');for(const e of old)assert.deepEqual(entries.find(x=>x.id===e.id),e);
    const view=await f.root.context(context);const compactions=entries.filter(e=>JSON.parse(e.record).kind==='pi.compaction');
    assert.ok(compactions.length>0);assert.ok(compactions.every(e=>JSON.parse(e.record).data.reason==='threshold'));
    assert.ok(view.entries.length<entries.length);assert.ok(CompactionEntry.is(view.head));
    const summaries=f.responses.filter(r=>r.summary);assert.ok(summaries.length>0);
    await events.stop();await events.closed;assert.ok(starts.includes(false),'default background threshold reached');
    const usage=await f.harness.usage(context);assert.equal(usage.models['faux/qualified-64k']!.totalTokens,f.responses.reduce((s,r)=>s+r.message.usage.totalTokens,0));
    const submissions=await rows(f,'submissions'),docs=await rows(f,'documents'),calls=f.faux.state.callCount,id=f.root.id;
    await f.close();await assert.rejects(f.db.all('SELECT 1'),/closed|not open/i);await f.open();
    assert.equal(f.root.id,id);assert.deepEqual(await rows(f,'entries'),entries);assert.deepEqual(await rows(f,'submissions'),submissions);assert.deepEqual(await rows(f,'documents'),docs);
    assert.deepEqual(await f.harness.usage(context),usage);assert.deepEqual(await f.root.context(context),view);assert.equal(f.faux.state.callCount,calls);
    for(const [i,r] of receipts.entries()){assert.deepEqual(await (await f.harness.submission(r.id,context))!.status(context),r.outcome);assert.equal((await f.root.submit({type:'input',content:'Question default-'+(i+1),requestId:'default-'+(i+1)},context)).id,r.id);}
  }finally{await events.stop();await f.close();assert.equal(f.closed,true);rmSync(dir,{recursive:true,force:true});}
});

test('failed threshold summary keeps prior history and failure receipt; native generation continues and usage includes attempt',{timeout:15000},async()=>{
  let fail=false;const dir=mkdtempSync(join(tmpdir(),'surge-native-failure-'));
  const f=await nativeFixture(dir,{settings:{compaction:{backgroundTokens:0}},respond:c=>fauxAssistantMessage(summaryRequest(c)&&fail?'':'DETAIL '.repeat(30000),summaryRequest(c)&&fail?{stopReason:'error',errorMessage:'fixture summary failure'}:{})});
  try{
    await settle(f,'before-failure');const before=await rows(f,'entries');fail=true;const failed=await settle(f,'failed-summary');
    // Threshold compaction uses allSettled in 1.1.0: a failed summary does not fail this generation.
    assert.equal(failed.outcome.status,'done');const after=await rows(f,'entries');for(const e of before)assert.deepEqual(after.find(x=>x.id===e.id),e);
    assert.equal(after.filter(e=>JSON.parse(e.record).kind==='pi.compaction').length,0);assert.equal(f.responses.filter(r=>r.summary).length,1);
    const failedTasks=(await rows(f,'tasks')).map(r=>JSON.parse(r.record)).filter(r=>r.kind==='pi.compaction');assert.equal(failedTasks.length,1);assert.equal(failedTasks[0].state.outcome.status,'failed');
    const usage=await f.harness.usage(context);assert.equal(usage.models['faux/qualified-64k']!.totalTokens,f.responses.reduce((s,r)=>s+r.message.usage.totalTokens,0));
    const calls=f.faux.state.callCount;await f.close();await f.open();assert.deepEqual(await (await f.harness.submission(failed.id,context))!.status(context),failed.outcome);assert.deepEqual(await f.harness.usage(context),usage);assert.equal(f.faux.state.callCount,calls);
  }finally{await f.close();rmSync(dir,{recursive:true,force:true});}
});

test('failed overflow summary leaves original submission unanswered and does not loop or replay after reopen',{timeout:15000},async()=>{
  let fail=false;const dir=mkdtempSync(join(tmpdir(),'surge-native-overflow-'));const f=await nativeFixture(dir,{settings:{compaction:{backgroundTokens:0}},respond:c=>fauxAssistantMessage(fail?'':'DETAIL '.repeat(15000),fail?{stopReason:'error',errorMessage:summaryRequest(c)?'fixture summary failure':'prompt is too long'}:{})});
  try{
    await settle(f,'overflow-history');const before=await rows(f,'entries');fail=true;const receipt=await settle(f,'overflow-failure');assert.equal(receipt.outcome.status,'unanswered');
    for(const e of before)assert.deepEqual((await rows(f,'entries')).find(x=>x.id===e.id),e);assert.equal(f.responses.filter(r=>r.summary).length,1);
    const calls=f.faux.state.callCount,usage=await f.harness.usage(context);assert.equal(usage.models['faux/qualified-64k']!.totalTokens,f.responses.reduce((s,r)=>s+r.message.usage.totalTokens,0));
    await f.close();await f.open();assert.deepEqual(await (await f.harness.submission(receipt.id,context))!.status(context),receipt.outcome);assert.equal(f.faux.state.callCount,calls);assert.deepEqual(await f.harness.usage(context),usage);
  }finally{await f.close();rmSync(dir,{recursive:true,force:true});}
});

test('native steer/follow-up inbox shares final boundary; Stop withdraws queued native future inputs',{timeout:15000},async()=>{
  let release!:()=>void,entered!:()=>void;let held=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r),hold=true;
  const dir=mkdtempSync(join(tmpdir(),'surge-native-inbox-'));const f=await nativeFixture(dir,{settings:{compaction:{enabled:false}},respond:async()=>{if(hold){entered();await held;}return fauxAssistantMessage('Public fixture answer');}});const events=await watchEvents(f.harness,f.root.id,context);const kinds:string[]=[];events.start(async batch=>{kinds.push(...batch.map(e=>e.type));});
  try{
    const first=await f.root.submit({type:'input',content:'first',requestId:'first'},context);await started;
    const steer=await f.root.submit({type:'input',content:'correct first',requestId:'steer',whenBusy:'steer'},context);
    const future=await f.root.submit({type:'input',content:'next turn',requestId:'future'},context);
    assert.equal((await steer.status(context)).status,'queued');assert.equal((await future.status(context)).status,'queued');assert.equal((await f.harness.snapshot(InboxDoc,f.root.id,context))!.items.length,2);
    hold=false;release();for(const s of [first,steer,future])assert.equal((await s.wait(context)).status,'done');await f.root.waitForIdle(context);
    const receipts=await rows(f,'submissions');await events.stop();await events.closed;assert.ok(kinds.includes('message_end'));assert.ok(kinds.includes('inbox_update'));assert.ok(kinds.includes('usage_changed'));
    await f.close();await f.open();assert.deepEqual(await rows(f,'submissions'),receipts);
    held=new Promise<void>(r=>release=r);started=new Promise<void>(r=>entered=r);hold=true;
    const active=await f.root.submit({type:'input',content:'active',requestId:'stop-active'},context);await started;
    const withdrawn=await f.root.submit({type:'input',content:'must survive in application mailbox',requestId:'stop-future'},context);
    // Faux holds are released by the test; this proves native semantics, not cancellation of a hung provider.
    const stop=f.root.abort(context);release();await stop;assert.equal((await active.status(context)).status,'unanswered');assert.equal((await withdrawn.status(context)).status,'unanswered');assert.equal((await f.harness.snapshot(InboxDoc,f.root.id,context))!.items.length,0);
  }finally{release();await events.stop();await f.close();rmSync(dir,{recursive:true,force:true});}
});

test('native manual summary waits for busy turn boundary and survives reopen as original placement',{timeout:15000},async()=>{
  let release!:()=>void,entered!:()=>void;const held=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);let hold=false;
  const dir=mkdtempSync(join(tmpdir(),'surge-native-boundary-'));const f=await nativeFixture(dir,{settings:{compaction:{enabled:false}},respond:async c=>{if(!summaryRequest(c)&&hold){entered();await held;}return fauxAssistantMessage(summaryRequest(c)?'## Goal\nPreserved manual checkpoint':'DETAIL '.repeat(15000));}});
  try{
    await settle(f,'manual-history');hold=true;const busy=await f.root.submit({type:'input',content:'busy',requestId:'busy'},context);await started;
    const task=await f.root.compact('Preserve checkpoint',context);const result=await f.harness.waitForTask(task,context);assert.equal(result.state.status,'terminal');
    assert.equal(result.state.outcome.status,'completed');const placement=result.state.outcome.status==='completed'?(result.state.outcome.result as any).submissionId:undefined;assert.ok(placement);
    assert.equal((await (await f.harness.submission(placement!,context))!.status(context)).status,'queued');
    release();assert.equal((await busy.wait(context)).status,'done');assert.equal((await (await f.harness.submission(placement!,context))!.wait(context)).status,'done');
    const view=await f.root.context(context);assert.ok(CompactionEntry.is(view.head));assert.equal(view.head.data.reason,'manual');await f.close();await f.open();assert.deepEqual(await f.root.context(context),view);
  }finally{release();await f.close();rmSync(dir,{recursive:true,force:true});}
});

test('native document and phase checkpoint survive SIGKILL; Stop aborts original task without repeating preparation',{timeout:15000},async()=>{
  const dir=mkdtempSync(join(tmpdir(),'surge-native-checkpoint-'));const child=fork(new URL('./pi-native-qualification-fixture.js',import.meta.url),['native-crash',dir],{stdio:['ignore','ignore','ignore','ipc']});
  let identity:any;let f:Awaited<ReturnType<typeof nativeFixture>>|undefined;
  try{
    await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('checkpoint deadline')),6000);child.on('message',(m:any)=>{if(m.type==='identity')identity=m;if(m.type==='checkpoint'){clearTimeout(timer);resolve();}});child.once('exit',()=>{clearTimeout(timer);reject(new Error('child exited before checkpoint'));});});
    const exited=once(child,'exit');assert.equal(child.kill('SIGKILL'),true);await exited;
    f=await nativeFixture(dir);assert.equal(f.root.id,identity.conversationId);const plan=await f.harness.snapshot(Plan,f.root.id,context);assert.deepEqual(plan,{steps:['committed preparation'],phase:'prepared'});
    const task=await f.harness.commit(tx=>tx.task(identity.taskId),context);assert.equal((task!.state as any).checkpoint.phase,'finish');
    await f.root.abort(context);const stopped=await f.harness.waitForTask(identity.taskId,context);assert.equal(stopped.state.status,'terminal');assert.equal(stopped.state.outcome.status,'aborted');assert.deepEqual(await f.harness.snapshot(Plan,f.root.id,context),plan);assert.equal(f.faux.state.callCount,0);
    await f.close();await f.open();assert.deepEqual(await f.harness.snapshot(Plan,f.root.id,context),plan);assert.equal((await f.harness.commit(tx=>tx.task(identity.taskId),context))!.state.outcome!.status,'aborted');assert.equal(f.faux.state.callCount,0);
  }finally{if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}if(f)await f.close();rmSync(dir,{recursive:true,force:true});}
});

test('native owned analyst conversation survives SIGKILL with parent and child identities; Stop waits for child terminal',{timeout:15000},async()=>{
  const dir=mkdtempSync(join(tmpdir(),'surge-native-owned-'));const child=fork(new URL('./pi-native-qualification-fixture.js',import.meta.url),['native-owned-crash',dir],{stdio:['ignore','ignore','ignore','ipc']});let identity:any,ready:any;let f:Awaited<ReturnType<typeof nativeFixture>>|undefined;
  try{
    await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('owned checkpoint deadline')),6000);child.on('message',(m:any)=>{if(m.type==='identity')identity=m;if(m.type==='checkpoint'){ready=m;clearTimeout(timer);resolve();}});child.once('exit',()=>{clearTimeout(timer);reject(new Error('owned child exited before checkpoint'));});});
    const exited=once(child,'exit');assert.equal(child.kill('SIGKILL'),true);await exited;f=await nativeFixture(dir);assert.equal(f.root.id,identity.conversationId);
    const parent=await f.harness.getTask(identity.taskId,context);assert.equal((parent!.state as any).checkpoint.child,ready.conversationId);assert.equal((parent!.state as any).checkpoint.task,ready.taskId);
    assert.deepEqual(await f.harness.snapshot(Plan,ready.conversationId,context),{steps:['committed preparation'],phase:'prepared'});
    const nativeChild=await f.harness.commit(tx=>tx.conversation(ready.conversationId),context);assert.equal(nativeChild!.owner!.taskId,identity.taskId);
    await f.root.abort(context);assert.equal((await f.harness.getTask(ready.taskId,context))!.state.outcome!.status,'aborted');assert.equal((await f.harness.getTask(identity.taskId,context))!.state.outcome!.status,'aborted');assert.equal((await f.harness.snapshot(Plan,f.root.id,context))!.phase,'owner-aborted');
    assert.deepEqual(await f.harness.snapshot(Plan,ready.conversationId,context),{steps:['committed preparation'],phase:'prepared'});assert.equal(f.faux.state.callCount,0);
    const tasks=await rows(f,'tasks');await f.close();await f.open();assert.deepEqual(await rows(f,'tasks'),tasks);assert.equal((await f.harness.commit(tx=>tx.conversation(ready.conversationId),context))!.owner!.taskId,identity.taskId);
  }finally{if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}if(f)await f.close();rmSync(dir,{recursive:true,force:true});}
});

test('in-flight native default background summary resumes original task after SIGKILL and accounts only committed resumed usage',{timeout:15000},async()=>{
  const dir=mkdtempSync(join(tmpdir(),'surge-native-summary-crash-'));const child=fork(new URL('./pi-native-qualification-fixture.js',import.meta.url),['native-summary-crash',dir],{stdio:['ignore','ignore','ignore','ipc']});let identity:any;let f:Awaited<ReturnType<typeof nativeFixture>>|undefined;
  try{
    await new Promise<void>((resolve,reject)=>{let ready=false;const timer=setTimeout(()=>reject(new Error('summary checkpoint deadline')),6000);child.on('message',(m:any)=>{if(m.type==='identity')identity=m;if(m.type==='summary')ready=true;if(identity&&ready){clearTimeout(timer);resolve();}});child.once('exit',()=>{clearTimeout(timer);reject(new Error('summary child exited early'));});});
    const exited=once(child,'exit');assert.equal(child.kill('SIGKILL'),true);await exited;f=await nativeFixture(dir);assert.equal(f.root.id,identity.conversationId);
    const entries=await rows(f,'entries'),before=await f.harness.usage(context);const live=(await rows(f,'tasks')).map(r=>JSON.parse(r.record)).filter(r=>r.kind==='pi.compaction'&&r.state.status!=='terminal');assert.equal(live.length,1);assert.equal(live[0].state.checkpoint.phase,'summarize');const taskId=live[0].id;
    const task=await f.harness.waitForTask(taskId,context);assert.equal(task.state.outcome!.status,'completed');const placement=(task.state.outcome as any).result.submissionId;assert.ok(placement);assert.equal((await (await f.harness.submission(placement,context))!.wait(context)).status,'done');await f.root.waitForIdle(context);
    for(const entry of entries)assert.deepEqual((await rows(f,'entries')).find(e=>e.id===entry.id),entry);assert.equal(f.responses.filter(r=>r.summary).length,1);
    const usage=await f.harness.usage(context);assert.equal(usage.models['faux/qualified-64k']!.totalTokens-(before.models['faux/qualified-64k']?.totalTokens??0),f.responses.reduce((s,r)=>s+r.message.usage.totalTokens,0));
    const calls=f.faux.state.callCount;await f.close();await f.open();assert.equal((await f.harness.getTask(taskId,context))!.state.outcome!.status,'completed');assert.equal(f.faux.state.callCount,calls);assert.deepEqual(await f.harness.usage(context),usage);
  }finally{if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}if(f)await f.close();rmSync(dir,{recursive:true,force:true});}
});
