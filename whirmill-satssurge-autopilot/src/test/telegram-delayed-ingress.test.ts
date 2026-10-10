import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {Store} from '../store.js';
import {Queue} from '../queue.js';
import {ApplicationControl,requestCapability} from '../application-control.js';
import {Telegram} from '../telegram.js';
import {hash} from '../domain.js';
const since='2026-10-10T12:00:00.000Z',at='2026-10-10T12:10:00.000Z',date=Date.parse('2026-10-10T12:01:00Z')/1000;
function fixture(dir=mkdtempSync(join(tmpdir(),'delayed-ingress-')),disk=false){const s=new Store(disk?join(dir,'operational.sqlite'):':memory:'),q=new Queue(s),c=new ApplicationControl(s,q),calls:string[]=[],t=new Telegram(s,c,dir,{call:async(method)=>{calls.push(method);return {message_id:1};}});if(!s.get('telegramBinding')){s.set('telegramConfigured',true);s.set('telegramBotGeneration','bot-A');s.set('telegramBinding',{generation:'binding-A',userId:42,chatId:42,since});s.set('enabled',false);}return {dir,s,q,c,t,calls,close(remove=true){t.stop();s.close();if(remove)rmSync(dir,{recursive:true,force:true});}};}
const update=(id:number,text:string,time=date)=>({update_id:id,message:{date:time,text,from:{id:42},chat:{id:42,type:'private'}}});
function ignored(f:ReturnType<typeof fixture>,id:number,text:string,legacy=true){f.t.ingest([update(id,text)]);if(legacy){const row=f.s.one('SELECT body FROM telegram_updates WHERE update_id=?',id),body=JSON.parse(row.body);delete body.botGeneration;f.s.run('UPDATE telegram_updates SET body=? WHERE update_id=?',JSON.stringify(body),id);}f.s.run("UPDATE telegram_updates SET status='ignored',error='Stale incoming command' WHERE update_id=?",id);return f.s.one('SELECT * FROM telegram_updates WHERE update_id=?',id);}
const jobs=(f:ReturnType<typeof fixture>)=>f.s.all('SELECT * FROM jobs');
const noEffects=(f:ReturnType<typeof fixture>)=>{assert.equal(f.s.all('SELECT * FROM operations').length,0);assert.equal(f.s.all('SELECT * FROM ledger').length,0);assert.equal(f.s.all('SELECT * FROM owner_proposals').length,0);assert.equal(f.s.get('enabled'),false);};

async function menu(f:ReturnType<typeof fixture>,id=900){f.t.ingest([update(id,'/recover',Date.parse(at)/1000)]);await f.t.process(at);return f.s.get('telegramButtons:update:'+id).inline_keyboard;}
function click(f:ReturnType<typeof fixture>,key:string,id=901){f.t.ingest([{update_id:id,callback_query:{id:'callback-'+id,data:key,from:{id:42},message:{chat:{id:42,type:'private'}}}}]);}
async function resume(f:ReturnType<typeof fixture>,target=100,id=900){const buttons=await menu(f,id);const button=buttons.flat().find((b:any)=>b.text==='Riprendi '+target);assert.ok(button);click(f,button.callback_data,id+1);await f.t.process(at);}
test('legacy ignored and newly delayed chat/status remain visible for owner review, even when identical later work was answered',async()=>{const f=fixture();try{const old=ignored(f,100,'Ci sei?');f.t.ingest([update(101,'Ci sei?',Date.parse(at)/1000)]);await f.t.process(at);assert.equal(jobs(f).length,1);assert.equal(f.s.get('telegramIngressRecovery:100').state,'review_required');assert.deepEqual(f.s.one('SELECT * FROM telegram_updates WHERE update_id=100'),old);f.t.ingest([update(102,'/status')]);await f.t.process(at);await f.t.process(at);assert.equal(f.s.get('telegramIngressRecovery:102').state,'review_required');assert.equal(f.s.one("SELECT count(*) n FROM telegram_outbox WHERE event_id='update:102'").n,0);assert.equal(jobs(f).length,1);noEffects(f);}finally{f.close();}});
test('fresh ordinary admission has no permanent generic ACK and its receipt alone deduplicates restart',async()=>{const dir=mkdtempSync(join(tmpdir(),'fresh-restart-'));let f=fixture(dir,true);try{f.t.ingest([update(100,'Spiega lo stato',Date.parse(at)/1000)]);await f.t.process(at);const original=jobs(f)[0];assert.equal(f.s.all('SELECT * FROM telegram_outbox').length,0);f.s.run("UPDATE telegram_updates SET status='pending' WHERE update_id=100");f.close(false);f=fixture(dir,true);await f.t.process(at);assert.equal(jobs(f).length,1);assert.equal(jobs(f)[0].id,original.id);assert.equal(f.s.all('SELECT * FROM telegram_outbox').length,0);noEffects(f);}finally{f.close();}});
test('explicit resume uses original request and existing ACK outcomes are not retried or considered job proof',async()=>{for(const outcome of ['sent','uncertain','sending','failed']){const f=fixture();try{const original=ignored(f,100,'Ci sei?');f.t.enqueue('update:100','Original ACK');f.s.run('UPDATE telegram_outbox SET status=?,attempts=1',outcome);const ack=f.s.one('SELECT * FROM telegram_outbox');await f.t.process(at);assert.equal(f.s.get('telegramIngressRecovery:100').state,'review_required');assert.equal(jobs(f).length,0);await resume(f);await f.t.process(at);assert.equal(jobs(f).length,1);assert.equal(jobs(f)[0].request_id,'telegram:bot-A:100');assert.equal(f.s.get('telegramIngressRecovery:100').state,'admitted');assert.deepEqual(f.s.one("SELECT * FROM telegram_outbox WHERE event_id='update:100'"),ack);assert.deepEqual(f.s.one('SELECT * FROM telegram_updates WHERE update_id=100'),original);assert.equal(f.s.get('jobCapability:'+jobs(f)[0].id),'read_only_chat');noEffects(f);}finally{f.close();}}});
test('dismiss is explicit owner_dismissed, never completion, and stale buttons cannot resume it',async()=>{const f=fixture();try{ignored(f,100,'Ci sei?');const buttons=await menu(f);click(f,buttons[0][1].callback_data);await f.t.process(at);assert.equal(f.s.get('telegramIngressRecovery:100').state,'dismissed');assert.equal(f.s.get('telegramIngressRecovery:100').outcome,'owner_dismissed');click(f,buttons[0][0].callback_data,902);await f.t.process(at);assert.equal(jobs(f).length,0);noEffects(f);}finally{f.close();}});
test('backlog numeric chronology is bounded and ignored financial/stateful input never becomes recoverable',async()=>{const f=fixture();try{for(const id of [100,9,10,99,1000,101,102,103,104])ignored(f,id,'Spiega '+id);for(const [i,text] of ['/pause','/resume','/stop','/analyze','proponimi una fee','approva questo'].entries())ignored(f,200+i,text);await f.t.process(at);const buttons=await menu(f);assert.deepEqual(buttons.map((r:any)=>r[0].text),['Riprendi 9','Riprendi 10','Riprendi 99','Riprendi 100','Riprendi 101','Riprendi 102','Riprendi 103','Riprendi 104']);assert.equal(jobs(f).length,0);for(let i=0;i<6;i++)assert.equal(f.s.get('telegramIngressRecovery:'+(200+i)),undefined);noEffects(f);}finally{f.close();}});
test('queued/running/waiting/completed original jobs and final uncertainty retain IDs without re-admission/resend',async()=>{for(const state of ['queued','running','waiting','completed','failed','cancelled']){const f=fixture();try{ignored(f,100,'Ci sei?');const j=f.c.admit('telegram:bot-A:100','Ci sei?','telegram');f.s.set('jobTelegramGeneration:'+j.id,'binding-A');f.s.run('UPDATE jobs SET state=? WHERE id=?',state,j.id);f.t.enqueue('job:'+j.id,'Original final');f.s.run("UPDATE telegram_outbox SET status='uncertain'");const before=jobs(f)[0],outbox=f.s.all('SELECT * FROM telegram_outbox');await f.t.process(at);await f.t.process(at);assert.deepEqual(jobs(f),[before]);assert.deepEqual(f.s.all('SELECT * FROM telegram_outbox'),outbox);assert.equal(f.s.get('telegramIngressRecovery:100').state,['completed','failed','cancelled'].includes(state)?'settled':'admitted');noEffects(f);}finally{f.close();}}});
test('resumed historical text preserves active-turn correction/new-request choice and future job',async()=>{const f=fixture();try{f.t.ingest([update(110,'Active',Date.parse(at)/1000),update(111,'Future',Date.parse(at)/1000)]);await f.t.process(at);const first=jobs(f)[0];f.s.run("UPDATE jobs SET state='running' WHERE id=?",first.id);f.s.set('telegramTurn:'+first.id,{...f.s.get<any>('telegramTurn:'+first.id),state:'running'});ignored(f,100,'Old question');await resume(f);assert.equal(jobs(f).length,2);assert.equal(f.s.get('telegramIngressRecovery:100').state,'choice_pending');assert.match(f.s.one("SELECT text FROM telegram_outbox WHERE event_id='update:100'").text,/Vuoi correggere/);noEffects(f);}finally{f.close();}});
test('owner callback rechecks body/binding/bot after await and expires missing original receipt',async()=>{for(const changed of ['body','binding','bot','missing','expiry']){const f=fixture();let release!:()=>void;try{ignored(f,100,'Ci sei?');const buttons=await menu(f);if(changed==='expiry'){const key=buttons[0][0].callback_data;f.s.set('telegramCallback:'+key,{...f.s.get<any>('telegramCallback:'+key),expires:at});}let entered!:()=>void;const start=new Promise<void>(r=>entered=r),held=new Promise<void>(r=>release=r);Object.assign(f.t,{transport:{call:async()=>{entered();await held;return true;}}});click(f,buttons[0][0].callback_data);const processing=f.t.process(at);await start;if(changed==='body')f.s.run("UPDATE telegram_updates SET body='{}' WHERE update_id=100");if(changed==='binding')f.s.set('telegramBinding',{...f.s.get<any>('telegramBinding'),generation:'new'});if(changed==='bot')f.s.set('telegramBotGeneration','new');if(changed==='missing')f.s.run('DELETE FROM telegram_updates WHERE update_id=100');release();await processing;await f.t.process(at);assert.equal(jobs(f).length,0);assert.notEqual(f.s.get('telegramIngressRecovery:100').state,'admitted');noEffects(f);}finally{release?.();f.close();}}});
for(const boundary of ['before-admission','during-admission','after-commit'] as const)test('SIGKILL '+boundary+' preserves owner resume decision and one original admission',async()=>{const dir=mkdtempSync(join(tmpdir(),'review-crash-'));let f=fixture(dir,true);try{const original=ignored(f,100,'Ci sei?');const buttons=await menu(f);click(f,buttons[0][0].callback_data);f.close(false);const urls={store:new URL('../store.js',import.meta.url).href,queue:new URL('../queue.js',import.meta.url).href,control:new URL('../application-control.js',import.meta.url).href,telegram:new URL('../telegram.js',import.meta.url).href};const code=`import {Store} from ${JSON.stringify(urls.store)};import {Queue} from ${JSON.stringify(urls.queue)};import {ApplicationControl} from ${JSON.stringify(urls.control)};import {Telegram} from ${JSON.stringify(urls.telegram)};const s=new Store(${JSON.stringify(join(dir,'operational.sqlite'))}),q=new Queue(s),c=new ApplicationControl(s,q),t=new Telegram(s,c,${JSON.stringify(dir)},{call:async()=>true});const kill=()=>process.kill(process.pid,'SIGKILL');if(${JSON.stringify(boundary)}==='before-admission')c.admitWithinTransaction=kill;if(${JSON.stringify(boundary)}==='during-admission'){const set=s.set.bind(s);s.set=(key,value)=>{set(key,value);if(key==='telegramIngressRecovery:100'&&value.state==='admitted')kill();};}if(${JSON.stringify(boundary)}==='after-commit')t.setWake(async()=>{kill();});await t.process(${JSON.stringify(at)});throw Error('Crash boundary not reached');`;const result=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',timeout:10000});assert.equal(result.signal,'SIGKILL',result.stderr);f=fixture(dir,true);assert.equal(f.s.get('telegramIngressRecovery:100').ownerDecision.action,'recover_resume');await f.t.process(at);await f.t.process(at);assert.equal(jobs(f).length,1);assert.equal(jobs(f)[0].request_id,'telegram:bot-A:100');assert.deepEqual(f.s.one('SELECT * FROM telegram_updates WHERE update_id=100'),original);noEffects(f);}finally{f.close();}});

test('immutable legacy done ACK-only model receipt gets separate unknown review while commands/jobs/consumed choices stay closed',async()=>{for(const route of ['ack','command','job','choice']){const f=fixture();try{const original=ignored(f,100,route==='command'?'/status':'Ci sei?');f.t.enqueue('update:100','Original reply');f.s.run("UPDATE telegram_outbox SET status='uncertain'");const receipt={state:'done',outcome:'existing_delivery_retained',generation:'binding-A',botGeneration:'bot-A',chatId:42,bodyHash:hash(original.body),requestId:'telegram:bot-A:100',eventId:'update:100',at};f.s.set('telegramIngressRecovery:100',receipt);const bytes=f.s.one("SELECT value FROM meta WHERE key='telegramIngressRecovery:100'").value;if(route==='job'){const job=f.c.admit(receipt.requestId,'Ci sei?','telegram');f.s.set('jobTelegramGeneration:'+job.id,'binding-A');f.s.run("UPDATE jobs SET state='completed' WHERE id=?",job.id);}if(route==='choice')f.s.set('telegramCorrection:binding-A:100',{id:'binding-A:100',generation:'binding-A',state:'settled',jobId:'existing',body:'Ci sei?',submissionId:'original',version:1,expires:at});await f.t.process(at);assert.equal(f.s.one("SELECT value FROM meta WHERE key='telegramIngressRecovery:100'").value,bytes);const shadow=f.s.get('telegramIngressRecoveryReview:100');assert.equal(shadow?.state,route==='ack'?'review_required':undefined);if(route==='ack'){assert.equal(shadow.outcome,'legacy_model_completion_unknown');await resume(f);assert.equal(jobs(f).length,1);assert.equal(f.s.one("SELECT status FROM telegram_outbox WHERE event_id='update:100'").status,'uncertain');assert.equal(f.s.one("SELECT value FROM meta WHERE key='telegramIngressRecovery:100'").value,bytes);}noEffects(f);}finally{f.close();}}});
test('slow native start has existing Thinking draft; fast terminal response emits only final message',async()=>{for(const slow of [true,false]){const f=fixture();try{const bodies:any[]=[];Object.assign(f.t,{transport:{call:async(method:string,body:any)=>{f.calls.push(method);bodies.push(body);return {message_id:7};}}});f.t.ingest([update(100,'Ci sei?',Date.parse(at)/1000)]);await f.t.process(at);const job=jobs(f)[0];assert.equal(f.s.all('SELECT * FROM telegram_outbox').length,0);if(slow){f.s.run("UPDATE jobs SET state='running' WHERE id=?",job.id);f.s.set('telegramTurn:'+job.id,{...f.s.get<any>('telegramTurn:'+job.id),state:'running'});await f.t.streamDrafts(at);assert.ok(f.calls.includes('sendRichMessageDraft'));assert.match(bodies.at(-1).rich_message.html,/tg-thinking/);}else{f.s.run("UPDATE jobs SET state='completed',result=? WHERE id=?",JSON.stringify({answer:'Risposta finale'}),job.id);f.t.capture(at);assert.equal(f.s.all("SELECT * FROM telegram_outbox WHERE kind='reply'").length,1);assert.match(f.s.one("SELECT text FROM telegram_outbox WHERE kind='reply'").text,/Risposta finale/);}noEffects(f);}finally{f.close();}}});

test('explicit owner resume survives SIGKILL after native terminal commit with original job/conversation/submission and zero model replay',async(t)=>{
 const dir=mkdtempSync(join(tmpdir(),'review-native-crash-'));let f=fixture(dir,true),native:any;
 try{const original=ignored(f,100,'Ci sei?');await resume(f);const jobId=jobs(f)[0].id;f.close(false);
 const module=new URL('./pi-fixture.js',import.meta.url).href;
 const code=`import {fixture} from ${JSON.stringify(module)};import {createAssistantMessageEventStream} from '@earendil-works/pi-ai/utils/event-stream';const f=fixture(${JSON.stringify(dir)},'state');f.agent.models.streamSimple=()=>{const stream=createAssistantMessageEventStream(),message={role:'assistant',api:'openai-responses',provider:'openai',model:'gpt-6.1-sol',timestamp:Date.now(),usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',content:[{type:'text',text:'Original recovered answer'}]};queueMicrotask(()=>{stream.push({type:'start',partial:message});stream.push({type:'done',reason:'stop',message});});return stream;};await f.agent.open();const job=f.queue.claim('coordinator','crash-native');const result=await f.agent.runJob(job);console.log(JSON.stringify({job:f.queue.get(job.id),terminal:f.store.get('telegramTerminal:'+job.id),result}));process.kill(process.pid,'SIGKILL');`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',timeout:15000});assert.equal(child.signal,'SIGKILL',child.stderr);const proof=JSON.parse(child.stdout.trim().split('\n').at(-1)!);assert.equal(proof.job.id,jobId);assert.ok(proof.job.conversation_id);assert.ok(proof.job.submission_id);t.diagnostic(JSON.stringify({nativeRecoveryProof:{jobId,conversationId:proof.job.conversation_id,submissionId:proof.job.submission_id,terminalState:proof.terminal.state}}));
 const {fixture:piFixture}=await import('./pi-fixture.js');native=piFixture(dir,'state');native.agent.models.streamSimple=()=>{throw Error('Native terminal recovery must not call model');};await native.agent.open();native.queue.recoverAfterRestart();const control=new ApplicationControl(native.store,native.queue),telegram=new Telegram(native.store,control,dir,{call:async()=>{throw Error('No network');}});await telegram.process(at);const claimed=native.queue.claim('coordinator','resume-native')!;assert.equal(claimed.id,jobId);const result=await native.agent.runJob(claimed);assert.deepEqual(result,proof.result);native.queue.finish(jobId,claimed.run_token!,'completed',result);assert.equal(native.queue.get(jobId).conversation_id,proof.job.conversation_id);assert.equal(native.queue.get(jobId).submission_id,proof.job.submission_id);assert.deepEqual(native.store.get('telegramTerminal:'+jobId),proof.terminal);assert.deepEqual(native.store.one('SELECT * FROM telegram_updates WHERE update_id=100'),original);assert.equal(native.store.all('SELECT * FROM operations').length,0);await telegram.process(at);assert.equal(native.store.get('telegramIngressRecovery:100').state,'settled');telegram.stop();
 }finally{if(native){await native.agent.close();native.store.close();}else{try{f.close(false);}catch{}}rmSync(dir,{recursive:true,force:true});}
});

test('bounded discovery advances across ineligible rows while fresh ingress is handled normally',async()=>{const f=fixture();try{for(let i=0;i<45;i++)ignored(f,100+i,'/pause');ignored(f,145,'/status');f.t.ingest([update(200,'Fresh question',Date.parse(at)/1000)]);await f.t.process(at);assert.equal(jobs(f).length,1);assert.equal(f.s.get('telegramIngressRecoveryScan').updateId,119);await f.t.process(at);await f.t.process(at);assert.equal(f.s.get('telegramIngressRecovery:145').state,'review_required');assert.equal(jobs(f).length,1);noEffects(f);}finally{f.close();}});
test('before-binding/future/bot-mismatched and malformed ignored inputs cannot gain review authority',async()=>{const f=fixture();try{f.t.ingest([update(100,'Ci sei?',Date.parse(since)/1000-1),update(101,'/status',Date.parse(at)/1000+61)]);for(const [i,body] of ['{invalid','null','[]'].entries())f.s.run("INSERT INTO telegram_updates(update_id,body,status,error) VALUES(?,?,'ignored','Stale incoming command')",200+i,body);const old=ignored(f,103,'Ci sei?',false),body=JSON.parse(old.body);body.botGeneration='old';f.s.run('UPDATE telegram_updates SET body=? WHERE update_id=103',JSON.stringify(body));await f.t.process(at);await f.t.process(at);assert.equal(jobs(f).length,0);assert.equal(f.s.all("SELECT key FROM meta WHERE key LIKE 'telegramIngressRecovery:%'").length,0);assert.equal(f.s.all('SELECT * FROM telegram_outbox').length,0);noEffects(f);}finally{f.close();}});

test('expired/late unconsumed legacy choice permits explicit future request preserving original correction; active/consumed choice stays owned',async()=>{for(const state of ['expired','late','active','admitted','placed','settled'] as const){const f=fixture();try{const original=ignored(f,100,'Old question');f.s.set('telegramIngressRecovery:100',{state:'done',generation:'binding-A',botGeneration:'bot-A',chatId:42,bodyHash:hash(original.body),requestId:'telegram:bot-A:100',eventId:'update:100',at});const correction={id:'binding-A:100',generation:'binding-A',state:state==='expired'||state==='active'?'choice_pending':state,jobId:'prior',body:'Old question',version:1,expires:state==='active'?'2026-10-10T12:15:00Z':at};f.s.set('telegramCorrection:'+correction.id,correction);const bytes=f.s.one('SELECT value FROM meta WHERE key=?','telegramCorrection:'+correction.id).value;await f.t.process(at);if(state==='expired'||state==='late'){assert.equal(f.s.get('telegramIngressRecoveryReview:100').state,'review_required');f.t.ingest([update(500,'Currently active',Date.parse(at)/1000)]);await f.t.process(at);const job=jobs(f)[0];f.s.run("UPDATE jobs SET state='running' WHERE id=?",job.id);f.s.set('telegramTurn:'+job.id,{...f.s.get<any>('telegramTurn:'+job.id),state:'running'});await resume(f);assert.equal(jobs(f).length,2);assert.ok(jobs(f).find(j=>j.request_id==='telegram:bot-A:100'));assert.equal(f.s.get('telegramIngressRecoveryReview:100').state,'admitted');}else assert.equal(f.s.get('telegramIngressRecoveryReview:100'),undefined);assert.equal(f.s.one('SELECT value FROM meta WHERE key=?','telegramCorrection:'+correction.id).value,bytes);noEffects(f);}finally{f.close();}}});
test('a correlated job or consumed/native correction appearing during recovery callback ACK prevents duplicate admission',async()=>{for(const change of ['job','consumed','native']){const f=fixture();let release!:()=>void;try{const original=ignored(f,100,'Old question');f.s.set('telegramIngressRecovery:100',{state:'done',generation:'binding-A',botGeneration:'bot-A',chatId:42,bodyHash:hash(original.body),requestId:'telegram:bot-A:100',eventId:'update:100',at});const correction={id:'binding-A:100',generation:'binding-A',state:'late',jobId:'prior',body:'Old question',version:1,expires:at};f.s.set('telegramCorrection:'+correction.id,correction);const buttons=await menu(f);let entered!:()=>void;const start=new Promise<void>(r=>entered=r),held=new Promise<void>(r=>release=r);Object.assign(f.t,{transport:{call:async()=>{entered();await held;return true;}}});click(f,buttons[0][0].callback_data);const processing=f.t.process(at);await start;if(change==='job'){const job=f.c.admit('telegram:bot-A:100','Old question','telegram');f.s.set('jobTelegramGeneration:'+job.id,'binding-A');}else f.s.set('telegramCorrection:'+correction.id,{...correction,...(change==='native'?{submissionId:'original-native'}:{state:'settled'})});release();await processing;assert.equal(jobs(f).length,change==='job'?1:0);assert.notEqual(f.s.get('telegramIngressRecoveryReview:100').ownerDecision?.action,'recover_resume');noEffects(f);}finally{release?.();f.close();}}});

test('legacy active choice matures after cursor advancement and reopen without changing original correction bytes',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'legacy-maturity-'));let f=fixture(dir,true);
 try{
  const original=ignored(f,100,'Old question');
  f.s.set('telegramIngressRecovery:100',{state:'done',generation:'binding-A',botGeneration:'bot-A',chatId:42,bodyHash:hash(original.body),requestId:'telegram:bot-A:100',eventId:'update:100',at});
  f.s.set('telegramCorrection:binding-A:100',{id:'binding-A:100',generation:'binding-A',state:'choice_pending',jobId:'prior',body:'Old question',version:1,expires:'2026-10-10T12:15:00.000Z'});
  const bytes=f.s.one("SELECT value FROM meta WHERE key='telegramCorrection:binding-A:100'").value,receipt=f.s.one("SELECT value FROM meta WHERE key='telegramIngressRecovery:100'").value;
  await f.t.process(at);assert.equal(f.s.get('telegramIngressRecoveryReview:100'),undefined);assert.equal(f.s.get('telegramIngressLegacyReviewScan').updateId,100);assert.ok(f.s.get('telegramIngressLegacyDeferred:100'));
  f.close(false);f=fixture(dir,true);const later='2026-10-10T12:16:00.000Z';
  f.t.ingest([update(900,'/recover',Date.parse(later)/1000)]);await f.t.process(later);
  assert.equal(f.s.get('telegramIngressRecoveryReview:100').state,'review_required');assert.equal(f.s.get('telegramIngressLegacyDeferred:100'),undefined);
  const button=f.s.get('telegramButtons:update:900').inline_keyboard[0][0];assert.equal(button.text,'Riprendi 100');click(f,button.callback_data);await f.t.process(later);
  assert.equal(jobs(f).length,1);assert.equal(jobs(f)[0].request_id,'telegram:bot-A:100');
  assert.equal(f.s.one("SELECT value FROM meta WHERE key='telegramCorrection:binding-A:100'").value,bytes);assert.equal(f.s.one("SELECT value FROM meta WHERE key='telegramIngressRecovery:100'").value,receipt);assert.deepEqual(f.s.one('SELECT * FROM telegram_updates WHERE update_id=100'),original);noEffects(f);
 }finally{f.close();}
});

test('deferred maturity revisits at most twenty choices per cycle and consumed choices never reopen',async()=>{
 const f=fixture();try{
  for(let id=100;id<125;id++){
   const original=ignored(f,id,'Old question '+id);
   f.s.set('telegramIngressRecovery:'+id,{state:'done',generation:'binding-A',botGeneration:'bot-A',chatId:42,bodyHash:hash(original.body),requestId:'telegram:bot-A:'+id,eventId:'update:'+id,at});
   f.s.set('telegramCorrection:binding-A:'+id,{id:'binding-A:'+id,generation:'binding-A',state:'choice_pending',jobId:'prior',body:'Old question '+id,version:1,expires:'2026-10-10T12:15:00.000Z'});
  }
  await f.t.process(at);await f.t.process(at);assert.equal(f.s.all("SELECT key FROM meta WHERE key LIKE 'telegramIngressLegacyDeferred:%'").length,25);
  f.s.set('telegramCorrection:binding-A:100',{...f.s.get<any>('telegramCorrection:binding-A:100'),state:'placed',submissionId:'existing-native'});
  const bytes=f.s.one("SELECT value FROM meta WHERE key='telegramCorrection:binding-A:100'").value;
  await f.t.process('2026-10-10T12:16:00.000Z');assert.equal(f.s.all("SELECT key FROM meta WHERE key LIKE 'telegramIngressLegacyDeferred:%'").length,5);assert.equal(f.s.all("SELECT key FROM meta WHERE key LIKE 'telegramIngressRecoveryReview:%'").length,19);
  await f.t.process('2026-10-10T12:16:00.000Z');assert.equal(f.s.all("SELECT key FROM meta WHERE key LIKE 'telegramIngressRecoveryReview:%'").length,24);assert.equal(f.s.get('telegramIngressRecoveryReview:100'),undefined);assert.equal(f.s.one("SELECT value FROM meta WHERE key='telegramCorrection:binding-A:100'").value,bytes);assert.equal(jobs(f).length,0);noEffects(f);
 }finally{f.close();}
});

test('recovery callback expiry includes all earlier ACK delays in the batch',async()=>{
 const f=fixture(),realNow=Date.now;let clock=Date.parse(at);
 try{
  ignored(f,100,'Old question');const buttons=await menu(f);const key=buttons[0][0].callback_data;let count=0;
  Object.assign(f.t,{transport:{call:async()=>{if(++count<=10)clock+=35000;return true;}}});
  for(let i=0;i<10;i++)click(f,'unknown-'+i,901+i);click(f,key,911);
  Date.now=()=>clock;await f.t.process(at);
  assert.equal(new Date(clock).toISOString(),'2026-10-10T12:15:50.000Z');assert.equal(jobs(f).length,0);assert.equal(f.s.get('telegramIngressRecovery:100').state,'review_required');assert.equal(f.s.get('telegramIngressRecovery:100').ownerDecision,undefined);noEffects(f);
 }finally{Date.now=realNow;f.close();}
});

test('recursive recovery keeps elapsed baseline for the remaining callbacks',async()=>{
 const f=fixture(),realNow=Date.now;let clock=Date.parse(at);
 try{
  ignored(f,100,'First question');ignored(f,101,'Second question');const buttons=await menu(f);let count=0;
  Object.assign(f.t,{transport:{call:async()=>{count++;if(count<=8||count===10)clock+=35000;return true;}}});
  for(let i=0;i<8;i++)click(f,'unknown-'+i,901+i);click(f,buttons[0][0].callback_data,909);click(f,buttons[1][0].callback_data,910);
  Date.now=()=>clock;await f.t.process(at);
  assert.equal(jobs(f).length,1);assert.equal(jobs(f)[0].request_id,'telegram:bot-A:100');assert.equal(f.s.get('telegramIngressRecovery:101').ownerDecision,undefined);assert.equal(f.s.get('telegramIngressRecovery:101').state,'review_required');noEffects(f);
 }finally{Date.now=realNow;f.close();}
});

// Seed a committed owner-selected receipt and exercise the production choice
// finalization path, without fabricating maturity anchors in the test itself.
function heldCurrentChoice(f:ReturnType<typeof fixture>,id:number){
 const original=ignored(f,id,'Held historical '+id),key='telegramIngressRecovery:'+id;
 f.s.set(key,{state:'pending',updateId:id,date,generation:'binding-A',botGeneration:'bot-A',chatId:42,bodyHash:hash(original.body),requestId:'telegram:bot-A:'+id,eventId:'update:'+id,at,ownerDecision:{action:'recover_resume',updateId:900+id,at}});
 f.s.set('telegramCorrection:binding-A:'+id,{id:'binding-A:'+id,generation:'binding-A',state:'choice_pending',jobId:'prior',body:'Held historical '+id,version:1,expires:'2026-10-10T12:15:00.000Z'});
 (f.t as any).finishIncoming({...original,recoveryKey:key});
 return original;
}
test('current recovery choice returns to explicit review after expiry and restart, retaining original bytes and one original request',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'current-maturity-'));let f=fixture(dir,true);
 try{
  f.t.ingest([update(500,'Active current request',Date.parse(at)/1000)]);await f.t.process(at);const active=jobs(f)[0];
  f.s.run("UPDATE jobs SET state='running' WHERE id=?",active.id);f.s.set('telegramTurn:'+active.id,{...f.s.get<any>('telegramTurn:'+active.id),state:'running'});
  const original=ignored(f,100,'Old question');await resume(f);assert.equal(f.s.get('telegramIngressRecovery:100').state,'choice_pending');
  const correction=f.s.one("SELECT value FROM meta WHERE key='telegramCorrection:binding-A:100'").value,receipt=f.s.one("SELECT value FROM meta WHERE key='telegramIngressRecovery:100'").value;
  f.close(false);f=fixture(dir,true);const later='2026-10-10T12:16:00.000Z';f.t.ingest([update(902,'/recover',Date.parse(later)/1000)]);await f.t.process(later);
  assert.equal(jobs(f).length,1);assert.equal(f.s.get('telegramIngressRecoveryReview:100').state,'review_required');const button=f.s.get('telegramButtons:update:902').inline_keyboard.flat().find((b:any)=>b.text==='Riprendi 100');assert.ok(button);
  click(f,button.callback_data,903);await f.t.process(later);await f.t.process(later);
  assert.equal(jobs(f).length,2);assert.equal(jobs(f).filter(j=>j.request_id==='telegram:bot-A:100').length,1);assert.equal(f.s.get('telegramIngressRecoveryReview:100').state,'admitted');assert.equal(f.s.get('telegramIngressRecoveryReview:100').forceFutureRequest,true);
  assert.equal(f.s.one("SELECT value FROM meta WHERE key='telegramCorrection:binding-A:100'").value,correction);assert.equal(f.s.one("SELECT value FROM meta WHERE key='telegramIngressRecovery:100'").value,receipt);assert.deepEqual(f.s.one('SELECT * FROM telegram_updates WHERE update_id=100'),original);noEffects(f);
 }finally{f.close();}
});
test('61 current choice candidates mature in batches of twenty across restart without automatic admission or starvation',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'current-maturity-bounded-'));let f=fixture(dir,true);
 try{
  for(let id=100;id<161;id++)heldCurrentChoice(f,id);
  const originals=f.s.all("SELECT key,value FROM meta WHERE key LIKE 'telegramIngressRecovery:%' OR key LIKE 'telegramCorrection:%'"),rows=f.s.all('SELECT * FROM telegram_updates');
  await f.t.process(at);assert.equal(f.s.all("SELECT key FROM meta WHERE key LIKE 'telegramIngressRecoveryReview:%'").length,0);
  f.close(false);f=fixture(dir,true);
  for(let cycle=1;cycle<=4;cycle++){await f.t.process('2026-10-10T12:16:00.000Z');assert.equal(f.s.all("SELECT key FROM meta WHERE key LIKE 'telegramIngressRecoveryReview:%'").length,Math.min(20*cycle,61));assert.equal(jobs(f).length,0);}
  for(const row of originals)assert.equal(f.s.one('SELECT value FROM meta WHERE key=?',row.key).value,row.value);assert.deepEqual(f.s.all('SELECT * FROM telegram_updates'),rows);noEffects(f);
 }finally{f.close();}
});
test('current choice consumed/native/wrong-generation/changed bytes or correlated admissions cannot reopen',async()=>{
 for(const change of ['consumed','native','generation','correctionHash','inputHash','recoveryHash','followup','job','missing'] as const){const f=fixture();try{
  heldCurrentChoice(f,100);const key='telegramCorrection:binding-A:100',c=f.s.get<any>(key);
  if(change==='consumed')f.s.set(key,{...c,state:'settled'});
  if(change==='native')f.s.set(key,{...c,submissionId:'original-native'});
  if(change==='generation')f.s.set(key,{...c,generation:'wrong'});
  if(change==='correctionHash')f.s.set(key,{...c,body:'Changed bytes'});
  if(change==='inputHash')f.s.run("UPDATE telegram_updates SET body='{}' WHERE update_id=100");
  if(change==='recoveryHash')f.s.set('telegramIngressRecovery:100',{...f.s.get<any>('telegramIngressRecovery:100'),outcome:'changed'});
  if(change==='missing')f.s.run('DELETE FROM meta WHERE key=?',key);
  if(change==='followup'||change==='job'){const job=f.c.admit(change==='job'?'telegram:bot-A:100':'telegram-followup:binding-A:100','Existing question','telegram');f.s.set('jobTelegramGeneration:'+job.id,'binding-A');}
  const corrections=f.s.all("SELECT key,value FROM meta WHERE key LIKE 'telegramCorrection:%'"),updates=f.s.all('SELECT * FROM telegram_updates'),beforeJobs=jobs(f);
  await f.t.process('2026-10-10T12:16:00.000Z');await f.t.process('2026-10-10T12:16:00.000Z');
  assert.equal(f.s.get('telegramIngressRecoveryReview:100'),undefined);assert.deepEqual(jobs(f),beforeJobs);assert.deepEqual(f.s.all('SELECT * FROM telegram_updates'),updates);assert.deepEqual(f.s.all("SELECT key,value FROM meta WHERE key LIKE 'telegramCorrection:%'"),corrections);assert.equal(f.s.get('telegramIngressCurrentDeferred:100').state,'closed');noEffects(f);
 }finally{f.close();}}
});
test('actual late steer of a current recovery choice returns to review before expiry, with no automatic new job',async()=>{
 const f=fixture();try{
  f.t.ingest([update(500,'Active current request',Date.parse(at)/1000)]);await f.t.process(at);const active=jobs(f)[0];f.s.run("UPDATE jobs SET state='running' WHERE id=?",active.id);f.s.set('telegramTurn:'+active.id,{...f.s.get<any>('telegramTurn:'+active.id),state:'running'});
  ignored(f,100,'Old question');await resume(f);const buttons=f.s.get('telegramButtons:update:100').inline_keyboard;f.s.run("UPDATE jobs SET state='completed' WHERE id=?",active.id);
  click(f,buttons[0][0].callback_data,902);await f.t.process('2026-10-10T12:11:00.000Z');assert.equal(f.s.get('telegramCorrection:binding-A:100').state,'late');
  const bytes=f.s.one("SELECT value FROM meta WHERE key='telegramCorrection:binding-A:100'").value;await f.t.process('2026-10-10T12:11:00.000Z');assert.equal(f.s.get('telegramIngressRecoveryReview:100').state,'review_required');assert.equal(jobs(f).length,1);assert.equal(f.s.one("SELECT value FROM meta WHERE key='telegramCorrection:binding-A:100'").value,bytes);noEffects(f);
 }finally{f.close();}
});

test('legacy ACK review held by active turn matures into a distinct view after restart; resume/dismiss remains explicit and deduplicated',async()=>{
 for(const action of ['resume','dismiss'] as const){const dir=mkdtempSync(join(tmpdir(),'legacy-review-chain-'));let f=fixture(dir,true);try{
  f.t.ingest([update(500,'Active request',Date.parse(at)/1000)]);await f.t.process(at);const active=jobs(f)[0];f.s.run("UPDATE jobs SET state='running' WHERE id=?",active.id);f.s.set('telegramTurn:'+active.id,{...f.s.get<any>('telegramTurn:'+active.id),state:'running'});
  const original=ignored(f,100,'Old question');f.s.set('telegramIngressRecovery:100',{state:'done',generation:'binding-A',botGeneration:'bot-A',chatId:42,bodyHash:hash(original.body),requestId:'telegram:bot-A:100',eventId:'update:100',at});
  const legacyBytes=f.s.one("SELECT value FROM meta WHERE key='telegramIngressRecovery:100'").value;await resume(f);assert.equal(f.s.get('telegramIngressRecoveryReview:100').state,'choice_pending');
  const reviewBytes=f.s.one("SELECT value FROM meta WHERE key='telegramIngressRecoveryReview:100'").value,correctionBytes=f.s.one("SELECT value FROM meta WHERE key='telegramCorrection:binding-A:100'").value;
  f.close(false);f=fixture(dir,true);const later='2026-10-10T12:16:00.000Z';f.t.ingest([update(902,'/recover',Date.parse(later)/1000)]);await f.t.process(later);
  const views=f.s.all("SELECT key,value FROM meta WHERE key LIKE 'telegramIngressRecoveryReview:100:maturity:%'");assert.equal(views.length,1);const view=JSON.parse(views[0].value);assert.equal(view.state,'review_required');assert.equal(view.originalRecoveryKey,'telegramIngressRecoveryReview:100');assert.equal(view.originalRecoveryHash,hash(reviewBytes));assert.equal(view.forceFutureRequest,true);assert.equal(jobs(f).length,1);
  const buttons=f.s.get('telegramButtons:update:902').inline_keyboard;const button=buttons.flat().find((b:any)=>b.text===(action==='resume'?'Riprendi 100':'Ignora 100'));assert.ok(button);
  click(f,button.callback_data,903);await f.t.process(later);click(f,button.callback_data,904);await f.t.process(later);await f.t.process(later);
  assert.equal(jobs(f).length,action==='resume'?2:1);assert.equal(jobs(f).filter(j=>j.request_id==='telegram:bot-A:100').length,action==='resume'?1:0);assert.equal(f.s.get(views[0].key).state,action==='resume'?'admitted':'dismissed');
  assert.equal(f.s.one("SELECT value FROM meta WHERE key='telegramIngressRecovery:100'").value,legacyBytes);assert.equal(f.s.one("SELECT value FROM meta WHERE key='telegramIngressRecoveryReview:100'").value,reviewBytes);assert.equal(f.s.one("SELECT value FROM meta WHERE key='telegramCorrection:binding-A:100'").value,correctionBytes);assert.deepEqual(f.s.one('SELECT * FROM telegram_updates WHERE update_id=100'),original);noEffects(f);
 }finally{f.close();}}
});

// Exercise recovery-on-recovery receipts without widening actual dispatch: the
// normal matured view forces a future request and cannot create another choice.
function repeatedRecoveryChain(f:ReturnType<typeof fixture>,depth:number){
 const original=heldCurrentChoice(f,100),origins:{key:string;value:string}[]=[];let key='telegramIngressRecovery:100';
 for(let i=0;i<depth;i++){
  if(i){f.s.set(key,{...f.s.get<any>(key),state:'pending'});(f.t as any).finishIncoming({...original,recoveryKey:key});}
  origins.push({key,value:f.s.one('SELECT value FROM meta WHERE key=?',key).value});
  (f.t as any).delayedRecovery('2026-10-10T12:16:00.000Z');
  const next=f.s.all("SELECT key,value FROM meta WHERE key LIKE 'telegramIngressRecoveryReview:%' AND json_extract(value,'$.state')='review_required'");assert.equal(next.length,1);assert.notEqual(next[0].key,key);key=next[0].key;
 }
 return {original,origins,key};
}
test('four repeated maturity origins remain reachable and preserve the entire nested chain through one owner admission',async()=>{
 const f=fixture();try{
  const {original,origins,key}=repeatedRecoveryChain(f,4),correction=f.s.one("SELECT value FROM meta WHERE key='telegramCorrection:binding-A:100'").value;
  assert.equal(jobs(f).length,0);for(const r of origins)assert.equal(f.s.one('SELECT value FROM meta WHERE key=?',r.key).value,r.value);
  const later='2026-10-10T12:16:00.000Z';f.t.ingest([update(900,'/recover',Date.parse(later)/1000)]);await f.t.process(later);const button=f.s.get('telegramButtons:update:900').inline_keyboard[0][0];assert.equal(button.text,'Riprendi 100');click(f,button.callback_data);await f.t.process(later);await f.t.process(later);
  assert.equal(jobs(f).length,1);assert.equal(jobs(f)[0].request_id,'telegram:bot-A:100');assert.equal(f.s.get(key).state,'admitted');for(const r of origins)assert.equal(f.s.one('SELECT value FROM meta WHERE key=?',r.key).value,r.value);assert.equal(f.s.one("SELECT value FROM meta WHERE key='telegramCorrection:binding-A:100'").value,correction);assert.deepEqual(f.s.one('SELECT * FROM telegram_updates WHERE update_id=100'),original);noEffects(f);
 }finally{f.close();}
});
test('changed deep origin during ACK or consumed nested correction prevents admission from the additive maturity view',async()=>{
 for(const change of ['ancestor','consumed','native','followup'] as const){const f=fixture();let release!:()=>void;try{
  const {origins,key}=repeatedRecoveryChain(f,3),later='2026-10-10T12:16:00.000Z';f.t.ingest([update(900,'/recover',Date.parse(later)/1000)]);await f.t.process(later);const button=f.s.get('telegramButtons:update:900').inline_keyboard[0][0];
  let entered!:()=>void;const start=new Promise<void>(r=>entered=r),hold=new Promise<void>(r=>release=r);Object.assign(f.t,{transport:{call:async()=>{entered();await hold;return true;}}});click(f,button.callback_data);const processing=f.t.process(later);await start;
  if(change==='ancestor')f.s.set(origins[0]!.key,{...f.s.get<any>(origins[0]!.key),outcome:'changed ancestor'});
  if(change==='consumed'||change==='native')f.s.set('telegramCorrection:binding-A:100',{...f.s.get<any>('telegramCorrection:binding-A:100'),...(change==='native'?{submissionId:'preserved-native'}:{state:'settled'})});
  if(change==='followup'){const job=f.c.admit('telegram-followup:binding-A:100','Existing linked work','telegram');f.s.set('jobTelegramGeneration:'+job.id,'binding-A');}
  const before=jobs(f),correction=f.s.one("SELECT value FROM meta WHERE key='telegramCorrection:binding-A:100'").value;release();await processing;
  assert.deepEqual(jobs(f),before);assert.notEqual(f.s.get(key).ownerDecision?.updateId,901);assert.equal(f.s.one("SELECT value FROM meta WHERE key='telegramCorrection:binding-A:100'").value,correction);noEffects(f);
 }finally{release?.();f.close();}}
});
