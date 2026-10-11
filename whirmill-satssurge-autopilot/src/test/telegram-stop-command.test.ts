import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.js';
import { Queue } from '../queue.js';
import { ApplicationControl } from '../application-control.js';
import { Telegram } from '../telegram.js';
import { TelegramTurns } from '../telegram-turns.js';

const sent = Math.floor(Date.now() / 1000), iso = (seconds: number) => new Date(seconds * 1000).toISOString();
function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'stop-command-')), store = new Store(':memory:'), queue = new Queue(store);
    const control = new ApplicationControl(store, queue), telegram = new Telegram(store, control, dir, { call: async () => ({ message_id: 1 }) });
    const turns = new TelegramTurns(store, queue), stopped: string[] = [];
    store.set('telegramConfigured', true); store.set('telegramBinding', { generation: 'g', userId: 42, chatId: 42, since: iso(sent - 200) });
    return { store, queue, telegram, turns, stopped,
        open(request: string, started: number) {
            const job = control.admit(request, 'Spiega lo stato', 'telegram'); turns.attach(job, 'g', 42);
            const claimed = queue.claim('coordinator', 'isolated-test', iso(started))!;
            turns.bind(claimed, { steer: async () => {}, stop: async () => { stopped.push(job.id); queue.finish(job.id, claimed.run_token!, 'failed', 'owner stop', iso(sent + 3)); turns.finalize(job.id, 'interrupted'); } });
            return { job, claimed };
        }, close() { telegram.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); }
    };
}
const command = (id: number, date: unknown = sent) => ({ update_id: id, message: { text: '/stop', date, from: { id: 42 }, chat: { id: 42, type: 'private' } } });
const settled = () => new Promise<void>(resolve => setImmediate(resolve));

test('delayed generic Stop preserves completed original, later active turn, future turn and incoming bytes', async () => {
    const f = fixture(); try {
        const old = f.open('original', sent - 20);
        f.queue.finish(old.job.id, old.claimed.run_token!, 'completed', { answer: 'Original answer' }, iso(sent + 1)); f.turns.finalize(old.job.id, 'completed');
        const current = f.open('later', sent + 2), future = new ApplicationControl(f.store, f.queue).admit('future', 'Future request', 'telegram'); f.turns.attach(future, 'g', 42);
        const before = [f.queue.get(old.job.id), f.turns.get(old.job.id), f.queue.get(current.job.id), f.turns.get(current.job.id), f.queue.get(future.id), f.turns.get(future.id)];
        f.telegram.ingest([command(1)]); const body = f.store.one('SELECT body FROM telegram_updates WHERE update_id=1').body;
        await f.telegram.process(iso(sent + 3)); await settled();
        assert.deepEqual([f.queue.get(old.job.id), f.turns.get(old.job.id), f.queue.get(current.job.id), f.turns.get(current.job.id), f.queue.get(future.id), f.turns.get(future.id)], before);
        assert.deepEqual(f.stopped, []); assert.equal(f.store.get('telegramStop:update:1'), undefined);
        assert.equal(f.store.one('SELECT body FROM telegram_updates WHERE update_id=1').body, body);
        assert.match(f.store.one("SELECT text FROM telegram_outbox WHERE event_id='update:1'").text, /Nessuna risposta è stata interrotta.*Usa Stop/);
        assert.equal(f.store.one("SELECT event_id FROM telegram_outbox WHERE event_id='update:1:stopped'"), undefined);
        const callback = f.store.get<any>('telegramButtons:update:1').inline_keyboard[0][0].callback_data;
        assert.equal(f.store.get<any>('telegramCallback:' + callback).id, current.job.id);
    } finally { f.close(); }
});

test('timely generic Stop releases only the exact original and duplicate update cannot stop its successor', async () => {
    const f = fixture(); try {
        const original = f.open('original', sent - 2);
        f.telegram.ingest([command(2)]); await f.telegram.process(iso(sent + 3)); await settled();
        assert.deepEqual(f.stopped, [original.job.id]); assert.equal(f.turns.get(original.job.id)!.state, 'interrupted');
        const receipt = f.store.get<any>('telegramStop:update:2'); assert.equal(receipt.jobId, original.job.id); assert.equal(receipt.state, 'idle_confirmed');
        const next = f.open('successor', sent + 4);
        f.telegram.ingest([command(2)]); await f.telegram.process(iso(sent + 5)); await settled();
        assert.deepEqual(f.stopped, [original.job.id]); assert.deepEqual(f.store.get('telegramStop:update:2'), receipt); assert.equal(f.turns.get(next.job.id)!.state, 'running');
    } finally { f.close(); }
});

for (const [label, date, started] of [
    ['same second', sent, iso(sent)], ['unknown start', sent, null], ['invalid start', sent, 'unknown'],
    ['missing date', undefined, iso(sent - 2)], ['zero date', 0, iso(sent - 2)], ['negative date', -1, iso(sent - 2)],
    ['fractional date', sent + .5, iso(sent - 2)], ['string date', String(sent), iso(sent - 2)], ['unsafe date', Number.MAX_SAFE_INTEGER + 1, iso(sent - 2)]
] as const) test('ambiguous generic Stop fails closed: ' + label, async () => {
    const f = fixture(); try {
        const { job } = f.open('active', sent - 2); f.store.run('UPDATE jobs SET started_at=? WHERE id=?', started, job.id);
        const update = command(3, date); if (date === undefined) delete (update.message as any).date;
        f.telegram.ingest([update]); await f.telegram.process(iso(sent + 3)); await settled();
        assert.deepEqual(f.stopped, []); assert.equal(f.turns.get(job.id)!.state, 'running'); assert.equal(f.queue.get(job.id)!.state, 'running');
        assert.equal(f.store.get('telegramStop:update:3'), undefined); assert.match(f.store.one("SELECT text FROM telegram_outbox WHERE event_id='update:3'").text, /Non posso collegare \/stop/);
    } finally { f.close(); }
});

test('explicit callback offered after ambiguous Stop still targets its exact turn', async () => {
    const f = fixture(); try {
        const { job } = f.open('active', sent);
        f.telegram.ingest([command(4)]); await f.telegram.process(iso(sent + 3));
        const callback = f.store.get<any>('telegramButtons:update:4').inline_keyboard[0][0].callback_data;
        f.telegram.ingest([{ update_id: 5, callback_query: { id: 'owner-choice', data: callback, from: { id: 42 }, message: { chat: { id: 42, type: 'private' } } } }]);
        await f.telegram.process(iso(sent + 3)); await settled(); assert.deepEqual(f.stopped, [job.id]); assert.equal(f.store.get<any>('telegramStop:update:5').state, 'idle_confirmed');
    } finally { f.close(); }
});

test('native Stop alias remains functional without a generic message date', async () => {
    const f = fixture(); try {
        const { job } = f.open('native', sent); await f.telegram.streamDrafts(iso(sent + 1));
        const draft = f.store.get<any>('telegramStream:' + job.id).draftId;
        f.telegram.ingest([{ update_id: 6, stopped_message_generation: { chat: { id: 42, type: 'private' }, draft_id: draft } }]);
        await f.telegram.process(iso(sent + 3)); await settled(); assert.deepEqual(f.stopped, [job.id]); assert.equal(f.store.get<any>('telegramStop:update:6').state, 'idle_confirmed');
    } finally { f.close(); }
});
