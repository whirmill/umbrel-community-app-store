import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../store.js';
import { Queue } from '../queue.js';
import { ApplicationControl } from '../application-control.js';
import { Telegram, romeHour, telegramText } from '../telegram.js';
import { Executor } from '../executor.js';
import { now, type Proposal, type Snapshot } from '../domain.js';
const snapshot = (): Snapshot => ({ at: now(), identity: 'self', synced: true, confirmedSat: '500001', channels: ['a', 'b'].map(id => ({ id, point: id + ':0', peer: id, alias: id, active: true, capacitySat: '500000', localSat: '250000', remoteSat: '250000', reserveSat: '5000', pendingSat: '0', baseMsat: '0', ppm: 300, cltv: 80, minMsat: '1', maxMsat: '500000000' })) });
function setup(transport: any = { call: async () => ({ message_id: 1 }) }) { const dir = mkdtempSync(join(tmpdir(), 'telegram-test-')), s = new Store(':memory:'), q = new Queue(s), c = new ApplicationControl(s, q), t = new Telegram(s, c, dir, transport); s.set('telegramConfigured', true); return { s, q, c, t, dir, close: () => { t.stop(); s.close(); rmSync(dir, { recursive: true, force: true }); } }; }
const update = (id: number, text: string, user = 42, type = 'private') => ({ update_id: id, message: { text, from: { id: user, username: 'owner' }, chat: { id: user, type } } });
async function pair(f: ReturnType<typeof setup>, at = now()) { const code = f.t.pairing(at); f.t.ingest([update((f.s.get<number>('telegramCursor') ?? 0) + 1, '/start ' + code.code)]); await f.t.process(at); f.t.confirm(42, at); }
function proposal(s: Store): Proposal { return { kind: 'fee_change', category: 'exploratory', source: '', target: 'b', amountSat: '0', maxFeeMsat: '0', decisionCapMsat: '0', newPpm: 305, strategy: 'trial', demandKey: 'fee:b', evidenceIds: [s.evidence('fixture', 'observed')], problem: 'pricing', evidence: 'observed', whyAct: 'review pricing', alternatives: 'wait', verify: '48h', hypothesis: 'return' }; }
test('pairing hashed one-use expires, rejects groups/wrong account and confirms only web-selected owner', async () => { const f = setup(); const at = now(), code = f.t.pairing(at); assert.ok(!JSON.stringify(f.s.get('telegramPairing')).includes(code.code)); f.t.ingest([update(1, '/start ' + code.code, 42, 'group')]); await f.t.process(at); assert.equal(f.s.get('telegramCandidate'), null); f.t.ingest([update(2, '/start ' + code.code)]); await f.t.process(at); assert.throws(() => f.t.confirm(43, at), /mismatch/); f.t.confirm(42, at); assert.equal(f.t.status().paired, true); f.t.revoke(); assert.equal(f.t.status().paired, false); const expired = f.t.pairing('2020-01-01T00:00:00Z'); f.t.ingest([update(3, '/start ' + expired.code)]); await f.t.process(at); assert.equal(f.s.get('telegramCandidate'), null); f.close(); });
test('token remains private file, redacted from inbound history and projections', async () => { const f = setup(), token = '123456789:abcdefghijklmnopqrstuvwxyzABCDE'; f.t.configure(token); assert.equal(statSync(f.t.tokenPath).mode & 0o777, 0o600); assert.equal(readFileSync(f.t.tokenPath, 'utf8'), token); await pair(f); f.t.ingest([update(3, 'secret ' + token)]); await f.t.process(); assert.ok(!JSON.stringify(f.s.all('SELECT * FROM telegram_updates')).includes(token)); assert.ok(!JSON.stringify(f.s.all('SELECT * FROM jobs')).includes(token)); assert.ok(!JSON.stringify(f.t.status()).includes(token)); assert.match(telegramText(token), /REDACTED/); f.close(); });
test('durable inbound cursor survives processing gap, duplicates create one readonly shared job while paused', async () => { const f = setup(); await pair(f); f.c.pause(); f.t.ingest([update(100, 'Explain status'), update(100, 'Explain status')]); assert.equal(f.s.get('telegramCursor'), 101); assert.equal(f.s.all("SELECT * FROM jobs").length, 0); await f.t.process(); await f.t.process(); assert.equal(f.s.all('SELECT * FROM jobs').length, 1); const job = f.q.claim('coordinator', 'test'); assert.ok(job); assert.equal(f.s.get('jobCapability:' + job.id), 'read_only_chat'); f.t.ingest([update(101, '/pause', 99), update(102, '/resume', 42, 'group')]); await f.t.process(); assert.equal(f.s.get('enabled'), false); f.close(); });
test('revoke invalidates approvals and old pending updates; no backlog sent to replacement binding', async () => { const f = setup(); await pair(f); f.t.ingest([update(3, 'old request')]); f.t.enqueue('old', 'old reply'); f.t.revoke(); await pair(f); await f.t.process(); assert.equal(f.s.all('SELECT * FROM jobs').length, 0); assert.equal(f.s.one("SELECT status FROM telegram_outbox WHERE event_id='old'").status, 'cancelled'); f.close(); });
test('resume explicit confirmation checks fresh snapshot, proof, integrity and maintenance', () => { const f = setup(); f.c.pause(); f.s.set('bootstrapReady', true); f.s.set('automationProof', { ok: true, at: now() }); f.s.saveSnapshot(snapshot()); let summary = f.c.resumeSummary(); f.s.set('maintenanceClaim', { owner: 'test' }); assert.throws(() => f.c.resume(summary.code), /maintenance/); assert.equal(f.s.get('enabled'), false); f.s.set('maintenanceClaim', null); f.c.resume(summary.code); assert.throws(() => f.c.resume(summary.code), /expired/); f.close(); });
test('proposal double-click cross-surface consumes once; operation correlation precedes effect', async () => { const f = setup(); f.s.set('bootstrapReady', true); f.s.set('automationProof', { ok: true, at: now() }); f.s.saveSnapshot(snapshot()); let sends = 0; const node: any = { snapshot: async () => snapshot(), updateFee: async () => { sends++; assert.ok(f.s.one('SELECT operation_id FROM owner_proposals').operation_id); }, }; let current = snapshot(); node.snapshot = async () => ({ ...current, at: now() }); node.updateFee = async () => { sends++; assert.ok(f.s.one('SELECT operation_id FROM owner_proposals').operation_id); current.channels[1]!.ppm = 305; }; const c = new ApplicationControl(f.s, f.q, new Executor(f.s, node)), job = c.admit('manual', 'Create a proposal for review', 'telegram'); const p = c.createProposal(proposal(f.s), job.id)!; const results = await Promise.all([c.approve(p.id), c.approve(p.id)]); assert.equal(sends, 1); assert.equal(results.filter(r => r.consumed).length, 1); assert.equal(c.proposal(p.id).status, 'executed'); f.close(); });
test('changed state and revoke during fresh snapshot prevent effects and cannot replay', async () => { for (const revoke of [false, true]) {
    const f = setup();
    f.s.set('bootstrapReady', true);
    f.s.set('automationProof', { ok: true, at: now() });
    f.s.saveSnapshot(snapshot());
    let sends = 0;
    const node: any = { snapshot: async () => { if (revoke)
            f.t.revoke(); const s = snapshot(); if (!revoke)
            s.channels[1]!.localSat = '240000'; return s; }, updateFee: async () => { sends++; } };
    const c = new ApplicationControl(f.s, f.q, new Executor(f.s, node)), job = c.admit('manual', 'proposal for review', 'telegram'), p = c.createProposal(proposal(f.s), job.id)!;
    await assert.rejects(c.approve(p.id));
    assert.equal(sends, 0);
    assert.equal(f.s.all('SELECT * FROM operations').length, 0);
    await c.approve(p.id);
    assert.equal(sends, 0);
    f.close();
} });
test('quiet time leaves unsolicited proposal pending but direct replies and critical notifications work; DST digest once per Rome day', async () => { let calls = 0; const f = setup({ call: async () => { calls++; return { message_id: calls }; } }); await pair(f, '2026-10-24T20:30:00Z'); f.t.enqueue('ordinary', 'ordinary', 'ordinary', undefined, '2026-10-24T20:30:00Z'); f.t.enqueue('reply', 'reply', 'reply'); f.t.enqueue('critical', 'critical', 'critical'); await f.t.deliver('2026-10-24T20:30:00Z'); assert.equal(calls, 2); assert.equal(romeHour('2026-10-25T07:00:00Z'), 8); assert.equal(romeHour('2026-03-29T07:00:00Z'), 9); f.t.capture('2026-10-25T08:00:00Z'); f.t.capture('2026-10-25T08:30:00Z'); assert.equal(f.s.one("SELECT count(*) n FROM telegram_outbox WHERE kind='digest'").n, 1); assert.equal(f.s.one("SELECT status FROM telegram_outbox WHERE event_id='ordinary'").status, 'aggregated'); f.close(); });
test('429 bounded retries and interrupted delivery remain visible without pausing autonomy', async () => { const f = setup({ call: async () => { const e: any = new Error('opaque'); e.rejected = true; e.retryAfter = 120; throw e; } }); await pair(f); f.t.enqueue('retry', 'retry'); await f.t.deliver(); assert.equal(f.s.one("SELECT attempts FROM telegram_outbox WHERE event_id='retry'").attempts, 1); assert.equal(f.s.one("SELECT status FROM telegram_outbox WHERE event_id='retry'").status, 'pending'); assert.equal(f.s.get('enabled'), true); for (let i = 0; i < 4; i++)
    await f.t.deliver(new Date(Date.now() + (i + 1) * 180000).toISOString()); assert.equal(f.s.one("SELECT status FROM telegram_outbox WHERE event_id='retry'").status, 'failed'); f.t.enqueue('crash', 'crash'); f.s.run("UPDATE telegram_outbox SET status='sending' WHERE event_id='crash'"); f.t.recover(); assert.equal(f.s.one("SELECT status FROM telegram_outbox WHERE event_id='crash'").status, 'uncertain'); assert.ok(f.t.status().failures.length); f.close(); });
test('delayed proposal is revalidated and starts expiry only on delivered message, expiry and immutable edits reject approval', async () => { let calls = 0; const f = setup({ call: async () => { calls++; return { message_id: calls }; } }), at = now(); await pair(f, at); f.s.set('bootstrapReady', true); f.s.set('automationProof', { ok: true, at }); f.s.saveSnapshot(snapshot()); const job = f.c.admit('delayed', 'proponimi una fee da approvare', 'telegram'), p = f.c.createProposal(proposal(f.s), job.id)!; f.t.capture(at); assert.equal(f.c.proposal(p.id).expires_at, null); assert.throws(() => f.c.validate(p.id, snapshot(), at), /expired/); const daytime = new Date(); daytime.setUTCHours(10, 0, 0, 0); const delivery = daytime.toISOString(); f.s.set('automationProof', { ok: true, at: delivery }); const s = snapshot(); s.at = delivery; f.s.saveSnapshot(s); await f.t.deliver(delivery); assert.ok(f.c.proposal(p.id).expires_at); assert.equal(f.s.one("SELECT status FROM telegram_outbox WHERE proposal_id=?", p.id).status, 'sent'); assert.throws(() => f.c.validate(p.id, snapshot(), '2099-01-01T00:00:00Z'), /expired/); f.s.run('UPDATE owner_proposals SET content=? WHERE id=?', JSON.stringify({ ...p.content, newPpm: 310 }), p.id); assert.throws(() => f.c.validate(p.id, snapshot(), delivery), /expired|changed/); f.close(); });
test('stale commands and exhausted pairing codes cannot change enabled state', async () => { const f = setup(); const code = f.t.pairing(); for (let n = 1; n <= 5; n++)
    f.t.ingest([update(n, '/start wrong')]); await f.t.process(); f.t.ingest([update(6, '/start ' + code.code)]); await f.t.process(); assert.equal(f.s.get('telegramCandidate'), null); await pair(f); const stale = update(100, '/pause'); (stale.message as any).date = 1; f.t.ingest([stale]); await f.t.process(); assert.equal(f.s.get('enabled'), true); f.close(); });
test('schema5 additive migration preserves jobs, ledger, immutable receipts and credential-history markers', () => { const dir = mkdtempSync(join(tmpdir(), 'telegram-migrate-')), path = join(dir, 'operational.sqlite'); let s = new Store(path), q = new Queue(s); const j = q.enqueue({ requestId: 'old', kind: 'chat', origin: 'owner', payload: { message: 'old' } }); s.ledger({ id: 'old-ledger', at: now(), classification: 'expense', amountMsat: '123', details: { scope: 'subscription' } }); s.set('piReceipt:' + j.id, { submission: 99 }); s.set('credentialHistoryMarker', { opaque: 'preserved' }); const before = { job: s.one('SELECT * FROM jobs WHERE id=?', j.id), ledger: s.all('SELECT * FROM ledger'), mandate: s.get('mandate') }; s.db.exec('DROP TABLE telegram_updates; DROP TABLE telegram_outbox; DROP TABLE owner_proposals; PRAGMA user_version=5'); s.close(); s = new Store(path); assert.equal(s.one('PRAGMA user_version').user_version, 6); assert.deepEqual(s.one('SELECT * FROM jobs WHERE id=?', j.id), before.job); assert.deepEqual(s.all('SELECT * FROM ledger'), before.ledger); assert.deepEqual(s.get('mandate'), before.mandate); assert.deepEqual(s.get('piReceipt:' + j.id), { submission: 99 }); assert.deepEqual(s.get('credentialHistoryMarker'), { opaque: 'preserved' }); assert.equal(s.all('SELECT * FROM owner_proposals').length, 0); s.close(); rmSync(dir, { recursive: true }); });
test('restart of consumed proposal records review required and cannot execute again', async () => { const f = setup(); f.s.saveSnapshot(snapshot()); const job = f.c.admit('crash-proposal', 'proposal for review', 'telegram'), p = f.c.createProposal(proposal(f.s), job.id)!; f.s.run("UPDATE owner_proposals SET status='executing',intent_at=? WHERE id=?", now(), p.id); f.c.recover(); let effects = 0; const c = new ApplicationControl(f.s, f.q, { execute: async () => { effects++; } } as any); const result = await c.approve(p.id); assert.equal(result.consumed, false); assert.equal(effects, 0); assert.equal(c.proposal(p.id).status, 'reconcile_required'); f.close(); });

test('outbox batch rechecks row, binding and bot credential generations before every send',async()=>{
  for(const transition of ['revoke','confirm','configure','row-cancel'] as const){
    let release!:()=>void;const held=new Promise<void>(r=>release=r);let entered!:()=>void;const started=new Promise<void>(r=>entered=r);const calls:number[]=[];
    const f=setup({call:async(_method:string,body:any)=>{calls.push(body.chat_id);if(calls.length===1){entered();await held;}return {message_id:calls.length};}});
    try{await pair(f);f.t.enqueue('batch-first','first');f.t.enqueue('batch-second','second');const sending=f.t.deliver();await started;
      if(transition==='revoke')f.t.revoke();
      if(transition==='confirm'){f.s.set('telegramCandidate',{userId:99,chatId:99,username:'other',expires:new Date(Date.now()+300000).toISOString()});f.t.confirm(99);}
      if(transition==='configure')f.t.configure('123456789:abcdefghijklmnopqrstuvwxyzABCDE');
      if(transition==='row-cancel')f.s.run("UPDATE telegram_outbox SET status='cancelled' WHERE event_id='batch-second'");
      release();await sending;assert.deepEqual(calls,[42]);assert.equal(f.s.one("SELECT status FROM telegram_outbox WHERE event_id='batch-second'").status,'cancelled');
    }finally{release();f.close();}
  }
});
test('re-pairing during approval snapshot invalidates authority and sends no reply to replacement owner',async()=>{
  const f=setup();await pair(f);f.s.set('bootstrapReady',true);f.s.set('automationProof',{ok:true,at:now()});f.s.saveSnapshot(snapshot());
  let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>entered=r),held=new Promise<void>(r=>release=r);let effects=0;
  const node:any={snapshot:async()=>{entered();await held;return snapshot();},updateFee:async()=>{effects++;}};
  const c=new ApplicationControl(f.s,f.q,new Executor(f.s,node));Object.assign(f.t,{control:c});const job=c.admit('approval-race','Proponimi una fee da approvare','telegram'),p=c.createProposal(proposal(f.s),job.id)!;
  const callbackKey='approval-race-button';f.s.set('telegramCallback:'+callbackKey,{action:'approve',id:p.id,generation:f.s.get('telegramBinding').generation});
  f.t.ingest([{update_id:100,callback_query:{data:callbackKey,from:{id:42},message:{chat:{id:42,type:'private'}}}}]);
  const processing=f.t.process();await started;f.s.set('telegramCandidate',{userId:99,chatId:99,username:'other',expires:new Date(Date.now()+300000).toISOString()});f.t.confirm(99);assert.equal(c.proposal(p.id).status,'revoked');release();await processing;
  assert.equal(effects,0);assert.equal(f.s.all('SELECT * FROM operations').length,0);assert.equal(f.s.all("SELECT * FROM telegram_outbox WHERE event_id='update:100'").length,0);f.close();
});
test('old callback and resume confirmation remain invalid after same-owner re-pairing',async()=>{
  const f=setup();await pair(f);f.c.pause();f.s.set('bootstrapReady',true);f.s.set('automationProof',{ok:true,at:now()});f.s.saveSnapshot(snapshot());
  f.t.ingest([update(100,'/resume')]);await f.t.process();const row=f.s.one("SELECT key,value FROM meta WHERE key LIKE 'telegramCallback:%'"),value=JSON.parse(row.value),key=row.key.slice('telegramCallback:'.length);
  assert.ok(value.generation);const oldGeneration=value.generation;await pair(f);assert.notEqual(f.s.get('telegramBinding').generation,oldGeneration);assert.equal(f.s.get(row.key),undefined);assert.throws(()=>f.c.resume(value.code),/expired/);
  // Even a retained old receipt cannot inherit a newly received update's identity.
  f.s.set(row.key,value);f.t.ingest([{update_id:200,callback_query:{data:key,from:{id:42},message:{chat:{id:42,type:'private'}}}}]);await f.t.process();assert.equal(f.s.get('enabled'),false);f.close();
});
test('critical incidents aggregate while active and identical recurrence gets a new alert',async()=>{
  const f=setup();await pair(f);f.s.set('blockers',['same failure']);f.t.capture();f.t.capture();assert.equal(f.s.one("SELECT count(*) n FROM telegram_outbox WHERE kind='critical'").n,1);
  f.s.set('blockers',[]);f.t.capture();f.s.set('blockers',['same failure']);f.t.capture();f.t.capture();assert.equal(f.s.one("SELECT count(*) n FROM telegram_outbox WHERE kind='critical'").n,2);
  // A resolved individual blocker recurs even when another incident stays active.
  f.s.set('blockers',['other']);f.t.capture();f.s.set('blockers',['same failure']);f.t.capture();assert.equal(f.s.one("SELECT count(*) n FROM telegram_outbox WHERE kind='critical'").n,4);f.close();
});
test('token install failure persists disabled unpaired authority before replacement and restart',async()=>{
  const f=setup();const token='123456789:abcdefghijklmnopqrstuvwxyzABCDE';f.t.configure(token);await pair(f);const before=f.s.get('telegramBotGeneration');
  const {mkdirSync}=await import('node:fs');mkdirSync(f.t.tokenPath+'.new');assert.throws(()=>f.t.configure('987654321:abcdefghijklmnopqrstuvwxyzABCDE'));
  assert.equal(f.t.status().paired,false);assert.equal(f.t.status().configured,false);assert.notEqual(f.s.get('telegramBotGeneration'),before);assert.equal(readFileSync(f.t.tokenPath,'utf8'),token);
  const restarted=new Telegram(f.s,f.c,f.dir,{call:async()=>{throw Error('No polling authorized');}});restarted.recover();assert.equal(restarted.status().paired,false);assert.equal(restarted.status().configured,false);assert.throws(()=>restarted.pairing(),/Configure/);restarted.stop();f.close();
});
test('old long-poll result is discarded after token replacement and cannot advance new cursor',async()=>{
  let release!:(value:any)=>void,entered!:()=>void;const held=new Promise<any>(r=>release=r),started=new Promise<void>(r=>entered=r);
  const f=setup({call:async(method:string)=>{assert.equal(method,'getUpdates');entered();return await held;}});await pair(f);const polling=f.t.loop();await started;
  f.t.configure('123456789:abcdefghijklmnopqrstuvwxyzABCDE');release([update(500,'/pause')]);
  await new Promise<void>(r=>setImmediate(r));f.t.stop();await polling;
  assert.equal(f.s.get('telegramCursor'),0);assert.equal(f.s.all('SELECT * FROM telegram_updates').length,0);assert.equal(f.s.get('enabled'),true);f.close();
});

test('critical availability labels require proven provider classification',async()=>{
 const identities={source:'native_entry',jobId:'job',conversationId:'7',submissionId:'15',taskId:'21',entryId:'22'};
 for(const [failure,expected] of [[undefined,/causa non qualificata/],[{kind:'provider_unknown',code:'unclassified'},/causa non qualificata/],[{...identities,kind:'transient_stream',code:'stream_ended_before_terminal_event'},/Risposta del provider interrotta/],[{...identities,kind:'authentication',code:'http_401'},/Autenticazione agente rifiutata/],[{...identities,kind:'quota',code:'http_429'},/Quota o limite richieste/]] as const){
  const f=setup();try{await pair(f);f.s.set('agent',{status:'unavailable',failure});f.t.capture();const rows=f.s.all("SELECT text FROM telegram_outbox WHERE kind='critical'");const text=JSON.stringify(rows);assert.match(text,expected);if(!failure||!['authentication','quota'].includes(failure.kind))assert.doesNotMatch(text,/Autenticazione|Quota|relogin/);}finally{f.close();}
 }
});
