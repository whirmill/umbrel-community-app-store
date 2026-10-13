import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.js';
import { Queue } from '../queue.js';
import { ApplicationControl } from '../application-control.js';
import { Telegram } from '../telegram.js';
import { TelegramTurns } from '../telegram-turns.js';
const unsupported = 'I messaggi audio non sono supportati. Invia il testo oppure usa la dettatura della tastiera del telefono.';
function setup(path = ':memory:') {
    const dir = mkdtempSync(join(tmpdir(), 'telegram-audio-unsupported-')), s = new Store(path), q = new Queue(s), c = new ApplicationControl(s, q), calls: { method: string; body: any }[] = [];
    const t = new Telegram(s, c, dir, { call: async (method, body) => {
        assert.notEqual(method, 'getFile');
        calls.push({ method, body }); return { message_id: calls.length };
    } });
    s.set('telegramConfigured', true); s.set('telegramBotGeneration', 'bot');
    s.set('telegramBinding', { userId: 42, chatId: 42, generation: 'owner', since: new Date(Date.now() - 10000).toISOString() });
    return { dir, s, q, c, t, calls, async close() { t.stop(); await t.drain(); s.close(); rmSync(dir, { recursive: true, force: true }); } };
}
function incoming(id: number, extra: any, owner = 42, type = 'private') {
    return { update_id: id, message: { message_id: id, date: Math.floor(Date.now() / 1000), chat: { id: owner, type }, from: { id: owner }, ...extra } };
}
const media = { file_id: 'synthetic_file_id', file_unique_id: 'synthetic_unique_id', file_size: 100, duration: 1, mime_type: 'audio/ogg' };
const callback = (id: number, key: string) => ({ update_id: id, callback_query: { id: 'callback-' + id, data: key, from: { id: 42 }, message: { chat: { id: 42, type: 'private' } } } });
for (const kind of ['voice', 'audio']) test(kind + ' replies unsupported once, without download, admission, wake or retained file metadata', async () => {
    const f = setup(), originalFetch = globalThis.fetch; let admitted = 0, wakes = 0;
    globalThis.fetch = async () => { assert.fail('Audio must never be downloaded'); };
    f.c.admitWithinTransaction = () => { admitted++; assert.fail('Audio must never be admitted'); };
    f.t.setWake(async () => { wakes++; });
    try {
        assert.equal('voice' in f.t, false);
        const u = incoming(1, { [kind]: media, text: '/resume', caption: 'Caption must not become an agent request' });
        f.s.set('financialEnabled', false); f.s.set('enabled', false);
        f.t.ingest([u, u]); await f.t.process(); await f.t.deliver();
        f.t.ingest([u]); await f.t.process(); await f.t.deliver();
        assert.equal(f.q.list().length, 0); assert.equal(admitted, 0); assert.equal(wakes, 0);
        assert.deepEqual(f.calls.map(c => c.method), ['sendMessage']);
        assert.equal(f.calls[0]!.body.text, unsupported);
        assert.equal(f.s.get('financialEnabled'), false); assert.equal(f.s.get('enabled'), false);
        assert.equal(f.s.one('SELECT status FROM telegram_updates').status, 'done');
        assert.equal(f.s.all("SELECT key FROM meta WHERE key LIKE 'telegramVoice:%'").length, 0);
        const stored = f.s.one('SELECT body FROM telegram_updates').body;
        assert.ok(!stored.includes('synthetic_file_id')); assert.ok(!stored.includes('synthetic_unique_id'));
    } finally { globalThis.fetch = originalFetch; await f.close(); }
});
test('foreign owners, groups and stale owner/bot generations cannot receive audio responses', async () => {
    const f = setup(); try {
        f.t.ingest([incoming(1, { voice: media }, 99), incoming(2, { audio: media }, 42, 'group')]);
        f.t.ingest([incoming(3, { voice: media })]); f.s.set('telegramBinding', { ...f.s.get<any>('telegramBinding'), generation: 'rebound' });
        f.t.ingest([incoming(4, { audio: media })]); f.s.set('telegramBotGeneration', 'new-bot');
        await f.t.process(); await f.t.deliver();
        assert.equal(f.q.list().length, 0); assert.equal(f.calls.length, 0);
        assert.deepEqual(f.s.all('SELECT status FROM telegram_updates ORDER BY update_id').map(r => r.status), ['ignored', 'ignored', 'ignored', 'ignored']);
    } finally { await f.close(); }
});
test('stale audio preserves ingress age fences and cannot become delayed text recovery', async () => {
    const f = setup(); try {
        const u = incoming(1, { audio: media }); u.message.date -= 400;
        f.s.set('telegramBinding', { ...f.s.get<any>('telegramBinding'), since: new Date(Date.now() - 1000000).toISOString() });
        f.t.ingest([u]); await f.t.process(); f.t.ingest([incoming(2, { text: '/recover' })]); await f.t.process();
        assert.equal(f.s.one('SELECT status FROM telegram_updates WHERE update_id=1').status, 'ignored');
        assert.equal(f.s.get('telegramIngressRecovery:1'), undefined); assert.equal(f.q.list().length, 0);
        assert.ok(!f.s.all('SELECT text FROM telegram_outbox').some(r => r.text === unsupported));
    } finally { await f.close(); }
});
test('voice and audio do not block normal text or smartphone keyboard dictation order, including dormant unknown-release receipts', async () => {
    const f = setup(); try {
        f.s.set('telegramVoice:legacy', { id: 'original', state: 'transcribing', release: 'unknown', transcript: 'Old private transcript', pins: { runtime: 'original-pin' }, updateId: 0 });
        const original = f.s.one("SELECT value FROM meta WHERE key='telegramVoice:legacy'").value;
        f.t.ingest([incoming(1, { voice: media }), incoming(2, { text: 'Testo dettato dalla tastiera del telefono' }), incoming(3, { audio: media }), incoming(4, { text: 'Seconda richiesta testuale' })]);
        await f.t.process(); f.t.capture();
        assert.deepEqual(f.s.all('SELECT request_id FROM jobs ORDER BY rowid').map(r => r.request_id), ['telegram:bot:2', 'telegram:bot:4']);
        assert.deepEqual(f.s.all('SELECT payload FROM jobs ORDER BY rowid').map(r => JSON.parse(r.payload).message), ['Testo dettato dalla tastiera del telefono', 'Seconda richiesta testuale']);
        assert.equal(f.s.one("SELECT value FROM meta WHERE key='telegramVoice:legacy'").value, original);
        assert.equal(f.s.all('SELECT text FROM telegram_outbox WHERE text=?', unsupported).length, 2);
    } finally { await f.close(); }
});
for (const action of ['steer', 'followup', 'withdraw', 'voice_cancel']) test('legacy voice ' + action + ' is unavailable without changing correction, callback, job or voice receipt', async () => {
    const f = setup(); try {
        const turns = new TelegramTurns(f.s, f.q), job = f.c.admit('original-job', 'Original text', 'telegram');
        const turn = turns.attach(job, 'owner', 42), correction = turns.receive('legacy-correction', turn, 'Original private transcript');
        f.s.set('telegramVoice:original-voice', { id: 'original-voice', generation: 'owner', transcript: correction.body, state: 'choice_pending', release: 'unknown', requestId: 'original-request', pins: { runtime: 'original-pin' } });
        f.s.set('telegramVoiceCorrection:' + correction.id, 'original-voice');
        f.s.set('jobTelegramVoice:' + job.id, { id: 'original-voice', requestId: 'original-request' });
        f.s.set('telegramCallback:legacy-button', { action, id: action === 'voice_cancel' ? 'original-voice' : correction.id, generation: 'owner' });
        f.t.enqueue('historical-terminal', 'Original terminal reply'); f.s.run("UPDATE telegram_outbox SET status='uncertain' WHERE event_id='historical-terminal'");
        const originals = () => ({ meta: f.s.all("SELECT key,value FROM meta WHERE key LIKE 'telegramVoice%' OR key LIKE 'jobTelegramVoice:%' OR key LIKE 'telegramCorrection:%' OR key='telegramCallback:legacy-button' ORDER BY key"), jobs: f.s.all('SELECT * FROM jobs ORDER BY id'), terminal: f.s.one("SELECT * FROM telegram_outbox WHERE event_id='historical-terminal'") });
        const before = originals();
        f.t.ingest([callback(1, 'legacy-button')]); await f.t.process(); f.t.capture();
        assert.deepEqual(originals(), before); assert.equal(f.q.list().length, 1);
        assert.equal(f.s.one("SELECT text FROM telegram_outbox WHERE event_id='update:1'").text, unsupported);
        assert.deepEqual(f.calls.map(c => c.method), ['answerCallbackQuery']);
    } finally { await f.close(); }
});
test('reopen does not transcribe, replay, delete or rewrite legacy receipts, transcripts and deliveries', async () => {
    const root = mkdtempSync(join(tmpdir(), 'telegram-audio-reopen-')), path = join(root, 'state.sqlite'); let f = setup(path);
    try {
        for (const state of ['accepted', 'downloading', 'transcribing', 'transcript_ready', 'choice_pending', 'admitted', 'held', 'failed', 'cancelled']) f.s.set('telegramVoice:' + state, { id: state, state, transcript: 'Original transcript', release: 'unknown', jobId: 'original-job', requestId: 'original-request', pins: { model: 'original-model-pin' } });
        f.t.enqueue('terminal-delivery', 'Original terminal text'); f.s.run("UPDATE telegram_outbox SET status='sent' WHERE event_id='terminal-delivery'");
        const originals = f.s.all("SELECT key,value FROM meta WHERE key LIKE 'telegramVoice:%' ORDER BY key"), delivery = f.s.one("SELECT * FROM telegram_outbox WHERE event_id='terminal-delivery'");
        await f.close(); f = setup(path); await f.t.process();
        // Before the normal daily digest window: this fixture measures legacy replay.
        f.t.capture('2026-10-13T00:00:00.000Z'); await f.t.deliver();
        assert.deepEqual(f.s.all("SELECT key,value FROM meta WHERE key LIKE 'telegramVoice:%' ORDER BY key"), originals);
        assert.deepEqual(f.s.one("SELECT * FROM telegram_outbox WHERE event_id='terminal-delivery'"), delivery);
        assert.equal(f.calls.length, 0); assert.equal(f.q.list().length, 0);
    } finally { await f.close(); rmSync(root, { recursive: true, force: true }); }
});

test('capture leaves expired legacy audio choices immutable while normal text choices still expire', async () => {
    const f = setup(); try {
        const turns = new TelegramTurns(f.s, f.q), job = f.c.admit('expiry-job', 'Original text', 'telegram'), turn = turns.attach(job, 'owner', 42);
        const voiceChoice = turns.receive('expired-voice', turn, 'Original audio transcript'), textChoice = turns.receive('expired-text', turn, 'Original text correction');
        voiceChoice.expires = textChoice.expires = '2000-01-01T00:00:00.000Z'; turns.saveCorrection(voiceChoice); turns.saveCorrection(textChoice);
        f.s.set('telegramVoiceCorrection:' + voiceChoice.id, 'original-voice');
        const before = f.s.one('SELECT value FROM meta WHERE key=?', 'telegramCorrection:' + voiceChoice.id).value;
        f.t.capture();
        assert.equal(f.s.one('SELECT value FROM meta WHERE key=?', 'telegramCorrection:' + voiceChoice.id).value, before);
        assert.equal(turns.correction(textChoice.id)!.state, 'withdrawn');
    } finally { await f.close(); }
});

for (const age of ['expired', 'unexpired']) test('twenty dormant legacy voice choices leave normal text capacity available across reopen: ' + age, async () => {
    const root = mkdtempSync(join(tmpdir(), 'telegram-choice-capacity-')), path = join(root, 'state.sqlite'); let f = setup(path);
    try {
        let turns = new TelegramTurns(f.s, f.q); const job = f.c.admit('capacity-original', 'Original text', 'telegram'), turn = turns.attach(job, 'owner', 42);
        const at = age === 'expired' ? '2000-01-01T00:00:00.000Z' : new Date().toISOString();
        for (let i = 0; i < 20; i++) {
            const c = turns.receive('legacy-capacity-' + i, turn, 'Original transcript ' + i, at);
            f.s.set('telegramVoiceCorrection:' + c.id, 'original-voice-' + i);
            f.s.set('telegramVoice:original-voice-' + i, { id: 'original-voice-' + i, correctionId: c.id, transcript: c.body, state: 'choice_pending', release: 'unknown' });
        }
        const originals = f.s.all("SELECT key,value FROM meta WHERE key LIKE 'telegramCorrection:%' OR key LIKE 'telegramVoice%' ORDER BY key");
        await f.close(); f = setup(path); turns = new TelegramTurns(f.s, f.q); turns.reconcile();
        assert.equal(turns.choices('owner').length, 0);
        assert.deepEqual(f.s.all("SELECT key,value FROM meta WHERE key LIKE 'telegramCorrection:%' OR key LIKE 'telegramVoice%' ORDER BY key"), originals);
        const text = turns.receive('new-normal-text', turn, 'New normal text');
        assert.equal(text.state, 'choice_pending'); assert.equal(turns.choices('owner').length, 1);
        assert.deepEqual(f.s.all("SELECT key,value FROM meta WHERE (key LIKE 'telegramCorrection:%' AND key <> 'telegramCorrection:new-normal-text') OR key LIKE 'telegramVoice%' ORDER BY key"), originals);
        assert.equal(f.q.list().length, 1);
    } finally { await f.close(); rmSync(root, { recursive: true, force: true }); }
});
test('twenty normal text choices still block the twenty-first and duplicate receive preserves its original', async () => {
    const f = setup(); try {
        const turns = new TelegramTurns(f.s, f.q), job = f.c.admit('normal-capacity', 'Original text', 'telegram'), turn = turns.attach(job, 'owner', 42);
        for (let i = 0; i < 20; i++) turns.receive('normal-' + i, turn, 'Original text ' + i);
        const before = f.s.all("SELECT key,value FROM meta WHERE key LIKE 'telegramCorrection:%' ORDER BY key");
        assert.equal(turns.choices('owner').length, 20);
        assert.throws(() => turns.receive('normal-overflow', turn, 'Twenty-first text'), /Too many unanswered choices/);
        assert.equal(turns.receive('normal-0', turn, 'Duplicate must not replace text').body, 'Original text 0');
        assert.deepEqual(f.s.all("SELECT key,value FROM meta WHERE key LIKE 'telegramCorrection:%' ORDER BY key"), before);
        assert.equal(f.q.list().length, 1);
    } finally { await f.close(); }
});
test('mixed legacy voice and text choices count only text, with normal expiry and legacy bytes preserved', async () => {
    const f = setup(); try {
        const turns = new TelegramTurns(f.s, f.q), job = f.c.admit('mixed-capacity', 'Original text', 'telegram'), turn = turns.attach(job, 'owner', 42);
        for (let i = 0; i < 20; i++) { const c = turns.receive('mixed-voice-' + i, turn, 'Original transcript ' + i, '2000-01-01T00:00:00.000Z'); f.s.set('telegramVoiceCorrection:' + c.id, 'original-voice-' + i); }
        const legacy = f.s.all("SELECT key,value FROM meta WHERE key LIKE 'telegramCorrection:mixed-voice-%' OR key LIKE 'telegramVoiceCorrection:%' ORDER BY key");
        for (let i = 0; i < 19; i++) turns.receive('mixed-text-' + i, turn, 'Normal text ' + i);
        turns.receive('expired-normal-text', turn, 'Expired text', '2000-01-01T00:00:00.000Z');
        assert.equal(turns.choices('owner').length, 20); turns.reconcile();
        assert.equal(turns.correction('expired-normal-text')!.state, 'withdrawn'); assert.equal(turns.choices('owner').length, 19);
        turns.receive('mixed-twentieth-text', turn, 'Twentieth text');
        assert.equal(turns.choices('owner').length, 20);
        assert.throws(() => turns.receive('mixed-text-overflow', turn, 'Overflow text'), /Too many unanswered choices/);
        assert.deepEqual(f.s.all("SELECT key,value FROM meta WHERE key LIKE 'telegramCorrection:mixed-voice-%' OR key LIKE 'telegramVoiceCorrection:%' ORDER BY key"), legacy);
        assert.equal(f.q.list().length, 1);
    } finally { await f.close(); }
});
