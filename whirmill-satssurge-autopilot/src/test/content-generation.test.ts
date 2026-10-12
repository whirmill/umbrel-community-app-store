import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,mkdirSync,realpathSync } from 'node:fs';
import { writeFile,readFile,rm,readdir,stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync,spawnSync } from 'node:child_process';
import { Store } from '../store.js';
import { Queue } from '../queue.js';
import { TelegramTurns } from '../telegram-turns.js';
import { ContentGeneration,type ContentFormat,type ContentSnapshot } from '../content-generation.js';
import { contentTools } from '../content-tools.js';
import { authorizeContentRequest,authorizedContentRequest } from '../content-requests.js';
import { checksum,DLS_CSS_SHA256,DLS_FONT_SHA256 } from '../content-artifacts.js';
import { exportTable } from '../content-exports.js';
import { createRegistry,Harness,MemoryStorage } from '@earendil-works/pi-durable';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxAssistantMessage,fauxProvider,fauxText,fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
const at='2026-10-10T12:30:00Z';
const snapshot:ContentSnapshot={title:'Rapporto sintetico',observedAt:at,coverage:'Synthetic partial data',evidenceRefs:['synthetic-1'],table:{headers:['Voce','Valore'],rows:[['Saldo','1234 sat'],['Untrusted',' \t=HYPERLINK("x")'],['Unicode','Caffè & tè']]}};
function fixture(conversationId='native-1'){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'content-generation-'))),store=new Store(join(root,'operational.sqlite')),queue=new Queue(store),turns=new TelegramTurns(store,queue);
 store.set('contentArtifactsEnabled',true);store.set('telegramBinding',{generation:'synthetic',chatId:42});store.set('telegramBotGeneration','bot-1');
 const job=queue.enqueue({requestId:'telegram:synthetic:42:1',kind:'chat',payload:{message:'export'}});store.set('jobCapability:'+job.id,'read_only_chat');const turn=turns.attach(job,'synthetic',42);turn.state='running';turn.conversationId=conversationId;turns.save(turn);store.run("UPDATE jobs SET state='running',conversation_id=? WHERE id=?",conversationId,job.id);
 const jobs=join(root,'jobs');mkdirSync(jobs);const service=new ContentGeneration(store,jobs);return {root,jobs,store,queue,turns,job,service,admit:(format:ContentFormat)=>service.admit(job.id,format,snapshot),close(){store.close();rmSync(root,{recursive:true,force:true});}};
}
test('accepted steering invalidates the original export grant and staged snapshot even without a turn version change',async()=>{
 const f=fixture();try{
  authorizeContentRequest(f.store,f.job.id,'csv',snapshot);const grant=f.admit('csv'),receipt=await f.service.create(grant,'native-1');
  const turn=f.turns.get(f.job.id)!;turn.correctionOrder=['new-owner-steer'];f.turns.save(turn);
  assert.throws(()=>authorizedContentRequest(f.store,f.job.id),/identity/);assert.throws(()=>f.service.snapshot(grant,'native-1'),/authority/);await assert.rejects(f.service.enqueue(receipt.id,at),/authority/);assert.equal(f.store.one('SELECT count(*) n FROM telegram_outbox').n,0);
 }finally{f.close();}
});
test('direct CSV/XLSX preserve authorized data, never create renderer IPC, and independently parse safe formulas',async()=>{
 const f=fixture();try{
  const grant=f.admit('csv');const frozen=f.service.snapshot(grant,'native-1');assert.equal(frozen.snapshotSha256,checksum(JSON.stringify(snapshot)));
  const r=await f.service.create(grant,'native-1');assert.equal(r.dlsVersion,null);assert.equal(r.renderRequest,null);assert.equal(r.state,'ready');
  const event=await f.service.enqueue(r.id,at);const attachment=await f.service.attachment(event!);assert.equal(attachment!.checksum,r.artifactSha256);assert.equal(attachment!.chatId,42);
  assert.match(attachment!.data.toString(),/"' \t=HYPERLINK/);assert.deepEqual((await readdir(f.jobs)).filter(x=>/^[a-f0-9]{64}$/.test(x)),[]);
  const xlsx=exportTable(snapshot.table,'xlsx');const file=join(f.root,'synthetic.xlsx');await writeFile(file,xlsx);
  const result=execFileSync('python3',['-c',`import zipfile,xml.etree.ElementTree as E,json,sys
with zipfile.ZipFile(sys.argv[1]) as z:
 assert z.testzip() is None
 root=E.fromstring(z.read('xl/worksheets/sheet1.xml')); ns={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
 assert not root.findall('.//s:f',ns)
 assert all(c.attrib['t']=='inlineStr' for c in root.findall('.//s:c',ns))
 print(json.dumps([[c.find('s:is/s:t',ns).text or '' for c in row] for row in root.find('s:sheetData',ns)]))`,file],{encoding:'utf8',timeout:2000});
  assert.deepEqual(JSON.parse(result),[snapshot.table.headers,...snapshot.table.rows]);
  assert.throws(()=>exportTable({headers:['x'],rows:[['\u0001']]},'xlsx'));
 }finally{f.close();}
});
test('persistent export retry/reopen retains exact bytes and one outbox; uncertain delivery cannot regenerate',async()=>{
 const f=fixture();let store=f.store;try{
  const grant=f.admit('xlsx'),r=await f.service.create(grant,'native-1');const event=await f.service.enqueue(r.id,at);const original=(await f.service.attachment(event!))!;
  store.close();store=new Store(join(f.root,'operational.sqlite'));const service=new ContentGeneration(store,f.jobs);
  assert.equal((await service.create(grant,'native-1')).artifactSha256,r.artifactSha256);assert.equal(await service.enqueue(r.id,at),event);assert.deepEqual((await service.attachment(event!))!.data,original.data);assert.equal(store.one('SELECT count(*) n FROM telegram_outbox').n,1);
  store.run("UPDATE telegram_outbox SET status='uncertain',attempts=1 WHERE event_id=?",event!);
  assert.equal(await service.enqueue(r.id,at),event);assert.equal(store.one('SELECT status FROM telegram_outbox').status,'uncertain');await assert.rejects(service.attachment(event!),/state/);
  await assert.rejects(service.create(grant,'native-1',undefined,r.id),/original artifact/);
  assert.equal(store.one('SELECT count(*) n FROM operations').n,0);assert.equal(store.one('SELECT count(*) n FROM ledger').n,0);
 }finally{store.close();rmSync(f.root,{recursive:true,force:true});}
});
test('SIGKILL after original HTML fsync reopens the persisted grant/revision and publishes only its missing IPC request',async()=>{
 const f=fixture();let store=f.store;try{
  const grant=f.admit('pdf'),html='<h1>Original authorized snapshot</h1><p>1234 sat</p>';store.close();
  const code=`import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';
const original=fs.open;fs.open=(path,...args)=>{if(String(path).includes('/.request-'))process.kill(process.pid,'SIGKILL');return original(path,...args);};syncBuiltinESMExports();
const {Store}=await import(${JSON.stringify(new URL('../store.js',import.meta.url).href)});const {ContentGeneration}=await import(${JSON.stringify(new URL('../content-generation.js',import.meta.url).href)});
const store=new Store(${JSON.stringify(join(f.root,'operational.sqlite'))});await new ContentGeneration(store,${JSON.stringify(f.jobs)}).create(${JSON.stringify(grant)},'native-1',${JSON.stringify(html)});throw Error('Crash boundary not reached');`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',code],{encoding:'utf8',timeout:5000});assert.equal(child.signal,'SIGKILL',child.stderr);assert.equal(child.status,null);
  store=new Store(join(f.root,'operational.sqlite'));const row=store.one("SELECT value FROM meta WHERE key LIKE 'contentReceipt:%'"),receipt=JSON.parse(row.value),job=join(f.jobs,receipt.id);assert.equal(receipt.html,html);assert.equal(receipt.revision,1);assert.equal(receipt.state,'pending');assert.deepEqual(await readdir(job),['input.html']);const before=await stat(join(job,'input.html'));
  const service=new ContentGeneration(store,f.jobs);await assert.rejects(service.create(grant,'wrong-conversation',html),/conversation/);await assert.rejects(service.create(grant,'native-1',html+'changed'),/conflict/);
  assert.equal((await service.create(grant,'native-1',html)).id,receipt.id);assert.deepEqual(JSON.parse(await readFile(join(job,'request.json'),'utf8')),receipt.renderRequest);const after=await stat(join(job,'input.html'));assert.equal(after.ino,before.ino);assert.equal(after.mtimeMs,before.mtimeMs);assert.equal(await readFile(join(job,'input.html'),'utf8'),html);
  assert.equal(await service.enqueue(receipt.id,at),null);assert.equal(store.one("SELECT count(*) n FROM meta WHERE key LIKE 'contentReceipt:%'").n,1);assert.equal(store.one('SELECT count(*) n FROM telegram_outbox').n,0);assert.equal(store.one('SELECT count(*) n FROM operations').n,0);
 }finally{store.close();rmSync(f.root,{recursive:true,force:true});}
});
async function publish(f:ReturnType<typeof fixture>,r:Awaited<ReturnType<ContentGeneration['create']>>){
 const request=r.renderRequest!,raw=await readFile(join(f.jobs,r.id,'request.json'));const data=Buffer.from('%PDF-synthetic-only');
 await writeFile(join(f.jobs,r.id,'artifact.pdf'),data);await writeFile(join(f.jobs,r.id,'manifest.json'),JSON.stringify({protocol:1,rendererVersion:'1.0.0',request,requestSha256:checksum(raw),artifactSha256:checksum(data),bytes:data.length,mime:'application/pdf',filename:'artifact.pdf',proof:{layout:{version:'puppeteer-visible-v1',textBoxes:2,svgBoxes:0,minFontPt:8},pages:1,selectedPage:null,width:null,height:null,versions:{puppeteer:'25.12.0',chromium:'HeadlessChrome/154.0.8037.92'},fontSha256:[...DLS_FONT_SHA256],dlsSha256:DLS_CSS_SHA256,inputSha256:r.inputSha256,requestSha256:checksum(raw)}}));return data;
}
test('agent HTML intent/IPC/revision/render completion/attachment share exact data/DLS checksums',async()=>{
 const f=fixture();try{
  const g=f.admit('pdf'),html='<h1>Synthetic report</h1><p>1234 sat</p>',r=await f.service.create(g,'native-1',html);
  assert.equal((await f.service.create(g,'native-1',html)).id,r.id);await assert.rejects(f.service.create(g,'native-1',html+'changed'),/conflict/);
  assert.equal(await f.service.enqueue(r.id,at),null);const revision=await f.service.create(g,'native-1','<p>Revised</p>',r.id);assert.equal(revision.revision,2);assert.equal(revision.revisionOf,r.id);
  await assert.rejects(f.service.enqueue(r.id,at),/Superseded/);
  const bytes=await publish(f,revision);const event=await f.service.enqueue(revision.id,at);const attachment=(await f.service.attachment(event!))!;assert.deepEqual(attachment.data,bytes);
  const receipt=f.service.describe(revision.id);assert.equal(receipt.artifactSha256,checksum(bytes));assert.equal(receipt.inputSha256,checksum('<p>Revised</p>'));assert.equal(receipt.dlsVersion,'1.0.0');assert.equal(receipt.snapshotSha256,checksum(JSON.stringify(snapshot)));
  await writeFile(join(f.jobs,revision.id,'artifact.pdf'),'%PDF-tampered');await assert.rejects(f.service.attachment(event!),/checksum/);
 }finally{f.close();}
});
test('Stop, revocation, token rotation, foreign conversation, changed snapshots and generation block content',async()=>{
 for(const mutation of ['stop','revoke','bot','version','capability']){
  const f=fixture();try{const grant=f.admit('csv'),r=await f.service.create(grant,'native-1');const event=await f.service.enqueue(r.id,at);
   if(mutation==='stop'){const t=f.turns.get(f.job.id)!;t.state='stop_requested';f.turns.save(t);}else if(mutation==='revoke')f.store.set('telegramBinding',{generation:'other',chatId:42});else if(mutation==='bot')f.store.set('telegramBotGeneration','bot-2');else if(mutation==='capability')f.store.set('jobCapability:'+f.job.id,'financial_guarded');else {const t=f.turns.get(f.job.id)!;t.version++;f.turns.save(t);}
   await assert.rejects(f.service.create(grant,'native-1'));await assert.rejects(f.service.attachment(event!));assert.equal(f.store.one('SELECT attempts FROM telegram_outbox').attempts,0);
  }finally{f.close();}
 }
 const f=fixture();try{const g=f.admit('csv');assert.throws(()=>f.service.snapshot(g,'foreign'));await assert.rejects(f.service.create(g,'foreign'));assert.throws(()=>f.service.admit(f.job.id,'csv',{...snapshot,coverage:'changed'}),/conflict/);await assert.rejects(f.service.create(g,'native-1','HTML'),/mismatch/);}finally{f.close();}
});
test('crash before IPC resumes committed HTML; closed rejection permits bounded linked revision; completed turn delivers',async()=>{
 const f=fixture();try{
  const g=f.admit('pdf'),r=await f.service.create(g,'native-1','<p>Original</p>');await rm(join(f.jobs,r.id),{recursive:true});
  assert.equal(await f.service.enqueue(r.id,at),null);assert.equal((await readFile(join(f.jobs,r.id,'input.html'))).toString(),'<p>Original</p>');
  await writeFile(join(f.jobs,r.id,'failure.json'),JSON.stringify({protocol:1,code:'render_rejected',artifactId:r.id}));await f.service.status(r.id,'native-1');assert.equal(f.service.describe(r.id).state,'rejected');
  const next=await f.service.create(g,'native-1','<p>Corrected</p>',r.id);await publish(f,next);f.turns.finalize(f.job.id,'completed');f.store.run("UPDATE jobs SET state='completed' WHERE id=?",f.job.id);
  const event=await f.service.enqueue(next.id,at);assert.ok(await f.service.attachment(event!));await assert.rejects(f.service.create(g,'native-1','<p>Corrected</p>',r.id));
 }finally{f.close();}
});
test('native Pi Durable 1.1 registry executes content tools only for pre-admitted current job',async()=>{
 const registry=createRegistry(),models=createModels(),f=fixture();let grant='';const tools=contentTools(f.service,()=>grant);registry.install({name:'content-fixture',tools});
 const faux=fauxProvider({tokensPerSecond:100000});models.setProvider(faux.provider);
 faux.setResponses([fauxAssistantMessage([fauxToolCall('content_snapshot',{}, {id:'snapshot-call'})],{stopReason:'toolUse'}),fauxAssistantMessage([fauxToolCall('create_content_artifact',{}, {id:'export-call'})],{stopReason:'toolUse'}),fauxAssistantMessage([fauxText('Synthetic export ready')])]);
 const harness=await Harness.open(new MemoryStorage(),{models,registry},context);
 try{
  const root=await harness.root(context,{agent:{model:{provider:'faux',modelId:'faux-1'},extensions:[{name:'content-fixture'}]}});
  const turn=f.turns.get(f.job.id)!;turn.conversationId=String(root.id);f.turns.save(turn);f.store.run('UPDATE jobs SET conversation_id=? WHERE id=?',String(root.id),f.job.id);grant=f.admit('csv');
  assert.deepEqual((await root.agent(context)).tools.map(t=>t.name).sort(),['content_artifact_status','content_snapshot','create_content_artifact']);
  const submission=await root.submit({type:'input',content:'Generate synthetic CSV',requestId:'synthetic-content'},context);await submission.wait(context);await harness.waitForIdle(context);
  const rows=f.store.all("SELECT value FROM meta WHERE key LIKE 'contentReceipt:%'");assert.equal(rows.length,1);const r=JSON.parse(rows[0]!.value);assert.equal(r.state,'ready');assert.equal(r.format,'csv');
  const event=await f.service.enqueue(r.id,at);assert.ok(await f.service.attachment(event!));assert.equal(f.store.one('SELECT count(*) n FROM operations').n,0);
 }finally{await harness.close(context);f.close();}
});
test('revocation during renderer IO blocks delivery after await; feature gate fails closed',async()=>{
 const f=fixture();try{
  const grant=f.admit('pdf'),r=await f.service.create(grant,'native-1','<p>1234 sat</p>');await publish(f,r);const event=await f.service.enqueue(r.id,at);
  const reading=f.service.attachment(event!);f.store.set('telegramBinding',{generation:'revoked',chatId:42});await assert.rejects(reading,/authority/);
  assert.equal(f.store.one('SELECT attempts FROM telegram_outbox').attempts,0);f.store.set('telegramBinding',{generation:'synthetic',chatId:42});f.store.set('contentArtifactsEnabled',false);await assert.rejects(f.service.attachment(event!));assert.throws(()=>f.admit('pdf'));
 }finally{f.close();}
});
test('bounded capture sends only latest ready revision and skips existing/uncertain outbox identities',async()=>{
 const f=fixture();try{const g=f.admit('csv'),r=await f.service.create(g,'native-1');assert.deepEqual(await f.service.capture(at),[{artifactId:r.id,state:'enqueued'}]);f.store.run("UPDATE telegram_outbox SET status='uncertain'");assert.deepEqual(await f.service.capture(at),[]);assert.equal(f.store.one('SELECT count(*) n FROM telegram_outbox').n,1);}finally{f.close();}
});
test('trusted request admission freezes snapshot before native binding; current turn alone may consume it',async()=>{
 const f=fixture();try{
  const original=structuredClone(snapshot),turn=f.turns.get(f.job.id)!;turn.conversationId=undefined;turn.state='queued';f.turns.save(turn);f.store.run("UPDATE jobs SET state='queued',conversation_id=NULL WHERE id=?",f.job.id);
  authorizeContentRequest(f.store,f.job.id,'xlsx',original);original.table.rows[0]![1]='changed';assert.equal(authorizedContentRequest(f.store,f.job.id)!.snapshot.table.rows[0]![1],'1234 sat');
  assert.throws(()=>authorizeContentRequest(f.store,f.job.id,'csv',snapshot),/conflict/);
  turn.state='running';turn.conversationId='native-1';f.turns.save(turn);f.store.run("UPDATE jobs SET state='running',conversation_id='native-1' WHERE id=?",f.job.id);
  const request=authorizedContentRequest(f.store,f.job.id)!;const g=f.service.admit(f.job.id,request.format,request.snapshot);assert.equal((await f.service.create(g,'native-1')).format,'xlsx');
  f.store.set('telegramBotGeneration','changed');assert.throws(()=>authorizedContentRequest(f.store,f.job.id),/identity/);
 }finally{f.close();}
});
test('bounded capture rotates past blocked historical heads rather than starving later owner artifacts',async()=>{
 const f=fixture();try{
  const ids:string[]=[];
  for(let n=0;n<8;n++){
   const job=n?f.queue.enqueue({requestId:'content-fairness:'+n,kind:'chat',payload:{message:'Synthetic CSV'}}):f.job;
   f.store.set('jobCapability:'+job.id,'read_only_chat');const t=f.turns.attach(job,'synthetic',42);t.state='running';t.conversationId='native-1';f.turns.save(t);f.store.run("UPDATE jobs SET state='running',conversation_id='native-1' WHERE id=?",job.id);
   const grant=f.service.admit(job.id,'csv',snapshot);ids.push((await f.service.create(grant,'native-1')).id);
   if(n<4){t.state='stop_requested';f.turns.save(t);}
  }
  assert.deepEqual((await f.service.capture(at)).map(r=>r.state),Array(4).fill('blocked'));
  assert.deepEqual((await f.service.capture(at)).map(r=>r.artifactId),ids.slice(4));assert.equal(f.store.one('SELECT count(*) n FROM telegram_outbox').n,4);
 }finally{f.close();}
});

test('content has an independent finite budget and revoked pending render publishes cancellation without finance or replacing bytes',async()=>{
 const f=fixture();try{
  const grant=f.admit('pdf');for(let n=0;n<12;n++)f.service.call(grant);assert.throws(()=>f.service.call(grant),/budget/);
  const html='<html><body><p>Copertura parziale</p></body></html>',receipt=await f.service.create(grant,'native-1',html),before=await stat(join(f.jobs,receipt.id,'input.html'));
  const t=f.turns.get(f.job.id)!;t.state='stop_requested';f.turns.save(t);assert.deepEqual((await f.service.capture(at)).map(r=>r.state),['blocked']);
  const cancel=JSON.parse(await readFile(join(f.jobs,receipt.id,'cancel.json'),'utf8'));assert.equal(cancel.artifactId,receipt.id);assert.equal(cancel.inputSha256,checksum(html));
  assert.equal((await stat(join(f.jobs,receipt.id,'input.html'))).ino,before.ino);assert.equal(f.store.get<any>('contentReceipt:'+receipt.id).state,'rejected');assert.equal(f.store.one('SELECT count(*) n FROM operations').n,0);assert.equal(f.store.one('SELECT count(*) n FROM telegram_outbox').n,0);
 }finally{f.close();}
});
test('expired render request retains a failure state and cannot become a delivery timeout or financial retry',async()=>{
 const f=fixture();try{
  const grant=f.admit('pdf'),receipt=await f.service.create(grant,'native-1','<html><body><p>Report parziale</p></body></html>');
  f.store.set('contentReceipt:'+receipt.id,{...receipt,createdAt:new Date(Date.now()-90001).toISOString()});await f.service.complete(f.store.get<any>('contentReceipt:'+receipt.id));
  assert.equal(f.store.get<any>('contentReceipt:'+receipt.id).state,'rejected');assert.ok(await readFile(join(f.jobs,receipt.id,'cancel.json')));assert.equal(f.store.one('SELECT count(*) n FROM telegram_outbox').n,0);
 }finally{f.close();}
});
test('committed Stop intent alone fences content before turn state projection catches up',async()=>{
 const f=fixture();try{
  const grant=f.admit('csv'),r=await f.service.create(grant,'native-1');f.store.set('telegramStop:synthetic-only-intent',{jobId:f.job.id,generation:'synthetic',state:'received'});
  assert.throws(()=>f.service.snapshot(grant,'native-1'),/authority/);await assert.rejects(f.service.enqueue(r.id,at),/authority/);assert.equal(f.store.one('SELECT count(*) n FROM telegram_outbox').n,0);
 }finally{f.close();}
});
