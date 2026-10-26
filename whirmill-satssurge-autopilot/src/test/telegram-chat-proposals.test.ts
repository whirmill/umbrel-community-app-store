import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApplicationControl, requestCapability } from '../application-control.js';
import { Telegram } from '../telegram.js';
import { TelegramTurns } from '../telegram-turns.js';
import { fixture } from './pi-fixture.js';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import { getDeclaredTools } from '@earendil-works/pi-ai/utils/transcript';
import { now, type Proposal, type Snapshot } from '../domain.js';
import type { Store } from '../store.js';

const incoming = (id: number, text: string) => ({ update_id: id, message: { text, from: { id: 42 }, chat: { id: 42, type: 'private' } } });
const snapshot = (): Snapshot => ({ at: now(), identity: 'self', synced: true, confirmedSat: '500001', channels: ['a', 'b'].map(id => ({ id, point: id + ':0', peer: id, alias: id, active: true, capacitySat: '500000', localSat: '250000', remoteSat: '250000', reserveSat: '5000', pendingSat: '0', baseMsat: '0', ppm: 300, cltv: 80, minMsat: '1', maxMsat: '500000000' })) });
const fee = (s: Store): Proposal => ({ kind: 'fee_change', category: 'exploratory', source: '', target: 'b', amountSat: '0', maxFeeMsat: '0', decisionCapMsat: '0', newPpm: 305, strategy: 'trial', demandKey: 'fee:b', evidenceIds: [s.evidence('fixture', 'observed')], problem: 'pricing', evidence: 'observed', whyAct: 'review pricing', alternatives: 'wait', verify: '48h', hypothesis: 'return' });
// ~250k sat to the LNMarkets side at an observed 400 sat: above the 100 sat per-attempt mandate cap.
const rebalance = (s: Store): Proposal => ({ kind: 'rebalance', category: 'exploratory', source: 'a', target: 'b', amountSat: '200000', maxFeeMsat: '400000', decisionCapMsat: '400000', strategy: 'refill', demandKey: 'a->b', evidenceIds: [s.evidence('fixture', 'observed')], problem: 'depleted', evidence: 'observed', whyAct: 'owner request', alternatives: 'wait', verify: 'forwards', hypothesis: 'more forwards' });

test('Telegram text is one chat capability without keyword routing; web and analysis routing unchanged', () => {
    for (const text of ['Fai il rebalance verso LNMarkets', 'mi confermi lo stato?', 'proponimi una fee da approvare', 'Ciao'])
        assert.equal(requestCapability(text, 'telegram'), 'telegram_chat');
    assert.equal(requestCapability('mi confermi lo stato?', 'telegram', true), 'read_only_research');
    assert.equal(requestCapability('proponimi una fee', 'owner'), 'guarded_manual_proposal');
    assert.equal(requestCapability('Fai il rebalance', 'owner'), 'financial_guarded');
    assert.equal(requestCapability('propose', 'owner', false, 'qualification'), 'read_only_qualification');
});

test('the existing chat conversation survives the capability rename', () => {
    const directory = mkdtempSync(join(tmpdir(), 'surge-chat-session-')), f = fixture(directory, 'state');
    try {
        const turns = new TelegramTurns(f.store, f.queue), base = { jobId: 'j', generation: 'g', chatId: 42, version: 1, state: 'queued' as const, submissions: [], closed: false };
        assert.equal(turns.sessionKey({ ...base, capability: 'telegram_chat' }), turns.sessionKey({ ...base, capability: 'read_only_chat' }));
        assert.notEqual(turns.sessionKey({ ...base, capability: 'telegram_chat' }), turns.sessionKey({ ...base, capability: 'read_only_research' }));
    } finally { f.store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('proposal tools stay refused for analyst research, qualification and autonomous jobs', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'surge-chat-refused-')), f = fixture(directory, 'state');
    try {
        f.store.saveSnapshot(snapshot());
        const control = new ApplicationControl(f.store, f.queue);
        const research = control.admit('research', 'proponimi un rebalance', 'telegram', true);
        const qualification = control.admit('qualification', 'proponimi un rebalance', 'owner', false, 'qualification');
        const autonomous = control.admit('autonomous', 'Fai il rebalance', 'owner');
        for (const job of [research, qualification, autonomous]) {
            assert.throws(() => control.createProposal(fee(f.store), job.id), /capability/);
            await assert.rejects(control.createChannelProposal({ kind: 'channel_close', peer: '02' + '1'.repeat(64), channel: '1', amountSat: '0', evidenceIds: [], problem: '', evidence: '', whyAct: '', alternatives: '', verify: '', hypothesis: '' }, job.id), /capability/);
        }
        assert.equal(f.store.all('SELECT * FROM owner_proposals').length, 0);
    } finally { f.store.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('Telegram chat without keywords prepares an Approva/Rifiuta proposal from data; nothing executes; mandate blocks are named', { timeout: 20000 }, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'surge-chat-proposal-')), f = fixture(directory, 'state');
    const sent: { method: string; body: any }[] = [];
    const control = new ApplicationControl(f.store, f.queue), turns = new TelegramTurns(f.store, f.queue);
    const telegram = new Telegram(f.store, control, directory, { call: async (method: string, body: any) => { sent.push({ method, body }); return { message_id: sent.length }; } });
    const prompts: string[] = [], declared: string[][] = [], results: string[] = [];
    let plan: (s: Store) => Proposal = fee;
    // The model reads node_state, then proposes; the tool result decides the final text.
    f.agent.models.streamSimple = (_model, request) => {
        const stream = createAssistantMessageEventStream();
        prompts.push(JSON.stringify(request)); // Durable renders the instructions into the request.
        declared.push(getDeclaredTools(request.messages).map(t => t.name));
        // The persistent conversation carries earlier turns: decide from the latest message only.
        const last: any = request.messages.at(-1);
        if (last?.role === 'toolResult') results.push(JSON.stringify(last.content));
        const content: any[] = last?.role !== 'toolResult' ? [{ type: 'toolCall', id: 'read-' + prompts.length, name: 'node_state', arguments: {} }]
            : last.toolName === 'node_state' ? [{ type: 'toolCall', id: 'propose-' + prompts.length, name: 'create_manual_proposal', arguments: plan(f.store) }]
            : [{ type: 'text', text: 'Proposta pronta' }];
        const message: any = { role: 'assistant', api: 'openai-responses', provider: 'openai', model: 'gpt-6.1-sol', timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: content[0].type === 'toolCall' ? 'toolUse' : 'stop', content };
        queueMicrotask(() => { stream.push({ type: 'start', partial: message }); stream.push({ type: 'done', reason: message.stopReason, message }); });
        return stream;
    };
    const turn = async (update: number, text: string) => {
        telegram.ingest([incoming(update, text)]); await telegram.process();
        const job = f.queue.claim('coordinator', 'fixture', now(), 'chat');
        assert.ok(job, 'admitted on the Telegram chat lane');
        const answer = await f.agent.runJob(job);
        f.queue.finish(job.id, job.run_token!, 'completed', answer);
        return f.queue.get(job.id)!;
    };
    try {
        f.store.set('telegramConfigured', true);
        f.store.set('telegramBinding', { generation: 'g', chatId: 42, userId: 42, since: new Date(Date.now() - 60000).toISOString() });
        f.store.set('automationProof', { ok: true, at: now() });
        f.store.saveSnapshot(snapshot());
        await f.agent.open();

        const first = await turn(1, 'Fai il rebalance verso LNMarkets');
        assert.equal(f.store.get('jobCapability:' + first.id), 'telegram_chat');
        assert.equal(turns.get(first.id)!.capability, 'telegram_chat');
        assert.ok(declared[0]!.includes('create_manual_proposal') && declared[0]!.includes('create_channel_proposal') && declared[0]!.includes('node_state'));
        for (const absent of ['execute_decision', 'propose', 'propose_channel']) assert.equal(declared[0]!.includes(absent), false, absent);
        assert.match(prompts[0]!, /assistente del proprietario/);
        assert.match(prompts[0]!, /node_state/);
        assert.match(prompts[0]!, /maxCostPerAttemptSat\\+":100/);
        assert.doesNotMatch(prompts[0]!, /sola lettura/);

        const created = f.store.all('SELECT * FROM owner_proposals');
        assert.equal(created.length, 1);
        assert.equal(created[0].status, 'pending');
        assert.equal(created[0].job_id, first.id);
        telegram.capture(); await telegram.deliver();
        const offer = sent.find(m => JSON.stringify(m.body.reply_markup ?? '').includes('Approva'));
        assert.ok(offer, 'proposal delivered with buttons');
        assert.deepEqual(offer!.body.reply_markup.inline_keyboard[0].map((b: any) => b.text), ['Approva', 'Rifiuta']);
        assert.equal(f.store.all('SELECT * FROM operations').length, 0);
        assert.equal(existsSync(join(directory, 'effects.jsonl')), false);

        // A confirmation question keeps the same profile and the persistent conversation.
        plan = rebalance;
        const second = await turn(2, 'mi confermi lo stato?');
        assert.equal(f.store.get('jobCapability:' + second.id), 'telegram_chat');
        assert.equal(second.conversation_id, first.conversation_id);
        // The over-cap rebalance is not recorded; the tool names the limit and its value.
        assert.equal(f.store.all('SELECT * FROM owner_proposals').length, 1);
        const blocked = results.find(r => r.includes('blockedBy'))!;
        assert.match(blocked, /created\\?":false/);
        assert.match(blocked, /Fee cap exceeds attempt\/decision limit/);
        assert.match(blocked, /maxCostPerAttemptSat\\?":100/);
        assert.equal(f.store.all('SELECT * FROM operations').length, 0);
    } finally { telegram.stop(); await f.agent.close(); f.store.close(); rmSync(directory, { recursive: true, force: true }); }
});
