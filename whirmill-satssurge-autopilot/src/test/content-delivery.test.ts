// Actual integrated Agent/Telegram paths with synthetic provider and transport.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.js';
import { Queue } from '../queue.js';
import { TelegramTurns } from '../telegram-turns.js';
import { Telegram } from '../telegram.js';
import { ApplicationControl } from '../application-control.js';
import { authorizeContentRequest,authorizedContentRequest } from '../content-requests.js';
import { fixture as piFixture } from './pi-fixture.js';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
const at='2026-10-10T12:30:00Z';
const snapshot={title:'Synthetic report',observedAt:at,coverage:'Partial synthetic data',evidenceRefs:['synthetic-1'],table:{headers:['Value'],rows:[['1234 sat']]}};
function fixture(call:(method:string,body:any)=>Promise<any>){
 const dir=mkdtempSync(join(tmpdir(),'content-telegram-')),store=new Store(join(dir,'operational.sqlite')),queue=new Queue(store),turns=new TelegramTurns(store,queue);
 const telegram=new Telegram(store,new ApplicationControl(store,queue),dir,{call});
 store.set('contentArtifactsEnabled',true);store.set('telegramBinding',{generation:'synthetic',chatId:42,userId:42});store.set('telegramBotGeneration','bot-1');
 const job=queue.enqueue({requestId:'telegram:synthetic:1',kind:'chat',payload:{message:'Export CSV'}});store.set('jobCapability:'+job.id,'read_only_chat');const t=turns.attach(job,'synthetic',42);t.state='running';t.conversationId='native-1';turns.save(t);store.run("UPDATE jobs SET state='running',conversation_id='native-1' WHERE id=?",job.id);
 return {dir,store,job,turns,telegram,close(){telegram.stop();store.close();rmSync(dir,{recursive:true,force:true});}};
}
test('existing rate-limit fence is rechecked after asynchronous content attachment readback',async()=>{
 let sent=0;const f=fixture(async()=>{sent++;return {message_id:1};});try{
  const grant=f.telegram.content.admit(f.job.id,'csv',snapshot);await f.telegram.content.create(grant,'native-1');
  const attachment=f.telegram.content.attachment.bind(f.telegram.content);f.telegram.content.attachment=async event=>{const result=await attachment(event);f.store.set('telegramRateLimitUntil',Math.max(Date.parse(at),Date.now())+60000);return result;};
  await f.telegram.deliver(at);assert.equal(sent,0);assert.equal(f.store.one('SELECT status FROM telegram_outbox').status,'pending');assert.equal(f.store.one('SELECT attempts FROM telegram_outbox').attempts,0);
 }finally{f.close();}
});
test('integrated Telegram path commits attachment intent before send and never replays accepted timeout',async()=>{
 let calls=0,data:Uint8Array|undefined,f:ReturnType<typeof fixture>;
 f=fixture(async(method,body)=>{calls++;assert.equal(method,'sendDocument');assert.equal(f.store.one('SELECT status FROM telegram_outbox').status,'sending');assert.equal(body.get('chat_id'),'42');const file=body.get('document') as File;data=new Uint8Array(await file.arrayBuffer());assert.match(file.name,/\.csv$/);throw Error('synthetic accepted timeout');});
 try{const g=f.telegram.content.admit(f.job.id,'csv',snapshot);await f.telegram.content.create(g,'native-1');await f.telegram.deliver(at);assert.ok(data);assert.match(Buffer.from(data!).toString(),/1234 sat/);assert.equal(f.store.one('SELECT status FROM telegram_outbox').status,'uncertain');f.telegram.recover();await f.telegram.deliver(at);assert.equal(calls,1);assert.equal(f.store.one('SELECT count(*) n FROM operations').n,0);}finally{f.close();}
});
test('integrated Telegram rejection retries recorded XLSX bytes; final synchronous fence catches Stop after IO',async()=>{
 let calls=0;const bytes:Buffer[]=[];let f:ReturnType<typeof fixture>;
 f=fixture(async(method,body)=>{assert.equal(method,'sendDocument');calls++;bytes.push(Buffer.from(await (body.get('document') as File).arrayBuffer()));if(calls===1)throw Object.assign(Error('synthetic rejection'),{rejected:true,retryAfter:0,apiCode:400});return {message_id:42};});
 try{const g=f.telegram.content.admit(f.job.id,'xlsx',snapshot);await f.telegram.content.create(g,'native-1');await f.telegram.deliver(at);assert.equal(f.store.one('SELECT status FROM telegram_outbox').status,'pending');await f.telegram.deliver('2026-10-10T12:30:05Z');assert.equal(calls,2);assert.deepEqual(bytes[0],bytes[1]);assert.equal(f.store.one('SELECT status FROM telegram_outbox').status,'sent');}finally{f.close();}
 let sent=0;const h=fixture(async()=>{sent++;return {message_id:1};});
 try{const g=h.telegram.content.admit(h.job.id,'csv',snapshot);await h.telegram.content.create(g,'native-1');const original=h.telegram.content.attachment.bind(h.telegram.content);h.telegram.content.attachment=async id=>{const a=await original(id);const t=h.turns.get(h.job.id)!;t.state='stop_requested';h.turns.save(t);return a;};await h.telegram.deliver(at);assert.equal(sent,0);assert.equal(h.store.one('SELECT attempts FROM telegram_outbox').attempts,0);assert.equal(h.store.one('SELECT status FROM telegram_outbox').status,'failed');}finally{h.close();}
});
test('integrated Agent registry generates export from staged owner request and delivers through actual Telegram',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'content-agent-proposal-')),f=piFixture(dir,'unsafe');let calls=0;
 try{
  f.store.set('contentArtifactsEnabled',true);f.store.set('telegramBinding',{generation:'synthetic',chatId:42,userId:42});f.store.set('telegramBotGeneration','bot-1');
  (f.agent as any).contentAdmission=(job:any)=>authorizedContentRequest(f.store,job.id);
  f.agent.models.streamSimple=(_model,request)=>{
   const count=request.messages.filter((m:any)=>m.role==='toolResult').length,stream=createAssistantMessageEventStream();
   const message:any={role:'assistant',api:'openai-responses',provider:'openai',model:'gpt-6.1-sol',timestamp:Date.now(),usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:count>=2?'stop':'toolUse',content:count>=2?[{type:'text',text:'Synthetic CSV ready'}]:[{type:'toolCall',id:'content-'+count,name:count?'create_content_artifact':'content_snapshot',arguments:{}}]};
   queueMicrotask(()=>{stream.push({type:'start',partial:message});stream.push({type:'done',reason:message.stopReason,message});});return stream;
  };
  await f.agent.open();const job=f.queue.enqueue({requestId:'telegram:content-agent:1',kind:'chat',payload:{message:'Export synthetic CSV'}});f.store.set('jobCapability:'+job.id,'read_only_chat');const turns=new TelegramTurns(f.store,f.queue);turns.attach(job,'synthetic',42);authorizeContentRequest(f.store,job.id,'csv',snapshot);
  const claimed=f.queue.claim('coordinator','fixture')!;await f.agent.runJob(claimed);assert.equal(f.store.one("SELECT count(*) n FROM meta WHERE key LIKE 'contentReceipt:%'").n,1);
  const telegram=new Telegram(f.store,new ApplicationControl(f.store,f.queue),dir,{call:async(method,body:any)=>{assert.equal(method,'sendDocument');calls++;assert.match(await (body.get('document') as File).text(),/1234 sat/);return {message_id:42};}});
  await telegram.deliver(at);telegram.stop();assert.equal(calls,1);assert.equal(f.store.one('SELECT count(*) n FROM operations').n,0);assert.equal(existsSync(join(dir,'effects.jsonl')),false);
 }finally{await f.agent.close();f.store.close();rmSync(dir,{recursive:true,force:true});}
});
test('integrated Telegram ingress commits explicit export snapshot with original request and keeps it on replay',async()=>{
 const f=fixture(async()=>({message_id:1}));let projections=0;try{
  f.turns.finalize(f.job.id,'completed');f.store.run("UPDATE jobs SET state='completed' WHERE id=?",f.job.id);f.store.set('telegramConfigured',true);
  f.telegram.setContentProjection(()=>{projections++;return structuredClone(snapshot);});
  f.telegram.ingest([{update_id:91,message:{message_id:91,date:Math.floor(Date.now()/1000),chat:{id:42,type:'private'},from:{id:42},text:'/export csv'}}]);await f.telegram.process();
  const requests=f.store.all("SELECT value FROM meta WHERE key LIKE 'contentAuthorizedRequest:%'");assert.equal(requests.length,1);const staged=JSON.parse(requests[0]!.value);assert.equal(staged.format,'csv');assert.equal(projections,1);assert.equal(f.store.one('SELECT status FROM telegram_updates WHERE update_id=91').status,'done');
  f.store.run("UPDATE telegram_updates SET status='pending' WHERE update_id=91");await f.telegram.process();assert.equal(projections,1);assert.equal(f.store.one("SELECT count(*) n FROM meta WHERE key LIKE 'contentAuthorizedRequest:%'").n,1);
 }finally{f.close();}
});
