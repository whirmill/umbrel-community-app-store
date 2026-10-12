// TEST ONLY: exact isolated DDL/guards/validator from preparation f946b0dd; no production migration activation.
import {channelScid} from '../diagnostics.js';
import type {DatabaseSync} from 'node:sqlite';
import {CANONICAL_SCHEMA,CanonicalModel,digest,stable,type Binding,type Meaning} from '../canonical-model.js';

const ddl=`
CREATE TABLE canonical_original_archive(id TEXT PRIMARY KEY NOT NULL,original_table TEXT NOT NULL CHECK(original_table IN ('events','evidence','claims','snapshots','ledger','decisions','operations','reservations','evaluations','evaluation_windows','aggregates','coverage','benefit_claims','ledger_annotations','expired_intervals','expired_events','channel_holds','strategies')),original_id TEXT NOT NULL,source_instance TEXT NOT NULL,source_version TEXT,original_digest TEXT NOT NULL,format_version INTEGER NOT NULL CHECK(format_version=1),raw_row TEXT NOT NULL,UNIQUE(original_table,original_id,source_instance,source_version,original_digest)) STRICT;
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
export function migrateCanonical(db:DatabaseSync,options:{beforeCommit?:()=>void}={}):void {
 const version=Number(db.prepare('PRAGMA user_version').get()?.user_version);
 if(version>CANONICAL_SCHEMA)throw Error('Database is newer than canonical software');
 db.exec('PRAGMA foreign_keys=ON');if(Number(db.prepare('PRAGMA foreign_keys').get()?.foreign_keys)!==1)throw Error('Canonical migration requires foreign keys outside any active transaction');
 if(version===CANONICAL_SCHEMA){validateCanonical(db);return;}
 if(version!==6)throw Error('Canonical migration requires schema 6');
 db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
 try{db.exec(ddl);for(const [table,sql] of Object.entries(retentionIndexes))if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))db.exec(sql);for(const table of tables)for(const action of ['insert','update','delete'] as const)db.exec(guardDDL(table,action));
 if((db.prepare('PRAGMA quick_check').get() as any).quick_check!=='ok'||db.prepare('PRAGMA foreign_key_check').all().length)throw Error('Canonical migration integrity check failed');options.beforeCommit?.();db.exec('PRAGMA user_version=7; COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
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
