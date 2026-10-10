import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../store.js';
import {Queue} from '../queue.js';
import {ApplicationControl} from '../application-control.js';
import {Telegram} from '../telegram.js';
import {TelegramTurns} from '../telegram-turns.js';
import {UiEvents} from '../ui-events.js';
function fixture(call:any){const dir=mkdtempSync(join(tmpdir(),'transport-')),s=new Store(':memory:'),q=new Queue(s),c=new ApplicationControl(s,q),t=new Telegram(s,c,dir,{call}),turns=new TelegramTurns(s,q);s.set('bootstrapReady',true);s.set('telegramConfigured',true);s.set('telegramBinding',{generation:'g',chatId:42,userId:42,since:new Date().toISOString()});let stops=0;return {s,q,t,turns,open(request='first'){const job=c.admit(request,'read','telegram'),turn=turns.attach(job,'g',42),claimed=q.claim('coordinator','owner')!;turns.bind(claimed,{steer:async()=>{},stop:async()=>{stops++;}});new UiEvents(s).append(job.id,'text',{text:'Public preview'});return {job,turn,claimed};},get stops(){return stops;},close(){t.stop();s.close();rmSync(dir,{recursive:true,force:true});}};}
function gate(){let resolve!:(v?:any)=>void;const promise=new Promise<any>(r=>resolve=r);return {promise,resolve};}
const stop=(id:number,draft:number)=>({update_id:id,stopped_message_generation:{chat:{id:42,type:'private'},draft_id:draft}});
test('rotating rich render and heartbeat retain delayed exact Stop aliases; duplicate and unknown never target another turn',async()=>{
 const calls:any[]=[],f=fixture(async(method:string,body:any)=>{calls.push({method,body});return {message_id:1};});try{const {job}=f.open();const at=Date.now();await f.t.streamDrafts(new Date(at).toISOString());await f.t.streamDrafts(new Date(at+1000).toISOString());assert.equal(calls.length,1);await f.t.streamDrafts(new Date(at+21000).toISOString());assert.equal(calls.length,2);const [first,second]=calls.map(c=>c.body.draft_id);assert.notEqual(first,second);assert.equal(calls[0].body.rich_message.html,calls[1].body.rich_message.html);
 for(const id of [first,second]){const a=f.s.get<any>('telegramDraft:'+id);assert.equal(a.jobId,job.id);assert.equal(a.chatId,42);assert.equal(a.outcome,'accepted');assert.equal(a.length,14);assert.equal(a.expires,new Date(Date.parse(a.at)+86700000).toISOString());assert.equal(a.text,undefined);}
 f.t.ingest([stop(1,first),stop(1,first),stop(2,second)]);await f.t.process();await new Promise(r=>setImmediate(r));assert.equal(f.stops,1);assert.equal(f.s.get<any>('telegramStop:update:1').jobId,job.id);f.t.ingest([stop(3,999999)]);await f.t.process();assert.equal(f.stops,1);assert.match(f.s.one("SELECT text FROM telegram_outbox WHERE event_id='update:3'").text,/sconosciuto/);
 }finally{f.close();}
});
test('stable control policy retains ID and cannot change active/inflight policy or identity',async()=>{
 const calls:any[]=[],f=fixture(async(method:string,body:any)=>{calls.push({method,body});return true;});try{const binding=f.s.get('telegramBinding');f.t.streamPolicy('stable');assert.equal(f.t.status().richDraftPolicy,'stable');assert.deepEqual(f.s.get('telegramBinding'),binding);assert.throws(()=>f.t.streamPolicy('bad'),/Unknown/);f.open();assert.throws(()=>f.t.streamPolicy('rotating'),(e:any)=>e.statusCode===409);await f.t.streamDrafts();await f.t.streamDrafts(new Date(Date.now()+21000).toISOString());assert.equal(calls[0].body.draft_id,calls[1].body.draft_id);}finally{f.close();}
});
test('normal message invalidates unchanged draft and active outbox batch is bounded; terminal never resurrects',async()=>{
 const calls:any[]=[],f=fixture(async(method:string,body:any)=>{calls.push({method,body});return {message_id:calls.length};});try{const {job,claimed}=f.open();const at=Date.now();await f.t.streamDrafts(new Date(at).toISOString());f.t.enqueue('ordinary-1','Acknowledged');f.t.enqueue('ordinary-2','Queued');await f.t.deliver();assert.equal(calls.filter(c=>c.method==='sendMessage').length,1);assert.equal(f.s.get<any>('telegramStream:'+job.id).invalidated,true);await f.t.streamDrafts(new Date(at+2000).toISOString());assert.equal(calls.filter(c=>c.method==='sendRichMessageDraft').length,2);f.q.finish(job.id,claimed.run_token!,'completed',{answer:'Final'});f.turns.finalize(job.id,'completed');const n=calls.length;await f.t.streamDrafts(new Date(at+25000).toISOString());assert.equal(calls.length,n);}finally{f.close();}
});
for(const change of ['closed','version','rebind','stop'] as const)test('late draft await '+change+' cannot restore obsolete stream state',async()=>{
 const held=gate(),entered=gate(),f=fixture(async(method:string)=>{if(method==='sendRichMessageDraft'){entered.resolve();return held.promise;}return true;});try{const {job}=f.open();const run=f.t.streamDrafts();await entered.promise;const old=f.turns.get(job.id)!;
 if(change==='closed')f.turns.finalize(job.id,'completed');if(change==='version')f.s.set('telegramTurn:'+job.id,{...old,version:old.version+1});if(change==='rebind')f.s.set('telegramBinding',{generation:'new',chatId:43,userId:43});if(change==='stop')await f.turns.stop(job.id,'g',old.version,'race');held.resolve(true);await run;assert.equal(f.s.get<any>('telegramStream:'+job.id),undefined);const aliases=f.s.all("SELECT value FROM meta WHERE key LIKE 'telegramDraft:%'");assert.equal(aliases.length,1);assert.equal(JSON.parse(aliases[0].value).outcome,'accepted');f.t.ingest([stop(90,JSON.parse(f.s.all("SELECT key FROM meta WHERE key LIKE 'telegramDraft:%'")[0].key.slice(14)))]);await f.t.process();if(change!=='stop')assert.equal(f.stops,0);
 }finally{held.resolve();f.close();}
});
test('shared 429 gate blocks draft and ordinary sends without a second keepalive',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;throw Object.assign(Error('safe'),{rejected:true,retryAfter:120});});try{f.open();await f.t.streamDrafts();f.t.enqueue('normal','Reply');await f.t.deliver();await f.t.streamDrafts(new Date(Date.now()+1000).toISOString());assert.equal(calls,1);assert.ok(f.s.get<number>('telegramRateLimitUntil')!>Date.now());}finally{f.close();}
});
test('timed out normal dispatch retains uncertainty, releases draft scheduling, and is never retried',{timeout:10000},async()=>{
 const calls:string[]=[],f=fixture(async(method:string)=>{calls.push(method);if(method==='sendMessage')return new Promise(()=>{});return true;});try{f.open();f.t.enqueue('slow','Reply');const at=Date.now();await f.t.deliver();assert.ok(Date.now()-at<6500);assert.equal(f.s.one("SELECT status FROM telegram_outbox WHERE event_id='slow'").status,'uncertain');await f.t.streamDrafts();await f.t.deliver();assert.equal(calls.filter(c=>c==='sendMessage').length,1);assert.equal(calls.at(-1),'sendRichMessageDraft');}finally{f.close();}
});
test('draft uncertainty retains exact alias and expiry is explicit, never borrowed by a newer turn',async()=>{
 const f=fixture(async()=>{throw Error('safe timeout');});try{const {job}=f.open();await f.t.streamDrafts();const [row]=f.s.all("SELECT key,value FROM meta WHERE key LIKE 'telegramDraft:%'");const alias=JSON.parse(row.value);assert.equal(alias.outcome,'uncertain');assert.equal(alias.jobId,job.id);assert.equal(f.s.get<any>('telegramStream:'+job.id).draftId,Number(row.key.slice(14)));f.s.set(row.key,{...alias,expires:'2000-01-01T00:00:00Z'});f.t.ingest([stop(1,Number(row.key.slice(14)))]);await f.t.process();assert.equal(f.stops,0);assert.match(f.s.one("SELECT text FROM telegram_outbox WHERE event_id='update:1'").text,/scaduto/);}finally{f.close();}
});
test('persisted aliases and monotonic counter survive actual Store reopen; late previous-turn Stop cannot target new turn',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'alias-reopen-')),path=join(dir,'operational.sqlite');let s=new Store(path),t:Telegram|undefined;let stopCalls=0;
 try{let q=new Queue(s),turns=new TelegramTurns(s,q),c=new ApplicationControl(s,q);s.set('telegramBinding',{generation:'g',chatId:42,userId:42,since:new Date().toISOString()});s.set('telegramConfigured',true);const old=c.admit('old-turn','read','telegram');turns.attach(old,'g',42);const claimed=q.claim('coordinator','owner')!;turns.bind(claimed,{steer:async()=>{},stop:async()=>{stopCalls++;}});t=new Telegram(s,c,dir,{call:async()=>true});await t.streamDrafts();const oldId=s.get<any>('telegramStream:'+old.id).draftId;turns.finalize(old.id,'completed');q.finish(old.id,claimed.run_token!,'completed',{});t.stop();s.close();
 s=new Store(path);q=new Queue(s);turns=new TelegramTurns(s,q);c=new ApplicationControl(s,q);t=new Telegram(s,c,dir,{call:async()=>true});const next=c.admit('next-turn','read','telegram');turns.attach(next,'g',42);turns.bind(q.claim('coordinator','new')!,{steer:async()=>{},stop:async()=>{stopCalls++;}});await t.streamDrafts(new Date(Date.now()+2000).toISOString());assert.ok(s.get<any>('telegramStream:'+next.id).draftId>oldId);t.ingest([stop(55,oldId)]);await t.process();assert.equal(stopCalls,0);assert.equal(turns.get(next.id)?.state,'running');assert.equal(s.get<any>('telegramStop:update:55').jobId,old.id);assert.equal(s.get<any>('telegramStop:update:55').state,'stale');
 }finally{t?.stop();s.close();rmSync(dir,{recursive:true,force:true});}
});
test('alias capacity fails closed without sending or reusing identifiers',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;return true;});try{const {job}=f.open();f.s.set('telegramDraftAliasState',{next:2147483647,count:1,prunedAt:Date.now()});await f.t.streamDrafts();assert.equal(calls,0);assert.equal(f.s.get<any>('telegramStream:'+job.id).status,'capacity_blocked');assert.equal(f.s.get<any>('telegramDraftAliasState').next,2147483647);}finally{f.close();}
});
test('overlapping normal/draft calls serialize per peer, and policy changes reject an inflight dispatch',async()=>{
 const held=gate(),entered=gate(),calls:string[]=[],f=fixture(async(method:string)=>{calls.push(method);if(method==='sendMessage'){entered.resolve();return held.promise;}return true;});try{f.t.enqueue('normal','reply');const normal=f.t.deliver();await entered.promise;assert.throws(()=>f.t.streamPolicy('stable'),(e:any)=>e.statusCode===409);f.open();const draft=f.t.streamDrafts();await new Promise(r=>setImmediate(r));assert.deepEqual(calls,['sendMessage']);held.resolve({message_id:1});await Promise.all([normal,draft]);assert.deepEqual(calls,['sendMessage','sendRichMessageDraft']);}finally{held.resolve();f.close();}
});

test('alias count cap is explicit and does not allocate a dispatch ID',async()=>{let calls=0;const f=fixture(async()=>{calls++;return true;});try{const {job}=f.open();f.s.set('telegramDraftAliasState',{next:100005,count:100000,prunedAt:Date.now()});await f.t.streamDrafts();assert.equal(calls,0);assert.equal(f.s.get<any>('telegramStream:'+job.id).status,'capacity_blocked');assert.equal(f.s.get<any>('telegramDraftAliasState').next,100005);assert.equal(f.s.all("SELECT key FROM meta WHERE key LIKE 'telegramDraft:%'").length,0);}finally{f.close();}});

test('stable control correction version allocates a fresh alias and old alias Stop remains stale',async()=>{const calls:any[]=[],f=fixture(async(method:string,body:any)=>{calls.push({method,body});return true;});try{f.t.streamPolicy('stable');const {job}=f.open();const at=Date.now();await f.t.streamDrafts(new Date(at).toISOString());const oldId=f.s.get<any>('telegramStream:'+job.id).draftId,old=f.turns.get(job.id)!;f.s.set('telegramTurn:'+job.id,{...old,version:old.version+1});new UiEvents(f.s).append(job.id,'text',{text:'Corrected public preview'});await f.t.streamDrafts(new Date(at+2000).toISOString());const current=f.s.get<any>('telegramStream:'+job.id).draftId;assert.notEqual(current,oldId);f.t.ingest([stop(77,oldId)]);await f.t.process();assert.equal(f.stops,0);assert.equal(f.s.get<any>('telegramStop:update:77').state,'stale');assert.equal(f.turns.get(job.id)?.state,'running');}finally{f.close();}});

for(const change of ['closed','stop','version','bot'] as const)test('late rejected draft 429 preserves current bot quota after '+change+' without stale turn writes',async()=>{
 const held=gate(),entered=gate(),calls:string[]=[],f=fixture(async(method:string)=>{calls.push(method);if(method==='sendRichMessageDraft'){entered.resolve();await held.promise;throw Object.assign(Error('API rejection'),{rejected:true,retryAfter:120});}return {message_id:1};});
 try{const {job}=f.open(),run=f.t.streamDrafts();await entered.promise;const turn=f.turns.get(job.id)!;
 if(change==='closed')f.turns.finalize(job.id,'completed');
 if(change==='stop')await f.turns.stop(job.id,'g',turn.version,'quota-race');
 if(change==='version')f.s.set('telegramTurn:'+job.id,{...turn,version:turn.version+1});
 if(change==='bot')f.s.set('telegramBotGeneration','replacement');
 held.resolve();await run;assert.equal(f.s.get('telegramStream:'+job.id),undefined);
 f.t.enqueue('final-quota-'+change,'Final');await f.t.deliver();
 if(change==='bot'){assert.equal(f.s.get('telegramRateLimitUntil'),undefined);assert.ok(calls.includes('sendMessage'));}
 else{assert.ok(f.s.get<number>('telegramRateLimitUntil')!>Date.now()+119000);assert.deepEqual(calls,['sendRichMessageDraft']);}
 assert.equal(f.s.all("SELECT value FROM meta WHERE key LIKE 'telegramDraft:%'").map(r=>JSON.parse(r.value))[0].outcome,'rejected');
 }finally{held.resolve();f.close();}
});
for(const rotated of [false,true])test('late normal rejection quota belongs only to originating bot: rotated='+rotated,async()=>{
 const held=gate(),entered=gate(),f=fixture(async()=>{entered.resolve();await held.promise;throw Object.assign(Error('API rejection'),{rejected:true,retryAfter:120});});
 try{f.t.enqueue('normal-quota','Reply');const run=f.t.deliver();await entered.promise;if(rotated)f.s.set('telegramBotGeneration','replacement');held.resolve();await run;
 assert.equal(f.s.one("SELECT status FROM telegram_outbox WHERE event_id='normal-quota'").status,rotated?'uncertain':'pending');
 if(rotated)assert.equal(f.s.get('telegramRateLimitUntil'),undefined);else assert.ok(f.s.get<number>('telegramRateLimitUntil')!>Date.now()+119000);
 }finally{held.resolve();f.close();}
});
test('only finite positive numeric rejected receipts establish quota; existing longer gate is preserved',async()=>{
 for(const receipt of [{rejected:true,retryAfter:Infinity},{rejected:true,retryAfter:NaN},{rejected:true,retryAfter:-1},{rejected:true,retryAfter:0},{rejected:true,retryAfter:'120'},{retryAfter:120}]){
  const f=fixture(async()=>{throw Object.assign(Error('retry_after 120'),receipt);});try{f.open();await f.t.streamDrafts();assert.equal(f.s.get('telegramRateLimitUntil'),undefined);}finally{f.close();}
 }
 const held=gate(),entered=gate(),f=fixture(async()=>{entered.resolve();await held.promise;throw Object.assign(Error('API rejection'),{rejected:true,retryAfter:120});});try{f.open();const run=f.t.streamDrafts();await entered.promise;const longer=Date.now()+240000;f.s.set('telegramRateLimitUntil',longer);held.resolve();await run;assert.equal(f.s.get('telegramRateLimitUntil'),longer);}finally{held.resolve();f.close();}
});

test('polling rejected 429 preserves cursor and shared quota, suspends next poll and stops promptly',{timeout:5000},async()=>{
 const entered=gate();let polls=0;const f=fixture(async(method:string)=>{if(method==='getUpdates'){polls++;entered.resolve();throw Object.assign(Error('API rejection'),{rejected:true,retryAfter:120});}return {};});
 try{f.s.set('telegramCursor',55);const run=f.t.loop();await entered.promise;await new Promise(r=>setTimeout(r,150));assert.equal(polls,1);assert.equal(f.s.get('telegramCursor'),55);assert.equal(f.s.get('telegramLastPoll'),undefined);assert.ok(f.s.get<number>('telegramRateLimitUntil')!>Date.now()+119000);f.t.stop();await run;assert.equal(polls,1);}finally{f.close();}
});
test('polling late old-bot rejection cannot rate-limit replacement bot',{timeout:5000},async()=>{
 const held=gate(),entered=gate();let polls=0;const f=fixture(async(method:string)=>{if(method==='getUpdates'){polls++;entered.resolve();await held.promise;throw Object.assign(Error('API rejection'),{rejected:true,retryAfter:120});}return {};});
 try{f.s.set('telegramCursor',55);const run=f.t.loop();await entered.promise;f.s.set('telegramBotGeneration','replacement');held.resolve();await new Promise(r=>setTimeout(r,50));assert.equal(f.s.get('telegramRateLimitUntil'),undefined);assert.equal(f.s.get('telegramCursor'),55);f.t.stop();await run;assert.equal(polls,1);}finally{held.resolve();f.close();}
});

for(const mode of ['current','rotated','string','infinite','unverified','longer'] as const)test('outbound menu quota uses verified receipt from its actual bot: '+mode,{timeout:5000},async()=>{
 const held=gate(),entered=gate(),calls:string[]=[],f=fixture(async(method:string,_body:any,signal:AbortSignal)=>{
  calls.push(method);
  if(method==='getUpdates')return new Promise(resolve=>signal.addEventListener('abort',()=>resolve([]),{once:true}));
  if(method==='setMyCommands'){entered.resolve();await held.promise;throw Object.assign(Error('API rejection retry_after 120'),mode==='string'?{rejected:true,retryAfter:'120'}:mode==='infinite'?{rejected:true,retryAfter:Infinity}:mode==='unverified'?{retryAfter:120}:{rejected:true,retryAfter:120});}
  return {message_id:1};
 });
 try{f.s.set('telegramCursor',55);const run=f.t.loop();await entered.promise;
 if(mode==='rotated'){f.s.set('telegramBotGeneration','replacement');f.s.set('telegramBinding',{generation:'replacement-binding',chatId:42,userId:42});}
 const longer=Date.now()+240000;if(mode==='longer')f.s.set('telegramRateLimitUntil',longer);
 held.resolve();await new Promise(r=>setTimeout(r,60));
 if(mode==='current'||mode==='longer'){
  if(mode==='longer')assert.equal(f.s.get('telegramRateLimitUntil'),longer);else assert.ok(f.s.get<number>('telegramRateLimitUntil')!>Date.now()+119000);
  const before=calls.length;f.open();f.t.enqueue('after-menu','Reply');await f.t.deliver();await f.t.streamDrafts();assert.equal(calls.length,before);
 }else assert.equal(f.s.get('telegramRateLimitUntil'),undefined);
 assert.equal(f.s.get('telegramCursor'),55);assert.equal(calls.filter(c=>c==='getUpdates').length,1);f.t.stop();await run;
 }finally{held.resolve();f.close();}
});

test('menu starting after earlier delivery rotates bot records actual new bot quota',{timeout:5000},async()=>{
 const held=gate(),entered=gate(),menuRejected=gate(),f=fixture(async(method:string,_body:any,signal:AbortSignal)=>{
  if(method==='getUpdates')return new Promise(resolve=>signal.addEventListener('abort',()=>resolve([]),{once:true}));
  if(method==='sendMessage'){entered.resolve();await held.promise;return {message_id:1};}
  if(method==='setMyCommands'){menuRejected.resolve();throw Object.assign(Error('API rejection'),{rejected:true,retryAfter:120});}
  return {};
 });try{f.t.enqueue('before-menu','Reply');const run=f.t.loop();await entered.promise;f.s.set('telegramBotGeneration','replacement');f.s.set('telegramBinding',{generation:'new-binding',chatId:42,userId:42});held.resolve();await menuRejected.promise;await new Promise(r=>setImmediate(r));assert.ok(f.s.get<number>('telegramRateLimitUntil')!>Date.now()+119000);f.t.stop();await run;}finally{held.resolve();f.close();}
});

test('ordinary rejected 429 prevents unregistered menu setup in the same outbound iteration',{timeout:5000},async()=>{
 const rejected=gate(),calls:string[]=[],f=fixture(async(method:string,_body:any,signal:AbortSignal)=>{
  if(method==='getUpdates')return new Promise(resolve=>signal.addEventListener('abort',()=>resolve([]),{once:true}));
  calls.push(method);if(method==='sendMessage'){rejected.resolve();throw Object.assign(Error('API rejection'),{rejected:true,retryAfter:120});}return {};
 });try{f.t.enqueue('reply-before-menu','Reply');const run=f.t.loop();await rejected.promise;await new Promise(r=>setTimeout(r,60));assert.deepEqual(calls,['sendMessage']);assert.equal(f.s.one("SELECT status FROM telegram_outbox WHERE event_id='reply-before-menu'").status,'pending');assert.equal(f.s.get('telegramMenu:g:null'),undefined);f.t.stop();await run;}finally{f.close();}
});
for(const during of [1,2,3])test('shared cooldown beginning during menu call '+during+' fences subsequent calls and retries after expiry',async()=>{
 const held=gate(),entered=gate(),calls:string[]=[],f=fixture(async(method:string)=>{calls.push(method);if(calls.length===during){entered.resolve();await held.promise;}return {username:'test_bot'};});
 try{f.s.set('telegramCursor',55);const run=f.t.menu();await entered.promise;f.s.set('telegramRateLimitUntil',Date.now()+120000);held.resolve();await run;assert.equal(calls.length,during);assert.equal(f.s.get('telegramMenu:g:null'),undefined);assert.equal(f.s.get('telegramCursor'),55);
 await f.t.menu();assert.equal(calls.length,during);f.s.set('telegramRateLimitUntil',Date.now()-1);await f.t.menu();assert.deepEqual(calls.slice(during),['setMyCommands','setMyCommands','setChatMenuButton','getMe']);assert.equal(f.s.get('telegramMenu:g:null'),true);assert.equal(f.s.get('telegramUsername'),'test_bot');await f.t.menu();assert.equal(calls.length,during+4);
 }finally{held.resolve();f.close();}
});
