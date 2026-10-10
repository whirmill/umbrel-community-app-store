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
import { UiEvents } from '../ui-events.js';
import { fixture } from './pi-fixture.js';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { now } from '../domain.js';
function setup(call: any = async () => ({ message_id: 1 })) { const dir = mkdtempSync(join(tmpdir(), 'interactive-')), s = new Store(':memory:'), q = new Queue(s), c = new ApplicationControl(s, q), t = new Telegram(s, c, dir, { call }); s.set('telegramConfigured', true); s.set('telegramBinding', { userId: 42, chatId: 42, generation: 'owner-generation', since: now() }); const turns = new TelegramTurns(s, q); return { s, q, c, t, turns, close() { t.stop(); s.close(); rmSync(dir, { recursive: true, force: true }); } }; }
const incoming = (id: number, text: string) => ({ update_id: id, message: { text, from: { id: 42 }, chat: { id: 42, type: 'private' } } });
const callback = (id: number, key: string) => ({ update_id: id, callback_query: { id: 'callback-' + id, data: key, from: { id: 42 }, message: { chat: { id: 42, type: 'private' } } } });
function held() { let release!: () => void; const promise = new Promise<void>(r => release = r); return { promise, release }; }
test('new active message waits for explicit choice; followup remains in app queue and cancellation preserves receipt', async () => { const f = setup(); try {
    f.t.ingest([incoming(1, 'Prima domanda')]);
    await f.t.process();
    const job = f.q.claim('coordinator', 'fixture')!;
    let steers = 0;
    f.turns.bind(job, { steer: async () => { steers++; }, stop: async () => { } });
    f.t.ingest([incoming(2, 'Seconda domanda')]);
    await f.t.process();
    assert.equal(f.q.list().length, 1);
    assert.equal(steers, 0);
    const markup = f.s.get('telegramButtons:update:2');
    assert.equal(markup.inline_keyboard[0][0].text, 'Correggi questa risposta');
    f.t.ingest([callback(3, markup.inline_keyboard[0][1].callback_data)]);
    await f.t.process();
    assert.equal(f.q.list().length, 2);
    const next = f.q.list()[0]!;
    assert.equal(next.submitted, 0);
    assert.equal(next.conversation_id, null);
    const turn = f.turns.get(next.id)!;
    assert.equal(f.turns.cancel(next.id, turn.generation, turn.version), true);
    assert.equal(f.q.get(next.id)!.state, 'cancelled');
    assert.equal(f.turns.get(next.id)!.state, 'cancelled');
    assert.equal(f.s.get('telegramLinkedRequest:' + next.id).priorTurn, job.id);
}
finally {
    f.close();
} });
test('Stop ACK precedes task release, duplicate/late Stop cannot reach next turn; uncertain finance stays untouched', async () => { const f = setup(); const latch = held(); try {
    f.s.run("INSERT INTO decisions VALUES('decision',?,'{}','{}','{}','observing')", now());
    f.s.run("INSERT INTO operations(id,decision_id,at,state,payment_hash,details) VALUES('uncertain','decision',?,'uncertain','original','{}')", now());
    const first = f.c.admit('first', 'first', 'telegram');
    f.turns.attach(first, 'owner-generation', 42);
    const claimed = f.q.claim('coordinator', 'fixture')!;
    let stops = 0;
    f.turns.bind(claimed, { steer: async () => { }, stop: async () => { stops++; await latch.promise; } });
    const next = f.c.admit('next', 'next', 'telegram');
    f.turns.attach(next, 'owner-generation', 42);
    const turn = f.turns.get(first.id)!;
    const receipt = await f.turns.stop(first.id, turn.generation, turn.version, 'stop-one');
    assert.equal(receipt.state, 'received');
    const stopping = f.turns.dispatchStop('stop-one');
    assert.equal(f.s.get('telegramStop:stop-one').state, 'received');
    assert.equal(stops, 1);
    assert.equal((await f.turns.stop(first.id, turn.generation, turn.version, 'stop-one')).state, 'received');
    assert.equal((await f.turns.stop(first.id, turn.generation, turn.version, 'duplicate')).state, 'stale');
    latch.release();
    await stopping;
    assert.equal(f.s.get('telegramStop:stop-one').state, 'idle_confirmed');
    f.turns.close(first.id, 'failed');
    await f.turns.dispatchStop('stop-one');
    assert.equal(stops, 1);
    assert.equal(f.q.get(next.id)!.state, 'queued');
    assert.equal(f.s.one("SELECT state FROM operations WHERE id='uncertain'").state, 'uncertain');
    assert.equal(f.s.get('enabled'), true);
}
finally {
    latch.release();
    f.close();
} });
test('late correction offers linked new request; owner generation fences admission and drafts, callback spinner ACK is first', async () => { const calls: any[] = []; const f = setup(async (method: string, body: any) => { calls.push({ method, body }); return { message_id: 1 }; }); try {
    const j = f.c.admit('first', 'first', 'telegram');
    const turn = f.turns.attach(j, 'owner-generation', 42);
    const c = f.turns.receive('late', turn, 'new context');
    f.turns.close(j.id, 'completed');
    assert.equal(await f.turns.steer(c.id), 'late');
    f.s.set('telegramCallback:button', { action: 'steer', id: c.id, generation: 'owner-generation' });
    f.t.ingest([callback(1, 'button')]);
    await f.t.process();
    assert.equal(calls[0].method, 'answerCallbackQuery');
    assert.equal(f.q.list().length, 1);
    assert.equal(f.s.get('telegramButtons:update:1').inline_keyboard[0][0].text, 'Nuova richiesta');
    f.s.set('telegramBinding', { userId: 42, chatId: 42, generation: 'replacement', since: now() });
    assert.equal(await f.turns.steer(c.id), 'late');
    await f.t.streamDrafts();
    assert.equal(calls.length, 1);
}
finally {
    f.close();
} });
test('progressive drafts use public projection only, refresh expiry, obey retry_after; final long text segments once and retains uncertain delivery', async () => { const calls: any[] = []; let rate = false; const f = setup(async (method: string, body: any) => { calls.push({ method, body }); if (rate) {
    const e: any = Error('redacted');
    e.rejected = true;
    e.retryAfter = 120;
    throw e;
} return { message_id: calls.length }; }); try {
    const j = f.c.admit('stream', 'hello', 'telegram'), turn = f.turns.attach(j, 'owner-generation', 42), owned = f.q.claim('coordinator', 'fixture')!;
    f.turns.bind(owned, { steer: async () => { }, stop: async () => { } });
    await f.t.streamDrafts('2026-10-10T12:00:00Z');
    assert.match(calls[0].body.rich_message.html, /tg-thinking/);
    const ui = new UiEvents(f.s);
    ui.append(j.id, 'thinking', { text: 'HIDDEN' });
    ui.append(j.id, 'reasoning_summary', { text: 'PUBLIC', provenance: 'responses.summary_text' });
    await f.t.streamDrafts('2026-10-10T12:00:01Z');
    assert.match(calls[1].body.rich_message.html, /PUBLIC/);
    assert.doesNotMatch(JSON.stringify(calls), /HIDDEN/);
    ui.append(j.id, 'text', { text: 'Prima parte' });
    await f.t.streamDrafts('2026-10-10T12:00:02Z');
    assert.equal(calls.at(-1).body.rich_message.html, 'Prima parte');
    const count = calls.length;
    await f.t.streamDrafts('2026-10-10T12:00:03Z');
    assert.equal(calls.length, count);
    await f.t.streamDrafts('2026-10-10T12:00:25Z');
    assert.equal(calls.length, count + 1);
    rate = true;
    ui.append(j.id, 'text', { text: 'Nuovo testo' });
    await f.t.streamDrafts('2026-10-10T12:00:26Z');
    await f.t.streamDrafts('2026-10-10T12:00:27Z');
    assert.equal(calls.length, count + 2);
    f.t.enqueue('long-final', 'a'.repeat(8200));
    f.t.enqueue('long-final', 'a'.repeat(8200));
    assert.equal(f.s.one("SELECT count(*) n FROM telegram_outbox WHERE event_id LIKE 'long-final%'").n, 3);
    f.s.run("UPDATE telegram_outbox SET status='sending' WHERE event_id='long-final'");
    f.t.recover();
    assert.equal(f.s.one("SELECT status FROM telegram_outbox WHERE event_id='long-final'").status, 'uncertain');
}
finally {
    f.close();
} });
test('native Stop without sender maps exact draft turn; unsupported edits/topics never mutate model input', async () => { const f = setup(); try {
    const j = f.c.admit('draft', 'draft', 'telegram'), turn = f.turns.attach(j, 'owner-generation', 42), owned = f.q.claim('coordinator', 'fixture')!;
    let stops = 0;
    f.turns.bind(owned, { steer: async () => { }, stop: async () => { stops++; } });
    f.s.set('telegramDraft:17', { jobId: j.id, generation: turn.generation, version: turn.version });
    f.t.ingest([{ update_id: 1, stopped_message_generation: { chat: { id: 42, type: 'private' }, draft_id: 17 } }, { update_id: 2, edited_message: { text: 'changed', from: { id: 42 }, chat: { id: 42, type: 'private' } } }, { update_id: 3, message: { text: 'topic', message_thread_id: 1, from: { id: 42 }, chat: { id: 42, type: 'private' } } }]);
    await f.t.process();
    await new Promise<void>(r => setImmediate(r));
    assert.equal(stops, 1);
    assert.equal(f.q.list().length, 1);
    assert.match(f.s.one("SELECT text FROM telegram_outbox WHERE event_id='update:2'").text, /non sono supportati/);
}
finally {
    f.close();
} });
for (const mode of ['final-boundary', 'tool-boundary'] as const)
    test('real Pi Durable correction ' + mode + ' retains app turn, all submissions and deadline; next conversation remembers context', async () => { const dir = mkdtempSync(join(tmpdir(), 'pi-interactive-')), f = fixture(dir, 'state'), turns = new TelegramTurns(f.store, f.queue), control = new ApplicationControl(f.store, f.queue); const first = held(), entered = held(); let calls = 0; f.store.set('telegramBinding', { generation: 'g', chatId: 42, userId: 42, since: now() }); f.agent.models.streamSimple = (_model, request, options) => { const stream = createAssistantMessageEventStream(), n = ++calls; const message: any = { role: 'assistant', api: 'openai-responses', provider: 'openai', model: 'gpt-6.1-sol', timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: n === 1 && mode === 'tool-boundary' ? 'toolUse' : 'stop', content: n === 1 && mode === 'tool-boundary' ? [{ type: 'toolCall', id: 'read-node', name: 'node_state', arguments: {} }] : [{ type: 'text', text: n === 1 ? 'First answer' : 'Corrected answer with remembered context' }] }; const emit = () => { stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: message.stopReason, message }); }; if (n === 1) {
        entered.release();
        void first.promise.then(emit);
    }
    else
        queueMicrotask(emit); return stream; }; let running: Promise<any> | undefined; try {
        await f.agent.open();
        const j = control.admit('interactive-first', 'Remember marker ABC', 'telegram');
        f.store.set('jobTelegramGeneration:' + j.id, 'g');
        turns.attach(j, 'g', 42);
        const owned = f.queue.claim('coordinator', 'test')!;
        running = f.agent.runJob(owned);
        await entered.promise;
        const turn = turns.get(j.id)!;
        const originalBudget = f.store.get('runBudget:' + j.id).started;
        const correction = turns.receive('correction-' + mode, turn, 'Use marker ABC and correct this answer');
        const result = await turns.steer(correction.id);
        assert.ok(['admitted', 'placed'].includes(result));
        first.release();
        const answer = await running;
        assert.equal(answer.answer, 'Corrected answer with remembered context');
        assert.equal(turns.get(j.id)!.submissions.length, 2);
        assert.equal(turns.get(j.id)!.state, 'completed');
        assert.equal(f.store.get('runBudget:' + j.id).started, originalBudget);
        assert.equal(turns.correction(correction.id)!.state, 'settled');
        f.queue.finish(j.id, owned.run_token!, 'completed', answer);
        const next = control.admit('interactive-next', 'What marker did I give?', 'telegram');
        f.store.set('jobTelegramGeneration:' + next.id, 'g');
        turns.attach(next, 'g', 42);
        const second = f.queue.claim('coordinator', 'test')!;
        await f.agent.runJob(second);
        assert.equal(f.queue.get(next.id)!.conversation_id, f.queue.get(j.id)!.conversation_id);
        assert.equal(f.store.get('jobCapability:' + next.id), 'read_only_chat');
    }
    finally {
        first.release();
        await running?.catch(() => { });
        await f.agent.close();
        f.store.close();
        rmSync(dir, { recursive: true, force: true });
    } });
test('restart preserves Stop intent through waiting reconciliation and redispatch before next ownership', async () => { const f = setup(); try {
    const j = f.c.admit('restart-stop', 'hello', 'telegram'), t = f.turns.attach(j, 'owner-generation', 42), owned = f.q.claim('coordinator', 'old')!;
    f.turns.bind(owned, { steer: async () => { }, stop: async () => { throw Error('process ended'); } });
    await f.turns.stop(j.id, t.generation, t.version, 'durable-stop');
    f.q.recoverAfterRestart();
    f.turns.reconcile();
    assert.equal(f.turns.get(j.id)!.state, 'stop_requested');
    const recovered = f.q.claim('coordinator', 'new')!;
    let aborted = 0;
    f.turns.bind(recovered, { steer: async () => { }, stop: async () => { aborted++; } });
    await f.turns.dispatchStop('durable-stop');
    assert.equal(aborted, 1);
    assert.equal(f.s.get('telegramStop:durable-stop').state, 'idle_confirmed');
}
finally {
    f.close();
} });
test('fallback accepted-but-timeout stores uncertainty and never repeats message creation after restart', async () => { let creates = 0; const f = setup(async (method: string) => { if (method.endsWith('Draft')) {
    const e: any = Error('unsupported');
    e.rejected = true;
    throw e;
} if (method === 'sendMessage') {
    creates++;
    throw Error('accepted but timed out');
} return {}; }); try {
    const j = f.c.admit('fallback', 'hello', 'telegram');
    f.turns.attach(j, 'owner-generation', 42);
    f.turns.bind(f.q.claim('coordinator', 'fixture')!, { steer: async () => { }, stop: async () => { } });
    await f.t.streamDrafts('2026-10-10T12:00:00Z');
    await f.t.streamDrafts('2026-10-10T12:00:02Z');
    await f.t.streamDrafts('2026-10-10T12:00:04Z');
    assert.equal(creates, 1);
    f.t.recover();
    await f.t.streamDrafts('2026-10-10T12:01:00Z');
    assert.equal(creates, 1);
    assert.equal(f.s.get('telegramStream:' + j.id).status, 'uncertain');
}
finally {
    f.close();
} });
test('FIFO Telegram context serializes chat and research while automatic analysts remain independent; claim-before-bind is active', async () => { const f = setup(); try {
    const first = f.c.admit('first-mixed', 'hello', 'telegram');
    f.turns.attach(first, 'owner-generation', 42);
    const active = f.q.claim('coordinator', 'fixture', now(), 'chat')!;
    assert.equal(f.turns.active('owner-generation')!.jobId, first.id);
    const second = f.c.admit('second-mixed', 'analyze', 'telegram', true);
    f.turns.attach(second, 'owner-generation', 42);
    assert.equal(f.q.claim('analyst', 'fixture'), undefined);
    const correction = f.turns.receive('during-setup', f.turns.get(first.id)!, 'Correct first answer');
    assert.equal(await f.turns.steer(correction.id), 'admitted');
    const automatic = f.q.enqueue({ requestId: 'independent', kind: 'analysis', payload: { message: 'background' }, origin: 'scheduler' });
    f.s.set('bootstrapReady', true);
    assert.equal(f.q.claim('analyst', 'fixture')!.id, automatic.id);
    f.q.finish(first.id, active.run_token!, 'completed', {});
    assert.equal(f.q.claim('analyst', 'fixture')!.id, second.id);
}
finally {
    f.close();
} });
test('two corrections during successive Pi runs remain one app turn; reused-session recovery excludes previous turn and usage is per turn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-steers-')), f = fixture(dir, 'state'), turns = new TelegramTurns(f.store, f.queue), control = new ApplicationControl(f.store, f.queue);
    const first = held(), second = held(), enteredFirst = held(), enteredSecond = held();
    let calls = 0;
    f.store.set('telegramBinding', { generation: 'g', chatId: 42, userId: 42, since: now() });
    f.agent.models.streamSimple = (_model, request) => { const stream = createAssistantMessageEventStream(), n = ++calls; const message: any = { role: 'assistant', api: 'openai-responses', provider: 'openai', model: 'gpt-6.1-sol', timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', content: [{ type: 'text', text: n === 1 ? 'OLD-FIRST-TURN' : n === 2 ? 'First correction answer' : n === 3 ? 'Second correction answer' : 'NEW-SECOND-TURN' }] }; const emit = () => { stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: 'stop', message }); }; if (n === 1) {
        enteredFirst.release();
        void first.promise.then(emit);
    }
    else if (n === 2) {
        enteredSecond.release();
        void second.promise.then(emit);
    }
    else
        queueMicrotask(emit); return stream; };
    let running: Promise<any> | undefined;
    try {
        await f.agent.open();
        const j = control.admit('multi-first', 'hello', 'telegram');
        f.store.set('jobTelegramGeneration:' + j.id, 'g');
        turns.attach(j, 'g', 42);
        const owned = f.queue.claim('coordinator', 'test')!;
        running = f.agent.runJob(owned);
        await enteredFirst.promise;
        const c1 = turns.receive('multi-c1', turns.get(j.id)!, 'first correction');
        await turns.steer(c1.id);
        first.release();
        await enteredSecond.promise;
        assert.equal(await turns.withdraw(c1.id), 'already_placed');
        const c2 = turns.receive('multi-c2', turns.get(j.id)!, 'second correction');
        assert.ok(['admitted', 'placed'].includes(await turns.steer(c2.id)));
        second.release();
        const answer = await running;
        assert.equal(answer.answer, 'Second correction answer');
        assert.equal(turns.get(j.id)!.submissions.length, 3);
        f.queue.finish(j.id, owned.run_token!, 'completed', answer);
        const next = control.admit('multi-next', 'new request', 'telegram');
        f.store.set('jobTelegramGeneration:' + next.id, 'g');
        turns.attach(next, 'g', 42);
        const secondJob = f.queue.claim('coordinator', 'test')!;
        const nextAnswer: any = await f.agent.runJob(secondJob);
        assert.equal(nextAnswer.usage.models['openai/gpt-6.1-sol'].input, 1);
        f.queue.recoverAfterRestart();
        const recovery = f.queue.claim('coordinator', 'recovered')!;
        await f.agent.runJob(recovery);
        const events = f.store.all("SELECT data FROM ui_events WHERE job_id=? AND type='text'", next.id).map(r => JSON.parse(r.data).text).join('\n');
        assert.doesNotMatch(events, /OLD-FIRST-TURN|First correction answer|Second correction answer/);
        assert.match(events, /NEW-SECOND-TURN/);
    }
    finally {
        first.release();
        second.release();
        await running?.catch(() => { });
        await f.agent.close();
        f.store.close();
        rmSync(dir, { recursive: true, force: true });
    }
});
test('production immediate Telegram dispatch uses read-only slot2 tools while financial coordinator remains owned', async () => { const { Scheduler } = await import('../scheduler.js'); const dir = mkdtempSync(join(tmpdir(), 'pi-dispatch-')), f = fixture(dir, 'state'), turns = new TelegramTurns(f.store, f.queue), control = new ApplicationControl(f.store, f.queue); const finance = held(), financeEntered = held(), chatDone = held(); let toolName = ''; f.store.set('telegramConfigured', true); f.store.set('telegramBinding', { generation: 'g', chatId: 42, userId: 42, since: now() }); f.agent.models.streamSimple = (_model, request) => { const stream = createAssistantMessageEventStream(), isFinance = JSON.stringify(request.messages).includes('hold-finance'), result = request.messages.some((m: any) => m.role === 'toolResult'); const message: any = { role: 'assistant', api: 'openai-responses', provider: 'openai', model: 'gpt-6.1-sol', timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: isFinance || result ? 'stop' : 'toolUse', content: isFinance || result ? [{ type: 'text', text: isFinance ? 'Finance done' : 'Chat done' }] : [{ type: 'toolCall', id: 'chat-state', name: 'node_state_analyst_2', arguments: {} }] }; const emit = () => { stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: message.stopReason, message }); if (result)
    chatDone.release(); }; if (isFinance) {
    financeEntered.release();
    void finance.promise.then(emit);
}
else {
    toolName = result ? toolName : 'node_state_analyst_2';
    queueMicrotask(emit);
} return stream; }; const scheduler = new Scheduler(f.queue, f.agent), telegram = new Telegram(f.store, control, dir, { call: async () => ({ message_id: 1 }) }); telegram.setWake(() => scheduler.dispatchTelegram()); try {
    await f.agent.open();
    const financial = control.admit('financial-slot', 'hold-finance', 'owner');
    await scheduler.pump();
    await financeEntered.promise;
    telegram.ingest([incoming(1, 'Read current node state')]);
    await telegram.process();
    await chatDone.promise;
    assert.equal(toolName, 'node_state_analyst_2');
    assert.equal(f.queue.get(financial.id)!.state, 'running');
    assert.equal(scheduler.status().coordinatorRunning, true);
    const chat = f.queue.list().find(j => j.id !== financial.id)!;
    assert.equal(f.store.get('jobCapability:' + chat.id), 'read_only_chat');
    assert.equal(turns.get(chat.id)!.capability, 'read_only_chat');
    assert.equal(f.store.one('SELECT count(*) n FROM operations').n, 0);
}
finally {
    finance.release();
    telegram.stop();
    assert.equal(await scheduler.drain(), true);
    await f.agent.close();
    f.store.close();
    rmSync(dir, { recursive: true, force: true });
} });
test('command menu replaces inherited default commands once per generation and fences every write', async () => { const methods: string[] = [], f = setup(async (method: string, body: any) => { methods.push(method); if (method === 'setMyCommands')
    assert.deepEqual(body.commands.map((c: any) => c.command), ['status', 'analyze', 'proposals', 'pause', 'resume', 'stop', 'queue', 'menu', 'help']); return { username: 'satssurge_bot' }; }); try {
    await f.t.menu();
    await f.t.menu();
    assert.deepEqual(methods, ['setMyCommands', 'setMyCommands', 'setChatMenuButton', 'getMe']);
    assert.equal(f.t.status().username, 'satssurge_bot');
}
finally {
    f.close();
} let count = 0; const g = setup(async () => { count++; g.t.revoke(); return {}; }); try {
    await g.t.menu();
    assert.equal(count, 1);
}
finally {
    g.close();
} });
test('durable Stop can target claimed turn before runner is bound and cannot cancel future admission', async () => { const f = setup(); try {
    const j = f.c.admit('setup-stop', 'hello', 'telegram'), turn = f.turns.attach(j, 'owner-generation', 42);
    f.q.claim('coordinator', 'fixture');
    assert.equal((await f.turns.stop(j.id, turn.generation, turn.version, 'before-bind')).state, 'received');
    let aborted = 0;
    f.turns.bind(f.q.get(j.id)!, { steer: async () => { }, stop: async () => { aborted++; } });
    await f.turns.dispatchStop('before-bind');
    assert.equal(aborted, 1);
}
finally {
    f.close();
} });

test('direct intake omits internal UUID and contextual gaps action appears only for actual missing research',async()=>{const f=setup();try{f.t.ingest([incoming(1,'Ciao')]);await f.t.process();const first=f.q.list()[0]!;assert.doesNotMatch(f.s.one("SELECT text FROM telegram_outbox WHERE event_id='update:1'").text,new RegExp(first.id));const greeting=f.q.claim('coordinator','fixture')!;f.q.finish(first.id,greeting.run_token!,'completed',{answer:'Ciao!',researchGaps:[]});f.t.capture();assert.equal(f.s.get('telegramButtons:answer:'+first.id),undefined);f.t.ingest([incoming(2,'Analizza le evidenze')]);await f.t.process();const second=f.q.list()[0]!,claimed=f.q.claim('coordinator','fixture')!;f.q.finish(second.id,claimed.run_token!,'completed',{answer:'Evidenze parziali',researchGaps:[{section:'channels'}]});f.t.capture();assert.ok(f.s.get('telegramButtons:answer:'+second.id).inline_keyboard[0].some((b:any)=>b.text==='Completa le lacune'));}finally{f.close();}});

for(const failure of ['stop','provider'] as const)test('correction '+failure+' after original final cannot report original answer as completed',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pi-correction-failure-')),f=fixture(dir,'state'),turns=new TelegramTurns(f.store,f.queue),control=new ApplicationControl(f.store,f.queue),telegram=new Telegram(f.store,control,dir,{call:async()=>({message_id:1})});
 const first=held(),firstEntered=held(),correction=held(),correctionEntered=held();let calls=0,aborted=false;
 f.store.set('telegramBinding',{generation:'g',chatId:42,userId:42,since:now()});
 f.agent.models.streamSimple=(_model,_request,options)=>{
  const stream=createAssistantMessageEventStream(),ordinal=++calls;
  const message:any={role:'assistant',api:'openai-responses',provider:'openai',model:'gpt-6.1-sol',timestamp:Date.now(),usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:ordinal===1?'stop':'error',content:ordinal===1?[{type:'text',text:'Original public answer retained'}]:[]};
  if(ordinal===1){firstEntered.release();void first.promise.then(()=>{stream.push({type:'start',partial:message});stream.push({type:'done',reason:'stop',message});});}
  else {correctionEntered.release();options?.signal?.addEventListener('abort',()=>{aborted=true;correction.release();},{once:true});void correction.promise.then(()=>{message.stopReason=aborted?'aborted':'error';message.errorMessage='Private provider failure must not leak';stream.push({type:'error',reason:message.stopReason,error:message});});}
  return stream;
 };
 let running:Promise<{result?:any;error?:Error}>|undefined;
 try{
  await f.agent.open();const admitted=control.admit('correction-'+failure,'original question','telegram');f.store.set('jobTelegramGeneration:'+admitted.id,'g');turns.attach(admitted,'g',42);const claimed=f.queue.claim('coordinator','test')!;
  running=f.agent.runJob(claimed).then(result=>{f.queue.finish(claimed.id,claimed.run_token!,'completed',result);return {result};},error=>{f.queue.finish(claimed.id,claimed.run_token!,'failed',error.message);return {error};});
  await firstEntered.promise;const request=turns.receive('correct-'+failure,turns.get(claimed.id)!,'change original answer');await turns.steer(request.id);first.release();await correctionEntered.promise;
  if(failure==='stop'){const target=turns.get(claimed.id)!;await turns.stop(claimed.id,'g',target.version,'stop-correction');await turns.dispatchStop('stop-correction');assert.equal(f.store.get('telegramStop:stop-correction').state,'idle_confirmed');}
  else correction.release();
  const outcome=await running;assert.ok(outcome.error);assert.equal(outcome.result,undefined);assert.equal(f.queue.get(claimed.id)!.state,'failed');assert.equal(turns.get(claimed.id)!.state,failure==='stop'?'interrupted':'failed');assert.equal(turns.correction(request.id)!.state,'failed');assert.equal(turns.get(claimed.id)!.submissions.length,2);assert.equal(calls,2);
  telegram.capture();const notification=f.store.one('SELECT text FROM telegram_outbox WHERE event_id=?','answer:'+claimed.id);assert.match(notification.text,/Original public answer retained/);assert.match(notification.text,/parziale/);assert.doesNotMatch(notification.text,/Private provider/);assert.equal(f.store.one('SELECT count(*) n FROM operations').n,0);
 }finally{first.release();correction.release();await running;telegram.stop();await f.agent.close();f.store.close();rmSync(dir,{recursive:true,force:true});}
});

test('draft429 gates pending outbox in the same outbound cycle until retry_after expires',async()=>{
 let messages=0;const f=setup(async(method:string)=>{if(method.endsWith('Draft')){const error:any=Error('limited');error.rejected=true;error.retryAfter=120;throw error;}if(method==='sendMessage')messages++;return {message_id:1};});
 try{const job=f.c.admit('draft-rate','hello','telegram');f.turns.attach(job,'owner-generation',42);f.turns.bind(f.q.claim('coordinator','fixture')!,{steer:async()=>{},stop:async()=>{}});f.t.enqueue('pending-ack','Request accepted');const at=now();await f.t.streamDrafts(at);await f.t.deliver(at);assert.equal(messages,0);assert.equal(f.s.one("SELECT status FROM telegram_outbox WHERE event_id='pending-ack'").status,'pending');await f.t.deliver(new Date(Date.parse(at)+121000).toISOString());assert.equal(messages,1);}finally{f.close();}
});

test('explicit withdrawal of queued correction preserves completed original answer and never starts correction run',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pi-queued-withdraw-')),f=fixture(dir,'state'),turns=new TelegramTurns(f.store,f.queue),control=new ApplicationControl(f.store,f.queue),first=held(),entered=held();let calls=0;
 f.store.set('telegramBinding',{generation:'g',chatId:42,userId:42,since:now()});
 f.agent.models.streamSimple=()=>{calls++;const stream=createAssistantMessageEventStream(),message:any={role:'assistant',api:'openai-responses',provider:'openai',model:'gpt-6.1-sol',timestamp:Date.now(),usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',content:[{type:'text',text:'Completed original answer'}]};entered.release();void first.promise.then(()=>{stream.push({type:'start',partial:message});stream.push({type:'done',reason:'stop',message});});return stream;};
 let running:Promise<any>|undefined;
 try{await f.agent.open();const job=control.admit('queued-withdraw','hello','telegram');f.store.set('jobTelegramGeneration:'+job.id,'g');turns.attach(job,'g',42);const owned=f.queue.claim('coordinator','test')!;running=f.agent.runJob(owned);await entered.promise;const c=turns.receive('withdraw-queued',turns.get(job.id)!,'unused correction');await turns.steer(c.id);assert.equal(await turns.withdraw(c.id),'aborted');first.release();const result=await running;assert.equal(result.answer,'Completed original answer');assert.equal(turns.get(job.id)!.state,'completed');assert.equal(turns.correction(c.id)!.state,'withdrawn');assert.equal(calls,1);}finally{first.release();await running?.catch(()=>{});await f.agent.close();f.store.close();rmSync(dir,{recursive:true,force:true});}
});

test('outbox rechecks global retry gate after every earlier awaited send',async()=>{
 let messages=0;const f=setup(async(method:string)=>{if(method==='sendMessage'){messages++;f.s.set('telegramRateLimitUntil',Date.now()+120000);}return {message_id:messages};});
 try{f.t.enqueue('first-global','first');f.t.enqueue('second-global','second');await f.t.deliver();assert.equal(messages,1);assert.equal(f.s.one("SELECT status FROM telegram_outbox WHERE event_id='second-global'").status,'pending');}finally{f.close();}
});

for(const mode of ['latest-success','failed-before-receipt','failed-after-receipt','stop-received','stop-closed','submit-before-bind-stop'] as const)test('reopened native Pi correction recovery: '+mode,async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pi-reopen-correction-'));let f=fixture(dir,'state'),calls=0;
 const install=(fail=false)=>{f.agent.models.streamSimple=()=>{const stream=createAssistantMessageEventStream();const n=++calls;const message:any={role:'assistant',api:'openai-responses',provider:'openai',model:'gpt-6.1-sol',timestamp:Date.now(),usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:fail?'error':'stop',content:fail?[]:[{type:'text',text:'Public answer '+n}]};queueMicrotask(()=>{if(fail){message.errorMessage='private fixture error';stream.push({type:'error',reason:'error',error:message});}else{stream.push({type:'start',partial:message});stream.push({type:'done',reason:'stop',message});}});return stream;};};
 let closed=false;
 try{
  install();f.store.set('telegramBinding',{generation:'g',chatId:42,userId:42,since:now()});await f.agent.open();let turns=new TelegramTurns(f.store,f.queue);const control=new ApplicationControl(f.store,f.queue),job=control.admit('reopen-'+mode,'original question','telegram');f.store.set('jobTelegramGeneration:'+job.id,'g');turns.attach(job,'g',42);const claimed=f.queue.claim('coordinator','first')!;await f.agent.runJob(claimed);
  // Snapshot the app immediately before terminal commit/Queue.finish, while native
  // original is already done. Subsequent submissions use the genuine Pi inbox.
  const turn=turns.get(job.id)!;turn.closed=false;turn.state='running';turn.version=1;turn.correctionOrder=[];turns.save(turn);f.store.run('DELETE FROM meta WHERE key=?','telegramTerminal:'+job.id);
  const {BACKGROUND_CONTEXT:ctx}=await import('@earendil-works/chord/context');const harness=(f.agent as any).harness;const conversation=await harness.conversation(f.queue.get(job.id)!.conversation_id,ctx);
  const count=mode==='latest-success'?2:1;
  for(let i=0;i<count;i++){
   const c=turns.receive('reopened-'+i,turns.get(job.id)!,'required correction '+i);c.state='admitted';turns.admitCorrection(turns.get(job.id)!,c);install(mode.startsWith('failed'));
   const native=await conversation.submit({type:'input',content:c.body,requestId:'telegram-steer:'+c.id,whenBusy:'steer'},ctx);await native.wait(ctx);
   if(mode!=='submit-before-bind-stop'){c.submissionId=String(native.id);turns.submission(job.id,c.submissionId);}c.state=mode==='failed-after-receipt'?'failed':mode==='latest-success'?'settled':'placed';turns.saveCorrection(c);
  }
  if(mode.includes('stop')){await turns.stop(job.id,'g',1,'reopened-stop');if(mode==='stop-closed'){f.store.set('telegramStop:reopened-stop',{...f.store.get<any>('telegramStop:reopened-stop'),state:'idle_confirmed'});turns.close(job.id,'interrupted');}}
  const callsBefore=calls;await f.agent.close();f.store.close();closed=true;
  f=fixture(dir,'state');closed=false;install();await f.agent.open();turns=new TelegramTurns(f.store,f.queue);f.queue.recoverAfterRestart();const recovered=f.queue.claim('coordinator','recovered')!;assert.equal(recovered.id,job.id);
  if(mode==='latest-success'){const result=await f.agent.runJob(recovered);assert.equal(result.answer,'Public answer 3');assert.equal(f.store.get('telegramTerminal:'+job.id).answer,'Public answer 3');assert.ok(f.store.get('telegramTerminal:'+job.id).selectedFinalEntry);assert.equal(turns.get(job.id)!.state,'completed');}
  else {await assert.rejects(f.agent.runJob(recovered));assert.equal(turns.get(job.id)!.state,mode.includes('stop')?'interrupted':'failed');assert.notEqual(f.store.get('telegramTerminal:'+job.id).state,'completed');}
  assert.equal(calls,callsBefore,'recovery must read durable submissions without provider replay');assert.equal(turns.get(job.id)!.submissions.length,count+1);if(mode==='stop-closed')assert.equal(turns.get(job.id)!.version,2,'closed recovery must not reopen or close twice');
 }finally{if(!closed){await f.agent.close();f.store.close();}rmSync(dir,{recursive:true,force:true});}
});

test('Stop accepted during post-answer accounting wins atomic terminal closure',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pi-final-stop-')),f=fixture(dir,'state'),turns=new TelegramTurns(f.store,f.queue),gate=held(),entered=held();let running:Promise<any>|undefined;
 f.store.set('telegramBinding',{generation:'g',chatId:42,userId:42,since:now()});f.agent.models.streamSimple=()=>{const stream=createAssistantMessageEventStream(),message:any={role:'assistant',api:'openai-responses',provider:'openai',model:'gpt-6.1-sol',timestamp:Date.now(),usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',content:[{type:'text',text:'Public answer before stop'}]};queueMicrotask(()=>{stream.push({type:'start',partial:message});stream.push({type:'done',reason:'stop',message});});return stream;};
 try{await f.agent.open();const harness=(f.agent as any).harness,usage=harness.usage.bind(harness);harness.usage=async(...args:any[])=>{entered.release();await gate.promise;return usage(...args);};const control=new ApplicationControl(f.store,f.queue),job=control.admit('post-answer-stop','hello','telegram');f.store.set('jobTelegramGeneration:'+job.id,'g');turns.attach(job,'g',42);const claimed=f.queue.claim('coordinator','test')!;running=f.agent.runJob(claimed).then(result=>({result}),error=>({error}));await entered.promise;const target=turns.get(job.id)!;assert.equal((await turns.stop(job.id,'g',target.version,'post-answer')).state,'received');await turns.dispatchStop('post-answer');gate.release();assert.ok((await running).error);assert.equal(turns.get(job.id)!.state,'interrupted');assert.equal(f.store.get('telegramTerminal:'+job.id).state,'interrupted');}
 finally{gate.release();await running;await f.agent.close();f.store.close();rmSync(dir,{recursive:true,force:true});}
});

for(const proof of [true,false])test('reopened queued withdrawal '+(proof?'confirmed receipt preserves original':'missing native-abort receipt fails closed'),async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pi-withdraw-reopen-'));let f=fixture(dir,'state'),closed=false;const gate=held(),entered=held();let running:Promise<any>|undefined,calls=0;
 f.store.set('telegramBinding',{generation:'g',chatId:42,userId:42,since:now()});f.agent.models.streamSimple=()=>{calls++;const stream=createAssistantMessageEventStream(),message:any={role:'assistant',api:'openai-responses',provider:'openai',model:'gpt-6.1-sol',timestamp:Date.now(),usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',content:[{type:'text',text:'Original answer remains public'}]};entered.release();void gate.promise.then(()=>{stream.push({type:'start',partial:message});stream.push({type:'done',reason:'stop',message});});return stream;};
 try{await f.agent.open();let turns=new TelegramTurns(f.store,f.queue);const control=new ApplicationControl(f.store,f.queue),job=control.admit('withdraw-reopen-'+proof,'hello','telegram');f.store.set('jobTelegramGeneration:'+job.id,'g');turns.attach(job,'g',42);const claimed=f.queue.claim('coordinator','first')!;running=f.agent.runJob(claimed);await entered.promise;const c=turns.receive('withdraw-reopen',turns.get(job.id)!,'unused correction');await turns.steer(c.id);assert.equal(await turns.withdraw(c.id),'aborted');gate.release();await running;
  const turn=turns.get(job.id)!;turn.closed=false;turn.state='running';turn.version=1;turns.save(turn);f.store.run('DELETE FROM meta WHERE key=?','telegramTerminal:'+job.id);if(!proof){const receipt=turns.correction(c.id)!;receipt.state='admitted';delete receipt.withdrawResult;turns.saveCorrection(receipt);}
  await f.agent.close();f.store.close();closed=true;f=fixture(dir,'state');closed=false;f.agent.models.streamSimple=()=>{throw Error('Recovery must never replay native aborted correction');};await f.agent.open();turns=new TelegramTurns(f.store,f.queue);f.queue.recoverAfterRestart();const recovered=f.queue.claim('coordinator','second')!;
  if(proof){const result=await f.agent.runJob(recovered);assert.equal(result.answer,'Original answer remains public');assert.equal(turns.get(job.id)!.state,'completed');}
  else {await assert.rejects(f.agent.runJob(recovered));assert.equal(turns.get(job.id)!.state,'failed');assert.equal(turns.correction(c.id)!.state,'failed');}
  assert.equal(calls,1);assert.equal(turns.get(job.id)!.submissions.length,2);
 }finally{gate.release();await running?.catch(()=>{});if(!closed){await f.agent.close();f.store.close();}rmSync(dir,{recursive:true,force:true});}
});

test('rejected correction before native commit makes held original terminal partial',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pi-reject-steer-')),f=fixture(dir,'state'),turns=new TelegramTurns(f.store,f.queue),gate=held(),entered=held();let running:Promise<any>|undefined;
 f.store.set('telegramBinding',{generation:'g',chatId:42,userId:42,since:now()});f.agent.models.streamSimple=()=>{const stream=createAssistantMessageEventStream(),message:any={role:'assistant',api:'openai-responses',provider:'openai',model:'gpt-6.1-sol',timestamp:Date.now(),usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',content:[{type:'text',text:'Original public partial'}]};entered.release();void gate.promise.then(()=>{stream.push({type:'start',partial:message});stream.push({type:'done',reason:'stop',message});});return stream;};
 try{await f.agent.open();const harness=(f.agent as any).harness,submit=harness.conversation.bind(harness);harness.conversation=async(...args:any[])=>{const conversation=await submit(...args),original=conversation.submit.bind(conversation);conversation.submit=async(input:any,...rest:any[])=>{if(input.requestId.startsWith('telegram-steer:'))throw Error('fixture rejected before commit');return original(input,...rest);};return conversation;};const job=new ApplicationControl(f.store,f.queue).admit('reject-before-commit','hello','telegram');f.store.set('jobTelegramGeneration:'+job.id,'g');turns.attach(job,'g',42);const claimed=f.queue.claim('coordinator','test')!;running=f.agent.runJob(claimed).then(result=>({result}),error=>({error}));await entered.promise;const c=turns.receive('rejected-intent',turns.get(job.id)!,'correct answer');assert.equal(await turns.steer(c.id),'failed');assert.equal(turns.correction(c.id)!.submissionId,undefined);await Promise.resolve();gate.release();assert.ok((await running).error);assert.equal(turns.get(job.id)!.state,'failed');assert.equal(turns.get(job.id)!.submissions.length,1);assert.equal(f.store.get('telegramTerminal:'+job.id).state,'failed');}
 finally{gate.release();await running;await f.agent.close();f.store.close();rmSync(dir,{recursive:true,force:true});}
});

test('committed terminal result survives restart with provider and accounting unavailable',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'pi-terminal-authority-'));let f=fixture(dir,'state'),closed=false;
 const gate=held(),entered=held();let calls=0;
 f.agent.models.streamSimple=()=>{const n=++calls,stream=createAssistantMessageEventStream(),message:any={role:'assistant',api:'openai-responses',provider:'openai',model:'gpt-6.1-sol',timestamp:Date.now(),usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',content:[{type:'text',text:n===1?'Original answer':'Latest corrected answer'}]};const emit=()=>{stream.push({type:'start',partial:message});stream.push({type:'done',reason:'stop',message});};if(n===1){entered.release();void gate.promise.then(emit);}else queueMicrotask(emit);return stream;};
 try{f.store.set('telegramBinding' ,{generation:'g',chatId:42,userId:42,since:now()});await f.agent.open();const turns=new TelegramTurns(f.store,f.queue),job=new ApplicationControl(f.store,f.queue).admit('terminal-authority','hello','telegram');f.store.set('jobTelegramGeneration:'+job.id,'g');turns.attach(job,'g',42);const claimed=f.queue.claim('coordinator','first')!,running=f.agent.runJob(claimed);await entered.promise;const correction=turns.receive('authoritative-correction',turns.get(job.id)!,'correct the original');await turns.steer(correction.id);gate.release();const result=await running;assert.equal(result.answer,'Latest corrected answer');const budget=f.store.get('runBudget:'+job.id),terminal=f.store.get('telegramTerminal:'+job.id);await f.agent.close();f.store.close();closed=true;
 f=fixture(dir,'state');closed=false;await f.agent.open();f.agent.available=async()=>{throw Error('provider unavailable');};(f.agent as any).harness.usage=async()=>{throw Error('accounting unavailable');};f.agent.models.streamSimple=()=>{throw Error('forbidden replay');};f.queue.recoverAfterRestart();const recovered=f.queue.claim('coordinator','restart')!;assert.deepEqual(await f.agent.runJob(recovered),result);assert.deepEqual(f.store.get('runBudget:'+job.id),budget);assert.deepEqual(f.store.get('telegramTerminal:'+job.id),terminal);f.queue.finish(job.id,recovered.run_token!,'completed',result);assert.equal(f.queue.get(job.id)!.state,'completed');
 }finally{if(!closed){await f.agent.close();f.store.close();}rmSync(dir,{recursive:true,force:true});}
});

test('SIGKILL during active correction recovers accepted Stop without completing old answer',async()=>{
 const {fork}=await import('node:child_process'),dir=mkdtempSync(join(tmpdir(),'pi-active-crash-'));const child=fork(new URL('./telegram-restart-fixture.js',import.meta.url),['active-correction-crash',dir],{stdio:['ignore','ignore','pipe','ipc']});let errors='';child.stderr!.on('data',data=>errors+=data);let f:ReturnType<typeof fixture>|undefined;
 try{const ready:any=await new Promise((resolve,reject)=>{child.on('message',resolve);child.once('exit',code=>reject(Error('fixture exited '+code+': '+errors)));});assert.equal(ready.submissions.length,2);const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await exited;
 f=fixture(dir,'state');f.agent.models.streamSimple=(_model,_request,options)=>{const stream=createAssistantMessageEventStream(),message:any={role:'assistant',api:'openai-responses',provider:'openai',model:'gpt-6.1-sol',timestamp:Date.now(),usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'aborted',content:[]};const abort=()=>stream.push({type:'error',reason:'aborted',error:message});if(options?.signal?.aborted)queueMicrotask(abort);else options?.signal?.addEventListener('abort',abort,{once:true});return stream;};await f.agent.open();f.queue.recoverAfterRestart();const recovered=f.queue.claim('coordinator','restart')!;assert.equal(recovered.id,ready.jobId);await assert.rejects(f.agent.runJob(recovered));const turns=new TelegramTurns(f.store,f.queue);assert.equal(turns.get(ready.jobId)!.state,'interrupted');assert.deepEqual(turns.get(ready.jobId)!.submissions,ready.submissions);assert.equal(f.store.get('telegramTerminal:'+ready.jobId).state,'interrupted');assert.equal(turns.correction('active-at-crash')!.state,'failed');
 }finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');if(f){await f.agent.close();f.store.close();}rmSync(dir,{recursive:true,force:true});}
});

test('production scheduler projects queued/waiting terminal receipts before model availability',async()=>{
 const {Scheduler}=await import('../scheduler.js'),dir=mkdtempSync(join(tmpdir(),'scheduler-terminal-'));let s=new Store(join(dir,'operational.sqlite')),q=new Queue(s),turns=new TelegramTurns(s,q);const jobs:{id:string;state:string;result?:any}[]=[];let runs=0;
 try{s.set('telegramBinding',{generation:'g',chatId:42,userId:42,since:now()});for(const state of ['completed','failed','interrupted']){const job=q.enqueue({requestId:'terminal-'+state,kind:'chat',payload:{message:'hello'}});s.set('jobCapability:'+job.id,'read_only_chat');turns.attach(job,'g',42);const result=state==='completed'?{answer:'Latest committed correction',usage:{input:2},budget:{calls:0}}:undefined;turns.finalize(job.id,state as any,{reason:state,result,selectedFinalEntry:'23',submissionIds:['19','22']});s.run("UPDATE jobs SET state=?,conversation_id='17',submission_id='19',submitted=1,wait_reason='model_unavailable' WHERE id=?",state==='failed'?'queued':'waiting',job.id);jobs.push({id:job.id,state,result});}s.close();s=new Store(join(dir,'operational.sqlite'));q=new Queue(s);const scheduler=new Scheduler(q,{available:async()=>false,runJob:async()=>{runs++;throw Error('No native work allowed');}});await scheduler.dispatchTelegram();await scheduler.pump();scheduler.stop();assert.equal(runs,0);for(const expected of jobs){const job=q.get(expected.id)!;assert.equal(job.state,expected.state==='completed'?'completed':'failed');assert.equal(job.conversation_id,'17');assert.equal(job.submission_id,'19');if(expected.result)assert.deepEqual(JSON.parse(job.result!),expected.result);else assert.match(job.error!,new RegExp(expected.state));assert.equal(s.get('runBudget:'+job.id),undefined);}}
 finally{s.close();rmSync(dir,{recursive:true,force:true});}
});

test('/menu delivers inline navigation through command handlers with ACK before admission',async()=>{
 const calls:{method:string;body:any}[]=[],f=setup(async(method:string,body:any)=>{calls.push({method,body});if(method==='answerCallbackQuery')assert.equal(f.q.metrics().states.reduce((n,r)=>n+r.count,0),0,'callback ACK precedes analysis admission');return {message_id:1};});
 try{f.t.ingest([incoming(900,'/menu')]);await f.t.process();await f.t.deliver();const sent=calls.find(c=>c.method==='sendMessage')!.body,buttons=sent.reply_markup.inline_keyboard.flat();assert.deepEqual(buttons.map((b:any)=>b.text),['Stato','Analizza','Proposte','Coda','Aiuto']);for(const b of buttons){assert.ok(Buffer.byteLength(b.callback_data)>=1&&Buffer.byteLength(b.callback_data)<=64);const receipt=f.s.get<any>('telegramCallback:'+b.callback_data);assert.equal(receipt.chatId,42);assert.equal(receipt.generation,'owner-generation');assert.ok(receipt.expires);assert.equal(receipt.eventId,'update:900:'+b.text);}
 const analyze=buttons.find((b:any)=>b.text==='Analizza');calls.length=0;f.t.ingest([callback(901,analyze.callback_data)]);await f.t.process();assert.equal(calls[0]!.method,'answerCallbackQuery');assert.equal(calls[0]!.body.callback_query_id,'callback-901');const jobs=f.s.all('SELECT * FROM jobs');assert.equal(jobs.length,1);assert.equal(jobs[0]!.kind,'analysis');assert.equal(JSON.parse(jobs[0]!.payload).message,'Analizza economia del nodo e blocchi attuali');assert.equal(f.s.get('jobTelegramGeneration:'+jobs[0]!.id),'owner-generation');await f.t.deliver();assert.match(calls.find(c=>c.method==='sendMessage')!.body.text,/Ti rispondo/);
 }finally{f.close();}
});

for(const revoked of ['owner','bot','expiry','chat'] as const)test('inline menu '+revoked+' correlation rejects callback after ACK without action',async()=>{
 const calls:string[]=[],f=setup(async(method:string)=>{calls.push(method);return {message_id:1};});try{f.s.set('telegramBotGeneration','bot-original');f.t.ingest([incoming(910,'/menu')]);await f.t.process();const button=f.s.get<any>('telegramButtons:update:910').inline_keyboard[0].find((b:any)=>b.text==='Analizza');if(revoked==='owner')f.s.set('telegramBinding',{...f.s.get<any>('telegramBinding'),generation:'owner-new'});if(revoked==='bot')f.s.set('telegramBotGeneration','bot-new');if(revoked==='expiry'||revoked==='chat'){const receipt=f.s.get<any>('telegramCallback:'+button.callback_data);if(revoked==='expiry')receipt.expires=new Date(Date.now()-1000).toISOString();else receipt.chatId=99;f.s.set('telegramCallback:'+button.callback_data,receipt);}calls.length=0;f.t.ingest([callback(911,button.callback_data)]);await f.t.process();assert.equal(calls[0],'answerCallbackQuery');assert.equal(f.s.all('SELECT * FROM jobs').length,0);assert.match(f.s.one("SELECT text FROM telegram_outbox WHERE event_id='update:911'")!.text,/Pulsante scaduto/);assert.equal(f.s.get('enabled'),true);}finally{f.close();}
});

for(const [label,command] of [['Stato','/status'],['Proposte','/proposals'],['Coda','/queue'],['Aiuto','/help']])test('inline '+label+' uses identical guarded '+command+' handler',async()=>{
 const nav=setup(),slash=setup();try{nav.t.ingest([incoming(920,'/menu')]);await nav.t.process();const buttons=nav.s.get<any>('telegramButtons:update:920').inline_keyboard.flat();assert.equal(buttons.some((b:any)=>/Approva|Riprendi|Pausa/.test(b.text)),false);const selected=buttons.find((b:any)=>b.text===label);nav.t.ingest([callback(921,selected.callback_data)]);await nav.t.process();slash.t.ingest([incoming(921,command!)]);await slash.t.process();assert.equal(nav.s.one("SELECT text FROM telegram_outbox WHERE event_id='update:921'")!.text,slash.s.one("SELECT text FROM telegram_outbox WHERE event_id='update:921'")!.text);assert.equal(nav.s.all('SELECT * FROM jobs').length,0);assert.equal(nav.s.get('enabled'),slash.s.get('enabled'));}finally{nav.close();slash.close();}
});

for(const ageMinutes of [6,14,16])test('menu callback message dated '+ageMinutes+' minutes ago uses durable expiry after ACK',async()=>{
 const calls:{method:string;body:any}[]=[],f=setup(async(method:string,body:any)=>{calls.push({method,body});if(method==='answerCallbackQuery')assert.equal(f.s.all('SELECT * FROM jobs').length,0);return {message_id:1};});
 try{const current=now(),created=new Date(Date.parse(current)-ageMinutes*60000).toISOString();f.s.set('telegramBinding',{...f.s.get<any>('telegramBinding'),since:new Date(Date.parse(created)-60000).toISOString()});f.t.ingest([incoming(930,'/menu')]);await f.t.process(created);const button=f.s.get<any>('telegramButtons:update:930').inline_keyboard.flat().find((b:any)=>b.text==='Analizza');const update=callback(931,button.callback_data);(update.callback_query.message as any).date=Math.floor(Date.parse(created)/1000);calls.length=0;f.t.ingest([update]);await f.t.process(current);assert.equal(calls[0]!.method,'answerCallbackQuery');assert.equal(calls[0]!.body.callback_query_id,'callback-931');if(ageMinutes<15){const jobs=f.s.all('SELECT * FROM jobs');assert.equal(jobs.length,1);assert.equal(jobs[0]!.kind,'analysis');assert.equal(JSON.parse(jobs[0]!.payload).message,'Analizza economia del nodo e blocchi attuali');}else{assert.equal(f.s.all('SELECT * FROM jobs').length,0);assert.match(f.s.one("SELECT text FROM telegram_outbox WHERE event_id='update:931'")!.text,/Pulsante scaduto/);}assert.equal(f.s.one('SELECT status FROM telegram_updates WHERE update_id=931')!.status,'done');}
 finally{f.close();}
});

test('rich draft rejection falls back to visible Thinking text with native Stop and public summaries only',async()=>{
 const calls:{method:string;body:any}[]=[],f=setup(async(method:string,body:any)=>{calls.push({method,body});if(method==='sendRichMessageDraft')throw Object.assign(Error('unsupported rich draft'),{rejected:true});return true;});
 try{const job=f.c.admit('plain-thinking','hello','telegram');f.turns.attach(job,'owner-generation',42);const owned=f.q.claim('coordinator','test')!;f.turns.bind(owned,{steer:async()=>{},stop:async()=>{}});await f.t.streamDrafts();await f.t.streamDrafts();const plain=calls.find(c=>c.method==='sendMessageDraft')!.body;assert.equal(plain.text,'Thinking…');assert.equal(plain.can_stop,true);assert.equal(plain.keep_on_stop,true);assert.ok(plain.draft_id>0);const ui=new UiEvents(f.s);ui.append(job.id,'reasoning_summary',{text:'Hidden provider block',provenance:'private'});ui.append(job.id,'reasoning_summary',{text:'Public provider summary',provenance:'responses.summary_text'});await f.t.streamDrafts(new Date(Date.now()+21000).toISOString());const updated=calls.filter(c=>c.method==='sendMessageDraft').at(-1)!.body;assert.match(updated.text,/Thinking…\nPublic provider summary/);assert.doesNotMatch(updated.text,/Hidden provider block/);}
 finally{f.close();}
});

test('long cumulative response keeps draft moving and final chunks preserve whole Unicode answer',async()=>{
 const calls:{method:string;body:any}[]=[],f=setup(async(method:string,body:any)=>{calls.push({method,body});return {message_id:1};});
 try{const job=f.c.admit('long-moving-draft','Spiega il nodo','telegram');f.s.set('jobTelegramGeneration:'+job.id,'owner-generation');f.turns.attach(job,'owner-generation',42);const owned=f.q.claim('coordinator','test')!;f.turns.bind(owned,{steer:async()=>{},stop:async()=>{}});const ui=new UiEvents(f.s),initial='a'.repeat(3498)+'😀'+'b'.repeat(150),later=initial+'NUOVA PARTE 😀';ui.append(job.id,'text',{text:initial});await f.t.streamDrafts();const first=calls.filter(c=>c.method==='sendRichMessageDraft').at(-1)!.body.rich_message.html;assert.match(first,/Risposta in corso \(continuazione\)/);assert.ok(first.length<=3500);ui.append(job.id,'text',{text:later});await f.t.streamDrafts(new Date(Date.now()+2000).toISOString());const next=calls.filter(c=>c.method==='sendRichMessageDraft').at(-1)!.body.rich_message.html;assert.notEqual(next,first);assert.ok(next.endsWith('NUOVA PARTE 😀'));assert.ok(next.length<=3500);assert.doesNotMatch(next,/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);f.q.finish(job.id,owned.run_token!,'completed',{answer:later});f.t.capture();const rows=f.s.all("SELECT text FROM telegram_outbox WHERE event_id LIKE ? ORDER BY rowid",'answer:'+job.id+'%');assert.ok(rows.length>=2);assert.equal(rows.map(r=>r.text).join(''),later);assert.ok(rows.every(r=>r.text.length<=3500));}
 finally{f.close();}
});
