import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../store.js';
import { Queue } from '../queue.js';
import { ApplicationControl } from '../application-control.js';
import { Telegram, telegramClean, telegramRichHtml, telegramParts } from '../telegram.js';
import { TelegramTurns } from '../telegram-turns.js';
import { UiEvents } from '../ui-events.js';
import { hash } from '../domain.js';

const at = new Date().toISOString();
async function scannerAdvisory(method: string, body: any, store: Store) {
    const document = method === 'sendDocument' && body instanceof FormData ? body.get('document') as File : undefined;
    if (!document || !/^satssurge-[a-f0-9]{16}-r\d+\.txt$/.test(document.name)) return false;
    // Only an independently correlated immutable advisory may be excluded from
    // response replay accounting, regardless of the current quiet-hours window.
    const artifact = store.all("SELECT value FROM meta WHERE key LIKE 'runtimeArtifact:advisory:%'").map(row => JSON.parse(row.value)).find(a => a.filename === document.name);
    assert.ok(artifact); assert.equal(hash(await document.text()), artifact.checksum); assert.equal(body.get('chat_id'), String(artifact.chatId));
    return true;
}

function fixture(call: (method: string, body: any) => Promise<any> = async () => ({ message_id: 71 }), path = ':memory:') {
    const directory = mkdtempSync(join(tmpdir(), 'telegram-composition-')), store = new Store(path), queue = new Queue(store);
    const control = new ApplicationControl(store, queue), telegram = new Telegram(store, control, directory, { call }), turns = new TelegramTurns(store, queue);
    store.set('bootstrapReady', true); store.set('telegramConfigured', true);
    store.set('telegramBinding', { generation: 'composition-owner', chatId: 42, userId: 42, since: new Date(Date.parse(at) - 60000).toISOString() });
    return { store, queue, control, telegram, turns,
        open(request = 'composition') {
            const job = control.admit(request, 'Spiega lo stato corrente', 'telegram'); turns.attach(job, 'composition-owner', 42);
            store.set('jobTelegramGeneration:' + job.id, 'composition-owner');
            const claimed = queue.claim('coordinator', 'composition-test', at)!;
            turns.bind(claimed, { steer: async () => {}, stop: async () => {} }); return { job, claimed };
        }, complete(answer: string) {
            const { job, claimed } = this.open(); queue.finish(job.id, claimed.run_token!, 'completed', { answer }, at); turns.finalize(job.id, 'completed'); return job;
        }, close() { telegram.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); }
    };
}

test('legacy composition preserves exact words and Unicode at transport boundaries', () => {
    const answer = 'word '.repeat(699) + 'riferirsi alla stessa vista, attestare gli scenari.\n\n' + ('Nodo 😀 👩‍💻 e\u0301 disponibile.\n').repeat(500);
    const parts = telegramParts(answer);
    assert.equal(parts.join(''), telegramClean(answer)); assert.equal(hash(parts.join('')), hash(telegramClean(answer)));
    assert.ok(parts.every(p => p.length <= 3500));
    for (let i = 1; i < parts.length; i++) {
        assert.ok(!(/[\p{L}\p{N}]$/u.test(parts[i - 1]!) && /^[\p{L}\p{N}]/u.test(parts[i]!)), 'a normal word was cut');
        assert.doesNotMatch(parts[i]!, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
    }
});

test('legacy boundaries keep family emoji and combining marks including whitespace clusters whole', () => {
    const answer = 'nodo \u0301👩‍👩‍👧‍👦 e\u0301 '.repeat(600), parts = telegramParts(answer);
    const boundaries = new Set([...new Intl.Segmenter('it', { granularity: 'grapheme' }).segment(answer)].map(s => s.index + s.segment.length));
    let end = 0; for (const part of parts) { end += part.length; assert.ok(boundaries.has(end)); assert.ok(part.length <= 3500); }
    assert.equal(parts.join(''), answer);
});

test('default stable draft retains one identity on text updates and heartbeat', async () => {
    const calls: any[] = [], f = fixture(async (method, body) => { calls.push({ method, body }); return true; });
    try {
        const { job } = f.open(); const events = new UiEvents(f.store);
        events.append(job.id, 'text', { text: 'Prima frase pubblica.' }); await f.telegram.streamDrafts(at);
        events.append(job.id, 'text', { text: 'Prima frase pubblica. Seconda frase.' }); await f.telegram.streamDrafts(new Date(Date.parse(at) + 1100).toISOString());
        await f.telegram.streamDrafts(new Date(Date.parse(at) + 22000).toISOString());
        assert.equal(f.telegram.status().richDraftPolicy, 'stable'); assert.equal(f.store.get('telegramRichDraftPolicy'), undefined);
        assert.equal(calls.length, 3); assert.equal(new Set(calls.map(c => c.body.draft_id)).size, 1);
        assert.equal(f.store.all("SELECT key FROM meta WHERE key LIKE 'telegramDraft:%'").length, 1);
    } finally { f.close(); }
});

test('long preview is an honest coherent prefix rather than overlapping rolling tails', async () => {
    const calls: any[] = [], f = fixture(async (method, body) => { calls.push({ method, body }); return true; });
    try {
        const { job } = f.open(), events = new UiEvents(f.store), answer = '# Stato corrente\n\n' + 'Una frase completa e verificabile. '.repeat(300);
        events.append(job.id, 'text', { text: answer }); await f.telegram.streamDrafts(at);
        const first = f.store.get<any>('telegramStream:' + job.id).text;
        assert.ok(first.startsWith('# Stato corrente\n\n')); assert.match(first, /Anteprima parziale/); assert.ok(first.length <= 3500);
        events.append(job.id, 'text', { text: answer + ' Ultima frase.' }); await f.telegram.streamDrafts(new Date(Date.parse(at) + 22000).toISOString());
        assert.equal(f.store.get<any>('telegramStream:' + job.id).text, first); assert.equal(calls[0].body.draft_id, calls[1].body.draft_id);
        assert.equal(JSON.parse(f.store.one('SELECT data FROM ui_events WHERE job_id=? AND type=\'text\' ORDER BY id DESC LIMIT 1', job.id).data).text, answer + ' Ultima frase.');
    } finally { f.close(); }
});

test('bounded complete response becomes one rich message with safe HTML and exact canonical outbox text', async () => {
    const calls: any[] = [], f = fixture(async (method, body) => { calls.push({ method, body }); return { message_id: 71 }; });
    try {
        const answer = '# Stato\n\n**Dato pubblico** e `ricevuta`. <img src="https://invalid.example/private">\n\n' + 'Una risposta completa senza tagli di parole. '.repeat(300);
        const job = f.complete(answer); f.telegram.capture(at); const event = 'answer:' + job.id;
        const rows = f.store.all('SELECT * FROM telegram_outbox WHERE event_id LIKE ?', event + '%');
        assert.equal(rows.length, 1); assert.equal(rows[0].text, telegramClean(answer));
        await f.telegram.deliver(at); const sent = calls.filter(c => c.method === 'sendRichMessage');
        assert.equal(sent.length, 1); assert.deepEqual(sent[0].body.rich_message, { html: telegramRichHtml(answer) });
        assert.ok(!('allow_paid_broadcast' in sent[0].body)); assert.ok(!('media' in sent[0].body.rich_message));
        assert.match(sent[0].body.rich_message.html, /&lt;img/); assert.doesNotMatch(sent[0].body.rich_message.html, /<img/);
        assert.equal(f.store.one('SELECT status,message_id FROM telegram_outbox WHERE event_id=?', event).status, 'sent');
        const saved = f.store.one('SELECT * FROM telegram_outbox WHERE event_id=?', event); f.telegram.capture(at); await f.telegram.deliver(at);
        assert.deepEqual(f.store.one('SELECT * FROM telegram_outbox WHERE event_id=?', event), saved); assert.equal(calls.filter(c => c.method === 'sendRichMessage').length, 1);
    } finally { f.close(); }
});

for (const apiCode of [400,404]) test('known rich API ' + apiCode + ' uses exact deterministic text attachment on the next bounded attempt', async () => {
    const calls: any[] = [], f = fixture(async (method, body) => {
        if (method === 'sendRichMessage') { calls.push({ method }); throw Object.assign(Error('known rejection'), { rejected: true, apiCode }); }
        if (method === 'sendDocument') { const document = body.get('document') as File; calls.push({ method, text: await document.text(), filename: document.name, type: document.type, chatId: body.get('chat_id'), buttons: body.get('reply_markup') }); }
        return { message_id: 72 };
    });
    try {
        const answer = 'Risposta completa 😀.\n\n' + 'Evidenza pubblica verificata. '.repeat(180), job = f.complete(answer), event = 'answer:' + job.id;
        f.telegram.capture(at); const original = f.store.one('SELECT value FROM meta WHERE key=?', 'telegramRichFinal:' + event).value;
        await f.telegram.deliver(at); assert.deepEqual(calls.map(c => c.method), ['sendRichMessage']);
        assert.equal(f.store.one('SELECT status FROM telegram_outbox WHERE event_id=?', event).status, 'pending');
        assert.equal(f.store.get<any>('telegramRichFinalFallback:' + event).apiCode, apiCode);
        await f.telegram.deliver(at); assert.equal(calls.length, 1);
        await f.telegram.deliver(new Date(Date.parse(at) + 3000).toISOString());
        assert.equal(calls.length, 2); assert.equal(calls[1].method, 'sendDocument'); assert.equal(calls[1].text, telegramClean(answer));
        assert.equal(hash(calls[1].text), hash(telegramClean(answer))); assert.match(calls[1].filename, /^satssurge-response-[a-f0-9]{16}\.txt$/);
        assert.equal(calls[1].chatId, '42'); assert.equal(calls[1].type, 'text/plain;charset=utf-8'); assert.ok(JSON.parse(calls[1].buttons).inline_keyboard.length);
        assert.equal(f.store.one('SELECT text,status,attempts FROM telegram_outbox WHERE event_id=?', event).text, telegramClean(answer));
        assert.equal(f.store.one('SELECT status,attempts FROM telegram_outbox WHERE event_id=?', event).status, 'sent');
        assert.equal(f.store.one('SELECT status,attempts FROM telegram_outbox WHERE event_id=?', event).attempts, 2);
        assert.equal(f.store.one('SELECT value FROM meta WHERE key=?', 'telegramRichFinal:' + event).value, original);
        f.telegram.capture(at); f.telegram.recover(); await f.telegram.deliver(new Date(Date.parse(at) + 6000).toISOString()); assert.equal(calls.length, 2);
    } finally { f.close(); }
});

for (const failure of ['unknown', 'server500', 'missing_ack', 'missing_code', 'malformed_code', 'unproven_code']) test('persistent rich ' + failure + ' remains uncertain without retry or channel fallback', async () => {
    const calls: string[] = [], f = fixture(async (method, body) => {
        if (method === 'sendRichMessage') { calls.push(method); if (failure === 'server500') throw Object.assign(Error('server failure'), { rejected: true, apiCode: 500 }); if (failure === 'unknown') throw Error('accepted then disconnected'); if (failure.endsWith('_code')) throw Object.assign(Error('unproved denial'), { rejected: true, ...(failure === 'malformed_code' ? { apiCode: '400' } : failure === 'unproven_code' ? { apiCode: 499 } : {}) }); return {}; }
        if (method === 'sendDocument' && !await scannerAdvisory(method, body, f.store)) calls.push(method);
        return { message_id: 73 };
    });
    try {
        const job = f.complete('Una risposta completa.'), event = 'answer:' + job.id; f.telegram.capture(at); await f.telegram.deliver(at);
        assert.equal(f.store.one('SELECT status FROM telegram_outbox WHERE event_id=?', event).status, 'uncertain');
        assert.equal(f.store.get('telegramRichFinalFallback:' + event), undefined);
        f.telegram.recover(); f.telegram.capture(at); await f.telegram.deliver(new Date(Date.parse(at) + 100000).toISOString()); assert.deepEqual(calls, ['sendRichMessage']);
    } finally { f.close(); }
});

for (const failure of ['unknown','server500']) test('four known rejections followed by fifth ' + failure + ' remain uncertain beyond the attempt budget', async () => {
    let attempts = 0; const calls: string[] = [], f = fixture(async method => {
        if (method === 'sendRichMessage') {
            calls.push(method); if (++attempts <= 4) throw Object.assign(Error('permission denied'), { rejected: true, apiCode: 403 });
            if (failure === 'server500') throw Object.assign(Error('server failure'), { rejected: true, apiCode: 500 }); throw Error('unknown network outcome');
        }
        if (method === 'sendDocument') calls.push(method); return { message_id: 81 };
    });
    try {
        const job = f.complete('Risposta con tentativi limitati.'), event = 'answer:' + job.id; f.telegram.capture(at);
        for (const seconds of [0,3,8,17,34]) await f.telegram.deliver(new Date(Date.parse(at) + seconds * 1000).toISOString());
        assert.equal(attempts, 5); assert.equal(f.store.one('SELECT status,attempts FROM telegram_outbox WHERE event_id=?', event).status, 'uncertain');
        assert.equal(f.store.get('telegramRichFinalFallback:' + event), undefined); f.telegram.recover(); await f.telegram.deliver(new Date(Date.parse(at) + 1000000).toISOString());
        assert.deepEqual(calls, Array(5).fill('sendRichMessage'));
    } finally { f.close(); }
});

test('rich outbound deadline stays uncertain without document fallback or replay', { timeout: 10000 }, async () => {
    const calls: string[] = [], f = fixture(async method => { if (method === 'sendRichMessage') { calls.push(method); return new Promise(() => {}); } if (method === 'sendDocument') calls.push(method); return { message_id: 74 }; });
    try {
        const job = f.complete('Risposta con invio sospeso.'), event = 'answer:' + job.id; f.telegram.capture(at); await f.telegram.deliver(at);
        assert.equal(f.store.one('SELECT status FROM telegram_outbox WHERE event_id=?', event).status, 'uncertain'); assert.equal(f.store.get('telegramRichFinalFallback:' + event), undefined);
        f.telegram.recover(); await f.telegram.deliver(new Date(Date.parse(at) + 100000).toISOString()); assert.deepEqual(calls, ['sendRichMessage']);
    } finally { f.close(); }
});

test('rich 429 preserves shared quota and original method, then retries only after the gate', async () => {
    const calls: string[] = []; let richCalls = 0; const f = fixture(async method => {
        calls.push(method); if (method === 'sendRichMessage' && ++richCalls === 1) throw Object.assign(Error('rate limited'), { rejected: true, apiCode: 429, retryAfter: 120 }); return { message_id: 75 };
    });
    try {
        const job = f.complete('Risposta limitata.'), event = 'answer:' + job.id; f.telegram.capture(at); f.telegram.enqueue('later', 'Un altro messaggio.', 'reply', undefined, at);
        await f.telegram.deliver(at); assert.deepEqual(calls, ['sendRichMessage']); assert.equal(f.store.get('telegramRichFinalFallback:' + event), undefined);
        const until = f.store.get<number>('telegramRateLimitUntil')!; await f.telegram.deliver(new Date(until - 1).toISOString()); assert.equal(calls.length, 1);
        await f.telegram.deliver(new Date(until + 1).toISOString()); assert.equal(calls.filter(c => c === 'sendRichMessage').length, 2); assert.equal(calls.includes('sendDocument'), false);
        assert.equal(f.store.one('SELECT status FROM telegram_outbox WHERE event_id=?', event).status, 'sent');
    } finally { f.close(); }
});

for (const transition of ['revoke','bot','chat']) test('known rich rejection after ' + transition + ' cannot admit a fallback to another identity', async () => {
    let calls = 0; const f = fixture(async method => {
        calls++; assert.equal(method, 'sendRichMessage');
        if (transition === 'revoke') f.telegram.revoke(); else if (transition === 'bot') f.store.set('telegramBotGeneration', 'replacement'); else f.store.set('telegramBinding', { ...f.store.get<any>('telegramBinding'), chatId: 43 });
        throw Object.assign(Error('rejected after authority changed'), { rejected: true, apiCode: 400 });
    });
    try {
        const job = f.complete('Una risposta con destinazione precisa.'), event = 'answer:' + job.id; f.telegram.capture(at); await f.telegram.deliver(at);
        assert.equal(f.store.get('telegramRichFinalFallback:' + event), undefined); assert.equal(f.store.one('SELECT status FROM telegram_outbox WHERE event_id=?', event).status, 'uncertain');
        assert.match(f.store.one('SELECT error FROM telegram_outbox WHERE event_id=?', event).error, /Delivery uncertain/);
        await f.telegram.deliver(new Date(Date.parse(at) + 100000).toISOString()); assert.equal(calls, 1);
    } finally { f.close(); }
});

test('oversize rich text or encoded HTML uses bounded coherent legacy parts with every canonical character preserved', async () => {
    for (const answer of ['Paragrafo pubblico 😀. '.repeat(2000), '&'.repeat(14000)]) {
        const calls: any[] = [], f = fixture(async (method, body) => { calls.push({ method, body }); return { message_id: 76 }; });
        try {
            const job = f.complete(answer), event = 'answer:' + job.id; f.telegram.capture(at);
            const rows = f.store.all('SELECT text FROM telegram_outbox WHERE event_id LIKE ? ORDER BY rowid', event + '%');
            assert.ok(rows.length > 1); assert.equal(rows.map(r => r.text).join(''), telegramClean(answer)); assert.ok(rows.every(r => r.text.length <= 3500));
            assert.equal(f.store.get('telegramRichFinal:' + event), undefined); await f.telegram.deliver(at); assert.equal(calls.some(c => c.method === 'sendRichMessage'), false);
        } finally { f.close(); }
    }
});

test('capture preserves historical multipart, partial, sent and uncertain receipts and their button bytes', () => {
    for (const states of [['sent','sent'], ['sent','pending'], ['uncertain','pending'], ['sending','pending']] as const) {
        const f = fixture(); try {
            const answer = 'Risposta storica. '.repeat(300), job = f.complete(answer), event = 'answer:' + job.id;
            // Reproduce the old fixed-unit composition, including its midword cut.
            for (const [i,text] of [answer.slice(0,3500),answer.slice(3500)].entries()) f.store.run('INSERT INTO telegram_outbox(event_id,created_at,kind,text,generation) VALUES(?,?,?,?,?)', i ? event + ':part:' + i : event, at, 'reply', text, 'composition-owner');
            const rows = f.store.all('SELECT * FROM telegram_outbox WHERE event_id LIKE ? ORDER BY rowid', event + '%'); assert.equal(rows.length, 2);
            for (let i = 0; i < rows.length; i++) f.store.run('UPDATE telegram_outbox SET status=?,message_id=?,attempts=1 WHERE event_id=?', states[i], i + 77, rows[i].event_id);
            f.store.set('telegramButtons:' + event, { originalHistoricalButtons: true });
            const before = f.store.all('SELECT * FROM telegram_outbox WHERE event_id LIKE ? ORDER BY rowid', event + '%'), buttonBytes = f.store.one('SELECT value FROM meta WHERE key=?', 'telegramButtons:' + event).value;
            f.telegram.capture(at); f.telegram.capture(at);
            assert.deepEqual(f.store.all('SELECT * FROM telegram_outbox WHERE event_id LIKE ? ORDER BY rowid', event + '%'), before);
            assert.equal(f.store.get('telegramRichFinal:' + event), undefined); assert.equal(f.store.one('SELECT value FROM meta WHERE key=?', 'telegramButtons:' + event).value, buttonBytes);
        } finally { f.close(); }
    }
});

test('interrupted turn keeps its truthful partial status and complete public text in the rich final', async () => {
    const calls: any[] = [], f = fixture(async (method, body) => { calls.push({ method, body }); return { message_id: 79 }; });
    try {
        const { job, claimed } = f.open(); const publicText = 'Testo ancora parziale 😀. '.repeat(180);
        new UiEvents(f.store).append(job.id, 'text', { text: publicText }); f.queue.finish(job.id, claimed.run_token!, 'failed', 'owner stop', at); f.turns.finalize(job.id, 'interrupted');
        f.telegram.capture(at); const row = f.store.one('SELECT text FROM telegram_outbox WHERE event_id=?', 'answer:' + job.id);
        assert.ok(row.text.startsWith(publicText)); assert.match(row.text, /Risposta interrotta o non completata/); await f.telegram.deliver(at);
        assert.equal(calls.filter(c => c.method === 'sendRichMessage').length, 1); assert.equal(f.queue.get(job.id)!.state, 'failed'); assert.equal(f.turns.get(job.id)!.state, 'interrupted');
    } finally { f.close(); }
});

test('interrupted sending rich intent survives Store reopen as uncertain and does not acquire a fallback', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rich-reopen-')), path = join(directory, 'operational.sqlite'); let event = '', composition = '';
    const f = fixture(undefined, path); try {
        const job = f.complete('Una ricevuta commessa.'); event = 'answer:' + job.id; f.telegram.capture(at); f.store.run("UPDATE telegram_outbox SET status='sending',attempts=1 WHERE event_id=?", event);
        composition = f.store.one('SELECT value FROM meta WHERE key=?', 'telegramRichFinal:' + event).value;
    } finally { f.close(); }
    const store = new Store(path), queue = new Queue(store); let calls = 0;
    const telegram = new Telegram(store, new ApplicationControl(store, queue), directory, { call: async (method, body) => { if (!await scannerAdvisory(method, body, store)) calls++; return { message_id: 80 }; } });
    try {
        telegram.recover(); assert.equal(store.one('SELECT status FROM telegram_outbox WHERE event_id=?', event).status, 'uncertain'); assert.equal(store.get('telegramRichFinalFallback:' + event), undefined);
        const before = store.one('SELECT * FROM telegram_outbox WHERE event_id=?', event); telegram.capture(at); await telegram.deliver(at);
        assert.deepEqual(store.one('SELECT * FROM telegram_outbox WHERE event_id=?', event), before); assert.equal(store.one('SELECT value FROM meta WHERE key=?', 'telegramRichFinal:' + event).value, composition);
        assert.equal(calls, 0);
    } finally { telegram.stop(); store.close(); rmSync(directory, { recursive: true, force: true }); }
});
