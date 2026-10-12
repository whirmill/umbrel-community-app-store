import {channelScid} from './diagnostics.js';
import type {DatabaseSync} from 'node:sqlite';
import {CANONICAL_SCHEMA,CanonicalModel,digest,stable,type Binding,type Meaning} from './canonical-model.js';

const ddl=`
CREATE TABLE canonical_original_archive(id TEXT PRIMARY KEY NOT NULL,original_table TEXT NOT NULL CHECK(original_table IN ('meta','events','evidence','claims','snapshots','ledger','decisions','operations','reservations','evaluations','evaluation_windows','aggregates','coverage','benefit_claims','ledger_annotations','expired_intervals','expired_events','channel_holds','strategies')),original_id TEXT NOT NULL,source_instance TEXT NOT NULL,source_version TEXT,original_digest TEXT NOT NULL,format_version INTEGER NOT NULL CHECK(format_version=1),raw_row TEXT NOT NULL,UNIQUE(original_table,original_id,source_instance,source_version,original_digest)) STRICT;
CREATE INDEX canonical_archive_original ON canonical_original_archive(original_table,original_id,source_instance);
CREATE TABLE canonical_observations(id TEXT PRIMARY KEY NOT NULL,node_id TEXT,network TEXT,kind TEXT NOT NULL,meaning TEXT NOT NULL CHECK(meaning IN ('lnd_effect','satssurge_intent','external_intent','derived_aggregate','booked_claim','historical_evidence')),source TEXT NOT NULL,source_version TEXT,source_instance TEXT NOT NULL,original_id TEXT NOT NULL,batch_id TEXT NOT NULL,occurred_at TEXT,observed_at TEXT NOT NULL,original_timestamp TEXT,timestamp_ns TEXT,granularity TEXT NOT NULL,calculation_version TEXT,source_channel TEXT,target_channel TEXT,endpoint_scope TEXT NOT NULL CHECK(endpoint_scope IN ('single_effect','aggregate')),amount_msat TEXT,fee_msat TEXT,signed_fee_delta_msat TEXT,original_digest TEXT,payload_digest TEXT NOT NULL,payload TEXT NOT NULL) STRICT;
CREATE TABLE canonical_entities(id TEXT PRIMARY KEY NOT NULL,node_id TEXT NOT NULL,network TEXT NOT NULL,kind TEXT NOT NULL,identity_namespace TEXT NOT NULL CHECK(identity_namespace IN ('payment_index','payment_hash','payment_attempt','forward_cursor','htlc_circuit','satssurge_operation')),identity_key TEXT NOT NULL,UNIQUE(node_id,network,kind,identity_namespace,identity_key)) STRICT;
CREATE TABLE canonical_evidence_links(id TEXT PRIMARY KEY NOT NULL,observation_id TEXT NOT NULL REFERENCES canonical_observations(id),entity_id TEXT REFERENCES canonical_entities(id),reference_table TEXT,reference_id TEXT,relation TEXT NOT NULL CHECK(relation IN ('same_effect','original','booked_receipt','intent','attempt','ambiguous','conflict','projection_input')),method TEXT NOT NULL,details TEXT NOT NULL) STRICT;
CREATE TABLE canonical_coverage(id TEXT PRIMARY KEY NOT NULL,node_id TEXT,network TEXT,capability TEXT NOT NULL,scope TEXT NOT NULL,source TEXT NOT NULL,epoch TEXT NOT NULL,start TEXT NOT NULL,end TEXT NOT NULL,observed_at TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('complete','partial','unknown','gap','expired','ready','checkpoint')),details TEXT NOT NULL,supersedes TEXT REFERENCES canonical_coverage(id)) STRICT;
CREATE TABLE canonical_projection_revisions(id TEXT PRIMARY KEY NOT NULL,name TEXT NOT NULL,scope TEXT NOT NULL,epoch TEXT NOT NULL,calculation_version TEXT NOT NULL,input_digest TEXT NOT NULL,evidence_ids TEXT NOT NULL,lineage_ids TEXT NOT NULL,coverage_ids TEXT NOT NULL,result TEXT NOT NULL,supersedes TEXT REFERENCES canonical_projection_revisions(id)) STRICT;
CREATE INDEX canonical_observation_time ON canonical_observations(node_id,network,kind,occurred_at,id);
CREATE INDEX canonical_observation_corridor ON canonical_observations(node_id,network,kind,source_channel,target_channel,occurred_at,id);
CREATE INDEX canonical_observation_original ON canonical_observations(source_instance,original_id,original_digest);
CREATE INDEX canonical_link_reference ON canonical_evidence_links(reference_table,reference_id,relation);
CREATE INDEX canonical_link_entity ON canonical_evidence_links(entity_id,relation,observation_id);
CREATE INDEX canonical_coverage_interval ON canonical_coverage(node_id,network,capability,scope,start,end);
CREATE INDEX canonical_legacy_checkpoint ON canonical_coverage(capability,scope,status);
CREATE INDEX canonical_coverage_checkpoint ON canonical_coverage(capability,scope,observed_at,id);
CREATE INDEX canonical_projection_lookup ON canonical_projection_revisions(name,scope,epoch);
`;
const tables=['canonical_original_archive','canonical_observations','canonical_entities','canonical_evidence_links','canonical_coverage','canonical_projection_revisions'];
const retentionIndexes={snapshots:'CREATE INDEX canonical_retention_snapshots_time ON snapshots(at)',operations:"CREATE INDEX canonical_retention_operation_snapshot ON operations(CAST(json_extract(details,'$.snapshotId') AS TEXT))"};
const guardDDL=(table:string,action:'insert'|'update'|'delete')=>{
 const unique=table==='canonical_original_archive'?['original_table','original_id','source_instance','source_version','original_digest']:table==='canonical_entities'?['node_id','network','kind','identity_namespace','identity_key']:[];
 const duplicate=`id=NEW.id${unique.length?' OR ('+unique.map(column=>`${column} IS NEW.${column}`).join(' AND ')+')':''}`;
 return action==='insert'?`CREATE TRIGGER ${table}_immutable_insert BEFORE INSERT ON ${table} WHEN EXISTS(SELECT 1 FROM ${table} WHERE ${duplicate}) BEGIN SELECT RAISE(ABORT,'Immutable canonical record'); END`:`CREATE TRIGGER ${table}_immutable_${action} BEFORE ${action.toUpperCase()} ON ${table} BEGIN SELECT RAISE(ABORT,'Immutable canonical record'); END`;
};
const normalizeDDL=(sql:string)=>sql.trim().replace(/;$/,'').replace(/\s+/g,' ');
/** Explicitly invoked by a fenced caller on its chosen connection. Does not open paths or ingest anything. */
export function migrateCanonical(db:DatabaseSync,options:{beforeCommit?:()=>void;freezeOriginals?:boolean;deadlineMs?:number}={}):void {
 const version=Number(db.prepare('PRAGMA user_version').get()?.user_version);
 if(version>CANONICAL_SCHEMA)throw Error('Database is newer than canonical software');
 db.exec('PRAGMA foreign_keys=ON');if(Number(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys)!==1)throw Error('Canonical migration requires foreign keys outside any active transaction');
 if(version===CANONICAL_SCHEMA){validateCanonical(db);return;}
 if(version!==6)throw Error('Canonical migration requires schema 6');
 db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
 try{db.exec(ddl);for(const [table,sql] of Object.entries(retentionIndexes))if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))db.exec(sql);for(const table of tables)for(const action of ['insert','update','delete'] as const)db.exec(guardDDL(table,action));
 if((db.prepare('PRAGMA quick_check').get() as any).quick_check!=='ok'||db.prepare('PRAGMA foreign_key_check').get())throw Error('Canonical migration integrity check failed');db.exec('PRAGMA user_version=7');if(options.freezeOriginals)freezeMigrationOriginals(db,options.deadlineMs??30000);options.beforeCommit?.();db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
}
/** Reject historical shadow7 files lacking this unpublished archive contract. */
export function validateCanonical(db:DatabaseSync):void {
 if(Number(db.prepare('PRAGMA user_version').get()?.user_version)!==7)throw Error('Explicit canonical schema7 required');
 const expected=ddl.split(';').map(sql=>sql.trim()).filter(Boolean);
 for(const table of tables)for(const action of ['insert','update','delete'] as const)expected.push(guardDDL(table,action));
 for(const [table,sql] of Object.entries(retentionIndexes))if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))expected.push(sql);
 for(const sql of expected){
  const match=/^CREATE (TABLE|INDEX|TRIGGER) (\w+)(?:[^]*? ON (\w+))?/.exec(sql)!;
  const type=match[1]!.toLowerCase(),name=match[2]!,target=type==='table'?name:match[3]!;
  const actual=db.prepare('SELECT type,tbl_name,sql FROM sqlite_master WHERE name=?').get(name);
  if(!actual||actual.type!==type||actual.tbl_name!==target||normalizeDDL(String(actual.sql))!==normalizeDDL(sql))throw Error(type==='trigger'?'Incomplete canonical immutable guards':'Incomplete canonical schema DDL');
 }

}
export const LEGACY_TABLES=['meta','events','evidence','claims','snapshots','ledger','decisions','operations','reservations','evaluations','evaluation_windows','aggregates','coverage','benefit_claims','ledger_annotations','expired_intervals','expired_events','channel_holds','strategies'] as const;
export type LegacyTable=typeof LEGACY_TABLES[number];
const keyColumns:Partial<Record<LegacyTable,string[]>>={meta:['key'],reservations:['operation_id'],aggregates:['day'],benefit_claims:['operation_id'],ledger_annotations:['ledger_id','version'],expired_events:['id'],channel_holds:['channel_id'],strategies:['key']};
const meanings:Partial<Record<LegacyTable,Meaning>>={ledger:'booked_claim',decisions:'satssurge_intent',operations:'satssurge_intent',reservations:'satssurge_intent',benefit_claims:'satssurge_intent',evaluations:'derived_aggregate',evaluation_windows:'derived_aggregate',aggregates:'derived_aggregate'};
const channel=(v:unknown):string|null=>{try{return channelScid(v);}catch{return null;}};
const utc=(v:unknown):string|null=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT.*Z$/.test(v)&&Number.isFinite(Date.parse(v))?v:null;
/** Reference projection only: original bytes remain untouched in original tables, including private operation invoices. */
function projection(table:LegacyTable,row:Record<string,any>,originalDigest:string) {
 const selected:Record<string,unknown>={originalTable:table,originalRecordDigest:originalDigest};
 for(const key of ['id','operation_id','decision_id','classification','category','state','status','kind','type','day','version','sector','attribution','source','target','at','occurred_at','acquired_at','start','end','complete','pinned','active','amount_msat','fee_msat','amount_sat','volume_msat','benefit_msat','source_version','digest'])if(row[key]!==undefined)selected[key]=typeof row[key]==='bigint'?row[key].toString():row[key];
 if(table==='meta'&&row.key==='diagnostics'){try{const value=JSON.parse(row.value);selected.diagnosticCapture={at:value.at??null,providers:Object.fromEntries(['lndg','lightningMate'].map(name=>{const p=value[name];return [name,{status:p?.status??'unavailable',version:p?.version??null,capturedAt:p?.capturedAt??null,captureComplete:p?.captureComplete??null,coverage:p?.coverage??null,captureCounts:p?.captureCounts??null,counts:Object.fromEntries(['forwards','failures','failureRollups','rebalances'].map(k=>[k,Array.isArray(p?.[k])?p[k].length:null]))}];})),sourceMutationTimeKnown:false};}catch{selected.diagnosticCapture={status:'unavailable'};}}
 // Structured originals are retained in place and addressed by digest; do not copy personal narratives or payment payloads.
 return selected;
}
export interface LegacyBatchOptions extends Binding {table:LegacyTable;sourceInstance:string;sourceVersion:string|null;observedAt:string;limit?:number;maxBytes?:number;beforeCheckpoint?:()=>void}
/** Each complete cycle starts another bounded scan: catches post-baseline rows, rowid reuse and updates behind a previous cursor. */
export function ingestLegacyBatch(db:DatabaseSync,o:LegacyBatchOptions):{read:number;inserted:number;cursor:string|null;cycle:number;cycleComplete:boolean;checkpointId:string} {
 if(!LEGACY_TABLES.includes(o.table))throw Error('Unsupported original table');
 const limit=o.limit??200;if(!Number.isSafeInteger(limit)||limit<1||limit>1000)throw Error('Bounded legacy batch required');
 const source='legacy:'+o.table;const model=new CanonicalModel(db),scope=stable({table:o.table,sourceInstance:o.sourceInstance,nodeId:o.nodeId,network:o.network});
 return model.transaction(()=>{
   const old=db.prepare("SELECT * FROM canonical_coverage WHERE capability='legacy_ingestion' AND scope=? AND status='checkpoint' ORDER BY rowid DESC LIMIT 1").get(scope) as any;
   const checkpoint=old?JSON.parse(old.details):null;
   let cycle=checkpoint?.cycle??1,cursor=checkpoint?.cursor===undefined||checkpoint.cursor===null?null:String(checkpoint.cursor),upperBound=checkpoint?.upperBound;
   if(checkpoint?.cycleComplete){cycle++;cursor=null;upperBound=undefined;}
   if(upperBound===undefined){const highwater=db.prepare(`SELECT coalesce(max(rowid),0) highwater FROM ${o.table}`);highwater.setReadBigInts(true);upperBound=String(highwater.get()!.highwater);}
   const rows=boundedOriginalRows(db,o.table,cursor===null?'rowid>=? AND rowid<=?':'rowid>? AND rowid<=?',[cursor===null?-9223372036854775808n:BigInt(cursor),BigInt(upperBound)],'rowid',limit,o.maxBytes??1048576);
   let inserted=0,encodedBytes=0;const rowDigests:string[]=[],previousDigest=checkpoint?.cycleComplete?null:checkpoint?.scanDigest??null;let scanDigest=previousDigest??digest({table:o.table,cycle,upperBound});let scannedRows=checkpoint?.cycleComplete?0:checkpoint?.scannedRows??0;
   for(const raw of rows){const {__canonical_rowid__,...row}=raw;cursor=String(__canonical_rowid__);const rowDigest=digest(encodeOriginal(row));rowDigests.push(rowDigest);scanDigest=digest({previous:scanDigest,rowid:cursor,rowDigest});scannedRows++;
     encodedBytes+=Buffer.byteLength(encodeOriginal(row));if(encodedBytes>(o.maxBytes??1048576))throw Error('Original archive byte limit exceeded; original rows retained');
     inserted+=archiveOriginal(db,o.table,row,{sourceInstance:o.sourceInstance,sourceVersion:o.sourceVersion,observedAt:o.observedAt,nodeId:o.nodeId,network:o.network,rowid:cursor}).inserted;

   }
   const cycleComplete=rows.length<limit||(cursor!==null&&BigInt(cursor)>=BigInt(upperBound));
   o.beforeCheckpoint?.();
   const checkpointId=model.appendCoverage({nodeId:o.nodeId,network:o.network,capability:'legacy_ingestion',scope,source,epoch:String(cycle),start:o.observedAt,end:o.observedAt,observedAt:o.observedAt,status:'checkpoint',supersedes:old?.id??null,details:{table:o.table,cycle,cursor,upperBound,cycleComplete,read:rows.length,scannedRows,scanDigest,rowDigests,frozenHighWaterComplete:cycleComplete,sourceMutationTimeKnown:false}});
   return {read:rows.length,inserted,cursor,cycle,cycleComplete,scannedRows,scanDigest,upperBound,checkpointId};
 });
}

/** Exact SQLite storage values; never expose raw_row in a public or model-visible DTO. */
export function encodeOriginal(row:Record<string,unknown>):string {
 return stable(Object.fromEntries(Object.entries(row).map(([k,v])=>[k,v===null?['null']:typeof v==='bigint'?['integer',v.toString()]:typeof v==='number'?['real',Object.is(v,-0)?'-0':String(v)]:typeof v==='string'?['text',v]:v instanceof Uint8Array?['blob',Buffer.from(v).toString('base64')]:(()=>{throw Error('Unsupported original SQLite value');})()])));
}
export function decodeOriginal(text:string):Record<string,unknown> {
 return Object.fromEntries(Object.entries(JSON.parse(text)).map(([k,raw])=>{const [type,value]=raw as string[];return [k,type==='null'?null:type==='integer'?BigInt(value!):type==='real'?Number(value):type==='text'?value:type==='blob'?Buffer.from(value!,'base64'):(()=>{throw Error('Unsupported archive format');})()];}));
}
/** Size gate is evaluated by SQLite before fetching payload columns. At most limit rows materialize. */
export function boundedOriginalRows(db:DatabaseSync,table:LegacyTable,where:string,args:any[],order:string,limit:number,maxBytes:number):any[] {
 if(!LEGACY_TABLES.includes(table)||!Number.isSafeInteger(limit)||limit<1||limit>1000||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>16777216)throw Error('Bounded original batch required');
 const columns=db.prepare(`PRAGMA table_info(${table})`).all().map(r=>String(r.name));
 const size=columns.map(k=>`coalesce(length(CAST("${k}" AS BLOB)),0)+64`).join('+');
 const candidateStatement=db.prepare(`SELECT rowid rid,(${size}) bytes FROM ${table} WHERE ${where} ORDER BY ${order} LIMIT ?`);candidateStatement.setReadBigInts(true);const candidates=candidateStatement.all(...args,limit) as any[];
 let bytes=0;for(const row of candidates){bytes+=Number(row.bytes)*2;if(bytes>maxBytes)throw Error('Original archive byte limit exceeded; original rows retained');}
 if(!candidates.length)return [];
 const statement=db.prepare(`SELECT rowid AS __canonical_rowid__,* FROM ${table} WHERE rowid IN (${candidates.map(()=>'?').join(',')}) ORDER BY ${order}`);statement.setReadBigInts(true);
 return statement.all(...candidates.map(r=>r.rid)) as any[];
}
export function archiveOriginal(db:DatabaseSync,table:LegacyTable,row:Record<string,any>,o:Binding&{sourceInstance:string;sourceVersion:string|null;observedAt:string;rowid:number|string}):{id:string;inserted:number} {
 if(!LEGACY_TABLES.includes(table)||!o.sourceInstance||o.sourceInstance.length>512)throw Error('Original provenance required');
 const raw=encodeOriginal(row),originalDigest=digest(raw),keys=keyColumns[table]??['id'];
 const originalId=keys.every(k=>row[k]!==undefined)?(keys.length===1?String(row[keys[0]!]):stable(keys.map(k=>String(row[k])))):stable({rowid:o.rowid});
 const id=digest({table,originalId,sourceInstance:o.sourceInstance,sourceVersion:o.sourceVersion,originalDigest,format:1});
 const old=db.prepare('SELECT raw_row,original_digest FROM canonical_original_archive WHERE id=?').get(id);
 if(old){if(old.raw_row!==raw||old.original_digest!==originalDigest)throw Error('Immutable original archive conflict');}
 else db.prepare('INSERT INTO canonical_original_archive VALUES(?,?,?,?,?,?,1,?)').run(id,table,originalId,o.sourceInstance,o.sourceVersion,originalDigest,raw);
 const model=new CanonicalModel(db),observationId=digest({archiveId:id});let inserted=0;
 if(!model.observation(observationId)){
 const payload=projection(table,row,originalDigest);
 model.observe({id:observationId,nodeId:o.nodeId,network:o.network,kind:table,meaning:meanings[table]??'historical_evidence',source:'legacy:'+table,sourceVersion:o.sourceVersion,sourceInstance:o.sourceInstance,originalId,batchId:'archive:'+id,occurredAt:utc(row.occurred_at)??utc(row.at)??utc(row.start),observedAt:o.observedAt,granularity:'original record',calculationVersion:row.version===undefined?null:String(row.version),sourceChannel:channel(row.source),targetChannel:channel(row.target),amountMsat:row.amount_msat??null,feeMsat:row.fee_msat??null,endpointScope:['aggregates','expired_intervals'].includes(table)?'aggregate':'single_effect',originalDigest,payload});inserted=1;
 }
 model.link({observationId,referenceTable:'canonical_original_archive',referenceId:id,relation:table==='ledger'?'booked_receipt':'original',method:'typed-original-archive-v1',details:{originalTable:table,originalDigest,financialAuthorityUnchanged:true}});
 return {id,inserted};
}

/** Invoked within the existing storage migration transaction/fence: immutable initial values, bounded memory, atomic rollback. */
export function freezeMigrationOriginals(db:DatabaseSync,deadlineMs:number){
 if(!db.isTransaction||!Number.isSafeInteger(deadlineMs)||deadlineMs<1||deadlineMs>30000)throw Error('Fenced bounded original freeze required');
 const deadline=Date.now()+deadlineMs,model=new CanonicalModel(db),observedAt=new Date().toISOString();
 for(const table of LEGACY_TABLES){let cursor:string|null=null,scannedRows=0;const high=db.prepare(`SELECT coalesce(max(rowid),0) n FROM ${table}`);high.setReadBigInts(true);const upperBound=String(high.get()!.n);let scanDigest=digest({table,cycle:0,upperBound});
  while(true){if(Date.now()>deadline)throw Error('Original storage freeze deadline exceeded');const rows=boundedOriginalRows(db,table,cursor===null?'rowid>=? AND rowid<=?':'rowid>? AND rowid<=?',[cursor===null?-9223372036854775808n:BigInt(cursor),BigInt(upperBound)],'rowid',100,16777216);
   for(const raw of rows){if(Date.now()>deadline)throw Error('Original storage freeze deadline exceeded');const {__canonical_rowid__,...row}=raw;cursor=String(__canonical_rowid__);const rowDigest=digest(encodeOriginal(row));scanDigest=digest({previous:scanDigest,rowid:cursor,rowDigest});scannedRows++;archiveOriginal(db,table,row,{nodeId:null,network:null,sourceInstance:'satssurge-schema6-migration-originals',sourceVersion:'schema6',observedAt,rowid:cursor});}
   if(rows.length<100||cursor!==null&&BigInt(cursor)>=BigInt(upperBound))break;
  }
  model.appendCoverage({nodeId:null,network:null,capability:'migration_original_freeze',scope:table,source:'satssurge-schema6-migration-originals',epoch:'schema6-to7',start:observedAt,end:observedAt,observedAt,status:'checkpoint',details:{table,cursor,upperBound,scannedRows,scanDigest,frozenHighWaterComplete:true,contentsFrozenInMigrationTransaction:true,sourceMutationTimeKnown:false}});
 }
}
