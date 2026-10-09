-- Historical DDL from 50beed67ecfc9a3259173ff622bacea10ba0abfc; generated without private state.

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

    
BEGIN IMMEDIATE;
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
      PRAGMA user_version=4;
      COMMIT;