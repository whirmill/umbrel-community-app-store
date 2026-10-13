import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../store.js';
import {LegacyStore} from './native-legacy-store-fixture.js';
import {boundedOriginalRows,decodeOriginal,ingestLegacyBatch,LEGACY_TABLES,migrateCanonical,OriginalArchiveCapacityError} from '../canonical-migration.js';
const at='2026-10-13T10:00:00.000Z',cap=1048576;
function metaFixture(s:{run:(sql:string,...args:any[])=>unknown}){
 s.run('DELETE FROM meta');
 for(let i=0;i<200;i++)s.run('INSERT INTO meta VALUES(?,?)',`synthetic-${String(i).padStart(3,'0')}`,'x'.repeat(i===0?360000:1700));
}
test('1.4 MiB candidate set commits only a bounded ordered prefix, resumes after reopen, and keeps its frozen high water',()=>{
 const dir=mkdtempSync(join(tmpdir(),'archive-prefix-')),path=join(dir,'operational.sqlite');let s=new Store(path);
 try{
  metaFixture(s);const originals=s.all('SELECT rowid,key,value FROM meta ORDER BY rowid');
  const estimated=originals.reduce((n,r)=>n+2*(Buffer.byteLength(r.key)+Buffer.byteLength(r.value)+128),0);assert.ok(estimated>1400000&&estimated<1500000);
  assert.throws(()=>boundedOriginalRows(s.db,'meta','1=1',[],'rowid',200,cap),OriginalArchiveCapacityError);
  const first=s.canonical.scan('meta',{limit:200,observedAt:at});assert.ok(first.read>0&&first.read<200);assert.equal(first.boundedByBytes,true);assert.equal(first.cycleComplete,false);
  const archived=s.all("SELECT original_id,raw_row FROM canonical_original_archive WHERE original_table='meta' AND source_instance='satssurge-operational-originals' ORDER BY rowid");
  assert.deepEqual(archived.map(r=>r.original_id),originals.slice(0,first.read).map(r=>r.key));assert.ok(archived.reduce((n,r)=>n+Buffer.byteLength(r.raw_row),0)<=cap);
  const prefixEstimate=originals.slice(0,first.read).reduce((n,r)=>n+2*(Buffer.byteLength(r.key)+Buffer.byteLength(r.value)+128),0),next=originals[first.read]!;
  assert.ok(prefixEstimate<=cap);assert.ok(prefixEstimate+2*(Buffer.byteLength(next.key)+Buffer.byteLength(next.value)+128)>cap);
  assert.equal(first.cursor,String(originals[first.read-1]!.rowid));assert.equal(s.canonical.summary().runtimeScansComplete,false);
  s.run('INSERT INTO meta VALUES(?,?)','after-high-water','new');s.close();s=new Store(path);
  const second=s.canonical.scan('meta',{limit:200,observedAt:at});assert.equal(second.cycle,first.cycle);assert.equal(second.read,200-first.read);assert.equal(second.cycleComplete,true);
  const checkpoint=JSON.parse(s.one('SELECT details FROM canonical_coverage WHERE id=?',second.checkpointId).details);assert.equal(checkpoint.upperBound,'200');assert.equal(checkpoint.scannedRows,200);assert.equal(checkpoint.sourceMutationTimeKnown,false);
  assert.equal(s.one("SELECT count(*) n FROM canonical_original_archive WHERE original_table='meta' AND source_instance='satssurge-operational-originals'").n,200);
  assert.equal(s.one("SELECT 1 FROM canonical_original_archive WHERE original_id='after-high-water'"),undefined);assert.deepEqual(s.all('SELECT rowid,key,value FROM meta ORDER BY rowid').slice(0,200),originals);
  for(let i=0;i<3;i++)s.canonical.scan('meta',{limit:200,observedAt:at});assert.ok(s.one("SELECT 1 FROM canonical_original_archive WHERE original_id='after-high-water'"));assert.equal(s.one('SELECT count(*) n FROM ledger').n,0);
 }finally{s.close();rmSync(dir,{recursive:true});}
});
test('escaped encoded payloads shorten the prefix independently of prefetch size without false completion',()=>{
 const s=new Store(':memory:');try{
  s.run('DELETE FROM meta');for(let i=0;i<3;i++)s.run('INSERT INTO meta VALUES(?,?)','nul-'+i,'\u0000'.repeat(100));
  const first=s.canonical.scan('meta',{limit:200,maxBytes:1500,observedAt:at});assert.equal(first.read,2);assert.equal(first.cycleComplete,false);assert.equal(first.boundedByBytes,true);
  assert.ok(s.all("SELECT raw_row FROM canonical_original_archive WHERE source_instance='satssurge-operational-originals'").reduce((n,r)=>n+Buffer.byteLength(r.raw_row),0)<=1500);
  const last=s.canonical.scan('meta',{limit:200,maxBytes:1500,observedAt:at});assert.equal(last.read,1);assert.equal(last.cycleComplete,true);
 }finally{s.close();}
});
test('oversized first row holds exact cursor and checkpoint, never skips a following small row',()=>{
 const s=new Store(':memory:');try{
  s.run('DELETE FROM meta');s.run('INSERT INTO meta VALUES(?,?)','large','x'.repeat(600000));s.run('INSERT INTO meta VALUES(?,?)','small','ok');
  for(let i=0;i<2;i++)assert.throws(()=>s.canonical.scan('meta',{observedAt:at}),OriginalArchiveCapacityError);
  assert.equal(s.one("SELECT count(*) n FROM canonical_original_archive WHERE source_instance='satssurge-operational-originals'").n,0);assert.equal(s.one("SELECT count(*) n FROM canonical_coverage WHERE capability='legacy_ingestion'").n,0);assert.equal(s.one('SELECT count(*) n FROM meta').n,2);
  s.run("INSERT INTO meta(rowid,key,value) VALUES(0,'prefix','ok')");const prefix=s.canonical.scan('meta',{observedAt:at});assert.equal(prefix.read,1);assert.equal(prefix.cursor,'0');assert.equal(prefix.cycleComplete,false);const checkpoint=s.one("SELECT * FROM canonical_coverage WHERE id=?",prefix.checkpointId);
  s.run("UPDATE meta SET value=? WHERE key='large'",'\u0000'.repeat(200000));assert.throws(()=>s.canonical.scan('meta',{observedAt:at}),OriginalArchiveCapacityError);assert.deepEqual(s.one("SELECT * FROM canonical_coverage WHERE capability='legacy_ingestion' ORDER BY rowid DESC LIMIT 1"),checkpoint);assert.equal(s.one("SELECT count(*) n FROM canonical_original_archive WHERE source_instance='satssurge-operational-originals'").n,1);assert.equal(s.one("SELECT 1 FROM canonical_original_archive WHERE original_id='small'"),undefined);
 }finally{s.close();}
});
test('prefix archive and cursor roll back together on checkpoint or payload failure',()=>{
 const s=new Store(':memory:');try{
  metaFixture(s);const options={table:'meta' as const,nodeId:null,network:null,sourceInstance:'synthetic-rollback',sourceVersion:'schema6',observedAt:at,limit:200};
  assert.throws(()=>ingestLegacyBatch(s.db,{...options,beforeCheckpoint:()=>{throw Error('synthetic checkpoint failure');}}),/synthetic checkpoint failure/);
  assert.equal(s.one("SELECT count(*) n FROM canonical_original_archive WHERE source_instance='synthetic-rollback'").n,0);assert.equal(s.one("SELECT count(*) n FROM canonical_coverage WHERE capability='legacy_ingestion'").n,0);
  s.event({id:'valid',at,type:'fixture',source:'1',target:'2',amountMsat:'1',feeMsat:'0'});s.event({id:'invalid',at,type:'fixture',source:'1',target:'2',amountMsat:'1',feeMsat:'0'});s.run("UPDATE events SET amount_msat='malformed' WHERE id='invalid'");
  assert.throws(()=>s.canonical.scan('events',{observedAt:at}));assert.equal(s.one("SELECT count(*) n FROM canonical_original_archive WHERE original_table='events'").n,0);assert.equal(s.one("SELECT count(*) n FROM canonical_coverage WHERE capability='legacy_ingestion'").n,0);assert.equal(s.one('SELECT count(*) n FROM events').n,2);
 }finally{s.close();}
});
test('migration strict batches freeze all 200 originals and all 19 table receipts without shortened-page truncation',()=>{
 const legacy=new LegacyStore(':memory:');try{
  metaFixture(legacy);const before=legacy.all('SELECT key,value FROM meta ORDER BY rowid');migrateCanonical(legacy.db,{freezeOriginals:true});
  const archived=legacy.all("SELECT raw_row FROM canonical_original_archive WHERE original_table='meta' ORDER BY rowid");assert.equal(archived.length,200);assert.deepEqual(archived.map(r=>decodeOriginal(r.raw_row)),before.map(r=>({...r})));
  const receipts=legacy.all("SELECT scope,details FROM canonical_coverage WHERE capability='migration_original_freeze'");assert.equal(receipts.length,LEGACY_TABLES.length);assert.equal(JSON.parse(receipts.find(r=>r.scope==='meta')!.details).scannedRows,200);assert.ok(receipts.every(r=>JSON.parse(r.details).contentsFrozenInMigrationTransaction===true));
 }finally{legacy.close();}
});
test('migration capacity failure rolls back schema and archive rather than accepting a shortened frozen batch',()=>{
 const legacy=new LegacyStore(':memory:');try{
  legacy.run('DELETE FROM meta');for(let i=0;i<100;i++)legacy.run('INSERT INTO meta VALUES(?,?)','large-'+i,'x'.repeat(90000));
  assert.throws(()=>migrateCanonical(legacy.db,{freezeOriginals:true}),OriginalArchiveCapacityError);assert.equal(legacy.one('PRAGMA user_version').user_version,6);assert.equal(legacy.one("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'canonical_%'").n,0);assert.equal(legacy.one('SELECT count(*) n,sum(length(value)) bytes FROM meta').n,100);assert.equal(legacy.one('SELECT sum(length(value)) bytes FROM meta').bytes,9000000);
 }finally{legacy.close();}
});
