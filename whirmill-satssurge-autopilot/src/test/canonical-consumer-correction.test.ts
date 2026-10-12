import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../store.js';
import {CanonicalModel,digest} from '../canonical-model.js';
import {canonicalDiagnostics,unifiedDiagnostics} from '../canonical-consumers.js';
import {evidenceSource} from '../evidence-source.js';
import {EvidenceViews,boundedEvidenceEnvelope} from '../evidence-views.js';
import {diagnosticCollectionCount,canonicalHistoryUrl} from '../ui-client.js';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {hash,json} from '../domain.js';
const at='2026-10-12T10:00:00.000Z';
const binding={nodeId:'02'+'11'.repeat(32),network:'mainnet',meaning:'lnd_effect' as const,sourceVersion:'0.21.4-beta',sourceInstance:'synthetic-client',batchId:'synthetic-batch',occurredAt:at,observedAt:at,granularity:'native nanoseconds',sourceChannel:'1',targetChannel:'2',amountMsat:'1000',feeMsat:'1'};
test('existing query-bound cursor hash stays usable and reordered new scopes retain exact binding',()=>{
 const s=new Store(':memory:');try{const q:any={section:'diagnostics',provider:'lightningMate',collection:'rebalances'};s.set('diagnostics',{at,lightningMate:{status:'qualified',rebalances:[{id:'a'},{id:'b'}]}});const first:any=evidenceSource(s,q);const original=Buffer.from(json({scopeHash:hash(json(q)),after:1,through:2,captureDigest:first.sourceMetadata.providerCaptureDigest})).toString('base64url');const last:any=evidenceSource(s,{...q,sourceCursor:original});assert.equal(last.diagnostics.lightningMate.rebalances[0].id,'b');assert.throws(()=>evidenceSource(s,{...q,collection:'failures',sourceCursor:original}),/scope/);
 }finally{s.close();}
});
test('review R1: routine coverage does not break actual history and native diagnostic envelopes',()=>{
 const s=new Store(':memory:'),m=new CanonicalModel(s.db),views=new EvidenceViews();try{
 for(let i=0;i<100;i++)m.appendCoverage({nodeId:binding.nodeId,network:'mainnet',capability:'native_history',scope:'native:synthetic-capture-'+i+':forwards',source:'lnd.forwards',epoch:'synthetic-capture-'+i,start:at,end:at,observedAt:at,status:'checkpoint',details:{}});
 m.observe({...binding,kind:'forward',source:'lnd.forwards',originalId:'one',payload:{}});s.set('nativeCollection',{at,ok:true});
 for(const q of [{section:'canonical_history' as const},{section:'diagnostics' as const,provider:'native' as const,collection:'forwards' as const}]){const page:any=views.page('synthetic-job',evidenceSource(s,q),q);assert.equal(page.rows.filter((r:any)=>r.kind==='forward').length,1);assert.equal(page.metadata.coverage.checkpointCount,s.one('SELECT count(*) n FROM canonical_coverage').n);assert.ok(page.metadata.coverage.checkpointCount>=100);assert.equal(Array.isArray(page.metadata.coverage),false);assert.ok(Buffer.byteLength(JSON.stringify(page))<=12000);const envelope=boundedEvidenceEnvelope(page,{phase:'research',remainingMs:10000},'_analyst');assert.ok(Buffer.byteLength(JSON.stringify(envelope.result))<=12000);}
 }finally{views.release('synthetic-job');s.close();}
});
test('coverage details paginate separately without losing checkpoints or duplicating them in metadata',()=>{
 const s=new Store(':memory:'),m=new CanonicalModel(s.db),views=new EvidenceViews();try{
 for(let i=0;i<205;i++)m.appendCoverage({nodeId:binding.nodeId,network:'mainnet',capability:'native_history',scope:'scope'+i,source:'lnd.forwards',epoch:'e'+i,start:at,end:at,observedAt:at,status:'checkpoint',details:{fixtureMemo:'synthetic-private'}});
 const expected=s.one('SELECT count(*) n FROM canonical_coverage').n,ids=new Set<string>();let q:any={section:'coverage',provider:'native'};
 for(let n=0;n<100;n++){const page:any=views.page('coverage-fixture',evidenceSource(s,q),q);assert.ok(Buffer.byteLength(JSON.stringify(page))<=12000);assert.equal(Array.isArray(page.metadata.coverage),false);assert.equal(JSON.stringify(page).includes('synthetic-private'),false);for(const row of page.rows){assert.equal(ids.has(row.id),false);ids.add(row.id);}if(!page.nextCall)break;q=page.nextCall.query;if(q.offset===0)views.release('coverage-fixture');}
 assert.equal(ids.size,expected);
 }finally{views.release('coverage-fixture');s.close();}
});
test('published agent wrapper accounts for escaped text, budget and continuation without dropping records',()=>{
 const views=new EvidenceViews(),state={claims:Array.from({length:30},(_,i)=>({id:String(i),text:'"\\'.repeat(250)}))},ids:string[]=[];let q:any={section:'claims'};
 try{for(let i=0;i<30;i++){const raw=views.page('envelope-fixture',q.cursor?{}:state,q),{page,result}=boundedEvidenceEnvelope(raw,{phase:'research',note:'"\\'.repeat(400)},'_analyst');assert.ok(Buffer.byteLength(JSON.stringify(result))<=12000);assert.deepEqual(JSON.parse(result.content[0]!.text).rows,page.rows);ids.push(...page.rows.map((r:any)=>r.id));if(!page.nextCall)break;assert.equal(page.nextCall.tool,'state_page_analyst');q=page.nextCall.query;}assert.deepEqual(ids,state.claims.map(r=>r.id));assert.throws(()=>boundedEvidenceEnvelope({rows:[],metadata:{text:'x'.repeat(12000)}},{}),/byte limit/);
 }finally{views.release('envelope-fixture');}
});
test('pre-index archive search resumes with persisted keyset and distinguishes unknown from exhausted absence',()=>{
 const dir=mkdtempSync(join(tmpdir(),'canonical-capture-')),path=join(dir,'operational.sqlite');let s=new Store(path);try{
 const capture={status:'qualified',version:'0.7.7',capturedAt:at,rebalances:[{id:'old',at,status:'requested'}]};s.set('diagnostics',{at,lightningMate:capture});for(let i=0;i<205;i++)s.set('diagnostics',{at:new Date(Date.parse(at)+1000+i*1000).toISOString(),lightningMate:{status:'unavailable'}});
 s.run("DELETE FROM meta WHERE key LIKE 'canonicalDiagnosticLookup:%'");const q:any={section:'diagnostics',provider:'lightningMate',collection:'rebalances'};const first:any=evidenceSource(s,q);assert.equal(first.unavailableEvidence.searching,true);assert.ok(first.unavailableEvidence.nextCall);s.close();s=new Store(path);
 s.set('diagnostics',{at:'2026-10-12T11:00:00Z',lightningMate:{status:'unavailable'}});let result:any=evidenceSource(s,first.unavailableEvidence.nextCall.query);for(let n=0;result.unavailableEvidence?.searching&&n<20;n++)result=evidenceSource(s,result.unavailableEvidence.nextCall.query);assert.equal(result.diagnostics?.lightningMate.rebalances[0].id,'old');assert.equal(result.sourceMetadata.providerCaptureDigest,digest(capture));
 s.run("DELETE FROM meta WHERE key LIKE 'canonicalDiagnosticLookup:%'");let missing:any=canonicalDiagnostics(s,{provider:'lightningMate',collection:'forwards'});assert.equal(missing.unavailableEvidence.searching,true);for(let n=0;missing.unavailableEvidence.searching&&n<20;n++)missing=canonicalDiagnostics(s,{provider:'lightningMate',collection:'forwards'});assert.equal(missing.unavailableEvidence.searching,undefined);assert.equal(missing.unavailableEvidence.rows,null);
 }finally{s.close();rmSync(dir,{recursive:true});}
});
function attemptFixture(s:Store){const m=new CanonicalModel(s.db);const parent=m.observe({...binding,kind:'payment',source:'lnd.payments',originalId:'circular-payment',payload:{status:'SUCCEEDED',allSettledRoutesToLocal:true,fixtureMemo:'synthetic-private'}});
 for(let i=0;i<302;i++){const matching=i>=201;const id=m.observe({...binding,kind:'payment_attempt',source:'lnd.payments',originalId:'attempt-'+i,payload:{status:matching?'SUCCEEDED':'FAILED',route:{amountMsat:'1000',feeMsat:'1'}}});m.link({observationId:id,referenceTable:'canonical_observations',referenceId:parent,relation:'attempt',method:'synthetic-route',details:{}});}s.set('nativeCollection',{at,ok:true});
}
test('settled circular attempts page after subtype selection and overview UI exposes count lower bounds',()=>{
 const s=new Store(':memory:');try{attemptFixture(s);const overview:any=s.stats().diagnostics;assert.equal(overview.native.rebalances.length,100);assert.equal(diagnosticCollectionCount(overview.native,'rebalances'),'100+');assert.equal(overview.native.collectionMetadata.rebalances.count.exact,false);assert.equal(diagnosticCollectionCount({rebalances:null},'rebalances'),'Non disponibili');assert.equal(JSON.stringify(overview).includes('synthetic-private'),false);
 const q:any={section:'diagnostics',provider:'native',collection:'rebalances'},first:any=evidenceSource(s,q);assert.equal(first.diagnostics.native.rebalances.length,101);assert.equal(first.sourceMetadata.sourceNext,null);assert.equal(first.projectionLimits.truncated,false);
 const detail:any=canonicalDiagnostics(s,{provider:'native',collection:'rebalances',limit:100});assert.equal(detail.diagnostics.native.rebalances.length,100);const next:any=canonicalDiagnostics(s,{provider:'native',collection:'rebalances',after:detail.sourceMetadata.nextAfter,through:detail.sourceMetadata.through,limit:100});assert.equal(next.diagnostics.native.rebalances.length,1);assert.equal(next.projectionLimits.truncated,false);
 }finally{s.close();}
});
test('real HTTP canonical route and UI continuation preserve subtype/high water and reject invalid subtypes',{timeout:15000},async()=>{
 const dir=mkdtempSync(join(tmpdir(),'canonical-route-')),s=new Store(join(dir,'operational.sqlite'));attemptFixture(s);const m=new CanonicalModel(s.db);for(let i=0;i<302;i++)m.observe({...binding,kind:'native_htlc',source:'lnd.htlc',originalId:'route-htlc-'+i,payload:{native:{variant:i>=201?'link_fail':'forward'}}});s.set('enabled',false);s.close();writeFileSync(join(dir,'owner.secret'),'synthetic-fixture-password',{mode:0o600});
 const fixture=`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';import {Server} from 'node:http';const read=fs.readFileSync;fs.readFileSync=function(path,...args){if(String(path).startsWith('/credentials/'))throw Error('Fixture native boundary disabled');return read.call(this,path,...args);};syncBuiltinESMExports();const listen=Server.prototype.listen;Server.prototype.listen=function(...args){this.once('listening',()=>process.send({port:this.address().port}));return listen.apply(this,args);};const {startApplication}=await import('./dist/server-app.js');await startApplication();`;
 const child=spawn(process.execPath,['--input-type=module','-e',fixture],{env:{PATH:process.env.PATH,DATA_DIR:dir,HISTORY_DIR:join(dir,'absent'),PORT:'0'},stdio:['ignore','ignore','ignore','ipc']});const exited=once(child,'exit');
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{const [{port}]=await Promise.race([once(child,'message') as Promise<any[]>,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('HTTP fixture startup deadline')),5000);})]);clearTimeout(timer);const base='http://127.0.0.1:'+port;const login=await fetch(base+'/api/owner/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({password:'synthetic-fixture-password'})});assert.equal(login.status,200);const {session}=await login.json() as any,headers={Authorization:'Bearer '+session};
 for(const filter of [{kind:'native_htlc',subtype:'failures'},{kind:'payment_attempt',subtype:'circular_attempts'}]){const response=await fetch(base+'/api/history/canonical?'+new URLSearchParams({...filter,limit:'100'}),{headers});assert.equal(response.status,200);const first:any=await response.json();assert.equal(first.rows.length,100);assert.equal(first.projectionLimits.truncated,true);const nextUrl=canonicalHistoryUrl(first,filter);assert.ok(nextUrl.includes('through='+first.through));const next:any=await (await fetch(base+nextUrl,{headers})).json();assert.equal(next.rows.length,1);assert.equal(next.nextAfter,null);assert.equal(next.through,first.through);assert.ok(next.rows.every((r:any)=>filter.subtype==='failures'?r.htlc.variant==='link_fail':r.status==='SUCCEEDED'));assert.equal(JSON.stringify(first).includes('synthetic-private'),false);}
 for(const query of ['subtype=arbitrary','kind=forward&subtype=failures','kind=native_htlc&subtype=circular_attempts'])assert.equal((await fetch(base+'/api/history/canonical?'+query,{headers})).status,400);
 }finally{clearTimeout(timer);child.kill('SIGTERM');await exited;rmSync(dir,{recursive:true});}
});
test('review R2: retained and digest pinned captures survive more than 200 unavailable refreshes',()=>{
 const s=new Store(':memory:');try{
 const captured={status:'qualified',version:'0.7.7',capturedAt:at,rebalances:Array.from({length:201},(_,i)=>({id:'r'+i,at,source:'1',target:'2',amountMsat:'1000',feeMsat:'1',status:'requested',privateToken:'synthetic-private'}))};
 s.set('diagnostics',{at,lightningMate:captured,lndg:{status:'unavailable'}});const first:any=evidenceSource(s,{section:'diagnostics',provider:'lightningMate',collection:'rebalances'});assert.ok(first.sourceMetadata.sourceNext);
 for(let i=0;i<205;i++)s.set('diagnostics',{at:new Date(Date.parse(at)+1000+i*1000).toISOString(),lightningMate:{status:'unavailable'},lndg:{status:'unavailable'}});
 const latest:any=canonicalDiagnostics(s,{provider:'lightningMate',collection:'rebalances'});assert.equal(latest.diagnostics?.lightningMate.rebalances.length,201);
 const last:any=evidenceSource(s,{section:'diagnostics',provider:'lightningMate',collection:'rebalances',sourceCursor:first.sourceMetadata.sourceNext});assert.equal(last.diagnostics?.lightningMate.rebalances.length,1);assert.equal(last.sourceMetadata.providerCaptureDigest,digest(captured));assert.equal(JSON.stringify(last).includes('synthetic-private'),false);
 }finally{s.close();}
});
test('review R3: failure subtype selection happens before caps in detail and overview consumers',()=>{
 const s=new Store(':memory:'),m=new CanonicalModel(s.db);try{
 for(let i=0;i<101;i++)m.observe({...binding,kind:'native_htlc',source:'lnd.htlc',originalId:'htlc-'+i,payload:{native:{variant:i===100?'link_fail':'forward'}}});s.set('nativeCollection',{at,ok:true});
 const detail:any=canonicalDiagnostics(s,{provider:'native',collection:'failures',limit:100}),overview:any=unifiedDiagnostics(s);assert.equal(detail.diagnostics.native.failures.length,1);assert.equal(detail.sourceMetadata.nextAfter,null);assert.equal(overview.native.failures.length,1);assert.ok(overview.native.collectionMetadata.failures);assert.equal(overview.native.collectionMetadata.failures.projectionLimits.truncated,false);
 const q={section:'diagnostics' as const,provider:'native' as const,collection:'failures' as const};const state:any=evidenceSource(s,q);assert.equal(state.diagnostics.native.failures.length,1);assert.equal(state.sourceMetadata.sourceNext,null);
 }finally{s.close();}
});
