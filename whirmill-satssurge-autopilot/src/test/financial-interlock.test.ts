import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../store.js';
import {Collector} from '../collector.js';
import {scopedAppControls} from '../app-controls.js';

const node='02'+'11'.repeat(32);
const gate=(flags:Record<string,boolean>={})=>JSON.stringify({schema:1,at:new Date().toISOString(),fee:false,rebalance:false,channel:false,sell:false,autoclose:false,relist:false,reprice:false,size:false,maxHTLC:false,lsp:false,lndgAF:false,lndgAR:false,lndgAutopilot:false,loop:false,...flags});

async function collect(s:Store,gateFile:string){
 const snapshot={at:new Date().toISOString(),identity:node,synced:true,confirmedSat:'600000',channels:[]};
 await new Collector(s,{snapshot:async()=>snapshot,payments:async()=>[],forwards:async()=>[]} as any,{reconcile:async()=>{}} as any,gateFile).collect();
}

test('a leftover scoped proof no longer holds finance once the scoped contract and environment are gone',async()=>{
 const s=new Store(':memory:');const dir=mkdtempSync(join(tmpdir(),'financial-interlock-'));
 try{
  const file=join(dir,'status.json');writeFileSync(file,gate());
  s.set('appControlProof',{schema:1,scope:'apps-only',ok:false});s.set('expectedIdentity',node);s.set('historicalLedgerImported',true);s.set('enabled',false);
  assert.equal(scopedAppControls(s),false);
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
