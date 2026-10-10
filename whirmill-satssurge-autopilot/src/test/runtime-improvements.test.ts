import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeImprovements, MAX_RUNTIME_OCCURRENCES, classifyRuntimeFailure, type RuntimeObservation, type RuntimeArtifact } from '../runtime-improvements.js';
import { Store } from '../store.js';
import { Queue } from '../queue.js';
import { ApplicationControl } from '../application-control.js';
import { Telegram } from '../telegram.js';
import { TelegramTurns } from '../telegram-turns.js';
import { fixture as piFixture } from './pi-fixture.js';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { hash } from '../domain.js';
const at = '2026-10-10T10:00:00Z';
const observation = (changes: Partial<RuntimeObservation> = {}): RuntimeObservation => ({ component: 'agent', classification: 'unknown', facts: ['job_failed'], impact: 'partial_response', receipt: hash('receipt'), ...changes });
const longObservation = (changes: Partial<RuntimeObservation> = {}) => observation({ facts: ['job_failed','turn_interrupted','delivery_failed','delivery_uncertain','collector_failed','source_incompatible','coverage_gap','regression_confirmed'], ...changes });
function fixture(call: (method: string, body: any) => Promise<any> = async () => ({ message_id: 1 }), path = ':memory:') {
    const dir = mkdtempSync(join(tmpdir(), 'runtime-advisory-')), store = new Store(path), queue = new Queue(store);
    const telegram = new Telegram(store, new ApplicationControl(store, queue), dir, { call });
    store.set('telegramBinding', { generation: 'fixture', chatId: 42, userId: 42, since: at });
    store.set('telegramConfigured', true);
    return { store, queue, telegram, runtime: new RuntimeImprovements(store), close() { telegram.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
test('dedup aggregates new receipts; material impact/evidence linked revision; delivery does not resolve; verified reopen', () => {
    const f = fixture(); try {
        const first = f.runtime.observe(observation(), at)!;
        f.runtime.observe(observation(), at); f.runtime.observe(observation({ receipt: hash('second') }), at);
        let issue = f.runtime.issues()[0]!; assert.equal(issue.revisions.length, 1); assert.equal(issue.revisions[0]!.observations, 2);
        f.runtime.observe(observation({ impact: 'runtime_blocked' }), at);
        issue = f.runtime.issues()[0]!; assert.equal(issue.revisions[1]!.previous, 1);
        f.runtime.observe(observation({ impact: 'runtime_blocked', classification: 'app_defect', facts: ['job_failed','regression_confirmed'] }), at);
        assert.equal(f.runtime.issues()[0]!.revisions.length, 3);
        f.telegram.capture(at); const event = f.runtime.issues()[0]!.revisions.at(-1)!.delivery!.eventId;
        f.runtime.delivery(event, 'sent', 99); assert.equal(f.runtime.issues()[0]!.status, 'open');
        assert.throws(() => f.runtime.resolve(first.issue.id, 'delivered'), /verification/);
        f.runtime.resolve(first.issue.id, hash('changed-runtime-verification'));
        f.runtime.observe(observation(), at); assert.equal(f.runtime.issues()[0]!.status, 'resolved'); assert.equal(f.runtime.issues()[0]!.revisions.length, 3);
        f.runtime.observe(observation({ receipt: hash('genuinely new occurrence') }), at); assert.equal(f.runtime.issues()[0]!.status, 'open'); assert.equal(f.runtime.issues()[0]!.revisions.length, 4);
    } finally { f.close(); }
});
test('closed evidence API rejects payloads, raw logs and credentials before persistence; bounds and advisory authority', () => {
    const f = fixture(); try {
        const before = { enabled: f.store.get('enabled'), mandate: f.store.get('mandate'), operations: f.store.all('SELECT * FROM operations') };
        for (const extra of [{ payment_request: 'lnbc1personal' }, { error: 'token=private' }, { credential: 'secret' }]) assert.throws(() => f.runtime.observe({ ...observation(), ...extra } as any), /allowlisted/);
        for (const receipt of ['lnbc1personal', '123456789:abcdefghijklmnopqrstuvwxyz', 'raw error password=secret']) assert.throws(() => f.runtime.observe(observation({ receipt })), /allowlisted/);
        assert.throws(() => f.runtime.observe(observation({ facts: ['private log'] as any })), /allowlisted/);
        assert.throws(() => f.runtime.observe(observation({ classification: 'app_defect' })), /regression/);
        f.runtime.observe(observation()); f.telegram.capture(at);
        assert.deepEqual({ enabled: f.store.get('enabled'), mandate: f.store.get('mandate'), operations: f.store.all('SELECT * FROM operations') }, before);
        assert.equal(f.store.all('SELECT * FROM jobs').length, 0); assert.equal(f.store.all('SELECT * FROM owner_proposals').length, 0);
        for (let i = 0; i < 100; i++) f.runtime.observe(observation({ receipt: hash('r' + i) }));
        assert.equal(f.runtime.issues()[0]!.revisions[0]!.receipts.length, 50);
        assert.ok(!JSON.stringify(f.runtime.issues()).includes('private'));
    } finally { f.close(); }
});
test('transient provider and auth diagnoses request evidence, not an app fix; actual diagnostic gaps only', () => {
    const f = fixture(); try {
        for (const error of ['provider 503', 'network timeout', '429 rate limit', 'ECONNRESET']) assert.equal(classifyRuntimeFailure(error), 'upstream_transient');
        assert.equal(classifyRuntimeFailure('401 authentication failure'), 'authentication'); assert.equal(classifyRuntimeFailure('opaque failure'), 'unknown');
        f.runtime.observe(observation({ classification: 'upstream_transient' }));
        assert.match(f.runtime.issues()[0]!.revisions[0]!.prompt, /da solo non giustifica/);
        f.store.set('diagnostics', { lndg: { status: 'qualified', coverage: { complete: true }, captureComplete: true }, lightningMate: { status: 'unavailable' } }); f.runtime.scan(at);
        assert.equal(f.runtime.issues().length, 1);
        f.store.set('diagnostics', { lndg: { status: 'qualified', coverage: { complete: false } } }); f.runtime.scan(at);
        assert.equal(f.runtime.issues().length, 2); assert.match(f.runtime.issues()[1]!.revisions[0]!.prompt, /ignoto non significa zero/);
    } finally { f.close(); }
});
test('immutable long attachment uses exact recorded bytes/checksum through rejection retry and destination receipt', async () => {
    const bytes: string[] = []; let calls = 0;
    const f = fixture(async (method, body) => { if (method !== 'sendDocument') return { message_id: 2 }; calls++; assert.ok(body instanceof FormData); assert.equal(body.get('chat_id'), '42'); bytes.push(await (body.get('document') as Blob).text()); if (calls === 1) throw Object.assign(Error('rejected'), { rejected: true }); return { message_id: 7 }; });
    try {
        f.runtime.observe(longObservation(), at); f.telegram.capture(at);
        const revision = f.runtime.issues()[0]!.revisions[0]!, event = revision.delivery!.eventId;
        const artifact = f.store.get<RuntimeArtifact>('runtimeArtifact:' + event)!;
        assert.ok(artifact.content.length > 3500); assert.equal(artifact.checksum, hash(artifact.content));
        await f.telegram.deliver(at); f.runtime.observe(longObservation({ receipt: hash('another') }), at); f.telegram.capture(at);
        await f.telegram.deliver('2026-10-10T10:01:00Z');
        assert.deepEqual(bytes, [artifact.content, artifact.content]); const delivery = f.runtime.issues()[0]!.revisions[0]!.delivery!;
        assert.equal(delivery.status, 'sent'); assert.equal(delivery.chatId, 42); assert.equal(delivery.checksum, artifact.checksum); assert.equal(delivery.messageId, 7); assert.equal(f.runtime.issues()[0]!.status, 'open');
    } finally { f.close(); }
});
test('accepted timeout and crash remain uncertain without automatic replay or recursive advisory', async () => {
    let calls = 0; const f = fixture(async (method) => { if (method === 'sendDocument') { calls++; throw Error('timeout after acceptance'); } return { message_id: 2 }; });
    try {
        f.runtime.observe(longObservation(), at); f.telegram.capture(at); await f.telegram.deliver(at);
        f.telegram.capture(at); f.telegram.recover(); await f.telegram.deliver(at);
        assert.equal(calls, 1); assert.equal(f.runtime.issues().length, 1); assert.equal(f.runtime.issues()[0]!.revisions[0]!.delivery!.status, 'uncertain');
        assert.equal(f.store.all('SELECT * FROM operations').length, 0);
    } finally { f.close(); }
});
test('advisory quiet hours and proven critical impact; rate limit and bounded attempts', async () => {
    let calls = 0; const f = fixture(async method => { if (method === 'sendDocument') { calls++; throw Object.assign(Error('rejected'), { rejected: true, retryAfter: 1 }); } return { message_id: 2 }; });
    try {
        f.runtime.observe(longObservation(), at); f.telegram.capture(at); await f.telegram.deliver('2026-10-10T21:00:00Z'); assert.equal(calls, 0);
        f.runtime.observe(longObservation({ classification: 'app_defect', impact: 'runtime_blocked' }), at); f.telegram.capture(at);
        await f.telegram.deliver('2026-10-10T21:00:00Z'); assert.equal(calls, 1);
        const event = f.runtime.issues()[0]!.revisions.at(-1)!.delivery!.eventId;
        await f.telegram.deliver('2026-10-10T21:00:00Z'); assert.equal(calls, 1);
        for (let i = 1; i < 5; i++) { f.store.set('telegramRateLimitUntil', 0); await f.telegram.deliver(`2026-10-10T21:0${i}:00Z`); }
        assert.equal(calls, 5); assert.equal(f.store.one('SELECT status,attempts FROM telegram_outbox WHERE event_id=?', event).status, 'failed');
    } finally { f.close(); }
});
test('revocation and token rotation during attachment await stop subsequent dispatch', async () => {
    for (const transition of ['revoke','rotate']) {
        let release!: () => void, enter!: () => void; const held = new Promise<void>(r => release = r), started = new Promise<void>(r => enter = r); let calls = 0;
        const f = fixture(async method => { calls++; assert.equal(method, 'sendDocument'); enter(); await held; return { message_id: 1 }; });
        try {
            f.runtime.observe(longObservation(), at); f.telegram.capture(at); f.telegram.enqueue('later', 'later', 'reply', undefined, at);
            // Remove digest so first dispatch is the attachment.
            f.store.run("DELETE FROM telegram_outbox WHERE event_id NOT LIKE 'advisory:%' AND event_id<>'later'"); f.store.run("UPDATE telegram_outbox SET kind='critical' WHERE event_id LIKE 'advisory:%'");
            const sending = f.telegram.deliver(at); await started;
            if (transition === 'revoke') f.telegram.revoke(); else f.telegram.configure('123456789:abcdefghijklmnopqrstuvwxyzABCDE');
            release(); await sending; assert.equal(calls, 1); assert.equal(f.store.one("SELECT status FROM telegram_outbox WHERE event_id='later'").status, 'cancelled');
            assert.equal(f.runtime.issues()[0]!.revisions[0]!.delivery!.chatId, 42);
        } finally { release(); f.close(); }
    }
});
test('advisory issues, artifacts and original unrelated receipts survive schema6 reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'runtime-reopen-')), path = join(dir, 'db.sqlite'); let s = new Store(path);
    try {
        s.set('piReceipt:original', { submission: 'original' }); const runtime = new RuntimeImprovements(s); runtime.observe(observation(), at);
        const original = runtime.issues(); s.close(); s = new Store(path);
        assert.deepEqual(new RuntimeImprovements(s).issues(), original); assert.deepEqual(s.get('piReceipt:original'), { submission: 'original' }); assert.equal(s.one('PRAGMA user_version').user_version, 6);
    } finally { s.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('reprocessed inbound message after admission becomes active retains original job and never creates correction', async () => {
    const f = fixture(); try {
        f.telegram.ingest([{ update_id: 88, message: { text: 'Spiega lo stato', from: { id: 42 }, chat: { id: 42, type: 'private' } } }]);
        await f.telegram.process(at); const job = f.queue.claim('coordinator', 'fixture', at)!; assert.ok(job);
        f.store.run("UPDATE telegram_updates SET status='pending' WHERE update_id=88"); await f.telegram.process(at);
        assert.equal(f.store.all('SELECT * FROM jobs').length, 1); assert.equal(f.store.all("SELECT * FROM meta WHERE key LIKE 'telegramCorrection:%'").length, 0);
        assert.equal(f.store.one('SELECT status FROM telegram_updates WHERE update_id=88').status, 'done');
    } finally { f.close(); }
});

test('canonical observations ignore key order, duplicate fact order and optional defaults', () => {
    const f = fixture(); try {
        const first = f.runtime.observe(observation({ facts: ['job_failed','turn_interrupted'] }), at)!;
        const reordered = { receipt: hash('receipt'), impact: 'partial_response', facts: ['turn_interrupted','job_failed','job_failed'], classification: 'unknown', component: 'agent', runtimeVersion: undefined, observedAt: undefined } as RuntimeObservation;
        const next = f.runtime.observe(reordered, at)!;
        assert.equal(next.issue.id, first.issue.id); assert.equal(next.revision.fingerprint, first.revision.fingerprint); assert.equal(f.runtime.issues()[0]!.revisions.length, 1);
        f.runtime.observe({ ...reordered, affectedVersion: '9.0.0' }, at); assert.equal(f.runtime.issues()[0]!.revisions.length, 2);
        // Historical receipts with their historical fingerprint cannot oscillate the latest version.
        f.runtime.observe(observation({ facts: ['job_failed','turn_interrupted'] }), at); assert.equal(f.runtime.issues()[0]!.revisions.length, 2);
        f.runtime.observe(observation({ facts: ['job_failed','turn_interrupted'], receipt: hash('new material return') }), at); assert.equal(f.runtime.issues()[0]!.revisions.length, 3);
    } finally { f.close(); }
});
test('same transport problem aggregates receipt rows; repeated mixed failed/uncertain scans cannot spam or exhaust revisions', () => {
    const f = fixture(); try {
        for (let i = 0; i < 6; i++) { f.telegram.enqueue('transport-' + i, 'fixture', 'reply', undefined, at); f.store.run('UPDATE telegram_outbox SET status=? WHERE event_id=?', i < 3 ? 'failed' : 'uncertain', 'transport-' + i); }
        f.telegram.capture(at);
        const issues = f.runtime.issues().filter(i => i.revisions[0]!.observation.component === 'telegram'); assert.equal(issues.length, 2);
        assert.deepEqual(issues.map(i => i.revisions[0]!.observations).sort(), [3,3]);
        const count = f.store.one("SELECT count(*) n FROM telegram_outbox WHERE event_id LIKE 'advisory:%'").n;
        for (let i = 0; i < 20; i++) f.telegram.capture(at);
        assert.equal(f.store.one("SELECT count(*) n FROM telegram_outbox WHERE event_id LIKE 'advisory:%'").n, count);
        assert.ok(f.runtime.issues().every(i => i.revisions.length === 1));
        const issue = f.runtime.issues()[0]!; f.runtime.observe({ ...issue.revisions[0]!.observation, impact: 'runtime_blocked' }, at);
        assert.equal(f.runtime.issues().find(i => i.id === issue.id)!.revisions[1]!.previous, 1);
        f.telegram.capture(at); f.telegram.capture(at);
        assert.equal(f.runtime.issues().find(i => i.id === issue.id)!.revisions.length, 2);
    } finally { f.close(); }
});
test('correlated native entry rejects invented receipts and raw payloads; derives source timestamp/version and honest classification', () => {
    const f = fixture(); try {
        assert.throws(() => f.runtime.reportEvidence('job', hash('invented')), /persisted evidence/);
        const job = f.queue.enqueue({ requestId: 'failed-upstream', kind: 'chat', payload: { message: 'private user payload' } });
        f.store.run("UPDATE jobs SET state='failed',error=?,updated_at=? WHERE id=?", 'provider 503 password=private lnbc1personal', at, job.id);
        const outcome = f.runtime.reportEvidence('job', job.id, at) as any;
        assert.equal(outcome.status, 'open'); assert.equal(outcome.financialExecution, false); assert.match(outcome.prompt, /prima di attribuire il problema al codice/);
        assert.ok(!JSON.stringify(outcome).includes('password=')); assert.ok(!JSON.stringify(outcome).includes('lnbc1personal')); assert.ok(!JSON.stringify(outcome).includes('private user payload'));
        const o = f.runtime.issues()[0]!.revisions[0]!.observation; assert.equal(o.observedAt, at); assert.equal(o.timeBasis, 'source'); assert.equal(o.classification, 'unknown');
        f.telegram.capture(at); assert.equal(f.store.one("SELECT count(*) n FROM telegram_outbox WHERE event_id LIKE 'advisory:%'").n, 1);
    } finally { f.close(); }
});

test('all Telegram admission paths roll back partial receipts and reopen/replay the original action before expired choice validation', async () => {
    for (const action of ['natural','followup','details','deepen','gaps'] as const) {
        const directory = mkdtempSync(join(tmpdir(), 'atomic-action-')), path = join(directory, 'operational.sqlite'); let f = fixture(undefined, path);
        try {
            const control = new ApplicationControl(f.store, f.queue), turns = new TelegramTurns(f.store, f.queue);
            const prior = control.admit('prior-' + action, 'Prior question', 'telegram'); turns.attach(prior, 'fixture', 42); f.store.set('jobTelegramGeneration:' + prior.id, 'fixture');
            f.store.run("UPDATE jobs SET state='completed' WHERE id=?", prior.id); turns.close(prior.id, 'completed');
            const correction = turns.receive('correction-' + action, turns.get(prior.id)!, 'Nuova richiesta senza effetti', at);
            f.store.set('telegramCallback:action', { action, id: action === 'followup' ? correction.id : prior.id, generation: 'fixture' });
            f.telegram.ingest([action === 'natural' ? { update_id: 99, message: { text: 'Proponimi una fee da approvare', from: { id: 42 }, chat: { id: 42, type: 'private' } } } : { update_id: 99, callback_query: { data: 'action', from: { id: 42 }, message: { chat: { id: 42, type: 'private' } } } }]);
            const set = f.store.set.bind(f.store); f.store.set = ((key: string, value: any) => { if (key.startsWith('telegramTurn:') && key !== 'telegramTurn:' + prior.id) throw Error('Simulated crash boundary after admission before turn'); return set(key, value); }) as any;
            await f.telegram.process(at); f.store.set = set;
            assert.equal(f.store.all('SELECT * FROM jobs').length, 1, action); assert.equal(f.store.all("SELECT * FROM meta WHERE key LIKE 'telegramLinkedRequest:%'").length, 0, action);
            assert.equal(turns.correction(correction.id)!.state, 'choice_pending');
            f.store.run("UPDATE telegram_updates SET status='pending' WHERE update_id=99"); let wakes = 0;
            f.telegram.setWake(async () => { wakes++; const next = f.store.one('SELECT id FROM jobs WHERE id<>?', prior.id); assert.ok(turns.get(next.id)); assert.equal(f.store.one('SELECT status FROM telegram_updates WHERE update_id=99').status, 'done'); if (action !== 'natural') assert.equal(f.store.get('telegramLinkedRequest:' + next.id).priorTurn, prior.id); });
            await f.telegram.process(at); assert.equal(wakes, 1, action);
            const next = f.store.one('SELECT * FROM jobs WHERE id<>?', prior.id); assert.ok(turns.get(next.id));
            assert.equal(f.store.get('jobCapability:' + next.id), action === 'natural' ? 'guarded_manual_proposal' : ['deepen','gaps'].includes(action) ? 'read_only_research' : 'read_only_chat');
            const before = f.store.all('SELECT id,request_id,kind FROM jobs'); f.close(); f = fixture(undefined, path);
            f.store.run("UPDATE telegram_updates SET status='pending' WHERE update_id=99"); await f.telegram.process('2099-01-01T00:00:00Z');
            assert.deepEqual(f.store.all('SELECT id,request_id,kind FROM jobs'), before, action);
            const reopenedTurns = new TelegramTurns(f.store, f.queue), claimed = f.queue.claim(next.lane, 'reopen')!; assert.equal(claimed.id, next.id);
            let stopped = 0; reopenedTurns.bind(claimed, { steer: async () => {}, stop: async () => { stopped++; } });
            const future = new ApplicationControl(f.store, f.queue).admit('future-' + action, 'future', 'telegram'); reopenedTurns.attach(future, 'fixture', 42);
            const turn = reopenedTurns.get(next.id)!; assert.equal((await reopenedTurns.stop(next.id, 'fixture', turn.version, 'action-stop')).state, 'received');
            await reopenedTurns.dispatchStop('action-stop'); assert.equal(stopped, 1); assert.equal(f.queue.get(future.id)!.state, 'queued');
        } finally { f.close(); rmSync(directory, { recursive: true, force: true }); }
    }
});

test('shared admission helper preserves capability, purpose and origin semantics with transaction rollback', () => {
    const f = fixture(); try {
        const control = new ApplicationControl(f.store, f.queue);
        for (const [requestId, source, analysis, purpose, capability] of [
            ['owner','owner',false,undefined,'financial_guarded'], ['telegram','telegram',false,undefined,'read_only_chat'],
            ['review','telegram',false,undefined,'guarded_manual_proposal'], ['analysis','telegram',true,undefined,'read_only_research'],
            ['qualification','owner',true,'qualification','read_only_qualification'],
        ] as const) {
            const job = f.store.tx(() => control.admitWithinTransaction(requestId, requestId === 'review' ? 'Proponimi una fee' : 'Spiega', source, analysis, purpose));
            assert.equal(f.store.get('jobCapability:' + job.id), capability);
            const accepted = f.store.one("SELECT details FROM job_events WHERE job_id=? AND type='accepted'", job.id); assert.equal(JSON.parse(accepted.details).origin, purpose === 'qualification' ? 'qualification' : source);
        }
        assert.throws(() => f.store.tx(() => { control.admitWithinTransaction('rolledback', 'Spiega', 'telegram'); throw Error('boundary'); }), /boundary/);
        assert.equal(f.store.one("SELECT id FROM jobs WHERE request_id='rolledback'"), undefined);
    } finally { f.close(); }
});

test('actual Pi slot2 advisory tools correlate persisted evidence, obey authority/budget and cannot execute finances', { timeout: 15000 }, async () => {
    for (const mode of ['valid','invented','revoked','exhausted'] as const) {
        const directory = mkdtempSync(join(tmpdir(), 'native-advisory-')), f = piFixture(directory, 'state');
        try {
            f.store.set('telegramBinding', { generation: 'native', chatId: 42, userId: 42, since: at });
            const source = f.queue.enqueue({ requestId: 'source', kind: 'chat', payload: { message: 'private payment payload must remain excluded' } });
            f.store.run("UPDATE jobs SET state='failed',error=?,updated_at=? WHERE id=?", 'opaque error password=private lnbc1personal', at, source.id);
            const turns = new TelegramTurns(f.store, f.queue), control = new ApplicationControl(f.store, f.queue), owner = control.admit('owned', 'Segnala un problema del runtime', 'telegram');
            f.store.set('jobTelegramGeneration:' + owner.id, 'native'); turns.attach(owner, 'native', 42);
            const toolResults: any[] = []; let first = true;
            f.agent.models.streamSimple = (_model, request) => {
                const stream = createAssistantMessageEventStream();
                toolResults.push(...request.messages.filter((m: any) => m.role === 'toolResult'));
                const hasResult = request.messages.some((m: any) => m.role === 'toolResult');
                if (first && mode === 'revoked') f.store.set('telegramBinding', null);
                if (first && mode === 'exhausted') { const budget = f.store.get('runBudget:' + owner.id); assert.ok(budget); /* next invocation consumes the remaining research budget */ }
                const content: any[] = hasResult ? [{ type: 'text', text: 'Segnalazione consultiva conclusa' }] : mode === 'exhausted' ? Array.from({ length: 26 }, (_, i) => ({ type: 'toolCall', id: 'report-' + i, name: 'report_runtime_improvement_analyst_2', arguments: { source: 'job', reference: source.id } })) : [{ type: 'toolCall', id: 'report', name: 'report_runtime_improvement_analyst_2', arguments: { source: 'job', reference: mode === 'invented' ? hash('invented') : source.id } }];
                first = false;
                const message: any = { role: 'assistant', api: 'openai-responses', provider: 'openai', model: 'gpt-6.1-sol', timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: hasResult ? 'stop' : 'toolUse', content };
                queueMicrotask(() => { stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: message.stopReason, message }); }); return stream;
            };
            await f.agent.open(); const running = f.agent.runJob(f.queue.claim('coordinator', 'owned')!, 2);
            if (mode === 'exhausted') await assert.rejects(running, /Absolute tool limit/); else await running;
            const issues = new RuntimeImprovements(f.store).issues();
            assert.equal(issues.length, ['invented','revoked'].includes(mode) ? 0 : 1, mode);
            if (mode === 'valid') { assert.equal(issues[0]!.revisions[0]!.observation.receipt, source.id); assert.equal(issues[0]!.revisions[0]!.observation.classification, 'unknown'); assert.ok(JSON.stringify(toolResults).includes('advisoryOnly')); assert.ok(!JSON.stringify(toolResults).includes('password=')); assert.ok(!JSON.stringify(toolResults).includes('lnbc1personal')); }
            assert.ok(f.store.get('runBudget:' + owner.id).calls >= 1 || mode === 'revoked');
            if (mode === 'exhausted') assert.equal(f.store.get('runBudget:' + owner.id).phase, 'finalization');
            assert.equal(f.store.all('SELECT * FROM operations').length, 0); assert.equal(f.store.all('SELECT * FROM owner_proposals').length, 0);
            assert.equal(f.store.get('jobCapability:' + owner.id), 'read_only_chat');
        } finally { await f.agent.close(); f.store.close(); rmSync(directory, { recursive: true, force: true }); }
    }
});

test('historical and upgraded job fault versions remain unverified; admission/delivery versions are immutable provenance', () => {
    const f = fixture(); try {
        const legacy = f.queue.enqueue({ requestId: 'legacy-version', kind: 'chat', payload: { message: 'legacy' } }); f.store.run("UPDATE jobs SET state='failed',updated_at=? WHERE id=?", at, legacy.id);
        const historical = f.runtime.reportEvidence('job', legacy.id, at) as any;
        assert.match(historical.prompt, /non verificata nella ricevuta/); assert.equal(f.runtime.issues()[0]!.revisions[0]!.observation.affectedVersion, 'unknown');
        const current = new ApplicationControl(f.store, f.queue).admit('current-version', 'Spiega', 'telegram'); f.store.run("UPDATE jobs SET state='failed',updated_at=? WHERE id=?", at, current.id);
        f.runtime.reportEvidence('job', current.id, at); const o = f.runtime.issues()[0]!.revisions.at(-1)!.observation;
        assert.equal(o.affectedVersion, 'unknown'); assert.ok(f.store.get('jobRuntimeVersion:' + current.id));
        // Admission can precede an upgrade; it does not prove the terminal failure version.
        f.store.set('jobRuntimeVersion:' + current.id, '0.1.0'); f.runtime.reportEvidence('job', current.id, at);
        assert.equal(f.runtime.issues()[0]!.revisions.length, 1); assert.equal(f.runtime.issues()[0]!.revisions[0]!.observation.affectedVersion, 'unknown');
        f.telegram.enqueue('versioned', 'fixture', 'reply', undefined, at); const original = f.store.get('telegramOutboxVersion:versioned'); f.store.set('telegramOutboxVersion:versioned', '1.0.0'); f.telegram.enqueue('versioned', 'duplicate', 'reply', undefined, at);
        assert.equal(f.store.get('telegramOutboxVersion:versioned'), '1.0.0'); assert.ok(original);
    } finally { f.close(); }
});

test('unchanged failed receipt never reopens after resolution/capture, including detector upgrade; new source occurrence or material evidence does', () => {
    const f = fixture(); try {
        const job = f.queue.enqueue({ requestId: 'old-failure', kind: 'chat', payload: { message: 'fixture' } });
        f.store.run("UPDATE jobs SET state='failed',error='opaque',updated_at=? WHERE id=?", at, job.id);
        f.telegram.capture(at); const issue = f.runtime.issues()[0]!, original = issue.revisions[0]!.observation;
        const count = f.store.one("SELECT count(*) n FROM telegram_outbox WHERE event_id LIKE 'advisory:%'").n;
        f.runtime.resolve(issue.id, hash('verified runtime'));
        for (let i = 0; i < 20; i++) f.telegram.capture(at);
        assert.equal(f.runtime.issues()[0]!.status, 'resolved'); assert.equal(f.runtime.issues()[0]!.revisions.length, 1);
        assert.equal(f.store.one("SELECT count(*) n FROM telegram_outbox WHERE event_id LIKE 'advisory:%'").n, count);
        f.runtime.observe({ ...original, runtimeVersion: '99.0.0' }, at);
        assert.equal(f.runtime.issues()[0]!.status, 'resolved'); assert.equal(f.runtime.issues()[0]!.revisions.length, 1);
        // A genuinely new terminal job receipt is explicitly identifiable.
        const freshAt = '2026-10-10T10:05:00Z', nextJob = f.queue.enqueue({ requestId: 'genuinely-new-failure', kind: 'chat', payload: { message: 'fixture' } });
        f.store.run("UPDATE jobs SET state='failed',error='opaque',updated_at=? WHERE id=?", freshAt, nextJob.id);
        f.runtime.reportEvidence('job', nextJob.id, freshAt); assert.equal(f.runtime.issues()[0]!.status, 'open'); assert.equal(f.runtime.issues()[0]!.revisions.length, 2);
        f.runtime.resolve(issue.id, hash('next verified runtime'));
        f.runtime.observe({ ...original, affectedVersion: '2.0.0' }, freshAt); assert.equal(f.runtime.issues()[0]!.status, 'open'); assert.equal(f.runtime.issues()[0]!.revisions.length, 3);
    } finally { f.close(); }
});

test('51 correlated receipts rotate display samples without losing exact historical replay identity after material revision and reopen', () => {
    const directory = mkdtempSync(join(tmpdir(), 'occurrence-reopen-')), path = join(directory, 'db.sqlite'); let f = fixture(undefined, path);
    try {
        let firstId = '';
        for (let i = 0; i < 51; i++) {
            const job = f.queue.enqueue({ requestId: 'occurrence-' + i, kind: 'chat', payload: { message: 'fixture' } });
            const stamp = i === 0 ? '2026-10-10T11:00:00Z' : new Date(Date.parse(at) + i * 1000).toISOString();
            f.store.run("UPDATE jobs SET state='failed',error='opaque',updated_at=? WHERE id=?", stamp, job.id);
            f.runtime.reportEvidence('job', job.id, at); if (i === 0) firstId = job.id;
        }
        const revision = f.runtime.issues()[0]!.revisions[0]!;
        assert.equal(revision.receipts.length, 50); assert.ok(!revision.receipts.includes(firstId)); assert.equal(revision.observations, 51);
        assert.equal(f.store.get<string[]>('runtimeImprovementOccurrences')!.length, 51);
        f.runtime.observe({ ...revision.observation, impact: 'runtime_blocked', receipt: hash('new impact'), occurrenceId: hash('new impact occurrence') }, at);
        f.telegram.capture(at); const count = f.store.one("SELECT count(*) n FROM telegram_outbox WHERE event_id LIKE 'advisory:%'").n;
        const id = f.runtime.issues()[0]!.id; f.runtime.resolve(id, hash('verified current runtime'));
        f.close(); f = fixture(undefined, path);
        for (let i = 0; i < 20; i++) f.telegram.capture(at);
        assert.equal(f.runtime.issues()[0]!.status, 'resolved'); assert.equal(f.runtime.issues()[0]!.revisions.length, 2);
        assert.equal(f.store.one("SELECT count(*) n FROM telegram_outbox WHERE event_id LIKE 'advisory:%'").n, count);
        assert.equal(f.store.get<string[]>('runtimeImprovementOccurrences')!.length, 52);
        // A previously unseen receipt with earlier material evidence is a real new occurrence.
        f.runtime.observe({ ...revision.observation, receipt: hash('genuine subsequent recurrence'), occurrenceId: hash('genuine subsequent occurrence') }, at);
        assert.equal(f.runtime.issues()[0]!.status, 'open'); assert.equal(f.runtime.issues()[0]!.revisions.length, 3);
    } finally { f.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('exact occurrence capacity blocks unrecognized observations truthfully, preserves known replay and cannot evict retained identities', () => {
    const f = fixture(); try {
        const first = f.runtime.observe(observation(), at)!;
        for (let i = 1; i < MAX_RUNTIME_OCCURRENCES; i++) assert.ok(f.runtime.observe(observation({ receipt: hash('bounded-' + i) }), at));
        assert.equal(f.store.get<string[]>('runtimeImprovementOccurrences')!.length, MAX_RUNTIME_OCCURRENCES);
        assert.equal(f.runtime.issues()[0]!.revisions[0]!.receipts.length, 50);
        f.runtime.resolve(first.issue.id, hash('verified full ledger'));
        const known = f.runtime.observe(observation(), at)!; assert.equal(known.issue.status, 'resolved'); assert.equal(known.issue.revisions.length, 1);
        assert.equal(f.runtime.observe(observation({ receipt: hash('unrecognized beyond capacity') }), at), undefined);
        const state = f.store.get('runtimeAdvisoryCapacity'); assert.equal(state.status, 'blocked'); assert.equal(state.reason, 'occurrence_limit'); assert.equal(state.reported, false); assert.equal(state.occurrenceRecorded, false);
        const job = f.queue.enqueue({ requestId: 'new-native-blocked', kind: 'chat', payload: { message: 'fixture' } }); f.store.run("UPDATE jobs SET state='failed',updated_at=? WHERE id=?", at, job.id);
        const outcome = f.runtime.reportEvidence('job', job.id, at) as any; assert.equal(outcome.status, 'blocked'); assert.equal(outcome.reported, false); assert.equal(outcome.reason, 'occurrence_limit');
        f.runtime.scan(at); assert.equal(f.runtime.issues()[0]!.status, 'resolved'); assert.equal(f.store.get<string[]>('runtimeImprovementOccurrences')!.length, MAX_RUNTIME_OCCURRENCES);
        assert.equal(f.store.all('SELECT * FROM operations').length, 0); assert.equal(f.store.get('enabled'), true);
    } finally { f.close(); }
});

test('issue and revision limits persist explicit blocked outcomes while known old observations remain harmless', () => {
    const f = fixture(), g = fixture(); try {
        const first = f.runtime.observe(observation(), at)!;
        for (let i = 1; i < 8; i++) f.runtime.observe(observation({ affectedVersion: `${i}.0.0` }), at);
        const retained = f.store.get<string[]>('runtimeImprovementOccurrences')!.length;
        assert.equal(f.runtime.observe(observation({ affectedVersion: '8.0.0' }), at), undefined); assert.equal(f.store.get('runtimeAdvisoryCapacity').reason, 'revision_limit');
        assert.equal(f.store.get<string[]>('runtimeImprovementOccurrences')!.length, retained);
        f.runtime.resolve(first.issue.id, hash('verified eight revisions')); f.runtime.observe(observation(), at); assert.equal(f.runtime.issues()[0]!.status, 'resolved'); assert.equal(f.runtime.issues()[0]!.revisions.length, 8);
        for (let i = 0; i < 100; i++) g.runtime.observe(observation({ component: 'diagnostics', classification: 'data_gap', facts: ['coverage_gap'], impact: 'data_unavailable', receipt: hash('distinct source-' + i) }), at);
        const job = g.queue.enqueue({ requestId: 'new-issue-beyond-cap', kind: 'chat', payload: { message: 'fixture' } }); g.store.run("UPDATE jobs SET state='failed',updated_at=? WHERE id=?", at, job.id);
        const outcome = g.runtime.reportEvidence('job', job.id, at) as any; assert.equal(outcome.status, 'blocked'); assert.equal(outcome.reason, 'issue_limit'); assert.equal(outcome.reported, false);
        assert.equal(g.runtime.issues().length, 100); assert.equal(g.store.get('runtimeAdvisoryCapacity').retainedIssues, 100);
    } finally { f.close(); g.close(); }
});

test('verified collector/diagnostic snapshots reopen only on newer source evidence; open unchanged snapshots use fixed watermarks without ledger growth', () => {
    const f = fixture(); try {
        for (const source of ['collector','lndg'] as const) {
            const set = (stamp: string) => source === 'collector' ? f.store.set('collector', { at: stamp, ok: false }) : f.store.set('diagnostics', { at: stamp, lndg: { status: 'qualified', coverage: { complete: false } } });
            set(at); const outcome = f.runtime.reportEvidence(source, source, at) as any; assert.ok(outcome.issueId);
            const id = outcome.issueId; f.runtime.resolve(id, hash('snapshot-runtime-verified-' + source));
            f.runtime.reportEvidence(source, source, at); assert.equal(f.runtime.issues().find(i => i.id === id)!.status, 'resolved');
            set('2026-10-10T10:01:00Z'); f.runtime.reportEvidence(source, source, at);
            assert.equal(f.runtime.issues().find(i => i.id === id)!.status, 'open'); assert.equal(f.runtime.issues().find(i => i.id === id)!.revisions.length, 2);
            const retained = f.store.get<string[]>('runtimeImprovementOccurrences')!.length;
            for (let i = 0; i < 100; i++) { set(new Date(Date.parse(at) + (i + 3) * 30000).toISOString()); f.runtime.reportEvidence(source, source, at); }
            assert.equal(f.store.get<string[]>('runtimeImprovementOccurrences')!.length, retained); assert.equal(f.runtime.issues().find(i => i.id === id)!.revisions.length, 2);
            f.runtime.resolve(id, hash('snapshot-next-verified-' + source));
            // A non-retained older snapshot is explicitly stale, not a new occurrence or duplicate assertion.
            set('2026-10-10T10:15:00Z'); const stale = f.runtime.reportEvidence(source, source, at) as any;
            assert.equal(stale.status, 'blocked'); assert.equal(stale.reason, 'stale_source_snapshot'); assert.equal(stale.reported, false); assert.equal(stale.boundedCapacityReached, false);
            assert.equal(f.runtime.issues().find(i => i.id === id)!.status, 'resolved');
            set('2026-10-10T11:30:00Z'); f.runtime.reportEvidence(source, source, at); assert.equal(f.runtime.issues().find(i => i.id === id)!.status, 'open'); assert.equal(f.runtime.issues().find(i => i.id === id)!.revisions.length, 3);
        }
        assert.equal(Object.keys(f.store.get('runtimeSnapshotWatermarks')!).length, 2);
    } finally { f.close(); }
});
