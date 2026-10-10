import {channelScid} from './diagnostics.js';
import {accountingPartition} from './accounting.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { id, now, json, hash, integer, day, MANDATE, SCHEMA_VERSION, type Snapshot, type Proposal, type Forecast } from './domain.js';

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    const previousSchema=Number(this.db.prepare('PRAGMA user_version').get()?.user_version);
    if(Number(this.db.prepare('PRAGMA user_version').get()?.user_version)>SCHEMA_VERSION)throw new Error('Database is newer than this software; rollback refused');
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS evidence(id TEXT PRIMARY KEY, acquired_at TEXT NOT NULL, source TEXT NOT NULL, digest TEXT NOT NULL, content TEXT NOT NULL, type TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS claims(id TEXT PRIMARY KEY, at TEXT NOT NULL, content TEXT NOT NULL, evidence_id TEXT REFERENCES evidence(id), status TEXT NOT NULL, supersedes TEXT);
      CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, occurred_at TEXT NOT NULL, acquired_at TEXT NOT NULL, type TEXT NOT NULL, source TEXT NOT NULL, target TEXT NOT NULL, amount_msat TEXT NOT NULL, fee_msat TEXT NOT NULL, details TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS events_time ON events(occurred_at);
      CREATE TABLE IF NOT EXISTS coverage(id TEXT PRIMARY KEY, start TEXT NOT NULL, end TEXT NOT NULL, kind TEXT NOT NULL, complete INTEGER NOT NULL, details TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshots(id TEXT PRIMARY KEY, at TEXT NOT NULL, content TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS ledger(id TEXT PRIMARY KEY, at TEXT NOT NULL, classification TEXT NOT NULL, amount_msat TEXT NOT NULL, category TEXT NOT NULL, operation_id TEXT, evidence_id TEXT, details TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS decisions(id TEXT PRIMARY KEY, at TEXT NOT NULL, proposal TEXT NOT NULL, forecast TEXT NOT NULL, mandate TEXT NOT NULL, status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, decision_id TEXT NOT NULL REFERENCES decisions(id), at TEXT NOT NULL, state TEXT NOT NULL, payment_hash TEXT UNIQUE, invoice TEXT, details TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reservations(operation_id TEXT PRIMARY KEY REFERENCES operations(id), at TEXT NOT NULL, fee_msat TEXT NOT NULL, amount_sat TEXT NOT NULL, category TEXT NOT NULL, source TEXT NOT NULL, target TEXT NOT NULL, demand_key TEXT NOT NULL, active INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS evaluations(id TEXT PRIMARY KEY, decision_id TEXT NOT NULL UNIQUE REFERENCES decisions(id), at TEXT NOT NULL, status TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS strategies(key TEXT PRIMARY KEY, status TEXT NOT NULL, fingerprint TEXT NOT NULL, reason TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS channel_holds(channel_id TEXT PRIMARY KEY, at TEXT NOT NULL, reason TEXT NOT NULL, snapshot_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS expired_events(id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS aggregates(day TEXT PRIMARY KEY, content TEXT NOT NULL, version INTEGER NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS evidence_search USING fts5(evidence_id UNINDEXED, content);

    `);
    this.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS jobs(
        id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, lane TEXT NOT NULL,
        priority INTEGER NOT NULL, payload TEXT NOT NULL, payload_digest TEXT NOT NULL,
        scope TEXT NOT NULL, snapshot_at TEXT, state TEXT NOT NULL, created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, lease_owner TEXT,
        lease_until TEXT, run_token TEXT, attempts INTEGER NOT NULL DEFAULT 0,
        result TEXT, error TEXT, wait_reason TEXT, coalesce_key TEXT, conversation_id TEXT,
        submitted INTEGER NOT NULL DEFAULT 0, submission_id TEXT
      );
      CREATE INDEX IF NOT EXISTS jobs_dispatch ON jobs(lane,state,priority,created_at);
      DROP INDEX IF EXISTS jobs_coalesce;
      CREATE UNIQUE INDEX jobs_coalesce ON jobs(coalesce_key) WHERE coalesce_key IS NOT NULL AND (state='queued' OR (state='waiting' AND submitted=0));
      CREATE TABLE IF NOT EXISTS job_events(id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), at TEXT NOT NULL, type TEXT NOT NULL, details TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS evaluation_windows(
        id TEXT PRIMARY KEY, decision_id TEXT NOT NULL REFERENCES decisions(id), horizon_days INTEGER NOT NULL,
        revision INTEGER NOT NULL, at TEXT NOT NULL, status TEXT NOT NULL, result TEXT NOT NULL,
        UNIQUE(decision_id,horizon_days,revision)
      );
      CREATE TABLE IF NOT EXISTS benefit_claims(
        operation_id TEXT PRIMARY KEY REFERENCES operations(id),source TEXT NOT NULL,target TEXT NOT NULL,
        at TEXT NOT NULL,until_at TEXT NOT NULL,volume_msat TEXT NOT NULL,benefit_msat TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ui_events(id INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT NOT NULL REFERENCES jobs(id),at TEXT NOT NULL,type TEXT NOT NULL,data TEXT NOT NULL,event_key TEXT,UNIQUE(job_id,event_key));
      CREATE TABLE IF NOT EXISTS ui_messages(job_id TEXT NOT NULL REFERENCES jobs(id),entry_id INTEGER NOT NULL,text TEXT NOT NULL,PRIMARY KEY(job_id,entry_id));
      CREATE TABLE IF NOT EXISTS event_ingestion(sequence INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT UNIQUE NOT NULL,type TEXT NOT NULL,source TEXT NOT NULL,target TEXT NOT NULL,baseline INTEGER NOT NULL DEFAULT 0);
      INSERT OR IGNORE INTO event_ingestion(event_id,type,source,target,baseline) SELECT id,type,source,target,1 FROM events ORDER BY acquired_at,id;
      CREATE INDEX IF NOT EXISTS event_ingestion_signal ON event_ingestion(type,baseline,sequence,source,target);
      CREATE TRIGGER IF NOT EXISTS ingest_event AFTER INSERT ON events BEGIN
        INSERT INTO event_ingestion(event_id,type,source,target,baseline) VALUES(new.id,new.type,new.source,new.target,COALESCE(json_extract(new.details,'$.ingestionBaseline'),0));
      END;
      CREATE TABLE IF NOT EXISTS automatic_scopes(scope TEXT PRIMARY KEY,generation INTEGER NOT NULL DEFAULT 0,job_id TEXT,forward_sequence INTEGER NOT NULL DEFAULT 0,material_sequence INTEGER NOT NULL DEFAULT 0,blocker_digest TEXT,due_consumed TEXT,trigger_consumed TEXT);
      CREATE TABLE IF NOT EXISTS automatic_admissions(scope TEXT NOT NULL,generation INTEGER NOT NULL,job_id TEXT NOT NULL,at TEXT NOT NULL,PRIMARY KEY(scope,generation));
      CREATE TABLE IF NOT EXISTS ledger_annotations(ledger_id TEXT NOT NULL REFERENCES ledger(id),version INTEGER NOT NULL,sector TEXT NOT NULL,attribution TEXT NOT NULL,reason TEXT NOT NULL,PRIMARY KEY(ledger_id,version));
      CREATE TABLE IF NOT EXISTS expired_intervals(start TEXT NOT NULL,end TEXT NOT NULL,type TEXT NOT NULL,source TEXT NOT NULL,target TEXT NOT NULL,count INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS owner_proposals(id TEXT PRIMARY KEY,created_at TEXT NOT NULL,content TEXT NOT NULL,content_digest TEXT NOT NULL,state_digest TEXT NOT NULL,status TEXT NOT NULL,expires_at TEXT,operation_id TEXT,intent_at TEXT,result TEXT,job_id TEXT);
      CREATE TABLE IF NOT EXISTS telegram_updates(update_id INTEGER PRIMARY KEY,body TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',error TEXT);
      CREATE TABLE IF NOT EXISTS telegram_outbox(event_id TEXT PRIMARY KEY,created_at TEXT NOT NULL,kind TEXT NOT NULL,text TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_at TEXT,proposal_id TEXT,message_id INTEGER,error TEXT,generation TEXT);
      PRAGMA user_version=6;
      COMMIT;`);
    if(!this.get('schema5AdmissionAdopted'))this.tx(()=>{
      for(const job of this.all("SELECT j.* FROM jobs j JOIN job_events e ON e.job_id=j.id AND e.type='accepted' WHERE json_extract(e.details,'$.origin')='scheduler' ORDER BY j.rowid")){
        let scope='node';try{if(job.lane==='analyst')scope=job.scope.split('->').map(channelScid).join('->');}catch{continue;}
        this.run('INSERT OR IGNORE INTO automatic_scopes(scope) VALUES(?)',scope);
        const generation=this.one('SELECT generation FROM automatic_scopes WHERE scope=?',scope).generation+1;
        this.run('INSERT OR IGNORE INTO automatic_admissions VALUES(?,?,?,?)',scope,generation,job.id,job.created_at);
        this.run('UPDATE automatic_scopes SET generation=?,job_id=?,forward_sequence=(SELECT COALESCE(max(sequence),0) FROM event_ingestion),material_sequence=(SELECT COALESCE(max(sequence),0) FROM event_ingestion),blocker_digest=? WHERE scope=?',generation,job.id,hash(json(this.get('blockers')??[])),scope);
        this.set('automaticOwnership:'+job.id,{scope,generation});
      }
      for(const job of this.all('SELECT id,lane FROM jobs'))if(!this.get('jobCapability:'+job.id))this.set('jobCapability:'+job.id,job.lane==='analyst'?'read_only_research':'financial_guarded');
      this.set('schema5AdmissionAdopted',true);
      for(const row of this.all("SELECT key,value FROM meta WHERE key LIKE 'reviewWait:%'")){
        const wait=JSON.parse(row.value);try{const scope=wait.scope==='node'?'node':wait.scope.split('->').map(channelScid).join('->');if(scope!==wait.scope){this.run('DELETE FROM meta WHERE key=?',row.key);this.set('reviewWait:'+hash(scope),{...wait,scope});}}catch{}
      }
    });
    this.tx(()=>{
      for(const row of this.all("SELECT r.*,d.forecast FROM reservations r JOIN operations o ON o.id=r.operation_id JOIN decisions d ON d.id=o.decision_id WHERE r.category='ordinary' AND o.state<>'FAILED' AND NOT EXISTS (SELECT 1 FROM benefit_claims b WHERE b.operation_id=r.operation_id)")){
        this.run('INSERT INTO benefit_claims VALUES(?,?,?,?,?,?,?)',row.operation_id,row.source,row.target,row.at,new Date(Date.parse(row.at)+30*86400000).toISOString(),(integer(row.amount_sat)*1000n).toString(),integer(JSON.parse(row.forecast).benefitMsat).toString());
      }
    });
    if (path !== ':memory:') chmodSync(path, 0o600);
    if (!this.get('mandate')) this.set('mandate', MANDATE);
    if (this.get('enabled')===undefined) this.set('enabled', true);
  }
  all(sql: string, ...args: any[]): any[] { return this.db.prepare(sql).all(...args) as any[]; }
  one(sql: string, ...args: any[]): any { return this.db.prepare(sql).get(...args); }
  run(sql: string, ...args: any[]) { return this.db.prepare(sql).run(...args); }
  get<T = any>(key: string): T | undefined { const row=this.one('SELECT value FROM meta WHERE key=?',key); return row ? JSON.parse(row.value) as T : undefined; }
  set(key: string, value: unknown) { this.run('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',key,json(value)); }
  private commitCallbacks: Set<() => void> | undefined;
  afterCommit(callback: () => void) {
    if (this.commitCallbacks) this.commitCallbacks.add(callback);
    else { try { callback(); } catch {} }
  }
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    this.commitCallbacks = new Set();
    let result: T;
    try { result=fn(); this.db.exec('COMMIT'); } catch(e) { this.commitCallbacks=undefined; this.db.exec('ROLLBACK'); throw e; }
    const callbacks=this.commitCallbacks; this.commitCallbacks=undefined;
    // A notification failure cannot turn a committed action into a retry.
    for(const callback of callbacks) { try { callback(); } catch {} }
    return result;
  }
  ledger(entry: {id:string; at:string; classification:string; amountMsat:string; category?:string; operationId?:string; evidenceId?:string; details?:unknown}) {
    integer(entry.amountMsat);
    const old=this.one('SELECT amount_msat,classification FROM ledger WHERE id=?',entry.id);
    if(old && (old.amount_msat!==entry.amountMsat || old.classification!==entry.classification)) throw new Error('Ledger conflict; explicit correction required');
    this.run('INSERT OR IGNORE INTO ledger VALUES(?,?,?,?,?,?,?,?)',entry.id,entry.at,entry.classification,entry.amountMsat,entry.category??'historical',entry.operationId??null,entry.evidenceId??null,json(entry.details??{}));
  }
  evidence(source:string, content:string, type='document', at=now()) {
    const digest=hash(content), key=hash(source+':'+digest);
    if(!this.one('SELECT id FROM evidence WHERE id=?',key)) {
      this.run('INSERT INTO evidence VALUES(?,?,?,?,?,?)',key,at,source,digest,content,type);
      this.run('INSERT INTO evidence_search VALUES(?,?)',key,content);
    }
    return key;
  }
  event(row:{id:string;at:string;type:string;source:string;target:string;amountMsat:string;feeMsat:string;details?:unknown;pinned?:boolean;baseline?:boolean}) {
    integer(row.amountMsat);integer(row.feeMsat);
    if(this.one('SELECT id FROM expired_events WHERE id=?',row.id))return;
    this.run('INSERT OR IGNORE INTO events VALUES(?,?,?,?,?,?,?,?,?,?)',row.id,row.at,now(),row.type,row.source,row.target,row.amountMsat,row.feeMsat,json({...row.details as object,ingestionBaseline:row.baseline===true}),row.pinned?1:0);

  }
  saveSnapshot(s:Snapshot) { this.run('INSERT INTO snapshots VALUES(?,?,?)',id(),s.at,json(s)); this.set('snapshot',s); }
  budget(at=now()) {
    const costs=this.all("SELECT amount_msat,at,category FROM ledger WHERE classification='expense'");
    const reservations=this.all('SELECT * FROM reservations WHERE active=1');
    const sum=(rows:any[],field:string) => rows.reduce((s,r)=>s+integer(r[field]),0n);
    const cumulative=sum(costs,'amount_msat')+sum(reservations,'fee_msat');
    // Pending operations spanning midnight count on every current day until terminal.
    const daily=sum(costs.filter(r=>day(r.at)===day(at) && ['ordinary','exploratory','manual_rebalance'].includes(r.category)),'amount_msat')+sum(reservations,'fee_msat');
    const exploratory=sum(costs.filter(r=>day(r.at)===day(at) && r.category==='exploratory'),'amount_msat')+sum(reservations.filter(r=>r.category==='exploratory'),'fee_msat');
    return { cumulativeMsat:cumulative.toString(), dailyMsat:daily.toString(), exploratoryMsat:exploratory.toString(), remainingMsat:(integer(MANDATE.totalMsat)-cumulative).toString(), coverageComplete:this.get('historicalCoverageComplete')===true };
  }
  assertDispatchReady(at=now()) {
    if(this.get('maintenanceClaim'))throw new Error('Financial execution suspended for maintenance');
    if(this.get('integrityBlocker'))throw new Error('Financial integrity review required');
    if(this.get('enabled')!==true)throw new Error('Autonomy paused');
    const proof=this.get('automationProof'),time=Date.parse(proof?.at??''),current=Date.parse(at);
    if(this.get('bootstrapReady')!==true || proof?.ok!==true || !Number.isFinite(time) || time>current || current-time>90000)throw new Error('Bootstrap/interlock not ready');
  }
  assertReservedDispatch(operation:string,s:Snapshot,at=now()) {
    this.assertDispatchReady(at);
    if(!this.one('SELECT operation_id FROM reservations WHERE operation_id=? AND active=1',operation))throw new Error('Reservation unavailable');
    if(!s.synced || !Number.isFinite(Date.parse(s.at)) || Date.parse(s.at)>Date.parse(at) || Date.parse(at)-Date.parse(s.at)>60000)throw new Error('Stale/unsynchronized state');
    if(integer(s.confirmedSat)<integer(MANDATE.reserveSat)+integer(this.get('pendingOnchainObligationsSat')??'0'))throw new Error('Protected on-chain reserve');
    // budget includes this active reservation exactly once, including across midnight.
    const b=this.budget(at);
    if(integer(b.cumulativeMsat)>integer(MANDATE.totalMsat)||integer(b.dailyMsat)>integer(MANDATE.dailyMsat))throw new Error('Expense budget exhausted');
    if(integer(b.exploratoryMsat)>integer(MANDATE.exploratoryDailyMsat))throw new Error('Exploration budget exhausted');
  }
  reserve(p:Proposal, f:Forecast, s:Snapshot, at=now(),onReserved?:(operation:string)=>void,previewOnly=false) {
    const validateAndReserve=()=>{
      if(this.get('expectedIdentity') && s.identity!==this.get('expectedIdentity'))throw new Error('Node identity mismatch');
      this.assertDispatchReady(at);
      if(!Number.isFinite(Date.parse(s.at)) || Date.parse(at)-Date.parse(s.at)>60_000 || Date.parse(s.at)>Date.parse(at) || !s.synced) throw new Error('Stale/unsynchronized state');
      if(this.one("SELECT id FROM operations WHERE state IN ('reserved','preparing','sending','uncertain','in_flight')")) throw new Error('Executor occupied or uncertain outcome');
      if(integer(s.confirmedSat)<integer(MANDATE.reserveSat)+integer(this.get('pendingOnchainObligationsSat')??'0')) throw new Error('Protected on-chain reserve');
      for(const c of [p.source,p.target].filter(Boolean)) if(this.one('SELECT channel_id FROM channel_holds WHERE channel_id=?',c)) throw new Error('Manual intervention under reconciliation');
      if(!MANDATE.allowed.includes(p.kind) || !['ordinary','exploratory'].includes(p.category)) throw new Error('Unsupported operation');
      if(!p.strategy || !p.problem || !p.evidence || !p.whyAct || !p.alternatives || !p.verify || !p.hypothesis || !p.demandKey) throw new Error('Incomplete decision');
      if(!p.evidenceIds.length || p.evidenceIds.some(e=>!this.one('SELECT id FROM evidence WHERE id=?',e) && !this.one('SELECT id FROM events WHERE id=?',e))) throw new Error('Unverified evidence references');
      const fingerprint=hash(json(p.evidenceIds.slice().sort()));
      const previousAttempts=this.all("SELECT d.id,d.proposal,o.state FROM decisions d JOIN operations o ON o.decision_id=d.id WHERE json_extract(d.proposal,'$.demandKey')=?",p.demandKey).filter(r=>hash(json((JSON.parse(r.proposal).evidenceIds as string[]).slice().sort()))===fingerprint);
      const spent=previousAttempts.reduce<bigint>((n,r)=>n+this.all("SELECT amount_msat FROM ledger WHERE operation_id IN (SELECT id FROM operations WHERE decision_id=?) AND classification='expense'",r.id).reduce<bigint>((a,x)=>a+integer(x.amount_msat),0n),0n);
      const originalCap=previousAttempts.length?integer(JSON.parse(previousAttempts[0].proposal).decisionCapMsat):integer(p.decisionCapMsat);
      if(previousAttempts.length>=MANDATE.maxAttempts || spent+integer(p.maxFeeMsat)>originalCap)throw new Error('Aggregate decision attempt/cost limit');
      if(previousAttempts.some(r=>r.state==='SUCCEEDED'))throw new Error('Exploration evidence already used');
      const strategy=this.one('SELECT * FROM strategies WHERE key=?',p.demandKey);
      if(strategy?.status==='suspended' && strategy.fingerprint===fingerprint) throw new Error('Negative strategy needs new evidence');
      if(this.one('SELECT operation_id FROM reservations WHERE active=1 AND demand_key=?',p.demandKey)) throw new Error('Benefit already committed');
      if(this.one("SELECT r.operation_id FROM reservations r JOIN decisions d ON d.id=(SELECT decision_id FROM operations WHERE id=r.operation_id) WHERE r.demand_key=? AND d.status='observing'",p.demandKey)) throw new Error('Corridor experiment already observing');
      const cap=integer(p.maxFeeMsat), decisionCap=integer(p.decisionCapMsat);
      if(cap>integer(MANDATE.attemptMsat) || cap>decisionCap) throw new Error('Fee cap exceeds attempt/decision limit');
      const b=this.budget(at);
      if(integer(b.cumulativeMsat)+cap>integer(MANDATE.totalMsat) || integer(b.dailyMsat)+cap>integer(MANDATE.dailyMsat)) throw new Error('Expense budget exhausted');
      if(p.category==='exploratory' && integer(b.exploratoryMsat)+cap>integer(MANDATE.exploratoryDailyMsat)) throw new Error('Exploration budget exhausted');
      if(p.category==='ordinary'){
        const uncommitted=this.uncommittedDemand(p.source,p.target,f.rawRequestedMsat??f.requestedMsat,at);
        if(uncommitted!==f.requestedMsat)throw new Error('Forecast stale: future demand already allocated; recompute');
      }
      if(p.category==='ordinary' && (!f.eligible || integer(f.benefitMsat)<2n*cap)) throw new Error('Insufficient independently computed benefit');
      const target=s.channels.find(c=>c.id===p.target);
      if(!target?.active) throw new Error('Target channel unavailable');
      if(p.kind==='rebalance') {
        if(s.channels.filter(c=>c.peer===target.peer).length!==1)throw new Error('Parallel target channels require exact-channel routing support');
        const source=s.channels.find(c=>c.id===p.source), amount=integer(p.amountSat);
        if(!source?.active || p.source===p.target || amount===0n) throw new Error('Invalid rebalance endpoints');
        if(amount+(cap+999n)/1000n>integer(source.localSat)-integer(source.reserveSat)-integer(source.pendingSat)) throw new Error('Source liquidity/reserve');
        if(amount>integer(target.remoteSat) || amount*1000n>integer(target.maxMsat) || amount*1000n<integer(target.minMsat)) throw new Error('Target capacity/HTLC limit');
        if(source.pendingSat!=='0' || target.pendingSat!=='0') throw new Error('HTLC pending; observe instead');
        if(p.category==='ordinary' && amount*1000n>integer(f.requestedMsat)) throw new Error('Amount exceeds conservative demand');
      } else {
        if(p.category!=='exploratory')throw new Error('Pricing changes require explicit experiment');
        if(cap!==0n || p.amountSat!=='0' || !Number.isInteger(p.newPpm) || p.newPpm!<0 || p.newPpm!>100000) throw new Error('Invalid fee proposal');
        const step=Math.max(5,Math.ceil(target.ppm*0.2));
        if(p.newPpm===target.ppm || Math.abs(p.newPpm!-target.ppm)>step) throw new Error('Fee step exceeds 20%/5ppm');
        const last=this.all("SELECT d.at,d.proposal FROM decisions d WHERE json_extract(d.proposal,'$.kind')='fee_change' AND json_extract(d.proposal,'$.target')=? ORDER BY d.at DESC LIMIT 1",p.target)[0];
        if(last && Date.parse(at)-Date.parse(last.at)<48*3600_000) throw new Error('Fee observation window');
      }
      // Read-only preview uses exactly the execution policy, without creating intent.
      if(previewOnly)return {decision:'',operation:''};
      const decision=id(), operation=id();
      this.run('INSERT INTO decisions VALUES(?,?,?,?,?,?)',decision,at,json(p),json(f),json(MANDATE),'planned');
      this.run('INSERT INTO operations VALUES(?,?,?,?,?,?,?)',operation,decision,at,'reserved',null,null,json({snapshot:s}));
      this.run('INSERT INTO reservations VALUES(?,?,?,?,?,?,?,?,?)',operation,at,cap.toString(),p.amountSat,p.category,p.source,p.target,p.demandKey,1);
      if(p.category==='ordinary')this.run('INSERT INTO benefit_claims VALUES(?,?,?,?,?,?,?)',operation,p.source,p.target,at,new Date(Date.parse(at)+30*86400000).toISOString(),(integer(p.amountSat)*1000n).toString(),f.benefitMsat);
      onReserved?.(operation);
      return {decision,operation};
    };
    return previewOnly?validateAndReserve():this.tx(validateAndReserve);
  }
  uncommittedDemand(source:string,target:string,rawDemand:string,at=now(),excludeOperation?:string) {
    let claimed=0n;
    const claims=this.all("SELECT b.*,o.state,COALESCE(json_extract(o.details,'$.completedAt'),(SELECT max(l.at) FROM ledger l WHERE l.operation_id=o.id AND l.classification='expense'),b.at) effective_at FROM benefit_claims b JOIN operations o ON o.id=b.operation_id WHERE b.at<=? AND o.state<>'FAILED'",at).map(r=>({...r,at:r.effective_at,until_at:new Date(Date.parse(r.effective_at)+30*86400000).toISOString()})).sort((a,b)=>a.at.localeCompare(b.at)||a.operation_id.localeCompare(b.operation_id));
    const remaining=new Map<string,bigint>(claims.map(r=>[r.operation_id,integer(r.volume_msat)]));
    const earliest=claims[0]?.at;
    if(earliest)for(const event of this.all("SELECT source,target,occurred_at,amount_msat FROM events WHERE type='external_forward' AND occurred_at>=? AND occurred_at<? ORDER BY occurred_at,id",earliest,at)){
      let amount=integer(event.amount_msat);
      // Allocate each observed msat once, FIFO. Two forecasts may not both consume the same return.
      for(const row of claims){
        if(row.state!=='SUCCEEDED'||row.source!==event.source||row.target!==event.target||row.at>event.occurred_at||row.until_at<=event.occurred_at)continue;
        const left=remaining.get(row.operation_id)!,used=left<amount?left:amount;remaining.set(row.operation_id,left-used);amount-=used;if(amount===0n)break;
      }
    }
    for(const row of claims)if(row.operation_id!==excludeOperation&&row.until_at>at&&(row.target===target||row.source===source))claimed+=remaining.get(row.operation_id)!;
    const demand=integer(rawDemand);return (demand>claimed?demand-claimed:0n).toString();
  }
  annotateLedger(ledgerId:string,sector:'routing'|'swap'|'other'|'unknown',attribution:'verified'|'shared'|'unattributed',reason:string) {
    if(!reason.trim()||!['routing','swap','other','unknown'].includes(sector)||!['verified','shared','unattributed'].includes(attribution))throw Error('Explicit classification receipt required');
    return this.tx(()=>{const version=(this.one('SELECT max(version) version FROM ledger_annotations WHERE ledger_id=?',ledgerId)?.version??0)+1;this.run('INSERT INTO ledger_annotations VALUES(?,?,?,?,?)',ledgerId,version,sector,attribution,reason);return version;});
  }
  stats() {
    const ledger=this.all('SELECT * FROM ledger ORDER BY at');
    const since=new Date(Date.now()-30*86400_000).toISOString();
    const sums=(rows:any[])=>{
      let revenue=0n,cost=0n; for(const r of rows){ if(r.classification==='expense')cost+=integer(r.amount_msat); if(r.classification==='revenue')revenue+=integer(r.amount_msat); }
      return {revenueMsat:revenue.toString(),costMsat:cost.toString(),netMsat:(revenue-cost).toString()};
    };
    return {enabled:this.get('enabled'),bootstrapReady:this.get('bootstrapReady')??false,blockers:this.get('blockers')??[],mandate:MANDATE,budget:this.budget(),snapshot:this.get('snapshot')??null,
      diagnostics:this.get('diagnostics')??null,competition:this.get('competition')??null,pnl30:sums(ledger.filter(r=>r.at>=since)),cumulative:sums(ledger),partial:this.get('historicalCoverageComplete')!==true || !ledger.some(r=>r.classification==='expense'&&JSON.parse(r.details).scope==='subscription') || accountingPartition(ledger,this.all('SELECT * FROM ledger_annotations')).unassignedCosts,
      accounting:accountingPartition(ledger,this.all('SELECT * FROM ledger_annotations')),
      accounting30:accountingPartition(ledger.filter(r=>r.at>=since),this.all('SELECT * FROM ledger_annotations')),
      operations:this.all('SELECT id,decision_id,at,state,payment_hash,details FROM operations ORDER BY at DESC LIMIT 50'),
      decisions:this.all('SELECT * FROM decisions ORDER BY at DESC LIMIT 50').map(r=>({...r,proposal:JSON.parse(r.proposal),forecast:JSON.parse(r.forecast)})),
      evaluations:this.all('SELECT * FROM evaluations ORDER BY at DESC LIMIT 30'),evaluationWindows:this.all('SELECT * FROM evaluation_windows ORDER BY at DESC LIMIT 60').map(r=>({...r,result:JSON.parse(r.result)})),coverage:this.all('SELECT * FROM coverage ORDER BY end DESC LIMIT 20'),
      claims:this.all('SELECT * FROM claims ORDER BY at DESC LIMIT 25'), holds:this.all('SELECT * FROM channel_holds'),
      projectionLimits:{operations:50,decisions:50,evaluations:30,evaluationWindows:60,coverage:20,claims:25,upstreamHistoryComplete:false},agent:this.get('agent')??{},importReport:this.get('importReport')??{}, roadmap:['M1–M2.1 · Fondamenti, diagnostica e interfaccia web','M2.2 · Conversazione quotidiana su Telegram','M2.3 · Stabilizzazione del core — in corso','M2.4 · Prompt consultivi sui problemi del runtime — da qualificare','M3 · Raccolta nativa e storico unificato — da qualificare','M4 · Documenti, immagini ed export — da qualificare','M5 · Integrazioni opzionali RoboSats, Amboss e Magma — da qualificare']};
  }
  retain(at=now()) {
    const cutoff=new Date(Date.parse(at)-90*86400_000).toISOString();
    this.tx(()=>{
      const rows=this.all('SELECT * FROM events WHERE occurred_at<? AND pinned=0',cutoff);
      this.run('INSERT INTO expired_intervals SELECT min(occurred_at),max(occurred_at),type,source,target,count(*) FROM events WHERE occurred_at<? AND pinned=0 GROUP BY type,source,target',cutoff);
      const days=new Set(rows.map(r=>r.occurred_at.slice(0,10)));
      for(const d of days){ const events=rows.filter(r=>r.occurred_at.startsWith(d)); const old=this.one('SELECT content FROM aggregates WHERE day=?',d); const agg=old?JSON.parse(old.content):{events:0,amountMsat:'0',feeMsat:'0',detailExpired:true};
        agg.events+=events.length; agg.amountMsat=(integer(agg.amountMsat)+events.reduce((s,r)=>s+integer(r.amount_msat),0n)).toString();agg.feeMsat=(integer(agg.feeMsat)+events.reduce((s,r)=>s+integer(r.fee_msat),0n)).toString();
        this.run('INSERT INTO aggregates VALUES(?,?,1) ON CONFLICT(day) DO UPDATE SET content=excluded.content',d,json(agg)); }
      this.run('INSERT OR IGNORE INTO expired_events SELECT id FROM events WHERE occurred_at<? AND pinned=0',cutoff);
      this.run('DELETE FROM events WHERE occurred_at<? AND pinned=0',cutoff);
      this.run("INSERT INTO expired_intervals SELECT min(at),max(at),'snapshot','','',count(*) FROM snapshots WHERE at<? HAVING count(*)>0",cutoff);
      this.run('DELETE FROM snapshots WHERE at<? AND id NOT IN (SELECT json_extract(details,\'$.snapshotId\') FROM operations WHERE json_extract(details,\'$.snapshotId\') IS NOT NULL)',cutoff);
    });
  }
  close() {this.db.close();}
}
