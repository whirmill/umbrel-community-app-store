import type {DatabaseSync} from 'node:sqlite';
import {CanonicalModel} from './canonical-model.js';
import {archiveOriginal,boundedOriginalPage,encodeOriginal,ingestLegacyBatch,validateCanonical,OriginalArchiveCapacityError,type LegacyTable,LEGACY_TABLES} from './canonical-migration.js';

/** LIMIT binds candidates before eligibility predicates; every link probe uses TEXT expression equality. */
export function retentionCandidateSQL(table:'events'|'snapshots',hasCursor:boolean):string {
 const columns=table==='events'?['id','occurred_at','acquired_at','type','source','target','amount_msat','fee_msat','details','pinned']:['id','at','content'];
 const size=columns.map(k=>`coalesce(length(CAST("${k}" AS BLOB)),0)+64`).join('+');
 const range=hasCursor?'rowid>? AND rowid<=?':'rowid>=? AND rowid<=?';
 if(table==='events')return `SELECT rowid rid,occurred_at stamp,pinned,(${size}) bytes FROM events WHERE ${range} ORDER BY rowid LIMIT ?`;
 return `WITH candidates AS MATERIALIZED (SELECT rowid rid,at stamp,(${size}) bytes FROM snapshots WHERE ${range} ORDER BY rowid LIMIT ?) SELECT c.*,CASE WHEN c.bytes*2>? THEN 0 ELSE coalesce(json_extract(s.content,'$.pinned'),0) END pinned,EXISTS(SELECT 1 FROM operations INDEXED BY canonical_retention_operation_snapshot WHERE CAST(json_extract(details,'$.snapshotId') AS TEXT)=CAST(s.id AS TEXT)) linked FROM candidates c JOIN snapshots s ON s.rowid=c.rid ORDER BY c.rid`;
}
// Minute snapshots are archived by retention immediately before their deletion, not mirrored every minute.
export const RUNTIME_ARCHIVE_TABLES=LEGACY_TABLES.filter(table=>table!=='snapshots');
/** Private operational archive. Client provenance is deliberately independent of LND incarnation. */
export class CanonicalRuntime {
 constructor(readonly db:DatabaseSync){validateCanonical(db);}
 scan(table:LegacyTable,options:{limit?:number;maxBytes?:number;sourceInstance?:string;sourceVersion?:string|null;observedAt?:string}={}){
  return ingestLegacyBatch(this.db,{table,nodeId:null,network:null,sourceInstance:options.sourceInstance??'satssurge-operational-originals',sourceVersion:options.sourceVersion===undefined?'schema6':options.sourceVersion,observedAt:options.observedAt??new Date().toISOString(),limit:options.limit,maxBytes:options.maxBytes});
 }
 summary(){
  const checkpoints=this.db.prepare("SELECT scope,details FROM canonical_coverage c WHERE capability='legacy_ingestion' AND status='checkpoint' AND rowid=(SELECT max(rowid) FROM canonical_coverage WHERE capability='legacy_ingestion' AND scope=c.scope AND status='checkpoint') ORDER BY scope").all();
  const tables=checkpoints.map(row=>{const d=JSON.parse(String(row.details));const completed=this.db.prepare("SELECT details FROM canonical_coverage WHERE capability='legacy_ingestion' AND scope=? AND json_extract(details,'$.frozenHighWaterComplete')=1 ORDER BY rowid DESC LIMIT 1").get(String(row.scope));const c=completed?JSON.parse(String(completed.details)):null;return {table:d.table,cycle:d.cycle,cursor:d.cursor,upperBound:d.upperBound,scannedRows:d.scannedRows??null,scanDigest:d.scanDigest??null,frozenHighWaterComplete:!!c,completedHighWater:c?{cycle:c.cycle,upperBound:c.upperBound,scannedRows:c.scannedRows,scanDigest:c.scanDigest}:null,currentCycleComplete:d.frozenHighWaterComplete===true,sourceMutationTimeKnown:false};});
  const initial=this.db.prepare("SELECT scope,details FROM canonical_coverage WHERE capability='migration_original_freeze' ORDER BY scope").all().map(r=>({table:String(r.scope),...JSON.parse(String(r.details))}));
  return {schema:7,initialFreeze:{tables:initial,complete:initial.length===LEGACY_TABLES.length&&initial.every(t=>t.contentsFrozenInMigrationTransaction===true&&t.frozenHighWaterComplete===true)},archiveRecords:Number(this.db.prepare('SELECT count(*) n FROM canonical_original_archive').get()!.n),observationRecords:Number(this.db.prepare('SELECT count(*) n FROM canonical_observations').get()!.n),tables,archiveComplete:initial.length===LEGACY_TABLES.length&&initial.every(t=>t.contentsFrozenInMigrationTransaction===true&&t.frozenHighWaterComplete===true),runtimeScansComplete:RUNTIME_ARCHIVE_TABLES.every(table=>tables.some(t=>t.table===table&&t.frozenHighWaterComplete)),financialAuthorityUnchanged:true,limits:{maxRows:1000,maxBytes:16777216},nativeCompletenessQualified:false};
 }
 /** One bounded atomic batch per invocation. Any archive/limit failure preserves every original. */
 retain(at:string,options:{limit?:number;maxBytes?:number;beforeDelete?:()=>void}={}){
  const limit=options.limit??200,maxBytes=options.maxBytes??1048576;
  if(!Number.isSafeInteger(limit)||limit<1||limit>1000||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>16777216)throw Error('Bounded retention options required');
  const cutoff=new Date(Date.parse(at)-90*86400_000).toISOString();
  return new CanonicalModel(this.db).transaction(()=>{
   const model=new CanonicalModel(this.db);let budget=maxBytes;
   const batches=(['events','snapshots'] as const).map(table=>{
    const old=this.db.prepare("SELECT id,details FROM canonical_coverage WHERE capability='original_retention' AND scope=? AND status='checkpoint' ORDER BY rowid DESC LIMIT 1").get(table);
    const checkpoint=old?JSON.parse(String(old.details)):null;
    let cycle=checkpoint?.cycle??1,cursor:string|null=checkpoint?.cycleComplete?null:checkpoint?.cursor??null,upperBound:string|undefined=checkpoint?.cycleComplete?undefined:checkpoint?.upperBound;
    if(checkpoint?.cycleComplete)cycle++;
    if(upperBound===undefined){const highwater=this.db.prepare(`SELECT coalesce(max(rowid),0) highwater FROM ${table}`);highwater.setReadBigInts(true);upperBound=String(highwater.get()!.highwater);}
    const statement=this.db.prepare(retentionCandidateSQL(table,cursor!==null));statement.setReadBigInts(true);
    const args=[cursor===null?-9223372036854775808n:BigInt(cursor),BigInt(upperBound),limit,...(table==='snapshots'?[maxBytes]:[])];
    const candidates=statement.all(...args) as any[];
    const eligible=candidates.filter(row=>row.stamp<cutoff&&row.pinned===0n&&!row.linked);
    // Both tables share one archive byte budget. A byte-bounded prefix resumes after its last archived
    // row. A head row that alone exceeds maxBytes (size estimate or exact encoding) stays in its original
    // table and is passed over, whatever budget the other table consumed.
    const available=budget;let rows:any[]=[];
    if(eligible.length&&available>0)try{rows=boundedOriginalPage(this.db,table,`rowid IN (${eligible.map(()=>'?').join(',')})`,eligible.map(row=>row.rid),'rowid',eligible.length,available).rows;}catch(error){if(!(error instanceof OriginalArchiveCapacityError))throw error;}
    for(const raw of rows){const {__canonical_rowid__,...row}=raw;budget-=Buffer.byteLength(encodeOriginal(row));}
    const truncated=rows.length<eligible.length;
    const oversized=(head:any)=>{if(Number(head.bytes)*2>maxBytes)return true;const original=this.db.prepare(`SELECT * FROM ${table} WHERE rowid=?`);original.setReadBigInts(true);return Buffer.byteLength(encodeOriginal(original.get(head.rid) as any))>maxBytes;};
    if(candidates.length)cursor=!truncated?String(candidates.at(-1).rid):rows.length?String(rows.at(-1).__canonical_rowid__):oversized(eligible[0])?String(eligible[0].rid):cursor;
    const cycleComplete=!truncated&&(candidates.length<limit||(cursor!==null&&BigInt(cursor)>=BigInt(upperBound)));
    return {table,rows,examined:candidates.length,checkpoint:{cycle,cursor,upperBound,cycleComplete},supersedes:old?String(old.id):null};
   });
   const events=batches[0]!.rows,snapshots=batches[1]!.rows;
   let bytes=0;for(const [table,rows] of [['events',events],['snapshots',snapshots]] as const)for(const raw of rows){
    const {__canonical_rowid__,...row}=raw;
    const result=archiveOriginal(this.db,table,row,{nodeId:null,network:null,sourceInstance:'satssurge-operational-originals',sourceVersion:'schema6',observedAt:at,rowid:String(__canonical_rowid__)});
    bytes+=Number(this.db.prepare('SELECT length(CAST(raw_row AS BLOB)) n FROM canonical_original_archive WHERE id=?').get(result.id)!.n);
    if(bytes>maxBytes)throw Error('Original archive byte limit exceeded; original rows retained');
   }
   options.beforeDelete?.();
   const days=new Map<string,any[]>(),intervals=new Map<string,any[]>();
   for(const row of events){const d=row.occurred_at.slice(0,10);days.set(d,[...(days.get(d)??[]),row]);const key=JSON.stringify([row.type,row.source,row.target]);intervals.set(key,[...(intervals.get(key)??[]),row]);}
   for(const [d,rows] of days){const old=this.db.prepare('SELECT content FROM aggregates WHERE day=?').get(d);const agg=old?JSON.parse(String(old.content)):{events:0,amountMsat:'0',feeMsat:'0',detailExpired:true};agg.events+=rows.length;agg.amountMsat=(BigInt(agg.amountMsat)+rows.reduce((sum,r)=>sum+BigInt(r.amount_msat),0n)).toString();agg.feeMsat=(BigInt(agg.feeMsat)+rows.reduce((sum,r)=>sum+BigInt(r.fee_msat),0n)).toString();this.db.prepare('INSERT INTO aggregates VALUES(?,?,1) ON CONFLICT(day) DO UPDATE SET content=excluded.content').run(d,JSON.stringify(agg));}
   for(const [key,rows] of intervals){const [type,source,target]=JSON.parse(key);this.db.prepare('INSERT INTO expired_intervals VALUES(?,?,?,?,?,?)').run(rows.reduce((v,r)=>r.occurred_at<v?r.occurred_at:v,rows[0].occurred_at),rows.reduce((v,r)=>r.occurred_at>v?r.occurred_at:v,rows[0].occurred_at),type,source,target,rows.length);}
   for(const row of events){this.db.prepare('INSERT OR IGNORE INTO expired_events VALUES(?)').run(row.id);this.db.prepare('DELETE FROM events WHERE id=?').run(row.id);}
   if(snapshots.length)this.db.prepare("INSERT INTO expired_intervals VALUES(?,?,'snapshot','','',?)").run(snapshots.reduce((v,r)=>r.at<v?r.at:v,snapshots[0].at),snapshots.reduce((v,r)=>r.at>v?r.at:v,snapshots[0].at),snapshots.length);
   for(const row of snapshots)this.db.prepare('DELETE FROM snapshots WHERE id=?').run(row.id);
   const checkpoints=batches.map(batch=>model.appendCoverage({nodeId:null,network:null,capability:'original_retention',scope:batch.table,source:'satssurge-operational-originals',epoch:String(batch.checkpoint.cycle),start:at,end:at,observedAt:at,status:'checkpoint',supersedes:batch.supersedes,details:{...batch.checkpoint,examined:batch.examined,deleted:batch.rows.length}}));
   return {eventsExamined:batches[0]!.examined,snapshotsExamined:batches[1]!.examined,checkpointIds:checkpoints,eventsDeleted:events.length,snapshotsDeleted:snapshots.length,archivedBytes:bytes,limit,moreMayRemain:batches.some(batch=>!batch.checkpoint.cycleComplete)};
  });
 }
}
