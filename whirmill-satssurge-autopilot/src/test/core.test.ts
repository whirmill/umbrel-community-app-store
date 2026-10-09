import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../store.js';
import { Executor } from '../executor.js';
import { now,MANDATE,hash,json,publicAnswer,type Snapshot,type Proposal,type Forecast } from '../domain.js';
import { importHistory } from '../importer.js';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const snapshot=():Snapshot=>({at:now(),identity:'self',synced:true,confirmedSat:'500001',channels:['a','b'].map(id=>({id,point:id+':0',peer:id,alias:id,active:true,capacitySat:'500000',localSat:'250000',remoteSat:'250000',reserveSat:'5000',pendingSat:'0',baseMsat:'0',ppm:300,cltv:80,minMsat:'1',maxMsat:'500000000'}))});
const f:Forecast={eligible:true,samples:10,observedHours:48,observedDays:2,benefitMsat:'200000',requestedMsat:'100000000',explanation:'test'};
test('public answers exclude thinking and provider metadata, including legacy history',()=>{
  const entry=[{role:'assistant',content:[{type:'thinking',thinking:'private'},{type:'text',text:'Esito pubblico'}],usage:{cost:99}}];
  assert.equal(publicAnswer(entry),'Esito pubblico');assert.equal(publicAnswer(JSON.stringify(entry)),'Esito pubblico');assert.equal(publicAnswer('Testo precedente'),'Testo precedente');assert.equal(publicAnswer([{role:'tool',content:[{type:'text',text:'not public'}]}]),'Risposta completata senza testo pubblico.');
});
function ready(){const s=new Store(':memory:');s.set('bootstrapReady',true);s.set('automationProof',{ok:true,at:now()});const e=s.evidence('fixture','observed demand');return {s,p:{kind:'rebalance',category:'exploratory',strategy:'trial',source:'a',target:'b',amountSat:'100000',maxFeeMsat:'100000',decisionCapMsat:'200000',demandKey:'a->b',evidenceIds:[e],problem:'depleted',evidence:'observed',whyAct:'test',alternatives:'wait / lower price / smaller',verify:'48h',hypothesis:'demand returns'} as Proposal};}
test('dispatch rejects interlocks changed during invoice preparation with zero sends',async()=>{
  for(const mutate of [
    (s:Store)=>s.set('automationProof',{ok:false,at:now()}),
    (s:Store)=>s.set('bootstrapReady',false),
    (s:Store)=>s.set('integrityBlocker','new integrity failure'),
    (s:Store)=>s.set('enabled',false),
    (s:Store)=>s.set('maintenanceClaim',{owner:'lm-backfill',at:now()}),
    (s:Store)=>s.set('automationProof',{ok:true,at:'invalid'}),
    (s:Store)=>s.set('automationProof',{ok:true,at:new Date(Date.now()+60000).toISOString()}),
  ]){
    const {s,p}=ready();let sends=0;
    const node:any={snapshot:async()=>snapshot(),invoice:async()=>{mutate(s);return {hash:'unused',request:'unused'};},send:async()=>{sends++;}};
    await assert.rejects(new Executor(s,node).execute(p));
    assert.equal(sends,0);assert.equal(s.one('SELECT state FROM operations').state,'FAILED');assert.equal(s.budget().dailyMsat,'0');s.close();
  }
});
test('atomic contention and pending survive midnight',()=>{const {s,p}=ready();s.reserve(p,f,snapshot());assert.throws(()=>s.reserve({...p,strategy:'other'},f,snapshot()),/occupied/);assert.equal(s.budget('2026-10-20T00:01:00Z').dailyMsat,'100000');s.close();});
test('ordinary trusted forecast and protected reserve',()=>{const {s,p}=ready();assert.throws(()=>s.reserve({...p,category:'ordinary'}, {...f,benefitMsat:'199999'},snapshot()),/benefit/);assert.throws(()=>s.reserve(p,f,{...snapshot(),confirmedSat:'499999'}),/reserve/);s.close();});
test('out of order duplicated events do not duplicate ledger',()=>{const {s}=ready();for(let i=0;i<2;i++){s.event({id:'x',at:'2026-09-25T00:00:00Z',type:'external_forward',source:'a',target:'b',amountMsat:'1',feeMsat:'1'});s.ledger({id:'x',at:now(),classification:'revenue',amountMsat:'1'});}assert.equal(s.all('SELECT * FROM events').length,1);assert.equal(s.all('SELECT * FROM ledger').length,1);assert.throws(()=>s.ledger({id:'x',at:now(),classification:'revenue',amountMsat:'2'}),/conflict/);s.close();});
test('uncertain send reconciles succeeded once and never resends',async()=>{const {s,p}=ready();let sends=0;const node:any={snapshot:async()=>snapshot(),invoice:async()=>({hash:'h',request:'private'}),send:async()=>{sends++;throw new Error('timeout after successful send');},track:async()=>({status:'SUCCEEDED',feeMsat:'25000',amountSat:'100000',source:'a',target:'b'})};const x=new Executor(s,node);await assert.rejects(x.execute(p));assert.equal(s.budget().dailyMsat,'100000');await x.reconcile();await x.reconcile();assert.equal(sends,1);assert.equal(s.budget().dailyMsat,'25000');assert.equal(s.all('SELECT * FROM ledger').length,1);assert.equal(s.one('SELECT invoice FROM operations').invoice,null);s.close();});
test('crash before dispatch has zero cost; pause stays paused across reopen',async()=>{const dir=mkdtempSync(join(tmpdir(),'surge-'));const {p}=ready();let s=new Store(join(dir,'state.sqlite'));s.set('bootstrapReady',true);s.set('automationProof',{ok:true,at:now()});p.evidenceIds=[s.evidence('test','test')];s.reserve(p,f,snapshot());s.set('enabled',false);s.close();s=new Store(join(dir,'state.sqlite'));assert.equal(s.get('enabled'),false);await new Executor(s,{} as any).reconcile();assert.equal(s.one('SELECT state FROM operations').state,'FAILED');assert.equal(s.budget().dailyMsat,'0');s.close();rmSync(dir,{recursive:true});});
test('manual policy change blocks affected operation',async()=>{const {s,p}=ready();s.saveSnapshot(snapshot());const changed=snapshot();changed.channels[0]!.ppm=500;await assert.rejects(new Executor(s,{snapshot:async()=>changed} as any).execute(p),/External/);assert.equal(s.all('SELECT * FROM operations').length,0);s.close();});
test('negative strategy requires genuinely new evidence',()=>{const {s,p}=ready();s.run('INSERT INTO strategies VALUES(?,?,?,?)',p.demandKey,'suspended',hash(json(p.evidenceIds.slice().sort())),'negative');assert.throws(()=>s.reserve({...p,strategy:'renamed'},f,snapshot()),/Negative/);p.evidenceIds.push(s.evidence('fresh','new observed condition'));assert.doesNotThrow(()=>s.reserve(p,f,snapshot()));s.close();});
test('same demand cannot be reused while observing',()=>{const {s,p}=ready();const {operation,decision}=s.reserve(p,f,snapshot());s.run("UPDATE operations SET state='SUCCEEDED' WHERE id=?",operation);s.run('UPDATE reservations SET active=0');s.run("UPDATE decisions SET status='observing' WHERE id=?",decision);assert.throws(()=>s.reserve({...p,strategy:'other'},f,snapshot()),/observing|already used/);s.close();});
test('history import repeat, full integer precision and pinned retention',()=>{const dir=mkdtempSync(join(tmpdir(),'surge-history-'));writeFileSync(join(dir,'expenses.json'),JSON.stringify({entries:[{id:'old',timestamp_utc:'2026-09-25T00:36:45Z',kind:'rebalance',amount_sat:1,amount_msat_exact:144451}],manual_coverage:{confirmed_complete:false}}));const s=new Store(':memory:');importHistory(s,dir);importHistory(s,dir);assert.equal(s.budget().cumulativeMsat,'144451');assert.equal(s.all('SELECT * FROM evidence').length,1);s.event({id:'pinned',at:'2020-01-01T00:00:00Z',type:'external_forward',source:'a',target:'b',amountMsat:'1',feeMsat:'1',pinned:true});s.retain();assert.equal(s.all('SELECT * FROM events').length,1);s.close();rmSync(dir,{recursive:true});});
test('reconciliation cannot steal a live invoice owner',async()=>{const {s,p}=ready();let release!:()=>void;let sends=0;const wait=new Promise<void>(r=>release=r);const node:any={snapshot:async()=>snapshot(),invoice:async()=>{await wait;return {hash:'one',request:'invoice'};},send:async()=>{sends++;return {status:'SUCCEEDED',feeMsat:'1000',amountSat:'100000',source:'a',target:'b'};}};const x=new Executor(s,node);const task=x.execute(p);await new Promise(r=>setTimeout(r,5));await x.reconcile();assert.equal(s.one('SELECT state FROM operations').state,'preparing');release();await task;assert.equal(sends,1);assert.equal(s.budget().dailyMsat,'1000');s.close();});
test('aggregate cap cannot be reset by renaming strategy',()=>{const {s,p}=ready();const x=new Executor(s,{} as any);for(let i=0;i<3;i++){const {operation}=s.reserve({...p,strategy:'name'+i},f,snapshot());x.finish(operation,{status:'FAILED',amountSat:'0',feeMsat:'0'});}assert.throws(()=>s.reserve({...p,strategy:'new-name'},f,snapshot()),/Aggregate/);s.close();});
test('MPP endpoint violation still records fee and pauses',()=>{const {s,p}=ready();const {operation}=s.reserve(p,f,snapshot());new Executor(s,{} as any).finish(operation,{status:'SUCCEEDED',feeMsat:'12000',amountSat:'100000'});assert.equal(s.budget().dailyMsat,'12000');assert.equal(s.get('enabled'),false);assert.match(s.get<string>('integrityBlocker')!,/invariant/);s.close();});
test('database rollback refuses newer schema',()=>{const dir=mkdtempSync(join(tmpdir(),'surge-version-'));const p=join(dir,'op.sqlite');const s=new Store(p);s.db.exec('PRAGMA user_version=5');s.close();assert.throws(()=>new Store(p),/newer/);rmSync(dir,{recursive:true});});
test('daily and exploration reservations reject aggregate overspend',()=>{const {s,p}=ready();s.ledger({id:'today',at:now(),classification:'expense',amountMsat:'1490000',category:'manual_rebalance'});assert.throws(()=>s.reserve(p,f,snapshot()),/budget/);s.close();const r=ready();r.s.ledger({id:'explore',at:now(),classification:'expense',amountMsat:'749000',category:'exploratory'});assert.throws(()=>r.s.reserve(r.p,f,snapshot()),/Exploration/);r.s.close();});

test('parallel ordinary forecasts cannot allocate the same target demand',()=>{
  const {s,p}=ready();const first=s.reserve({...p,category:'ordinary'},f,snapshot());new Executor(s,{} as any).finish(first.operation,{status:'SUCCEEDED',amountSat:p.amountSat,feeMsat:'1000',source:p.source,target:p.target});
  const other={...p,category:'ordinary' as const,source:'c',demandKey:'c->b',evidenceIds:[s.evidence('fresh','different observed incoming corridor')]};
  const state=snapshot();state.channels.push({...state.channels[0]!,id:'c',peer:'c',point:'c:0'});
  assert.throws(()=>s.reserve(other,f,state),/already allocated/);
  assert.equal(s.uncommittedDemand('c','b','150000000'),'50000000');
  s.event({id:'consumed',at:now(),type:'external_forward',source:'a',target:'b',amountMsat:'100000000',feeMsat:'1000'});
  assert.equal(s.uncommittedDemand('c','b','150000000',new Date(Date.now()+1000).toISOString()),'150000000');s.close();
});
test('an observed forward releases only one of two overlapping benefit claims',()=>{
  const {s,p}=ready();const initial=s.reserve(p,f,snapshot());s.run("UPDATE operations SET state='SUCCEEDED' WHERE id=?",initial.operation);
  const start='2026-10-01T00:00:00.000Z',end='2026-10-31T00:00:00.000Z';
  s.run('INSERT INTO benefit_claims VALUES(?,?,?,?,?,?,?)',initial.operation,'a','b',start,end,'1000000','100');
  s.run('INSERT INTO decisions VALUES(?,?,?,?,?,?)','other',start,json(p),json(f),'{}','observing');s.run('INSERT INTO operations VALUES(?,?,?,?,?,?,?)','second','other',start,'SUCCEEDED',null,null,'{}');
  s.run('INSERT INTO benefit_claims VALUES(?,?,?,?,?,?,?)','second','a','b','2026-10-01T00:01:00.000Z',end,'1000000','100');
  s.event({id:'one-return',at:'2026-10-02T00:00:00.000Z',type:'external_forward',source:'a',target:'b',amountMsat:'1000000',feeMsat:'100'});
  assert.equal(s.uncommittedDemand('a','b','3000000','2026-10-03T00:00:00.000Z'),'2000000');
  assert.equal(s.uncommittedDemand('a','b','3000000','2026-11-01T00:00:00.000Z'),'3000000');s.close();
});

test('migration preserves legacy pending ordinary reservation and reconstructs its future demand claim',()=>{
  const dir=mkdtempSync(join(tmpdir(),'surge-migrate-')),path=join(dir,'state.sqlite');let s=new Store(path);
  s.set('bootstrapReady',true);s.set('automationProof',{ok:true,at:now()});const p={kind:'rebalance',category:'ordinary',strategy:'old',source:'a',target:'b',amountSat:'100000',maxFeeMsat:'100000',decisionCapMsat:'200000',demandKey:'a->b',evidenceIds:[s.evidence('old','qualified history')],problem:'old',evidence:'old',whyAct:'old',alternatives:'wait',verify:'7/30',hypothesis:'old'} as Proposal;
  const original=s.reserve(p,f,snapshot());s.run('DELETE FROM benefit_claims');s.db.exec('PRAGMA user_version=1');s.set('enabled',false);s.close();
  s=new Store(path);assert.equal(s.get('enabled'),false);assert.equal(s.one('PRAGMA user_version').user_version,4);assert.equal(s.one('SELECT state FROM operations WHERE id=?',original.operation).state,'reserved');assert.equal(s.budget().dailyMsat,'100000');assert.equal(s.uncommittedDemand('c','b','100000000'),'0');assert.equal(s.one('SELECT volume_msat FROM benefit_claims').volume_msat,'100000000');s.close();rmSync(dir,{recursive:true});
});

test('forwards before verified settlement cannot consume future demand claims',()=>{
  const {s,p}=ready();const op=s.reserve(p,f,snapshot());s.run("UPDATE operations SET state='SUCCEEDED',details=? WHERE id=?",json({completedAt:'2026-10-03T00:00:00.000Z'}),op.operation);
  s.run('INSERT INTO benefit_claims VALUES(?,?,?,?,?,?,?)',op.operation,'a','b','2026-10-01T00:00:00.000Z','2026-10-31T00:00:00.000Z','1000000','100');
  s.event({id:'too-early',at:'2026-10-02T00:00:00.000Z',type:'external_forward',source:'a',target:'b',amountMsat:'1000000',feeMsat:'100'});
  assert.equal(s.uncommittedDemand('c','b','2000000','2026-10-04T00:00:00.000Z'),'1000000');s.close();
});
