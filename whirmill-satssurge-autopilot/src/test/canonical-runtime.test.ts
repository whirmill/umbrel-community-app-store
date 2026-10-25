import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {retentionCandidateSQL} from '../canonical-runtime.js';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../store.js';
import {LegacyStore} from './native-legacy-store-fixture.js';
import {CanonicalRuntime} from '../canonical-runtime.js';
function fixtureStore(path:string){const legacy=new LegacyStore(path);migrateCanonical(legacy.db);(legacy as any).canonical=new CanonicalRuntime(legacy.db);return legacy as unknown as Store;}
import {migrateCanonical,encodeOriginal,decodeOriginal,LEGACY_TABLES} from '../canonical-migration.js';
const at='2026-10-10T08:00:00.000Z',old='2025-01-01T00:00:00.000Z';
const original=(db:DatabaseSync)=>Object.fromEntries((db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'canonical_%' ORDER BY name").all() as any[]).map(({name})=>{const stmt=db.prepare(`SELECT * FROM "${name}"`);stmt.setReadBigInts(true);return [name,stmt.all().map(r=>encodeOriginal(r))];}));
test('fresh7, incomplete shadow7 and newer refusal; immutable archive and exact typed roundtrip',()=>{
 const s=fixtureStore(':memory:');assert.equal(s.get('enabled'),true);
 const row={text:'synthetic private\u0000 narrative',blob:Buffer.from([0,255,4]),integer:9223372036854775807n,negative:-9223372036854775808n,real:1.25,nil:null};assert.deepEqual(decodeOriginal(encodeOriginal(row)),row);
 s.run('INSERT INTO evidence VALUES(?,?,?,?,?,?)','e',at,'fixture','digest',row.blob,'fixture');s.canonical!.scan('evidence',{observedAt:at});const saved=s.one('SELECT raw_row FROM canonical_original_archive');assert.deepEqual(decodeOriginal(saved.raw_row).content,row.blob);assert.throws(()=>s.run('UPDATE canonical_original_archive SET raw_row=?','{}'),/Immutable/);assert.throws(()=>s.run('DELETE FROM canonical_original_archive'),/Immutable/);assert.equal(JSON.stringify(s.canonical!.summary()).includes('raw_row'),false);s.close();
 const dir=mkdtempSync(join(tmpdir(),'canonical-refuse-')),path=join(dir,'fixture.sqlite');const db=new DatabaseSync(path);db.exec('PRAGMA user_version=7');db.close();assert.throws(()=>new Store(path),/Incomplete/);const next=new DatabaseSync(path);next.exec('PRAGMA user_version=8');next.close();assert.throws(()=>new Store(path),/newer/);rmSync(dir,{recursive:true});
});
test('retention bounded atomic archive+delete, pinned and operation snapshots survive; retry never doubles aggregates',()=>{
 const s=fixtureStore(':memory:');for(let i=0;i<501;i++)s.event({id:'e'+i,at:old,type:'external_forward',source:'1',target:'2',amountMsat:'1000',feeMsat:'1',details:{privateNarrative:'synthetic-private-narrative'}});
 s.run("UPDATE events SET pinned=1 WHERE id='e0'");s.run('INSERT INTO snapshots VALUES(?,?,?)','keep',old,'{}');s.run('INSERT INTO snapshots VALUES(?,?,?)','delete',old,'{"narrative":"synthetic-private-snapshot"}');s.run('INSERT INTO snapshots VALUES(?,?,?)','pin',old,'{"pinned":true}');s.run('INSERT INTO decisions VALUES(?,?,?,?,?,?)','d',at,'{}','{}','{}','observing');s.run('INSERT INTO operations VALUES(?,?,?,?,?,?,?)','o','d',at,'SUCCEEDED',null,null,'{"snapshotId":"keep"}');
 assert.throws(()=>s.canonical!.retain(at,{limit:20,beforeDelete:()=>{throw Error('injected');}}),/injected/);assert.equal(s.one('SELECT count(*) n FROM events').n,501);assert.equal(s.one('SELECT count(*) n FROM canonical_original_archive').n,0);assert.equal(s.one('SELECT count(*) n FROM aggregates').n,0);
 assert.equal(s.canonical!.retain(at,{maxBytes:1}).eventsDeleted,0);assert.equal(s.one('SELECT count(*) n FROM events').n,501);assert.equal(s.one('SELECT count(*) n FROM canonical_original_archive').n,0);
 let total=0;for(let i=0;i<5;i++)total+=s.canonical!.retain(at,{limit:200}).eventsDeleted;assert.equal(total,500);assert.equal(s.one('SELECT count(*) n FROM events').n,1);assert.equal(s.one('SELECT count(*) n FROM snapshots').n,2);assert.equal(s.one('SELECT count(*) n FROM canonical_original_archive').n,501);assert.equal(JSON.parse(s.one('SELECT content FROM aggregates').content).events,500);assert.equal(s.one('SELECT count(*) n FROM ledger').n,0);assert.equal(s.one("SELECT count(*) n FROM canonical_observations WHERE payload LIKE '%synthetic-private%'").n,0);
 const eventPlan=s.all('EXPLAIN QUERY PLAN '+retentionCandidateSQL('events',false),-9223372036854775808n,9223372036854775807n,200);assert.match(JSON.stringify(eventPlan),/SEARCH events USING INTEGER PRIMARY KEY/);
 const snapshotPlan=s.all('EXPLAIN QUERY PLAN '+retentionCandidateSQL('snapshots',false),-9223372036854775808n,9223372036854775807n,200,1048576);assert.match(JSON.stringify(snapshotPlan),/SEARCH operations USING (?:COVERING )?INDEX canonical_retention_operation_snapshot/);s.close();
});
test('cyclic scan archives updates behind cursor and rowid reuse without duplicate bookings',()=>{
 const s=fixtureStore(':memory:');for(let i=0;i<3;i++)s.event({id:'e'+i,at,type:'fixture',source:'1',target:'2',amountMsat:'1',feeMsat:'0'});s.canonical!.scan('events',{limit:2,observedAt:at});s.run("UPDATE events SET details=? WHERE id='e0'",'{"narrative":"synthetic-change"}');s.canonical!.scan('events',{limit:2,observedAt:at});s.run("DELETE FROM events WHERE id='e2'");s.event({id:'new-id',at,type:'fixture',source:'1',target:'2',amountMsat:'1',feeMsat:'0'});for(let i=0;i<4;i++)s.canonical!.scan('events',{limit:2,observedAt:at});assert.equal(s.one("SELECT count(*) n FROM canonical_original_archive WHERE original_table='events'").n,5);assert.equal(s.one('SELECT count(*) n FROM ledger').n,0);s.close();
});

test('oversized encoded original is passed over and retained in place, and SQLite signed int64 remains exact',()=>{
 const s=fixtureStore(':memory:');s.event({id:'integer',at,type:'fixture',source:'1',target:'2',amountMsat:'1',feeMsat:'0'});s.run('UPDATE events SET pinned=?',9223372036854775807n);s.canonical!.scan('events',{observedAt:at});assert.equal(decodeOriginal(s.one('SELECT raw_row FROM canonical_original_archive').raw_row).pinned,9223372036854775807n);
 s.event({id:'oversized',at:old,type:'fixture',source:'1',target:'2',amountMsat:'1',feeMsat:'0',details:{text:'\u0000'.repeat(10000)}});assert.equal(s.canonical!.retain(at,{maxBytes:50000}).eventsDeleted,0);assert.equal(s.one("SELECT count(*) n FROM events WHERE id='oversized'").n,1);assert.equal(s.one("SELECT count(*) n FROM canonical_original_archive WHERE original_table='events' AND original_id='oversized'").n,0);s.close();
});

test('retention restart resumes committed bounded batches and incomplete guard cannot reopen',()=>{
 const dir=mkdtempSync(join(tmpdir(),'canonical-restart-')),path=join(dir,'fixture.sqlite');let s=new Store(path);for(let i=0;i<5;i++)s.event({id:'e'+i,at:old,type:'fixture',source:'1',target:'2',amountMsat:'7',feeMsat:'1'});assert.equal(s.canonical!.retain(at,{limit:2}).eventsDeleted,2);s.close();
 s=new Store(path);assert.equal(s.canonical!.retain(at,{limit:2}).eventsDeleted,2);s.close();s=new Store(path);assert.equal(s.canonical!.retain(at,{limit:2}).eventsDeleted,1);assert.equal(s.canonical!.retain(at,{limit:2}).eventsDeleted,0);assert.equal(JSON.parse(s.one('SELECT content FROM aggregates').content).events,5);assert.equal(s.one('SELECT count(*) n FROM expired_events').n,5);assert.equal(s.one("SELECT count(*) n FROM canonical_original_archive WHERE original_table='events'").n,5);s.run('DROP TRIGGER canonical_original_archive_immutable_update');s.close();assert.throws(()=>new Store(path),/immutable guards/);rmSync(dir,{recursive:true});
});

test('bounded archive cursor covers negative, zero and full signed int64 rowids',()=>{
 const s=fixtureStore(':memory:');for(const [key,rowid] of [['min',-9223372036854775808n],['zero',0n],['max',9223372036854775807n]] as const)s.run('INSERT INTO expired_events(rowid,id) VALUES(?,?)',rowid,key);for(let i=0;i<4;i++)s.canonical!.scan('expired_events',{limit:1,observedAt:at});assert.equal(s.one('SELECT count(*) n FROM canonical_original_archive').n,3);s.close();
});

test('duplicate insert/replace cannot rewrite canonical rows with recursive triggers disabled; helpers remain idempotent',()=>{
 const s=fixtureStore(':memory:');s.event({id:'original',at,type:'fixture',source:'1',target:'2',amountMsat:'1',feeMsat:'0'});s.canonical!.scan('events',{observedAt:at});assert.equal(s.one('PRAGMA recursive_triggers').recursive_triggers,0);
 for(const table of ['canonical_original_archive','canonical_observations','canonical_evidence_links','canonical_coverage']){const row=s.one(`SELECT * FROM ${table} LIMIT 1`);assert.throws(()=>s.run(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table} WHERE id=?`,row.id),/Immutable/);assert.throws(()=>s.run(`INSERT OR IGNORE INTO ${table} SELECT * FROM ${table} WHERE id=?`,row.id),/Immutable/);assert.deepEqual(s.one(`SELECT * FROM ${table} WHERE id=?`,row.id),row);}
 const archive=s.one('SELECT * FROM canonical_original_archive');assert.throws(()=>s.run("INSERT OR REPLACE INTO canonical_original_archive SELECT 'different-id',original_table,original_id,source_instance,source_version,original_digest,format_version,raw_row FROM canonical_original_archive WHERE id=?",archive.id),/Immutable/);assert.deepEqual(s.one('SELECT * FROM canonical_original_archive'),archive);
 assert.equal(s.canonical!.scan('events',{observedAt:at}).inserted,0);assert.equal(s.one('SELECT count(*) n FROM canonical_original_archive').n,1);s.close();
});
test('exact DDL validation refuses no-op trigger, wrong target, weakened constraints and wrong expression index on reopen',()=>{
 const dir=mkdtempSync(join(tmpdir(),'canonical-tamper-'));
 const changes=["DROP TRIGGER canonical_original_archive_immutable_update; CREATE TRIGGER canonical_original_archive_immutable_update BEFORE UPDATE ON canonical_original_archive BEGIN SELECT 1; END", "DROP TRIGGER canonical_original_archive_immutable_insert; CREATE TRIGGER canonical_original_archive_immutable_insert BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'Immutable canonical record'); END", "weaken archive constraint", "DROP INDEX canonical_retention_operation_snapshot; CREATE INDEX canonical_retention_operation_snapshot ON operations(json_extract(details,'$.snapshotId'))"];
 for(const [i,sql] of changes.entries()){const path=join(dir,`fixture-${i}.sqlite`),s=new Store(path);if(sql==='weaken archive constraint'){const objects=s.all("SELECT type,sql FROM sqlite_master WHERE tbl_name='canonical_original_archive' AND sql IS NOT NULL");s.db.exec('DROP TABLE canonical_original_archive');for(const object of objects)s.db.exec(object.type==='table'?object.sql.replace('CHECK(format_version=1)','CHECK(format_version>=1)'):object.sql);}else s.db.exec(sql);s.close();assert.throws(()=>new Store(path),/Incomplete canonical/);}
 rmSync(dir,{recursive:true});
});
test('persisted candidate cursor progresses across pinned rows, revisits changed pins and matches snapshot IDs as TEXT',()=>{
 const dir=mkdtempSync(join(tmpdir(),'canonical-candidate-')),path=join(dir,'fixture.sqlite');let s=new Store(path);for(let i=0;i<500;i++){s.event({id:'pin'+i,at:old,type:'fixture',source:'1',target:'2',amountMsat:'1',feeMsat:'0'});s.run('UPDATE events SET pinned=1 WHERE id=?','pin'+i);}s.event({id:'eligible',at:old,type:'fixture',source:'1',target:'2',amountMsat:'1',feeMsat:'0'});
 assert.equal(s.canonical!.retain(at).eventsExamined,200);s.close();s=new Store(path);assert.equal(s.canonical!.retain(at).eventsExamined,200);const last=s.canonical!.retain(at);assert.equal(last.eventsExamined,101);assert.equal(last.eventsDeleted,1);s.run("UPDATE events SET pinned=0 WHERE id='pin0'");assert.equal(s.canonical!.retain(at).eventsDeleted,1);
 s.run('INSERT INTO snapshots VALUES(?,?,?)','7',old,'{}');s.run('INSERT INTO snapshots VALUES(?,?,?)','007',old,'{}');s.run('INSERT INTO decisions VALUES(?,?,?,?,?,?)','d',at,'{}','{}','{}','observing');s.run('INSERT INTO operations VALUES(?,?,?,?,?,?,?)','o','d',at,'SUCCEEDED',null,null,'{"snapshotId":7}');assert.equal(s.canonical!.retain(at).snapshotsDeleted,1);assert.ok(s.one("SELECT 1 FROM snapshots WHERE id='7'"));assert.equal(s.one("SELECT 1 FROM snapshots WHERE id='007'"),undefined);s.close();rmSync(dir,{recursive:true});
});
test('100k pinned candidates and 10k operations have bounded examined rows, indexed link probes and measured VM work',()=>{
 const dir=mkdtempSync(join(tmpdir(),'canonical-volume-')),path=join(dir,'fixture.sqlite'),s=new Store(path);s.tx(()=>{
 s.db.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100000) INSERT INTO events SELECT 'pinned-'||x,'${old}','${old}','fixture','1','2','1','0','{}',1 FROM n`);
 s.run('INSERT INTO decisions VALUES(?,?,?,?,?,?)','d',at,'{}','{}','{}','observing');s.db.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10000) INSERT INTO operations SELECT 'op-'||x,'d','${at}','SUCCEEDED',NULL,NULL,json_object('snapshotId','other-'||x) FROM n`);
 s.db.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<200) INSERT INTO snapshots SELECT 'snapshot-'||x,'${old}','{}' FROM n`);
 });
 const sql=[retentionCandidateSQL('events',false),retentionCandidateSQL('snapshots',false)];const plans=sql.map((query,i)=>s.all('EXPLAIN QUERY PLAN '+query,-9223372036854775808n,9223372036854775807n,200,...(i?[1048576]:[])));assert.match(JSON.stringify(plans[1]),/SEARCH operations USING (?:COVERING )?INDEX canonical_retention_operation_snapshot/);assert.doesNotMatch(JSON.stringify(plans),/SCAN (events|operations|snapshots)/);
 s.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
 const measured=JSON.parse(execFileSync('python3',['-c',`import sqlite3,sys,json
c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
results=[]
for i,sql in enumerate(sys.argv[2:]):
 count=[0]
 def step(): count[0]+=1; return 0
 c.set_progress_handler(step,1)
 rows=c.execute(sql,[-9223372036854775808,9223372036854775807,200]+([1048576] if i else [])).fetchall()
 c.set_progress_handler(None,0)
 results.append({'rows':len(rows),'vmSteps':count[0]})
c.close()
print(json.dumps(results))`,path,...sql],{encoding:'utf8'}));assert.ok(measured[0].vmSteps<15000);assert.ok(measured[1].vmSteps<30000);assert.deepEqual(measured.map((r:any)=>r.rows),[200,200]);console.log(JSON.stringify({canonicalRetentionVolume:{pinned:100000,operations:10000,snapshots:200,measured,plans}}));
 const result=s.canonical!.retain(at);assert.equal(result.eventsExamined,200);assert.equal(result.eventsDeleted,0);assert.equal(result.snapshotsExamined,200);assert.equal(result.snapshotsDeleted,200);assert.equal(s.one('SELECT count(*) n FROM events').n,100000);assert.equal(s.one('SELECT count(*) n FROM ledger').n,0);s.close();rmSync(dir,{recursive:true});
});

test('retention rejects invalid options before any SQLite access even when every original is pinned',()=>{
 const s=fixtureStore(':memory:');s.tx(()=>{
 s.db.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100001) INSERT INTO events SELECT 'pinned-'||x,'${old}','${old}','fixture','1','2','1','0','{}',1 FROM n`);
 s.db.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<201) INSERT INTO snapshots SELECT 'pinned-snapshot-'||x,'${old}','{"pinned":true}' FROM n`);
 });
 const counts=()=>['events','snapshots','event_ingestion','canonical_coverage','canonical_original_archive','canonical_observations','aggregates','expired_events','expired_intervals','ledger'].map(table=>({table,count:s.one(`SELECT count(*) n FROM ${table}`).n}));
 const before=counts(),prepare=s.db.prepare,exec=s.db.exec;let sqliteCalls=0;
 try{
 s.db.prepare=(()=>{sqliteCalls++;throw Error('SQLite accessed before validation');}) as typeof prepare;
 s.db.exec=(()=>{sqliteCalls++;throw Error('SQLite accessed before validation');}) as typeof exec;
 for(const limit of [-1,0,1001,100001,1.5,NaN,Infinity,-Infinity,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>s.canonical!.retain(at,{limit}),/Bounded retention options required/);
 for(const maxBytes of [-1,0,16777217,0.5,NaN,Infinity,-Infinity,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>s.canonical!.retain(at,{maxBytes}),/Bounded retention options required/);
 assert.equal(sqliteCalls,0);
 }finally{s.db.prepare=prepare;s.db.exec=exec;}
 assert.deepEqual(counts(),before);
 const defaults=s.canonical!.retain(at);assert.equal(defaults.eventsExamined,200);assert.equal(defaults.snapshotsExamined,200);assert.equal(defaults.eventsDeleted,0);assert.equal(defaults.snapshotsDeleted,0);
 const maximum=s.canonical!.retain(at,{limit:1000,maxBytes:16777216});assert.equal(maximum.eventsExamined,1000);assert.equal(maximum.eventsDeleted,0);assert.equal(maximum.snapshotsDeleted,0);
 const minimum=s.canonical!.retain(old,{limit:1,maxBytes:1});assert.equal(minimum.eventsExamined,1);assert.equal(minimum.eventsDeleted,0);assert.equal(minimum.snapshotsDeleted,0);assert.equal(s.one('SELECT count(*) n FROM events').n,100001);assert.equal(s.one('SELECT count(*) n FROM snapshots').n,201);assert.equal(s.one('SELECT count(*) n FROM canonical_coverage').n,6);s.close();
});
