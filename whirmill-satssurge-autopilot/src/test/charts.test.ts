import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../store.js';
import { Queue } from '../queue.js';
import { ApplicationControl } from '../application-control.js';
import { Telegram } from '../telegram.js';
import { CHART_KINDS, chartData, chartCaption, chartPng, chartSvg, chartsReady, cleanAlias, enqueueChart } from '../charts.js';
import type { Snapshot } from '../domain.js';

const HOUR = 3600000, end = Date.now();
const channel = (id: string, alias: string, local: number, capacity: number, ppm: number) => ({ id, point: id + ':0', peer: id, alias, active: true, capacitySat: String(capacity), localSat: String(local), remoteSat: String(capacity - local), reserveSat: '5000', pendingSat: '0', baseMsat: '0', ppm, cltv: 80, minMsat: '1', maxMsat: '1000000000' });
const snapshotAt = (t: number, lnmLocal: number, ppm = 400): Snapshot => ({ at: new Date(t).toISOString(), identity: 'self', synced: true, confirmedSat: '600000', channels: [channel('100', 'routing.lightning.lnmarkets.com', lnmLocal, 1000000, ppm), channel('200', '🛡 Don Quixote Bank 🚩', 391227 - (lnmLocal > 100000 ? 250285 : 0), 400000, 250), channel('300', 'bhodl', 418735, 2000000, 300)] });
/** Ten days of hourly snapshots, forwards, ledger rows and one owner rebalance two days ago. */
function populated() {
  const s = new Store(':memory:');
  const rebalanceAt = end - 48 * HOUR;
  for (let t = end - 10 * 24 * HOUR; t <= end; t += HOUR) s.saveSnapshot(snapshotAt(t, t < rebalanceAt ? 17363 : 267363 - Math.round((t - rebalanceAt) / HOUR) * 500, t < end - 5 * 24 * HOUR ? 380 : 400));
  for (let i = 0; i < 40; i++) {
    const at = new Date(end - (i * 5 + 1) * HOUR).toISOString(), target = i % 3 ? '100' : '300', fee = 4000 + i * 100;
    s.event({ id: 'fwd:' + i, at, type: 'external_forward', source: '300', target, amountMsat: String(10_000_000 + i * 1_000_000), feeMsat: String(fee) });
    s.ledger({ id: 'routing:' + i, at, classification: 'revenue', amountMsat: String(fee), category: 'routing' });
  }
  s.ledger({ id: 'cost:1', at: new Date(rebalanceAt).toISOString(), classification: 'expense', amountMsat: '284482', category: 'exploratory' });
  const proposal = { kind: 'rebalance', category: 'exploratory', source: '200', target: '100', amountSat: '250000', maxFeeMsat: '500000' };
  s.run('INSERT INTO decisions VALUES(?,?,?,?,?,?)', 'decision-1', new Date(rebalanceAt).toISOString(), JSON.stringify(proposal), '{}', '{}', 'observing');
  s.run('INSERT INTO operations VALUES(?,?,?,?,?,?,?)', 'op-rebalance-1', 'decision-1', new Date(rebalanceAt).toISOString(), 'SUCCEEDED', null, null, JSON.stringify({ status: 'SUCCEEDED', feeMsat: '284482', amountSat: '250000', completedAt: new Date(rebalanceAt).toISOString() }));
  return s;
}

test('every chart kind renders to a PNG from database data, with its readable caption', async () => {
  await chartsReady();
  const s = populated(), at = new Date(end).toISOString();
  try {
    for (const kind of CHART_KINDS) {
      const data = chartData(s, { kind }, at), png = chartPng(data);
      assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], kind);
      assert.ok(png.length > 10000, kind + ' has content');
      assert.ok(chartCaption(data).length <= 1024, kind);
      assert.doesNotMatch(chartSvg(data), /NaN|undefined|Infinity/, kind);
      if (process.env.CHART_PREVIEW_DIR) writeFileSync(join(process.env.CHART_PREVIEW_DIR, kind + '.png'), png);
    }
    assert.match(chartCaption(chartData(s, { kind: 'canali' }, at)), /^Bilanciamento dei canali.*\nbhodl: 21% · 419k su 2M\n.*\nDon Quixote Bank: 35% · 141k su 400k$/s);
    const payback = chartCaption(chartData(s, { kind: 'rebalance' }, at));
    assert.match(payback, /250\.000 sat da Don Quixote Bank verso routing\.lightning\.lnmarkets\.com, costo 284 sat\./);
    assert.match(payback, /Commissioni rientrate da allora su routing\.lightning\.lnmarkets\.com: [\d.,]+ sat \(\d+% del costo\)/);
    assert.match(chartCaption(chartData(s, { kind: 'fee', channel: 'lnmarkets' }, at)), /^routing\.lightning\.lnmarkets\.com dal .*: fee 380 → 400 ppm \(1 modifiche\), 26 inoltri in uscita\.$/);
    assert.match(chartCaption(chartData(s, { kind: 'guadagni' }, at)), /costi dei rebalance 284 sat/);
    assert.throws(() => chartData(s, { kind: 'fee', channel: 'sconosciuto' }, at), /Canale non trovato/);
    assert.equal(cleanAlias('🛡 Don Quixote Bank 🚩'), 'Don Quixote Bank');
  } finally { s.close(); }
});

test('a chart is queued once with frozen data and goes out as a photo; /grafico offers the six charts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'charts-telegram-')), s = populated(), sent: { method: string; body: any }[] = [];
  const t = new Telegram(s, new ApplicationControl(s, new Queue(s)), dir, { call: async (method: string, body: any) => { sent.push({ method, body }); return { message_id: sent.length }; } });
  try {
    s.set('telegramConfigured', true);
    const paired = new Date(Date.now() - 4 * HOUR).toISOString(), code = t.pairing(paired);
    t.ingest([{ update_id: 1, message: { text: '/start ' + code.code, from: { id: 42, username: 'owner' }, chat: { id: 42, type: 'private' } } }]); await t.process(paired); t.confirm(42, paired);
    const generation = s.get('telegramBinding').generation, data = chartData(s, { kind: 'canali' });
    assert.equal(enqueueChart(s, 'chart:test', data, generation), true);
    assert.equal(enqueueChart(s, 'chart:test', chartData(s, { kind: 'storico' }), generation), false, 'same event keeps the first data');
    assert.equal(s.get('telegramChart:chart:test').kind, 'canali');
    assert.equal(enqueueChart(s, 'chart:other', data, 'old-generation'), false, 'a revoked generation queues nothing');
    await t.deliver();
    const photo = sent.find(m => m.method === 'sendPhoto')!;
    assert.ok(photo, 'sent as a photo');
    assert.equal(photo.body.get('chat_id'), '42');
    assert.match(photo.body.get('caption'), /^Bilanciamento dei canali/);
    assert.equal(photo.body.get('photo').type, 'image/png');
    assert.equal(s.one("SELECT status FROM telegram_outbox WHERE event_id='chart:test'").status, 'sent');
    // The menu command offers the six charts; a named chart is queued as an image.
    t.ingest([{ update_id: 2, message: { text: '/grafico', from: { id: 42 }, chat: { id: 42, type: 'private' }, date: Math.floor(Date.now() / 1000) } }]); await t.process();
    assert.deepEqual(s.get('telegramButtons:update:2').inline_keyboard.flat().map((b: any) => b.text), ['Bilanciamento', 'Storico saldi', 'Inoltri', 'Guadagni e costi', 'Ritorno rebalance', 'Fee e traffico']);
    t.ingest([{ update_id: 3, message: { text: '/grafico storico 3', from: { id: 42 }, chat: { id: 42, type: 'private' }, date: Math.floor(Date.now() / 1000) } }]); await t.process();
    assert.equal(s.get('telegramChart:chart:update:3').kind, 'storico');
    t.ingest([{ update_id: 4, message: { text: '/grafico fee nessuno', from: { id: 42 }, chat: { id: 42, type: 'private' }, date: Math.floor(Date.now() / 1000) } }]); await t.process();
    assert.match(s.one("SELECT text FROM telegram_outbox WHERE event_id='update:4'").text, /Grafico non disponibile: Canale non trovato: nessuno/);
  } finally { t.stop(); s.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('the payback chart keeps a drain within the hour: every snapshot in short windows', async () => {
  await chartsReady();
  const s = new Store(':memory:'), MIN = 60000, done = end - 90 * MIN;
  try {
    // 16:45 +250k, used by forwards within seven minutes, as on 26 Oct.
    for (let t = done - 10 * MIN; t <= end; t += MIN) s.saveSnapshot(snapshotAt(t, t <= done ? 17363 : t < done + 5 * MIN ? 267363 : t < done + 8 * MIN ? 42241 : 22240));
    s.run('INSERT INTO decisions VALUES(?,?,?,?,?,?)', 'decision-fast', new Date(done).toISOString(), JSON.stringify({ kind: 'rebalance', source: '200', target: '100', amountSat: '250000' }), '{}', '{}', 'observing');
    s.run('INSERT INTO operations VALUES(?,?,?,?,?,?,?)', 'op-fast', 'decision-fast', new Date(done).toISOString(), 'SUCCEEDED', null, null, JSON.stringify({ feeMsat: '284482', completedAt: new Date(done + 30000).toISOString() }));
    for (const [i, amount, fee] of [[1, 144869144, 57947], [2, 80252080, 32100], [3, 20001020, 8000]] as const) s.event({ id: 'fast:' + i, at: new Date(done + (3 + i) * MIN).toISOString(), type: 'external_forward', source: '300', target: '100', amountMsat: String(amount), feeMsat: String(fee) });
    const data = chartData(s, { kind: 'rebalance' }, new Date(end).toISOString());
    assert.equal(Math.max(...(data as any).balance.map((p: number[]) => p[1])), 267363);
    assert.match(chartCaption(data), /: 98,0 sat \(34% del costo\)\. Saldo locale subito dopo 267k sat, ora 22k sat\.$/);
    if (process.env.CHART_PREVIEW_DIR) writeFileSync(join(process.env.CHART_PREVIEW_DIR, 'rebalance-fast.png'), chartPng(data));
  } finally { s.close(); }
});
