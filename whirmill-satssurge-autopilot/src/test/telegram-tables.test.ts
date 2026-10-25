import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../store.js';
import { Queue } from '../queue.js';
import { ApplicationControl } from '../application-control.js';
import { Telegram, telegramRichHtml } from '../telegram.js';
import { TelegramTurns } from '../telegram-turns.js';
import { unsolicitedFixture } from './telegram-unsolicited-fixture.js';

const at = new Date().toISOString();
const table = '| Canale | Saldo locale | Quota della capacità |\n|---|---:|---:|\n| **NiceHash** | 13.471 sat | 2,7% |\n| LNMarkets | 75.561 sat | 7,6% |';

test('Markdown tables render as labelled list items instead of raw pipes', () => {
    const html = telegramRichHtml('Liquidità:\n\n' + table + '\n\nFine.');
    assert.equal(html, '<p>Liquidità:</p><ul>'
        + '<li><p><b>NiceHash</b> — Saldo locale: 13.471 sat · Quota della capacità: 2,7%</p></li>'
        + '<li><p><b>LNMarkets</b> — Saldo locale: 75.561 sat · Quota della capacità: 7,6%</p></li>'
        + '</ul><p>Fine.</p>');
    assert.doesNotMatch(html, /\|/);
    // Pipes without a separator row, and escaped markup inside cells, stay plain text.
    assert.equal(telegramRichHtml('a | b | c'), '<p>a | b | c</p>');
    assert.equal(telegramRichHtml('| <x> | y |\n|---|---|\n| <b> | & |'), '<ul><li><p><b>&lt;b&gt;</b> — y: &amp;</p></li></ul>');
});

test('a final recorded with the v1 grammar is still delivered with its original layout', async () => {
    const calls: any[] = [], directory = mkdtempSync(join(tmpdir(), 'telegram-tables-')), store = new Store(':memory:'), queue = new Queue(store);
    const unsolicited = unsolicitedFixture(store), control = new ApplicationControl(store, queue), turns = new TelegramTurns(store, queue);
    const telegram = new Telegram(store, control, directory, { call: async (method, body) => await unsolicited.acknowledge(method, body) ?? (calls.push({ method, body }), { message_id: 5 }) });
    try {
        store.set('bootstrapReady', true); store.set('telegramConfigured', true);
        store.set('telegramBinding', { generation: 'tables-owner', chatId: 42, userId: 42, since: new Date(Date.parse(at) - 60000).toISOString() });
        const job = control.admit('tables', 'Liquidità?', 'telegram'); turns.attach(job, 'tables-owner', 42); store.set('jobTelegramGeneration:' + job.id, 'tables-owner');
        const claimed = queue.claim('coordinator', 'tables-test', at)!; turns.bind(claimed, { steer: async () => {}, stop: async () => {} });
        queue.finish(job.id, claimed.run_token!, 'completed', { answer: table }, at); turns.finalize(job.id, 'completed');
        telegram.capture(at);
        const key = 'telegramRichFinal:answer:' + job.id, v2 = store.get<any>(key);
        assert.equal(v2.format, 'rich-blocks-v2'); assert.equal(v2.blocks, 5);
        // Simulate a final committed by 0.5.19 before the upgrade: one paragraph, pipes kept.
        const v1Html = '<p>' + table.split('\n').map(line => line.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')).join('<br>') + '</p>';
        store.set(key, { ...v2, format: 'rich-blocks-v1', blocks: 1, depth: 2, htmlBytes: Buffer.byteLength(v1Html, 'utf8') });
        await telegram.deliver(at);
        const sent = calls.find(c => c.method === 'sendRichMessage');
        assert.ok(sent, 'v1 final was not delivered'); assert.equal(JSON.stringify(sent.body).includes('| LNMarkets |'), true);
    } finally { unsolicited.verify(); telegram.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});
