import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../store.js';
import { Queue } from '../queue.js';
import { ApplicationControl } from '../application-control.js';
import { Executor } from '../executor.js';
import { Telegram, operationText } from '../telegram.js';
import { now, type PaymentOutcome, type Proposal, type Snapshot } from '../domain.js';

const channel = (id: string, alias: string) => ({ id, point: id + ':0', peer: id, alias, active: true, capacitySat: '500000', localSat: '250000', remoteSat: '250000', reserveSat: '5000', pendingSat: '0', baseMsat: '0', ppm: 300, cltv: 80, minMsat: '1', maxMsat: '500000000' });
const snapshot = (): Snapshot => ({ at: now(), identity: 'self', synced: true, confirmedSat: '600000', channels: [channel('a', 'Don Quixote'), channel('b', 'LNMarkets')] });
const rebalance = (s: Store): Proposal => ({ kind: 'rebalance', category: 'exploratory', strategy: 'refill', source: 'a', target: 'b', amountSat: '1000', maxFeeMsat: '50000', decisionCapMsat: '50000', demandKey: 'a->b', evidenceIds: [s.evidence('fixture', 'observed')], problem: 'depleted', evidence: 'observed', whyAct: 'owner request', alternatives: 'wait', verify: 'forwards', hypothesis: 'more forwards' });
const message = (uid: number, text: string) => ({ update_id: uid, message: { text, from: { id: 42, username: 'owner' }, chat: { id: 42, type: 'private' } } });
const press = (uid: number, data: string) => ({ update_id: uid, callback_query: { id: 'cb' + uid, data, from: { id: 42 }, message: { chat: { id: 42, type: 'private' } } } });

/** A paired bot, a fake LND whose send/track the test scripts, and one delivered rebalance proposal. */
async function setup(send: () => Promise<PaymentOutcome>) {
    const dir = mkdtempSync(join(tmpdir(), 'telegram-approval-')), s = new Store(':memory:'), q = new Queue(s);
    const sent: any[] = [], node: any = { sends: 0, tracked: undefined as PaymentOutcome | undefined, snapshot: async () => snapshot(), invoice: async () => ({ hash: 'ab'.repeat(32), request: 'lnbc-fixture' }), send: async () => { node.sends++; return send(); }, track: async () => node.tracked, updateFee: async () => { } };
    const executor = new Executor(s, node), c = new ApplicationControl(s, q, executor);
    const t = new Telegram(s, c, dir, { call: async (method: string, body: any) => { sent.push({ method, body }); return { message_id: sent.length }; } });
    s.set('telegramConfigured', true);
    const paired = new Date(Date.now() - 4 * 3600000).toISOString(), code = t.pairing(paired);
    t.ingest([message(1, '/start ' + code.code)]); await t.process(paired); t.confirm(42, paired);
    s.set('bootstrapReady', true); s.set('automationProof', { ok: true, at: now() }); s.saveSnapshot(snapshot());
    const job = c.admit('chat-rebalance', 'Fai il rebalance verso LNMarkets', 'telegram');
    const p = c.createProposal(rebalance(s), job.id)!;
    t.capture(); await t.deliver();
    const offer = sent.find(m => m.body?.reply_markup?.inline_keyboard?.[0]?.[0]?.text === 'Approva');
    assert.ok(offer, 'proposal delivered with Approva');
    const approve = offer.body.reply_markup.inline_keyboard[0][0].callback_data;
    const tap = async (uid: number) => { t.ingest([press(uid, approve)]); await t.process(); };
    const outbox = (like: string) => s.all('SELECT event_id,kind,text FROM telegram_outbox WHERE event_id LIKE ? ORDER BY created_at', like);
    return { s, c, t, p, node, executor, tap, outbox, close: () => { t.stop(); s.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('Approva is acknowledged at once; a failed payment is reported in Italian with the LND reason; a second tap sends nothing', async () => {
    const f = await setup(async () => ({ status: 'FAILED', feeMsat: '0', amountSat: '1000', reason: 'FAILURE_REASON_NO_ROUTE' }));
    try {
        await f.tap(100);
        assert.match(f.outbox('update:100:accepted')[0].text, /Approvazione ricevuta/);
        const operation = f.s.one('SELECT operation_id FROM owner_proposals WHERE id=?', f.p.id).operation_id;
        const [outcome] = f.outbox('operation:' + operation + ':%');
        assert.equal(outcome.kind, 'reply');
        assert.equal(outcome.text, 'Rebalance non riuscito: 1.000 sat da Don Quixote verso LNMarkets (nessun percorso entro il costo massimo, limite 50 sat). Nessun costo e saldi invariati.');
        assert.equal(f.c.proposal(f.p.id).status, 'failed');
        assert.equal(f.outbox('update:100').length, 0, 'no generic reply besides the outcome');
        await f.tap(101);
        assert.match(f.outbox('update:101')[0].text, /già eseguita; nessuna seconda esecuzione/);
        assert.equal(f.outbox('update:101:accepted').length, 0);
        assert.equal(f.node.sends, 1);
    } finally { f.close(); }
});

test('an unconfirmed payment is never "blocked": the owner hears it is in verification, the alert waits ten minutes, reconciliation reports the outcome', async () => {
    const f = await setup(async () => { throw Object.assign(new Error('cancelled'), { code: 1 }); });
    try {
        await f.tap(100);
        const operation = f.s.one('SELECT operation_id FROM owner_proposals WHERE id=?', f.p.id).operation_id;
        assert.equal(f.s.one('SELECT state FROM operations WHERE id=?', operation).state, 'uncertain');
        assert.equal(f.c.proposal(f.p.id).status, 'reconcile_required');
        assert.doesNotMatch(JSON.stringify(f.outbox('update:100%')), /bloccata/);
        assert.match(f.outbox('operation:' + operation + ':uncertain')[0].text, /pagamento inviato, esito non ancora confermato da LND\. Verifico senza ripeterlo/);
        f.t.capture();
        assert.equal(f.outbox('blockers:%').length, 0, 'no critical alert before ten minutes');
        // Still unsettled after ten minutes: one critical notice and the blocker.
        const later = new Date(Date.now() + 11 * 60000).toISOString();
        f.s.set('automationProof', { ok: true, at: later });
        f.t.capture(later);
        const stale = f.outbox('operation:' + operation + ':uncertain:stale');
        assert.equal(stale[0].kind, 'critical');
        assert.match(stale[0].text, /dopo 10 minuti/);
        assert.match(f.outbox('blockers:%')[0].text, /incerto da oltre 10 minuti/);
        // LND settles it: proposal and owner message follow the operation; nothing is re-sent.
        f.node.tracked = { status: 'FAILED', feeMsat: '0', amountSat: '1000', reason: 'FAILURE_REASON_TIMEOUT' };
        await f.executor.reconcile();
        assert.equal(f.c.proposal(f.p.id).status, 'failed');
        f.t.capture();
        assert.match(f.outbox('operation:' + operation + ':FAILED')[0].text, /tempo scaduto senza un percorso riuscito/);
        assert.equal(f.node.sends, 1);
    } finally { f.close(); }
});

test('a delivered proposal past its five minutes becomes expired and its tap says so', async () => {
    const f = await setup(async () => ({ status: 'SUCCEEDED', feeMsat: '0', amountSat: '1000' }));
    try {
        f.t.capture(new Date(Date.now() + 6 * 60000).toISOString());
        assert.equal(f.c.proposal(f.p.id).status, 'expired');
        await f.tap(100);
        assert.match(f.outbox('update:100')[0].text, /scaduta o non più valida: chiedine una nuova/);
        assert.equal(f.outbox('update:100:accepted').length, 0);
        assert.equal(f.node.sends, 0);
    } finally { f.close(); }
});

test('operation outcomes name channels, cost and fee changes', () => {
    const s = snapshot(), p = { ...rebalance(new Store(':memory:')), amountSat: '250000', maxFeeMsat: '100000' };
    assert.equal(operationText(p, 'SUCCEEDED', { feeMsat: '98999' }, s), 'Rebalance riuscito: 250.000 sat da Don Quixote verso LNMarkets, costo 98,999 sat.');
    assert.equal(operationText(p, 'FAILED', {}, s), 'Rebalance non riuscito: 250.000 sat da Don Quixote verso LNMarkets. Nessun costo e saldi invariati.');
    const fee: Proposal = { ...p, kind: 'fee_change', source: '', newPpm: 360 };
    assert.equal(operationText(fee, 'SUCCEEDED', {}, s), 'Fee aggiornata: fee di LNMarkets a 360 ppm.');
});
