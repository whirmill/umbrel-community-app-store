import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,symlinkSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../store.js';
import {Collector,checkInterlocks} from '../collector.js';

const node='02'+'11'.repeat(32);
const gate=(flags:Record<string,boolean>={})=>JSON.stringify({schema:1,at:new Date().toISOString(),fee:false,rebalance:false,channel:false,sell:false,autoclose:false,relist:false,reprice:false,size:false,maxHTLC:false,lsp:false,lndgAF:false,lndgAR:false,lndgAutopilot:false,loop:false,...flags});

async function collect(s:Store,gateFile:string){
 const snapshot={at:new Date().toISOString(),identity:node,synced:true,confirmedSat:'600000',channels:[]};
 await new Collector(s,{snapshot:async()=>snapshot,payments:async()=>[],forwards:async()=>[]} as any,{reconcile:async()=>{}} as any,gateFile).collect();
}

test('a leftover scoped proof is dropped and the schema-1 gate alone admits finance',async()=>{
 const s=new Store(':memory:');const dir=mkdtempSync(join(tmpdir(),'financial-interlock-'));
 try{
  const file=join(dir,'status.json');writeFileSync(file,gate());
  s.set('appControlProof',{schema:1,scope:'apps-only',ok:false});s.set('expectedIdentity',node);s.set('historicalLedgerImported',true);s.set('enabled',false);
  await collect(s,file);
  assert.equal(s.get('appControlProof'),undefined);
  assert.equal(s.get('automationProof').ok,true);
  assert.deepEqual(s.get('blockers'),[]);
  assert.equal(s.get('bootstrapReady'),true);
  // Readiness alone grants nothing: the owner still has to resume autonomy.
  assert.throws(()=>s.assertDispatchReady(),/Autonomy paused/);
  s.set('enabled',true);assert.doesNotThrow(()=>s.assertDispatchReady());
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});

test('an active competing automation keeps finance held outside scoped mode',async()=>{
 const s=new Store(':memory:');const dir=mkdtempSync(join(tmpdir(),'financial-interlock-'));
 try{
  const file=join(dir,'status.json');writeFileSync(file,gate({lndgAR:true}));
  s.set('expectedIdentity',node);s.set('historicalLedgerImported',true);s.set('enabled',true);
  await collect(s,file);
  assert.equal(s.get('automationProof').ok,false);
  assert.equal(s.get('bootstrapReady'),false);
  assert.throws(()=>s.assertDispatchReady(),/interlock/);
 }finally{s.close();rmSync(dir,{recursive:true,force:true});}
});

test('a retired interlock mode still configured holds finance, even with a clean gate',async()=>{
 for(const key of ['interlockContract','appControlContract']){
  const s=new Store(':memory:');const dir=mkdtempSync(join(tmpdir(),'financial-interlock-'));
  try{
   const file=join(dir,'status.json');writeFileSync(file,gate());
   s.set(key,{schema:key==='interlockContract'?2:1});s.set('expectedIdentity',node);s.set('historicalLedgerImported',true);s.set('enabled',true);
   await collect(s,file);
   assert.equal(s.get('automationProof').ok,false);assert.match(s.get('automationProof').reason,/Retired interlock mode/);
   s.set('automationProof',{ok:true,at:new Date().toISOString()});s.set('bootstrapReady',true);
   assert.throws(()=>s.assertDispatchReady(),/Retired interlock mode configured/);
  }finally{s.close();rmSync(dir,{recursive:true,force:true});}
 }
});

test('the schema-1 gate fails closed for links, FIFOs, oversized, stale and enabled automation',()=>{
 const dir=mkdtempSync(join(tmpdir(),'interlock-gate-'));
 try{
  const file=join(dir,'status.json');writeFileSync(file,gate());
  assert.equal(checkInterlocks({lightningMate:file,lndg:''}).ok,true);
  symlinkSync(file,join(dir,'link'));assert.equal(checkInterlocks({lightningMate:join(dir,'link'),lndg:''}).ok,false);
  execFileSync('mkfifo',[join(dir,'fifo')]);assert.equal(checkInterlocks({lightningMate:join(dir,'fifo'),lndg:''}).ok,false);
  writeFileSync(join(dir,'big'),Buffer.alloc(70000,32));assert.equal(checkInterlocks({lightningMate:join(dir,'big'),lndg:''}).ok,false);
  writeFileSync(join(dir,'stale'),JSON.stringify({...JSON.parse(gate()),at:new Date(Date.now()-120000).toISOString()}));assert.equal(checkInterlocks({lightningMate:join(dir,'stale'),lndg:''}).ok,false);
  writeFileSync(join(dir,'on'),gate({rebalance:true}));assert.equal(checkInterlocks({lightningMate:join(dir,'on'),lndg:''}).ok,false);
  assert.equal(checkInterlocks({lightningMate:join(dir,'missing'),lndg:''}).ok,false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
