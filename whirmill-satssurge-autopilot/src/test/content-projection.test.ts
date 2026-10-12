import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,mkdirSync,chmodSync,symlinkSync,realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.js';
import { CanonicalModel } from '../canonical-model.js';
import { projectContent } from '../content-projection.js';
import { parseContentRequest } from '../content-requests.js';
import { prepareContentDirectory } from '../content-runtime.js';
const at='2026-10-10T12:30:00Z';
test('public canonical export preserves exact observations, gap/provenance and partial pagination without confidential originals or sums',()=>{
 const store=new Store(':memory:');try{
  const m=new CanonicalModel(store.db);
  for(let n=0;n<2;n++)m.observe({nodeId:'fixture-node',network:'mainnet',kind:'forward',meaning:'lnd_effect',source:'lnd-native',sourceVersion:'fixture-v1',sourceInstance:'fixture-instance',originalId:'native-'+n,batchId:'fixture-batch',occurredAt:at,observedAt:at,granularity:'event',sourceChannel:'0x0x1',targetChannel:'0x0x2',amountMsat:'9007199254740993123',feeMsat:'17',payload:{privateNarrative:'PRIVATE_ORIGINAL_NOT_PUBLIC',status:'SUCCEEDED'}});
  m.appendCoverage({nodeId:'fixture-node',network:'mainnet',capability:'forwards',scope:'node',source:'lnd-native',epoch:'fixture',start:at,end:at,observedAt:at,status:'gap',details:{privateNarrative:'PRIVATE_COVERAGE_NOT_PUBLIC'}});
  const before=store.all('SELECT * FROM canonical_observations'),snapshot=projectContent(store,'/export csv section=corridor_events source=1 target=2 limit=1',at),text=JSON.stringify(snapshot);
  assert.equal(snapshot.table.headers.length,12);assert.ok(snapshot.table.rows.length>=3);assert.ok(snapshot.table.rows.length<=34);assert.match(text,/9007199254740993123/);assert.match(text,/gap/);assert.match(text,/lnd-native/);assert.match(text,/originalChecksum/);assert.doesNotMatch(text,/PRIVATE_|privateNarrative/);
  const meta=JSON.parse(snapshot.table.rows[0]![11]!);assert.equal(meta.accountingAuthority,'none');assert.equal(meta.complete,false);assert.equal(meta.truncated,true);assert.equal(meta.financialQualified,false);assert.equal(meta.scopeEvidenceUnknown,true);assert.ok(meta.nextAfter);
  assert.equal(JSON.parse(snapshot.table.rows[1]![11]!).accountingAuthority,'none');assert.match(snapshot.coverage,/Parziale/);assert.deepEqual(store.all('SELECT * FROM canonical_observations'),before);
  const coverage=projectContent(store,'/export xlsx section=coverage',at);assert.ok(coverage.table.rows.some(row=>row[3]==='gap'));assert.ok(coverage.table.rows.length<=101);
 }finally{store.close();}
 const legacy=new Store(':memory:');Object.defineProperty(legacy,'canonical',{value:undefined});try{assert.throws(()=>projectContent(legacy,'/export pdf',at),/Canonical runtime unavailable/);}finally{legacy.close();}
});
test('explicit export scope rejects freeform requests, ambiguous identifiers, unbounded limits and invalid dates',()=>{
 assert.equal(parseContentRequest('please export csv'),undefined);assert.equal(parseContentRequest('/export png')!.format,'png');
 for(const input of ['/export','/export zip','/export csv send to other chat','/export pdf limit=101','/export pdf limit=0','/export pdf source=banana','/export pdf source=1 source=2','/export pdf section=private','/export pdf kind=secrets','/export csv after=12','/export csv start=2026-02-31T00:00:00Z','/export csv section=coverage channel=1'])assert.throws(()=>parseContentRequest(input),input);
});
test('IPC setup requires current app ownership, mode0700 and a real dedicated directory',()=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'content-owner-')));try{const jobs=join(dir,'jobs');prepareContentDirectory(jobs);prepareContentDirectory(jobs);chmodSync(jobs,0o755);assert.throws(()=>prepareContentDirectory(jobs),/Exclusive/);mkdirSync(join(dir,'other'),{mode:0o700});symlinkSync(join(dir,'other'),join(dir,'alias'));assert.throws(()=>prepareContentDirectory(join(dir,'alias')),/Exclusive/);}finally{rmSync(dir,{recursive:true,force:true});}
});
