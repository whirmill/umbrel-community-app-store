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
const chat = { from: { id: 42 }, chat: { id: 42, type: 'private' } };
function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'reset-command-')), store = new Store(':memory:'), queue = new Queue(store);
    const control = new ApplicationControl(store, queue), telegram = new Telegram(store, control, dir, { call: async () => ({ message_id: 1 }) });
    store.set('telegramConfigured', true); store.set('telegramBinding', { generation: 'g', userId: 42, chatId: 42, since: iso(sent - 200) });
    return { store, queue, control, telegram, turns: new TelegramTurns(store, queue), close() { telegram.stop(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const reply = (store: Store, event: string) => store.one('SELECT text FROM telegram_outbox WHERE event_id=?', event)?.text as string | undefined;

test('/reset asks for confirmation, then starts a new conversation epoch once', async () => {
    const f = fixture(); try {
        const job = f.control.admit('earlier', 'Spiega lo stato', 'telegram'); f.turns.attach(job, 'g', 42);
        const before = f.turns.sessionKey(f.turns.get(job.id)!);
        f.turns.finalize(job.id, 'completed');
        f.telegram.ingest([{ update_id: 1, message: { text: '/reset', date: sent, ...chat } }]); await f.telegram.process(iso(sent + 1));
        assert.match(reply(f.store, 'update:1')!, /^Ripartire da una conversazione nuova\?/);
        assert.equal(f.turns.epoch(), 0, 'the command alone changes nothing');
        const callback = f.store.get<any>('telegramButtons:update:1').inline_keyboard[0][0].callback_data;
        f.telegram.ingest([{ update_id: 2, callback_query: { id: 'confirm', data: callback, from: { id: 42 }, message: { chat: { id: 42, type: 'private' } } } }]); await f.telegram.process(iso(sent + 2));
        assert.match(reply(f.store, 'update:2')!, /^Conversazione nuova/);
        assert.equal(f.turns.epoch(), 1);
        assert.notEqual(f.turns.sessionKey(f.turns.get(job.id)!), before);
        f.telegram.ingest([{ update_id: 3, callback_query: { id: 'again', data: callback, from: { id: 42 }, message: { chat: { id: 42, type: 'private' } } } }]); await f.telegram.process(iso(sent + 3));
        assert.equal(f.turns.epoch(), 1, 'a stale button does not reset twice');
    } finally { f.close(); }
});

test('/reset is refused while a Telegram turn is open, and the epoch key leaves epoch 0 unchanged', async () => {
    const f = fixture(); try {
        const job = f.control.admit('pending', 'Analizza', 'telegram'); f.turns.attach(job, 'g', 42);
        const key = f.turns.sessionKey(f.turns.get(job.id)!);
        f.telegram.ingest([{ update_id: 1, message: { text: '/reset', date: sent, ...chat } }]); await f.telegram.process(iso(sent + 1));
        assert.match(reply(f.store, 'update:1')!, /^Ci sono risposte in corso o in coda/);
        assert.equal(f.store.get('telegramButtons:update:1'), undefined);
        assert.equal(f.turns.reset('g', 0), false); assert.equal(f.turns.epoch(), 0);
        assert.equal(f.turns.sessionKey(f.turns.get(job.id)!), key);
    } finally { f.close(); }
});
