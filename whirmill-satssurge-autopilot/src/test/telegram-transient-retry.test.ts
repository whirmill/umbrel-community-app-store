import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../store.js';
import { Queue } from '../queue.js';
import { ApplicationControl } from '../application-control.js';
import { Telegram } from '../telegram.js';
import { TelegramTurns } from '../telegram-turns.js';
import { unsolicitedFixture } from './telegram-unsolicited-fixture.js';

const at = new Date().toISOString(), later = (ms: number) => new Date(Date.parse(at) + ms).toISOString();

function fixture() {
    const directory = mkdtempSync(join(tmpdir(), 'telegram-retry-')), store = new Store(':memory:'), queue = new Queue(store);
    const unsolicited = unsolicitedFixture(store);
    const control = new ApplicationControl(store, queue), telegram = new Telegram(store, control, directory, { call: async (method, body) => await unsolicited.acknowledge(method, body) ?? { message_id: 71 } }), turns = new TelegramTurns(store, queue);
    store.set('bootstrapReady', true); store.set('telegramConfigured', true);
    store.set('telegramBinding', { generation: 'retry-owner', chatId: 42, userId: 42, since: later(-60000) });
    const fail = (job: { id: string }, kind: string, failedAt = at) => {
        const claimed = queue.claim('coordinator', 'retry-test', at)!; assert.equal(claimed.id, job.id);
        store.set('providerFailure:' + job.id, { jobId: job.id, conversationId: '1', submissionId: '2', taskId: '3', entryId: '4', source: 'native_entry', kind, code: 'connection_error', at: failedAt, cooldownMs: 60000, until: new Date(Date.parse(failedAt) + 60000).toISOString() });
        queue.finish(job.id, claimed.run_token!, 'failed', 'Model unavailable; original submission terminal, no automatic replay', at); turns.finalize(job.id, 'failed');
    };
    const open = (request: string, message = 'stato del nodo?') => {
        const job = control.admit(request, message, 'telegram'); turns.attach(job, 'retry-owner', 42); store.set('jobTelegramGeneration:' + job.id, 'retry-owner'); return job;
    };
    const retryOf = (id: string) => store.one('SELECT * FROM jobs WHERE request_id=?', 'telegram-retry:' + id);
    return { store, queue, telegram, open, fail, retryOf, close() { unsolicited.verify(); telegram.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('a read-only turn cut by a transient network error is asked again once after the cooldown', () => {
    const f = fixture();
    try {
        const job = f.open('telegram:1'); f.fail(job, 'transient_network');
        f.telegram.capture(at);
        assert.match(f.store.one('SELECT text FROM telegram_outbox WHERE event_id=?', 'answer:' + job.id).text, /Riprovo automaticamente una volta/);
        assert.equal(f.retryOf(job.id), undefined);
        f.telegram.capture(later(61000)); f.telegram.capture(later(62000));
        const retry = f.retryOf(job.id);
        assert.equal(JSON.parse(retry.payload).message, 'stato del nodo?');
        assert.equal(f.store.get('jobCapability:' + retry.id), 'read_only_chat');
        assert.deepEqual(f.store.get('telegramLinkedRequest:' + retry.id), { priorTurn: job.id, retryOf: job.id });
        assert.equal(f.store.one("SELECT count(*) n FROM jobs WHERE request_id LIKE 'telegram-retry:%'").n, 1);
        // A retry that fails again is reported normally and never retried a second time.
        f.fail(retry, 'transient_stream', later(63000)); f.telegram.capture(later(130000));
        assert.equal(f.retryOf(retry.id), undefined);
        assert.match(f.store.one('SELECT text FROM telegram_outbox WHERE event_id=?', 'answer:' + retry.id).text, /Risposta interrotta o non completata/);
    } finally { f.close(); }
});

test('authentication failures, stale failures and non-native receipts are not retried', () => {
    const f = fixture();
    try {
        const auth = f.open('telegram:2'); f.fail(auth, 'authentication');
        const stale = f.open('telegram:3'); f.fail(stale, 'transient_network', later(-700000));
        const legacy = f.open('telegram:4'); f.fail(legacy, 'transient_network'); f.store.set('providerFailure:' + legacy.id, { ...f.store.get<any>('providerFailure:' + legacy.id), source: 'native_submission' });
        f.telegram.capture(later(61000));
        for (const job of [auth, stale, legacy]) {
            assert.equal(f.retryOf(job.id), undefined);
            assert.match(f.store.one('SELECT text FROM telegram_outbox WHERE event_id=?', 'answer:' + job.id).text, /Risposta interrotta o non completata/);
        }
    } finally { f.close(); }
});
