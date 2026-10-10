import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fixture} from './pi-fixture.js';
import {classifyNativeProviderError,availabilityBlocker,matchedNativeProviderFailure} from '../provider-failures.js';
import {TelegramTurns} from '../telegram-turns.js';
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai/utils/event-stream';
import {Telegram} from '../telegram.js';
import {ApplicationControl} from '../application-control.js';
import {RuntimeImprovements} from '../runtime-improvements.js';
import {hash,now} from '../domain.js';
import {BACKGROUND_CONTEXT as context} from '@earendil-works/chord/context';
const sdk=await import(new URL('./api/openai-responses.js',import.meta.resolve('@earendil-works/pi-ai')).href);
for(const status of [0,401,429])test('genuine SDK/native failure '+(status||'truncated stream')+' is qualified without replay',{timeout:15000},async()=>{
 const directory=mkdtempSync(join(tmpdir(),'surge-provider-'));let f=fixture(directory,'state');
 try{
  const original=f.agent.models.streamSimple.bind(f.agent.models);let requests=0,tools=0;
  f.agent.models.streamSimple=(model,request,options)=>{
   if(!request.messages.some((m:any)=>m.role==='toolResult')){tools++;return original(model,request,options);}
   return sdk.streamSimple(model,request,{...options,apiKey:'fixture-no-network',maxRetries:0,fetch:async()=>{
    requests++;
    return status?new Response(JSON.stringify({error:{message:'private-provider-body',type:'fixture',code:status===401?'invalid_api_key':'rate_limit_exceeded'}}),{status,headers:{'content-type':'application/json'}}):new Response('event: response.created\ndata: {"type":"response.created","response":{"id":"fixture-response","model":"gpt-6.1-sol"}}\n\n',{headers:{'content-type':'text/event-stream'}});
   }});
  };
  await f.agent.open();const job=f.queue.enqueue({requestId:'original-provider-'+status,kind:'analysis',payload:{message:'read state'}}),claimed=f.queue.claim('analyst','first')!;
  await assert.rejects(f.agent.runJob(claimed,0),/original submission terminal/);f.queue.finish(job.id,claimed.run_token!,'failed','Model unavailable; original submission terminal, no automatic replay');
  const stored=f.queue.get(job.id)!,failure=f.store.get<any>('providerFailure:'+job.id);
  assert.equal(failure.kind,status===401?'authentication':status===429?'quota':'transient_stream');assert.equal(failure.source,'native_entry');
  assert.equal(failure.conversationId,stored.conversation_id);assert.equal(failure.submissionId,stored.submission_id);assert.ok(failure.taskId);assert.ok(failure.entryId);
  assert.ok(matchedNativeProviderFailure(failure,stored));
  // Integration boundary: generic failed-job text must defer to the original
  // matched native receipt, so pure provider faults do not create development files.
  const captureAt=now();f.store.set('telegramConfigured',true);f.store.set('telegramBinding',{generation:'provider-capture',chatId:42,userId:42,since:captureAt});
  const telegram=new Telegram(f.store,new ApplicationControl(f.store,f.queue),directory,{call:async()=>{throw Error('No live Telegram');}});
  try{telegram.capture(captureAt);telegram.capture(captureAt);
   const issue=new RuntimeImprovements(f.store).issues().find(i=>i.revisions[0]?.observation.receipt===job.id)!;
   assert.equal(issue.revisions[0]!.observation.classification,status?'authentication':'upstream_transient');
   assert.equal(f.store.one("SELECT count(*) n FROM telegram_outbox WHERE event_id LIKE 'advisory:%'").n,0);
   assert.equal(f.store.one("SELECT count(*) n FROM meta WHERE key LIKE 'runtimeArtifact:%'").n,0);
   assert.deepEqual(f.store.get('providerFailure:'+job.id),failure);
   assert.equal(f.queue.get(job.id)?.submission_id,stored.submission_id);assert.equal(f.store.all('SELECT * FROM operations').length,0);
  }finally{telegram.stop();}
  assert.equal(failure.cooldownMs,status?1800000:60000);assert.equal(requests,1);assert.equal(tools,1);assert.equal(existsSync(join(directory,'effects.jsonl')),false);
  assert.doesNotMatch(JSON.stringify(f.store.get('agent')),/private-provider-body|fixture-no-network/);
  console.log('provider-native-proof',JSON.stringify({status,job:job.id,conversation:failure.conversationId,submission:failure.submissionId,task:failure.taskId,entry:failure.entryId,kind:failure.kind}));
  const harness=(f.agent as any).harness,submission=await harness.submission(Number(stored.submission_id),context);assert.equal((await submission.status(context)).status,'unanswered');
  const future=f.queue.enqueue({requestId:'future-provider-'+status,kind:'analysis',payload:{message:'fresh read'}});const wait=f.queue.claim('analyst','waiting')!;assert.equal(wait.id,future.id);f.queue.wait(wait.id,wait.run_token!,'model_unavailable');
  const until=f.store.get<number>('modelUnavailableUntil')!;await f.agent.close();f.store.close();f=fixture(directory,'state');await f.agent.open();
  assert.equal(await f.agent.available(),false);f.queue.releaseWaiting(new Date(until-1).toISOString());assert.equal(f.queue.get(future.id)?.state,'waiting');
  assert.equal(f.queue.get(job.id)?.submission_id,stored.submission_id);
  // Advance only the fixture clock to expiry; never rewrite the original receipt or resubmit it.
  const clock=Date.now;Date.now=()=>until+1;
  try{f.queue.releaseWaiting(new Date(until+1).toISOString());assert.equal(await f.agent.available(),true);const next=f.queue.claim('analyst','fresh',new Date(until+1).toISOString())!;assert.equal(next.id,future.id);await f.agent.runJob(next,0);assert.notEqual(f.queue.get(next.id)?.submission_id,stored.submission_id);}finally{Date.now=clock;}
  assert.equal(existsSync(join(directory,'effects.jsonl')),false);
 }finally{await f.agent.close();f.store.close();rmSync(directory,{recursive:true,force:true});}
});
test('unknown text and legacy state never claim authentication or quota',()=>{
 for(const message of ['Quota exceeded; private-provider-detail','please login authentication failed','HTTP 429 quota','invalid_api_key'])assert.equal(classifyNativeProviderError(message).kind,'provider_unknown');
 for(const failure of [undefined,{kind:'authentication'},{kind:'quota',source:'legacy_unknown'}])assert.doesNotMatch(availabilityBlocker(failure),/Autenticazione|Quota|connessione/);
});
test('legacy persisted expiry and missing-expiry fallback remain conservative',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'surge-legacy-'));const f=fixture(directory,'state');
 try{const job=f.queue.enqueue({requestId:'legacy-wait',kind:'analysis',payload:{message:'read'}}),claimed=f.queue.claim('analyst','owner')!;const at='2026-10-10T00:00:00.000Z';f.queue.wait(job.id,claimed.run_token!,'model_unavailable',at);
 f.store.set('modelUnavailableUntil',Date.parse(at)+3600000);f.queue.releaseWaiting('2026-10-10T00:31:00Z');assert.equal(f.queue.get(job.id)?.state,'waiting');f.queue.releaseWaiting('2026-10-10T01:00:00Z');assert.equal(f.queue.get(job.id)?.state,'queued');
 }finally{await f.agent.close();f.store.close();rmSync(directory,{recursive:true,force:true});}
});
test('pre-submission legacy hold retains expiry and cannot fabricate native or authentication proof',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'surge-held-'));const f=fixture(directory,'state');
 try{const until=Date.now()+60000;f.store.set('modelUnavailableUntil',until);(f.agent as any).cooldown=until;await f.agent.open();const job=f.queue.enqueue({requestId:'held',kind:'analysis',payload:{message:'read'}}),claimed=f.queue.claim('analyst','owner')!;
 await assert.rejects(f.agent.runJob(claimed,0),/unavailable/);assert.equal(f.store.get('modelUnavailableUntil'),until);assert.equal(f.queue.get(job.id)?.submission_id,null);assert.equal(f.store.get('providerFailure:'+job.id),undefined);assert.doesNotMatch(availabilityBlocker(f.store.get<any>('agent').failure),/Autenticazione|Quota/);
 }finally{await f.agent.close();f.store.close();rmSync(directory,{recursive:true,force:true});}
});
test('missing configured model fails before submission with truthful separate configuration receipt',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'surge-model-'));const f=fixture(directory,'state');
 try{f.store.set('model',null);await f.agent.open();const job=f.queue.enqueue({requestId:'no-configured-model',kind:'analysis',payload:{message:'read'}}),claimed=f.queue.claim('analyst','owner')!;
 await assert.rejects(f.agent.runJob(claimed,0),/model/);const failure=f.store.get<any>('agent').failure;assert.equal(failure.kind,'configuration_missing');assert.equal(failure.source,'pre_submission');assert.equal(f.queue.get(job.id)?.submission_id,null);assert.equal(f.calls.thinking.length,0);assert.match(availabilityBlocker(failure),/non configurato/);
 }finally{await f.agent.close();f.store.close();rmSync(directory,{recursive:true,force:true});}
});

test('missing, mismatched and invalid native provenance stays unknown and still produces advisory capture without touching original receipts',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'surge-provider-provenance-')),f=fixture(directory,'state');
 const at='2026-10-10T10:00:00.000Z';
 try{
  f.store.set('telegramConfigured',true);f.store.set('telegramBinding',{generation:'proof-owner',chatId:42,userId:42,since:at});
  const telegram=new Telegram(f.store,new ApplicationControl(f.store,f.queue),directory,{call:async()=>{throw Error('No live Telegram');}});
  try{
   const invalid:Record<string,unknown>[]=[{jobId:'another-job'},{conversationId:'9'},{submissionId:'9'},{source:'native_submission'},{source:'legacy_unknown'},{taskId:undefined},{entryId:undefined},{taskId:'0'},{entryId:'not-native'},{kind:'authentication',code:'stream_ended_before_terminal_event'},{code:'http_401',kind:'authentication',httpStatus:429},{until:'2026-10-10T10:02:00.000Z'},{cooldownMs:0},{at:'unknown'},{errorMessage:'OpenAI API error (401): model text is not proof'}];
   for(const mutation of [undefined,...invalid]){
    const job=f.queue.enqueue({requestId:'provenance-'+f.queue.list().length,kind:'analysis',payload:{message:'private owner input'}});
    f.store.run("UPDATE jobs SET state='failed',error=?,conversation_id='1',submission_id='2',updated_at=? WHERE id=?",'OpenAI API error (401): arbitrary text without native proof',at,job.id);
    const original=f.queue.get(job.id)!;
    const receipt={kind:'transient_stream',code:'stream_ended_before_terminal_event',source:'native_entry',jobId:job.id,conversationId:'1',submissionId:'2',taskId:'3',entryId:'4',at,cooldownMs:60000,until:'2026-10-10T10:01:00.000Z'};
    if(mutation)f.store.set('providerFailure:'+job.id,{...receipt,...mutation});
    assert.equal(matchedNativeProviderFailure(f.store.get('providerFailure:'+job.id),original),undefined);
    const report=new RuntimeImprovements(f.store).reportEvidence('job',job.id,at) as any;
    assert.equal(report.status,'open');assert.match(report.prompt,/Classificazione: unknown/);
    telegram.capture(at);assert.deepEqual(f.queue.get(job.id),original);
   }
   assert.equal(f.store.one("SELECT count(*) n FROM telegram_outbox WHERE event_id LIKE 'advisory:%'").n,1);
   assert.equal(f.store.all('SELECT * FROM operations').length,0);assert.equal(f.store.all('SELECT * FROM owner_proposals').length,0);
   assert.equal(existsSync(join(directory,'effects.jsonl')),false);
   const runtime=new RuntimeImprovements(f.store);runtime.observe({component:'agent',classification:'app_defect',facts:['job_failed','regression_confirmed'],impact:'runtime_blocked',receipt:hash('trusted-app-regression')},at);
   telegram.capture(at);assert.equal(f.store.one("SELECT count(*) n FROM telegram_outbox WHERE event_id LIKE 'advisory:%'").n,2);
  }finally{telegram.stop();}
 }finally{await f.agent.close();f.store.close();rmSync(directory,{recursive:true,force:true});}
});

test('closed native network and qualified auth/quota codes validate only with matching original native IDs',()=>{
 const at='2026-10-10T10:00:00.000Z',job={id:'original',conversation_id:'1',submission_id:'2'};
 for(const [kind,code,httpStatus] of [['transient_network','connection_error',undefined],['transient_network','request_timeout',undefined],['authentication','http_401',401],['authentication','http_403',403],['authentication','invalid_api_key',undefined],['authentication','token_expired',undefined],['quota','http_429',429],['quota','rate_limit_exceeded',undefined],['quota','insufficient_quota',undefined],['quota','subscription_sharing_usage_limit_exceeded',undefined]] as const){
  const cooldownMs=kind==='transient_network'?60000:1800000;
  const receipt={kind,code,httpStatus,source:'native_entry',jobId:job.id,conversationId:'1',submissionId:'2',taskId:'3',entryId:'4',at,cooldownMs,until:new Date(Date.parse(at)+cooldownMs).toISOString()};
  assert.equal(matchedNativeProviderFailure(receipt,job)?.kind,kind);
  assert.equal(matchedNativeProviderFailure(receipt,{...job,submission_id:'9'}),undefined);
 }
});

test('genuine placed correction SDK stream failure binds its accepted turn ledger, preserves both submissions and suppresses only proven advisory', {timeout:15000},async()=>{
 const directory=mkdtempSync(join(tmpdir(),'surge-correction-provider-')),f=fixture(directory,'state');
 let releaseFirst!:()=>void,enteredFirst!:()=>void,releaseProvider!:()=>void,enteredProvider!:()=>void;
 const firstHeld=new Promise<void>(r=>releaseFirst=r),firstStarted=new Promise<void>(r=>enteredFirst=r),providerHeld=new Promise<void>(r=>releaseProvider=r),providerStarted=new Promise<void>(r=>enteredProvider=r);
 let running:Promise<any>|undefined,calls=0,requests=0;
 try{
  const at=now();f.store.set('telegramConfigured',true);f.store.set('telegramBinding',{generation:'correction-owner',chatId:42,userId:42,since:at});
  const turns=new TelegramTurns(f.store,f.queue),control=new ApplicationControl(f.store,f.queue);
  f.agent.models.streamSimple=(model,request,options)=>{
   if(++calls===1){const stream=createAssistantMessageEventStream(),message:any={role:'assistant',api:'openai-responses',provider:'openai',model:'gpt-6.1-sol',timestamp:Date.now(),usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',content:[{type:'text',text:'Original public answer'}]};
    enteredFirst();void firstHeld.then(()=>{stream.push({type:'start',partial:message});stream.push({type:'done',reason:'stop',message});});return stream;}
   return sdk.streamSimple(model,request,{...options,apiKey:'fixture-no-network',maxRetries:0,fetch:async()=>{requests++;enteredProvider();await providerHeld;return new Response('event: response.created\ndata: {"type":"response.created","response":{"id":"fixture-correction","model":"gpt-6.1-sol"}}\n\n',{headers:{'content-type':'text/event-stream'}});}});
  };
  await f.agent.open();const job=control.admit('correction-provider','Original question','telegram');f.store.set('jobTelegramGeneration:'+job.id,'correction-owner');turns.attach(job,'correction-owner',42);
  const claimed=f.queue.claim('coordinator','fixture')!;running=f.agent.runJob(claimed);void running.catch(()=>{});await firstStarted;
  const initialId=f.queue.get(job.id)!.submission_id!,correction=turns.receive('correction-provider-receipt',turns.get(job.id)!,'Correct the original answer');
  assert.ok(['admitted','placed'].includes(await turns.steer(correction.id)));const correctionId=turns.correction(correction.id)!.submissionId!;assert.notEqual(correctionId,initialId);
  releaseFirst();await providerStarted;
  const harness=(f.agent as any).harness,nativeCorrection=await harness.submission(Number(correctionId),context);
  assert.equal((await nativeCorrection.status(context)).status,'placed');
  releaseProvider();await assert.rejects(running,/original submission terminal/);f.queue.finish(job.id,claimed.run_token!,'failed','Model unavailable; original submission terminal, no automatic replay');
  const original=f.queue.get(job.id)!,failure=f.store.get<any>('providerFailure:'+job.id),accepted=turns.correction(correction.id)!,closedTurn=turns.get(job.id)!;
  assert.equal(failure.kind,'transient_stream');assert.equal(failure.source,'native_entry');assert.equal(failure.submissionId,correctionId);assert.equal(original.submission_id,initialId);assert.equal(accepted.submissionId,correctionId);assert.equal(accepted.state,'failed');assert.ok(closedTurn.correctionOrder!.includes(correction.id));
  assert.equal((await nativeCorrection.status(context)).status,'unanswered');assert.equal(requests,1);assert.equal(existsSync(join(directory,'effects.jsonl')),false);
  const telegram=new Telegram(f.store,control,directory,{call:async()=>{throw Error('No live Telegram');}});
  try{
   telegram.capture();const runtime=new RuntimeImprovements(f.store);assert.equal(runtime.issues()[0]!.revisions[0]!.observation.classification,'upstream_transient');assert.equal(f.store.one("SELECT count(*) n FROM telegram_outbox WHERE event_id LIKE 'advisory:%'").n,0);
   // Same conversation alone, unplaced admission, foreign ownership/generation,
   // or mismatched turn version cannot authorize a correction failure receipt.
   const unknown=()=>{f.store.set('runtimeImprovements',[]);f.store.set('runtimeImprovementOccurrences',[]);telegram.capture();assert.equal(new RuntimeImprovements(f.store).issues()[0]!.revisions[0]!.observation.classification,'unknown');};
   f.store.set('providerFailure:'+job.id,{...failure,submissionId:String(Number(correctionId)+999)});unknown();f.store.set('providerFailure:'+job.id,failure);
   for(const mutation of [{state:'admitted'},{jobId:'foreign-job'},{generation:'foreign-generation'},{version:accepted.version+1},{withdrawalRequested:true}]){turns.saveCorrection({...accepted,...mutation} as any);unknown();}
   turns.saveCorrection(accepted);for(const mutation of [{correctionOrder:[]},{conversationId:'999999'},{capability:'foreign-capability'},{generation:undefined}]){turns.save({...closedTurn,...mutation} as any);unknown();}turns.save(closedTurn);
   assert.deepEqual(f.queue.get(job.id),original);assert.deepEqual(f.store.get('providerFailure:'+job.id),failure);assert.equal(f.store.all('SELECT * FROM operations').length,0);assert.equal(f.store.all('SELECT * FROM owner_proposals').length,0);
  }finally{telegram.stop();}
 }finally{releaseFirst();releaseProvider();await running?.catch(()=>{});await f.agent.close();f.store.close();rmSync(directory,{recursive:true,force:true});}
});
