import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fixture} from './pi-fixture.js';
import {classifyNativeProviderError,availabilityBlocker} from '../provider-failures.js';
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
  await assert.rejects(f.agent.runJob(claimed,0),/original submission terminal/);f.queue.finish(job.id,claimed.run_token!,'failed','terminal model error');
  const stored=f.queue.get(job.id)!,failure=f.store.get<any>('providerFailure:'+job.id);
  assert.equal(failure.kind,status===401?'authentication':status===429?'quota':'transient_stream');assert.equal(failure.source,'native_entry');
  assert.equal(failure.conversationId,stored.conversation_id);assert.equal(failure.submissionId,stored.submission_id);assert.ok(failure.taskId);assert.ok(failure.entryId);
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
