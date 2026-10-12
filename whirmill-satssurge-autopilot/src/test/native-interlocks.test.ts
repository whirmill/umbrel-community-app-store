import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {INTERLOCK_FLAGS,readInterlock,validateInterlock,type InterlockContract} from '../interlocks.js';
import {now} from '../domain.js';
const binding={nodeId:'02'+'1'.repeat(64)};
const contract:InterlockContract={schema:2,hostBootId:'fixture-boot',sourceHash:'a'.repeat(64),generation:7,producerHash:'f'.repeat(64),runtimeBinding:{containerId:'1'.repeat(64),imageRef:'ghcr.io/fixture/app@sha256:'+'2'.repeat(64),imageId:'sha256:'+'3'.repeat(64)},appIds:['lightningmate','lndg','lightning-terminal','albyhub']};
function gate(at=now()) {const inventory=contract.appIds.map(id=>({id,durableInstalled:false,lifecycle:'not-installed',containers:[]}));return {...contract,appIds:[...contract.appIds],at,registryBeforeHash:'b'.repeat(64),registryAfterHash:'b'.repeat(64),otherAutomationBefore:[],otherAutomationAfter:[],ownerScope:'owner',before:inventory,after:structuredClone(inventory),flags:Object.fromEntries(INTERLOCK_FLAGS.map(f=>[f,false]))};}
function fixtureInterlock(path:string,clock=Date.now,expected?:InterlockContract){try{return validateInterlock(JSON.parse(readFileSync(path,'utf8')),path,clock,expected);}catch{return validateInterlock(null,path,clock,expected);}}
function temporary(){const directory=mkdtempSync(join(tmpdir(),'m3-runtime-'));return {directory,file:join(directory,'gate.json'),close:()=>rmSync(directory,{recursive:true,force:true})};}

test('schema2 distinguishes verified absence, installed disabled and unknown; trust is explicit',()=>{
 const f=temporary();try{const valid=gate();writeFileSync(f.file,JSON.stringify(valid));assert.equal(fixtureInterlock(f.file,Date.now,contract).state,'verified_absent');assert.equal(fixtureInterlock(f.file).ok,false);
 const installed:any=gate();const installedContract:InterlockContract={...contract,expectedLndNodeId:binding.nodeId,installedQualifications:{lightningmate:{runtimeBinding:contract.runtimeBinding!,version:'fixture',hook:{sourceHash:'c'.repeat(64)}}}};installed.before[0]={id:'lightningmate',durableInstalled:true,lifecycle:'stopped',containers:[],runtimeBinding:contract.runtimeBinding,settingsFacts:{version:'fixture',sourceHash:'c'.repeat(64),nodeId:binding.nodeId,settingsDigest:'e'.repeat(64)}};installed.after=structuredClone(installed.before);writeFileSync(f.file,JSON.stringify(installed));assert.equal(fixtureInterlock(f.file,Date.now,installedContract).state,'installed_disabled');
 for(const change of [(p:any)=>p.after.pop(),(p:any)=>p.otherAutomationAfter=['unqualified-lit'],(p:any)=>p.flags.loop=null,(p:any)=>p.flags.fee=true,(p:any)=>p.before[0].lifecycle='installing',(p:any)=>p.generation++,(p:any)=>p.hostBootId='old',(p:any)=>p.appIds.pop(),(p:any)=>p.at=new Date(Date.now()-100000).toISOString()]){const invalid=gate();change(invalid);writeFileSync(f.file,JSON.stringify(invalid));assert.equal(fixtureInterlock(f.file,Date.now,contract).ok,false);}
 writeFileSync(f.file,'{');assert.equal(readInterlock(f.file,Date.now,contract).state,'unknown');assert.equal(fixtureInterlock(join(f.directory,'missing'),Date.now,contract).ok,false);
 }finally{f.close();}
});
test('Alby conditional control requires qualified backend facts and blocks shared-LND auto swaps',()=>{
 const f=temporary();try{
  const qualified:InterlockContract={...contract,installedQualifications:{albyhub:{runtimeBinding:contract.runtimeBinding!}},expectedLndNodeId:binding.nodeId,albyQualification:{contract:'albyhub-v1.24.0-native-read-v1',version:'1.24.0-patch.1',sourceHash:'c'.repeat(64)}};
  const installed:any=gate();installed.before[3]={id:'albyhub',durableInstalled:true,lifecycle:'running',containers:['albyhub_web_1'],runtimeBinding:contract.runtimeBinding,backendFacts:{...qualified.albyQualification,at:now(),checksum:'d'.repeat(64),backend:'lnd',nodeId:binding.nodeId,autoSwapOutEnabled:false}};installed.after=structuredClone(installed.before);writeFileSync(f.file,JSON.stringify(installed));
  assert.equal(fixtureInterlock(f.file,Date.now,contract).state,'unknown');assert.equal(fixtureInterlock(f.file,Date.now,qualified).state,'installed_disabled');
  for(const modify of [(p:any)=>p.before[3].backendFacts.autoSwapOutEnabled=true,(p:any)=>p.before[3].backendFacts.backend='unknown',(p:any)=>p.before[3].backendFacts.version='other',(p:any)=>p.registryAfterHash='e'.repeat(64)]){const p=structuredClone(installed);modify(p);p.after=structuredClone(p.before);writeFileSync(f.file,JSON.stringify(p));assert.equal(fixtureInterlock(f.file,Date.now,qualified).state,'unknown');}
  const separate=structuredClone(installed);separate.before[3].backendFacts.backend='ldk';separate.before[3].backendFacts.nodeId='03'+'9'.repeat(64);separate.before[3].backendFacts.autoSwapOutEnabled=true;separate.after=structuredClone(separate.before);writeFileSync(f.file,JSON.stringify(separate));assert.equal(fixtureInterlock(f.file,Date.now,qualified).state,'installed_disabled');
 }finally{f.close();}
});

test('original FIFO, linked and oversized gates fail closed under an isolated reconciliation watchdog',()=>{
 const f=temporary();try{
  const program=`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const {readInterlock}=await import(${JSON.stringify(new URL('../interlocks.js',import.meta.url).href)});const {Collector}=await import(${JSON.stringify(new URL('../collector.js',import.meta.url).href)});const {Store}=await import(${JSON.stringify(new URL('../store.js',import.meta.url).href)});let bytes=0;const stat=fs.fstatSync;fs.fstatSync=(fd)=>{const result=stat(fd);result.uid=0;return result;};const original=fs.readSync;fs.readSync=(...args)=>{const n=original(...args);bytes+=n;return n;};syncBuiltinESMExports();const proof=readInterlock(process.argv[1],Date.now,${JSON.stringify(contract)});const s=new Store(':memory:');let reconciled=0;try{await new Collector(s,{snapshot:async()=>{throw Error('offline');}},{reconcile:async()=>{reconciled++;}},process.argv[1]).collect();console.log(JSON.stringify({state:proof.state,bytes,reconciled}));}finally{s.close();}`;
  const check=(path:string)=>{const child=spawnSync(process.execPath,['--input-type=module','-e',program,path],{timeout:3000,encoding:'utf8'});assert.equal(child.error,undefined);assert.equal(child.status,0,child.stderr);const result=JSON.parse(child.stdout.trim());assert.equal(result.state,'unknown');assert.equal(result.reconciled,1);assert.ok(result.bytes<=65537);};
  execFileSync('mkfifo',[f.file]);check(f.file);rmSync(f.file);
  writeFileSync(f.file,Buffer.alloc(16*1024*1024,32));check(f.file);rmSync(f.file);
  writeFileSync(f.file,JSON.stringify(gate()));execFileSync('ln',['-s',f.file,join(f.directory,'symlink')]);check(join(f.directory,'symlink'));
  execFileSync('ln',[f.file,join(f.directory,'hardlink')]);check(f.file);
 }finally{f.close();}
});
test('a gate growing during descriptor read is bounded and rejected',()=>{
 const f=temporary();try{
  writeFileSync(f.file,JSON.stringify(gate()));
  const program=`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const {readInterlock}=await import(${JSON.stringify(new URL('../interlocks.js',import.meta.url).href)});let bytes=0,changed=false;const stat=fs.fstatSync;fs.fstatSync=(fd)=>{const result=stat(fd);result.uid=0;return result;};const read=fs.readSync;fs.readSync=(...args)=>{if(!changed){changed=true;fs.appendFileSync(process.argv[1],Buffer.alloc(16*1024*1024,32));}const n=read(...args);bytes+=n;return n;};syncBuiltinESMExports();console.log(JSON.stringify({state:readInterlock(process.argv[1],Date.now,${JSON.stringify(contract)}).state,bytes}));`;
  const child=spawnSync(process.execPath,['--input-type=module','-e',program,f.file],{timeout:3000,encoding:'utf8'});assert.equal(child.error,undefined);assert.equal(child.status,0,child.stderr);assert.deepEqual(JSON.parse(child.stdout.trim()),{state:'unknown',bytes:65537});
 }finally{f.close();}
});

test('privileged producer binding compares actual digest equality and user-owned files fail closed',()=>{
 const f=temporary();try{
  const valid=gate();writeFileSync(f.file,JSON.stringify(valid));
  if(process.getuid?.()!==0)assert.equal(readInterlock(f.file,Date.now,contract).state,'unknown');
  for(const change of [(p:any)=>delete p.producerHash,(p:any)=>delete p.runtimeBinding,(p:any)=>p.producerHash='9'.repeat(64),(p:any)=>p.runtimeBinding.imageId='sha256:'+'4'.repeat(64),(p:any)=>p.runtimeBinding.imageRef='ghcr.io/fixture/app@sha256:'+'5'.repeat(64),(p:any)=>p.runtimeBinding.containerId='6'.repeat(64)]){
   const p=structuredClone(valid);change(p);assert.equal(validateInterlock(p,f.file,Date.now,contract).state,'unknown');
  }
 }finally{f.close();}
});
