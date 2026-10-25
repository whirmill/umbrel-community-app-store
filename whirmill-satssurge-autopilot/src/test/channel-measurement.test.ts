import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import * as grpc from '@grpc/grpc-js';
import { Store } from '../store.js';
import { Queue } from '../queue.js';
import { Executor } from '../executor.js';
import { ApplicationControl } from '../application-control.js';
import { Telegram } from '../telegram.js';
import { ChannelLifecycle, candidateView, type ChannelOperation } from '../channels.js';
import { channelPerformance, channelCandidate } from '../channel-measurement.js';
import { Lnd, lndPackage } from '../lnd.js';
import { now, month, json, id, type Snapshot, type Channel } from '../domain.js';

const self = '02' + '00'.repeat(32), peerA = '02' + 'aa'.repeat(32), peerB = '03' + 'bb'.repeat(32), cand = '03' + 'cc'.repeat(32), far = '02' + 'ee'.repeat(32);
const channel = (cid: string, peer: string, over: Partial<Channel> = {}): Channel => ({ id: cid, point: 'ab'.repeat(32) + ':' + cid, peer, alias: 'alias' + cid, active: true, capacitySat: '1000000', localSat: '500000', remoteSat: '500000', reserveSat: '10000', pendingSat: '0', baseMsat: '0', ppm: 100, cltv: 80, minMsat: '1', maxMsat: '990000000', ...over });
const minutes = (n: number) => new Date(Date.now() - n * 60000).toISOString();

function seeded() {
  const s = new Store(':memory:'), at = now();
  // Channel 1 starts depleted then recovers; channel 2 flaps offline once.
  const shares = [100000, 300000, 800000], actives = [true, false, true];
  for (let i = 0; i < 3; i++) { const snap: Snapshot = { at: minutes(3 - i), identity: self, synced: true, confirmedSat: '3000000', channels: [channel('1', peerA, { localSat: String(shares[i]) }), channel('2', peerB, { active: actives[i]! })] }; s.saveSnapshot(snap); }
  s.saveSnapshot({ at, identity: self, synced: true, confirmedSat: '3000000', channels: [channel('1', peerA, { localSat: '800000' }), channel('2', peerB, { localSat: '50000' })] });
  const fwd = (eid: string, source: string, target: string, amount: string, fee: string, when = minutes(5)) => s.event({ id: eid, at: when, type: 'external_forward', source, target, amountMsat: amount, feeMsat: fee });
  fwd('f1', '1', '2', '100000000', '1000'); fwd('f2', '1', '2', '50000000', '500'); fwd('f3', '2', '1', '200000000', '4000');
  fwd('old', '1', '2', '999000000', '9999', new Date(Date.now() - 40 * 86400000).toISOString());
  s.event({ id: 'manual:x', at: minutes(10), type: 'manual_operation', source: '2', target: '1', amountMsat: '10000000', feeMsat: '10', pinned: true });
  const proposal = { kind: 'rebalance', source: '2', target: '1' };
  s.run('INSERT INTO decisions VALUES(?,?,?,?,?,?)', 'd1', minutes(20), json(proposal), '{}', '{}', 'observing');
  s.run('INSERT INTO operations VALUES(?,?,?,?,?,?,?)', 'o1', 'd1', minutes(20), 'SUCCEEDED', null, null, '{}');
  s.run('INSERT INTO decisions VALUES(?,?,?,?,?,?)', 'd2', minutes(15), json(proposal), '{}', '{}', 'failed');
  s.run('INSERT INTO operations VALUES(?,?,?,?,?,?,?)', 'o2', 'd2', minutes(15), 'FAILED', null, null, '{}');
  return s;
}

test('channel_performance: 30-day forwards, fees, local share, activity, rebalances and utilisation', () => {
  const s = seeded();
  s.run("INSERT OR REPLACE INTO coverage VALUES('forwards',?,?,'LND forwards',1,'{}')", new Date(Date.now() - 60 * 86400000).toISOString(), now());
  const r: any = channelPerformance(s);
  assert.equal(r.available, true); assert.equal(r.total, 2); assert.equal(r.coverage.forwards, 'complete');
  const [one, two] = r.rows;
  assert.deepEqual(one.forwards, { in: { count: 2, amountMsat: '150000000' }, out: { count: 1, amountMsat: '200000000' }, feesEarnedMsat: '4000' });
  assert.deepEqual(two.forwards, { in: { count: 1, amountMsat: '200000000' }, out: { count: 2, amountMsat: '150000000' }, feesEarnedMsat: '1500' });
  assert.equal(one.utilisation, 0.35);
  assert.deepEqual({ ...one.localShare, firstSampleAt: undefined }, { samples: 4, min: 0.1, avg: 0.5, max: 0.8, current: 0.8, firstSampleAt: undefined });
  assert.equal(two.activity.samples, 4); assert.equal(two.activity.activeSamples, 3); assert.equal(two.activity.transitions, 2); assert.equal(one.activity.transitions, 0);
  assert.deepEqual(one.rebalances.asTarget, { autopilotSucceeded: 1, autopilotAttempts: 2, manual: 1 });
  assert.deepEqual(two.rebalances.asSource, { autopilotSucceeded: 1, autopilotAttempts: 2, manual: 1 });
  assert.equal(one.observedForwardsLowerBound, undefined);
  assert.ok(Buffer.byteLength(json(r)) < 16384);
  s.close();
});

test('channel_performance never infers zero: incomplete coverage is unknown with an observed lower bound', () => {
  const s = seeded();
  let r: any = channelPerformance(s);
  assert.equal(r.coverage.forwards, 'incomplete'); assert.equal(r.rows[0].forwards, 'unknown'); assert.equal(r.rows[0].utilisation, 'unknown');
  assert.equal(r.rows[0].observedForwardsLowerBound.in.count, 2);
  // Coverage that stopped long ago, or a retention gap inside the window, is also incomplete.
  s.run("INSERT OR REPLACE INTO coverage VALUES('forwards',?,?,'LND forwards',1,'{}')", new Date(Date.now() - 60 * 86400000).toISOString(), minutes(60));
  assert.equal((channelPerformance(s) as any).rows[0].forwards, 'unknown');
  s.run("INSERT OR REPLACE INTO coverage VALUES('forwards',?,?,'LND forwards',1,'{}')", new Date(Date.now() - 60 * 86400000).toISOString(), now());
  s.run("INSERT INTO expired_intervals VALUES(?,?,'external_forward','1','2',3)", new Date(Date.now() - 35 * 86400000).toISOString(), new Date(Date.now() - 20 * 86400000).toISOString());
  assert.equal((channelPerformance(s) as any).rows[0].forwards, 'unknown');
  // A channel without retained samples has unknown share and activity, not zero.
  const snap = s.get<Snapshot>('snapshot')!; snap.channels.push(channel('3', far)); s.set('snapshot', snap);
  r = channelPerformance(s); assert.equal(r.rows[2].localShare, 'unknown'); assert.equal(r.rows[2].activity, 'unknown');
  const empty = new Store(':memory:'); assert.equal((channelPerformance(empty) as any).available, false); empty.close();
  // Bounded pages.
  for (let i = 10; i < 40; i++) snap.channels.push(channel(String(i), far)); s.set('snapshot', snap);
  const first: any = channelPerformance(s); assert.equal(first.rows.length, 25); assert.equal(first.nextOffset, 25);
  const second: any = channelPerformance(s, now(), 25); assert.equal(second.rows.length, 8); assert.equal(second.nextOffset, null);
  assert.throws(() => channelPerformance(s, now(), -1));
  s.close();
});

const policy = (ppm: number, disabled = false) => ({ baseMsat: '0', ppm, cltv: 40, disabled });
test('channel_candidate: capacity, fee policy and routes back to depleted channels from the snapshot', async () => {
  const s = new Store(':memory:');
  s.saveSnapshot({ at: now(), identity: self, synced: true, confirmedSat: '3000000', channels: [channel('1', peerA, { localSat: '50000' }), channel('2', peerB, { localSat: '900000' }), channel('3', far, { localSat: '150000' })] });
  const rpc: any = { nodeGraph: async () => ({ alias: 'Candidate', channels: 3, capacitySat: '9000000', truncated: false, edges: [
    { channelId: '10', peer: peerA, capacitySat: '5000000', outgoing: policy(300), incoming: policy(20) },
    { channelId: '11', peer: peerB, capacitySat: '2000000', outgoing: policy(100), incoming: policy(10) },
    { channelId: '12', peer: '02' + '99'.repeat(32), capacitySat: '2000000', outgoing: policy(900, true), incoming: null }] }) };
  const r: any = await channelCandidate(s, rpc, cand);
  assert.equal(r.available, true); assert.equal(r.capacitySat, '9000000'); assert.equal(r.existingChannelWithUs, false);
  assert.deepEqual(r.feePolicy, { enabledOutgoingEdges: 2, outgoingPpm: { min: 100, median: 300, max: 300 } });
  // Depleted are identified from local share, most depleted first; peerB (90% local) is not depleted.
  assert.deepEqual(r.routesBack.map((x: any) => [x.channel, x.directChannels]), [['1', 1], ['3', 0]]);
  assert.equal(r.routesBack[0].candidateToPeerPpm, 300); assert.equal(r.routesBack[0].peerToCandidatePpm, 20); assert.equal(r.routesBack[0].capacitySat, '5000000');
  const truncated: any = await channelCandidate(s, { nodeGraph: async () => ({ alias: '', channels: 9000, capacitySat: '1', truncated: true, edges: [] }) } as any, cand);
  assert.equal(truncated.routesBack[1].directChannels, 'unknown'); assert.equal(truncated.feePolicy, 'unknown');
  assert.deepEqual(await candidateView(undefined, cand), { available: false, reason: 'Channel credential not provisioned; candidate graph unavailable' });
  const failing = new ChannelLifecycle(s, {} as any, { nodeGraph: async () => { throw Error('LND down'); } } as any);
  assert.equal((await candidateView(failing, cand) as any).available, false);
  s.close();
});

function certificate(dir: string) {
  const key = join(dir, 'k.key'), cert = join(dir, 'c.pem'), csr = join(dir, 'c.csr');
  execFileSync('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', csr, '-subj', '/CN=isolated-fixture', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  execFileSync('openssl', ['x509', '-req', '-in', csr, '-signkey', key, '-out', cert, '-days', '30', '-copy_extensions', 'copy'], { stdio: 'ignore' });
  return { key: readFileSync(key), cert: readFileSync(cert) };
}
test('gRPC nodeGraph requests include_channels under the channel credential and orients edges from the candidate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'satssurge-graph-')), pair = certificate(dir), seen: any[] = [];
  const ca = join(dir, 'tls.cert'), read = join(dir, 'read'), write = join(dir, 'write'), chan = join(dir, 'channel');
  writeFileSync(ca, pair.cert); writeFileSync(read, Buffer.from('01', 'hex')); writeFileSync(write, Buffer.from('02', 'hex')); writeFileSync(chan, Buffer.from('0709', 'hex'));
  const server = new grpc.Server();
  server.addService(lndPackage.lnrpc.Lightning.service, { getNodeInfo: (call: any, cb: any) => { seen.push({ request: call.request, token: call.metadata.get('macaroon')[0] }); cb(null, { node: { alias: 'Candidate' }, num_channels: 2, total_capacity: '7000000', channels: [
    { channel_id: '18446744073709551614', node1_pub: cand, node2_pub: peerA, capacity: '5000000', node1_policy: { fee_base_msat: '1000', fee_rate_milli_msat: '250', time_lock_delta: 40, disabled: false }, node2_policy: { fee_base_msat: '0', fee_rate_milli_msat: '5', time_lock_delta: 80, disabled: true } },
    { channel_id: '2', node1_pub: peerB, node2_pub: cand, capacity: '2000000', node1_policy: { fee_rate_milli_msat: '7' } }] }); } } as any);
  const port = await new Promise<number>((resolve, reject) => server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createSsl(null, [{ private_key: pair.key, cert_chain: pair.cert }], false), (e, p) => e ? reject(e) : resolve(p)));
  const client = new Lnd('127.0.0.1:' + port, ca, read, write, { unaryMs: 1500, paymentMs: 1500, htlcMs: 1500, maxChannels: 4, maxCalls: 64, historyBytes: 1024 * 1024, streamBytes: 1024 * 1024 });
  try {
    client.enableChannels(chan); const g = await client.channelRpc()!.nodeGraph(cand);
    assert.equal(seen[0].request.include_channels, true); assert.equal(seen[0].request.pub_key, cand); assert.equal(seen[0].token, '0709');
    assert.deepEqual(g.edges[0], { channelId: '18446744073709551614', peer: peerA, capacitySat: '5000000', outgoing: { baseMsat: '1000', ppm: 250, cltv: 40, disabled: false }, incoming: { baseMsat: '0', ppm: 5, cltv: 80, disabled: true } });
    assert.equal(g.edges[1]!.peer, peerB); assert.equal(g.edges[1]!.outgoing, null); assert.equal(g.edges[1]!.incoming!.ppm, 7); assert.equal(g.truncated, false);
  } finally { client.close(); server.forceShutdown(); rmSync(dir, { recursive: true, force: true }); }
});

function channelSetup() {
  const dir = mkdtempSync(join(tmpdir(), 'telegram-channel-')), s = new Store(':memory:'), q = new Queue(s);
  s.set('bootstrapReady', true); s.set('automationProof', { ok: true, at: now() });
  const pending = { opens: [] as any[], closing: [] as any[] }, closed: any[] = [], calls: string[] = [];
  let state: Snapshot = { at: now(), identity: self, synced: true, confirmedSat: '3000000', channels: [channel('1', peerA)] }; s.saveSnapshot(state);
  const node: any = { snapshot: async () => ({ ...state, at: now() }) };
  const rpc: any = { pendingChannels: async () => pending, closedChannels: async () => closed, openChannel: async () => { calls.push('open'); }, closeChannel: async () => { calls.push('close'); }, connectPeer: async () => { calls.push('connect'); } };
  const executor = new Executor(s, node); executor.channels = new ChannelLifecycle(s, node, rpc);
  const c = new ApplicationControl(s, q, executor), t = new Telegram(s, c, dir, { call: async () => ({ message_id: 1 }) } as any);
  s.set('telegramConfigured', true);
  const op = (kind: 'channel_open' | 'channel_close', st: string): ChannelOperation => { const at = now(), o: any = { id: id(), proposalId: id(), kind, at, month: month(at), state: st, peer: kind === 'channel_open' ? cand : peerA, ...(kind === 'channel_close' ? { channel: '1', point: 'ab'.repeat(32) + ':1' } : {}), amountSat: kind === 'channel_open' ? '1000000' : '0', satPerVbyte: '10', maxFeeSat: '2500', feeChargedSat: '2500', history: [{ at, state: 'reserved' }, { at, state: 'sending' }, { at, state: st }] }; s.set('channelOperation:' + o.id, o); return o; };
  return { s, c, t, pending, closed, calls, op, set: (next: Snapshot) => { state = next; s.saveSnapshot(next); }, close: () => { t.stop(); s.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const tgUpdate = (uid: number, text: string) => ({ update_id: uid, message: { text, from: { id: 42, username: 'owner' }, chat: { id: 42, type: 'private' } } });
async function pairOwner(f: ReturnType<typeof channelSetup>) { const at = new Date(Date.now() - 3600000).toISOString(), code = f.t.pairing(at); f.t.ingest([tgUpdate(1, '/start ' + code.code)]); await f.t.process(at); f.t.confirm(42, at); }

test('Telegram reports each channel state once; uncertain carries an owner close-out that never re-sends', async () => {
  const f = channelSetup(); await pairOwner(f);
  const open = f.op('channel_open', 'uncertain');
  f.t.capture(); f.t.capture();
  const rows = f.s.all("SELECT event_id,kind,text FROM telegram_outbox WHERE event_id LIKE 'channel-operation:%'");
  assert.deepEqual(rows.map(r => [r.event_id, r.kind]), [['channel-operation:' + open.id + ':uncertain', 'critical']]);
  assert.match(rows[0].text, /esito incerto/); assert.match(rows[0].text, /Nessuna chiusura forzata/);
  const button = f.s.get('telegramButtons:channel-operation:' + open.id + ':uncertain').inline_keyboard[0][0];
  assert.equal(button.text, 'Segna come fallita');
  const press = async (uid: number) => { f.t.ingest([{ update_id: uid, callback_query: { id: 'cb' + uid, data: button.callback_data, from: { id: 42 }, message: { chat: { id: 42, type: 'private' } } } }]); await f.t.process(); return f.s.all('SELECT text FROM telegram_outbox WHERE event_id LIKE ?', 'update:' + uid + '%').map(r => r.text).join(' '); };
  // LND still shows a pending open for this peer and amount: refused, the operation stays uncertain.
  f.pending.opens.push({ peer: cand, point: 'cd'.repeat(32) + ':0', capacitySat: '1000000' });
  assert.match(await press(200), /Non segnata come fallita: LND still shows this channel/);
  assert.equal(f.s.get<ChannelOperation>('channelOperation:' + open.id)!.state, 'uncertain');
  f.pending.opens.length = 0;
  assert.match(await press(201), /segnata come fallita/);
  const failed = f.s.get<ChannelOperation>('channelOperation:' + open.id)!;
  assert.equal(failed.state, 'failed'); assert.equal(failed.ownerResolved, true); assert.equal(failed.feeChargedSat, '0');
  assert.match(await press(202), /not uncertain/);
  f.t.capture();
  assert.ok(f.s.one('SELECT event_id FROM telegram_outbox WHERE event_id=?', 'channel-operation:' + open.id + ':failed'));
  assert.deepEqual(f.calls, []);
  // Pending and confirmed states of another operation are reported once each.
  const close = f.op('channel_close', 'pending'); f.t.capture();
  f.closed.push({ point: 'ab'.repeat(32) + ':1', peer: peerA, txid: 'ef'.repeat(32), type: 'COOPERATIVE_CLOSE' });
  f.s.set('channelOperation:' + close.id, { ...close, txid: 'ef'.repeat(32) });
  await f.c.channels().reconcile(); f.t.capture(); f.t.capture();
  assert.deepEqual(f.s.all("SELECT event_id,kind FROM telegram_outbox WHERE event_id LIKE ? ORDER BY event_id", 'channel-operation:' + close.id + '%').map(r => [r.event_id.split(':').at(-1), r.kind]), [['confirmed', 'operational'], ['pending', 'operational']]);
  assert.deepEqual(f.calls, []); f.close();
});

test('an owner-failed close that LND completes later is recorded with its fee, never re-sent', async () => {
  const f = channelSetup();
  const close = f.op('channel_close', 'uncertain');
  // Peer offline: channel inactive, no waiting close and no closed record. The owner may close it out.
  f.set({ at: now(), identity: self, synced: true, confirmedSat: '3000000', channels: [channel('1', peerA, { active: false })] });
  await f.c.channels().reconcile(); assert.equal(f.s.get<ChannelOperation>('channelOperation:' + close.id)!.state, 'uncertain');
  await f.c.channels().ownerMarkFailed(close.id);
  assert.equal(f.s.get<ChannelOperation>('channelOperation:' + close.id)!.feeChargedSat, '0');
  f.pending.closing.push({ peer: peerA, point: close.point, txid: 'ef'.repeat(32) });
  await f.c.channels().reconcile();
  const late = f.s.get<ChannelOperation>('channelOperation:' + close.id)!;
  assert.equal(late.state, 'pending'); assert.equal(late.feeChargedSat, '2500'); assert.match(late.reason!, /after the owner marked it failed/);
  await assert.rejects(f.c.channels().ownerMarkFailed(close.id), /not uncertain/);
  assert.deepEqual(f.calls, []); f.close();
});
