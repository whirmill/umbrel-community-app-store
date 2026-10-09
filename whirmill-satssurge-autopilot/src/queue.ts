import { Store } from './store.js';
import { id, now, hash, json, scrub } from './domain.js';

export type JobKind='chat'|'autonomy'|'events'|'analysis';
export type JobState='queued'|'running'|'waiting'|'completed'|'failed'|'cancelled';
export interface Job {
  id:string; request_id:string; kind:JobKind; lane:'coordinator'|'analyst'; priority:number;
  payload:string; scope:string; snapshot_at:string|null; state:JobState; created_at:string;
  updated_at:string; started_at:string|null; finished_at:string|null; lease_owner:string|null;
  lease_until:string|null; run_token:string|null; attempts:number; result:string|null;
  error:string|null; wait_reason:string|null; conversation_id:string|null; submitted:number; submission_id:string|null;
}
const pending="('queued','running','waiting')";
const activeFinancial="('reserved','preparing','sending','uncertain','in_flight')";

/** Queue ownership is transactional. Financial intents are owned exclusively by Executor. */
export class Queue {
  constructor(readonly store:Store,readonly maxPending=100){}
  enqueue(input:{requestId:string;kind:JobKind;payload:unknown;scope?:string;coalesceKey?:string},at=now()):Job {
    if(!/^[a-zA-Z0-9:_.-]{1,160}$/.test(input.requestId))throw new Error('Invalid request ID');
    if(!['chat','autonomy','events','analysis'].includes(input.kind))throw new Error('Unknown job kind');
    const payload=json(scrub(input.payload));if(Buffer.byteLength(payload)>16384)throw new Error('Job payload too large');
    const digest=hash(json([input.kind,payload,input.scope??'']));
    return this.store.tx(()=>{
      const old=this.store.one('SELECT * FROM jobs WHERE request_id=?',input.requestId);
      if(old){if(old.payload_digest!==digest)throw new Error('Request ID conflicts with original payload');return old;}
      if(input.coalesceKey){const existing=this.store.one(`SELECT * FROM jobs WHERE coalesce_key=? AND state IN ${pending}`,input.coalesceKey);if(existing)return existing;}
      if(this.store.one(`SELECT count(*) n FROM jobs WHERE state IN ${pending}`).n>=this.maxPending)throw new Error('Queue full; try later with the same request ID');
      const key=id(),lane=input.kind==='analysis'?'analyst':'coordinator';
      const priority=input.kind==='chat'?30:input.kind==='analysis'?20:input.kind==='events'?10:0;
      this.store.run(`INSERT INTO jobs(id,request_id,kind,lane,priority,payload,payload_digest,scope,snapshot_at,state,created_at,updated_at,coalesce_key)
        VALUES(?,?,?,?,?,?,?,?,?,'queued',?,?,?)`,key,input.requestId,input.kind,lane,priority,payload,digest,input.scope??'',this.store.get('snapshot')?.at??null,at,at,input.coalesceKey??null);
      this.event(key,'accepted',{kind:input.kind,lane},at);return this.get(key)!;
    });
  }
  get(key:string):Job|undefined{return this.store.one('SELECT * FROM jobs WHERE id=?',key);}
  list(limit=40){return this.store.all('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?',Math.max(1,Math.min(100,limit)));}
  event(key:string,type:string,details:unknown,at=now()){this.store.run('INSERT INTO job_events VALUES(?,?,?,?,?)',id(),key,at,type,json(scrub(details)));}
  claim(lane:Job['lane'],owner:string,at=now()):Job|undefined {
    return this.store.tx(()=>{
      if(this.store.get('enabled')!==true||!this.store.get('bootstrapReady'))return;
      if(lane==='coordinator' && this.store.one("SELECT id FROM jobs WHERE lane='coordinator' AND state='running'"))return;
      const uncertain=lane==='coordinator'&&!!this.store.one(`SELECT id FROM operations WHERE state IN ${activeFinancial}`);
      if(lane==='analyst'&&this.store.one("SELECT count(*) n FROM jobs WHERE lane='analyst' AND state='running'").n>=2)return;
      // Priority ages: old maintenance jobs eventually outrank newly arrived chats.
      const row=this.store.one(`SELECT * FROM jobs WHERE lane=? AND (state='queued' OR (state='waiting' AND wait_reason='restart_recovery')) ${uncertain?"AND kind='chat'":''}
        ORDER BY priority+CAST((julianday(?)-julianday(created_at))*1440/5 AS INTEGER) DESC,created_at,id LIMIT 1`,lane,at);
      if(!row)return;
      const token=id(),until=new Date(Date.parse(at)+60000).toISOString();
      this.store.run("UPDATE jobs SET state='running',started_at=COALESCE(started_at,?),updated_at=?,lease_owner=?,lease_until=?,run_token=?,attempts=attempts+1,wait_reason=NULL WHERE id=? AND state IN ('queued','waiting')",at,at,owner,until,token,row.id);
      this.event(row.id,'claimed',{owner,token},at);return this.get(row.id);
    });
  }
  renew(key:string,token:string,at=now()) {
    return this.store.run("UPDATE jobs SET lease_until=?,updated_at=? WHERE id=? AND run_token=? AND state='running'",new Date(Date.parse(at)+60000).toISOString(),at,key,token).changes===1;
  }
  finish(key:string,token:string,state:'completed'|'failed',result:unknown,at=now()) {
    return this.store.tx(()=>{
      const row=this.get(key);if(!row||row.state!=='running'||row.run_token!==token)return false;
      this.store.run("UPDATE jobs SET state=?,result=?,error=?,updated_at=?,finished_at=?,lease_owner=NULL,lease_until=NULL,run_token=NULL WHERE id=?",state,state==='completed'?json(scrub(result)):null,state==='failed'?String(result).slice(0,1000):null,at,at,key);
      this.event(key,state,state==='failed'?{error:String(result).slice(0,1000)}:{},at);return true;
    });
  }
  wait(key:string,token:string,reason:string,at=now()) {
    return this.store.tx(()=>{
      const row=this.get(key);if(!row||row.run_token!==token||row.state!=='running')return false;
      this.store.run("UPDATE jobs SET state='waiting',wait_reason=?,updated_at=?,lease_owner=NULL,lease_until=NULL,run_token=NULL WHERE id=?",reason,at,key);this.event(key,'waiting',{reason},at);return true;
    });
  }
  cancel(key:string,at=now()) {
    return this.store.tx(()=>{
      const row=this.get(key);if(!row)return false;
      if(row.state==='running')throw new Error('Running jobs must settle or be aborted through their runner');
      if(row.state==='waiting' && row.submitted)throw new Error('Submitted job requires reconciliation before cancellation');
      if(!['queued','waiting'].includes(row.state))return false;
      this.store.run("UPDATE jobs SET state='cancelled',updated_at=?,finished_at=? WHERE id=?",at,at,key);this.event(key,'cancelled',{},at);return true;
    });
  }
  /** Call ONLY after process flock acquisition: the previous writer is then proven absent. */
  recoverAfterRestart(at=now()) {
    return this.store.tx(()=>{
      for(const row of this.store.all("SELECT * FROM jobs WHERE state='running'")) {
        this.store.run("UPDATE jobs SET state='waiting',wait_reason='restart_recovery',updated_at=?,lease_owner=NULL,lease_until=NULL,run_token=NULL WHERE id=?",at,row.id);
        this.event(row.id,'restart_recovery',{submitted:!!row.submitted},at);
      }
    });
  }
  releaseWaiting(at=now()) {
    return this.store.tx(()=>{
      const uncertain=this.store.one(`SELECT id FROM operations WHERE state IN ${activeFinancial}`);
      for(const row of this.store.all("SELECT * FROM jobs WHERE state='waiting'")) {
        if(uncertain&&row.lane==='coordinator'&&row.kind!=='chat')continue;
        if(row.wait_reason==='restart_recovery'&&row.submitted)continue; // durable runner must recover original submission, never resubmit
        if(!this.store.get('enabled')||!this.store.get('bootstrapReady'))continue;
        if(row.wait_reason==='model_unavailable'&&Date.parse(row.updated_at)>Date.parse(at)-30*60000)continue;
        this.store.run("UPDATE jobs SET state='queued',wait_reason=NULL,updated_at=? WHERE id=?",at,row.id);this.event(row.id,'ready',{},at);
      }
    });
  }
  bindConversation(key:string,token:string,conversation:string) {
    if(this.store.run("UPDATE jobs SET conversation_id=? WHERE id=? AND run_token=? AND state='running'",conversation,key,token).changes!==1)throw new Error('Lost queue ownership');
  }
  markSubmitted(key:string,token:string,submission:string) {
    if(this.store.run("UPDATE jobs SET submitted=1,submission_id=? WHERE id=? AND run_token=? AND state='running'",submission,key,token).changes!==1)throw new Error('Lost queue ownership');
  }
  metrics(at=now()) {
    const rows=this.store.all('SELECT state,count(*) count FROM jobs GROUP BY state');
    const oldest=this.store.one(`SELECT min(created_at) at FROM jobs WHERE state IN ${pending}`)?.at;
    const completed=this.store.one("SELECT count(*) n,avg((julianday(started_at)-julianday(created_at))*86400000) wait_ms,avg((julianday(finished_at)-julianday(started_at))*86400000) run_ms FROM jobs WHERE state IN ('completed','failed')");
    return {states:rows,oldestAgeMs:oldest?Math.max(0,Date.parse(at)-Date.parse(oldest)):0,completed:completed.n,averageWaitMs:completed.wait_ms??null,averageRunMs:completed.run_ms??null,analystLimit:2,maxPending:this.maxPending};
  }
}
