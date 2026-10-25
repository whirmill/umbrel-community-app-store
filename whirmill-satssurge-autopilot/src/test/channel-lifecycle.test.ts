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
import { ChannelLifecycle, channelBudget, channelApprovalState, type ChannelOperation } from '../channels.js';
import { Lnd, lndPackage } from '../lnd.js';
import { now, month, json, hash, type Snapshot, type Channel, type ChannelProposal } from '../domain.js';

const self = '02' + '00'.repeat(32), peerA = '02' + 'aa'.repeat(32), peerB = '03' + 'bb'.repeat(32), fresh = '03' + 'cc'.repeat(32), other = '02' + 'dd'.repeat(32);
const funding = 'ab'.repeat(32), openTx = 'cd'.repeat(32), closeTx = 'ef'.repeat(32);
const channel = (id: string, peer: string, over: Partial<Channel> = {}): Channel => ({ id, point: funding + ':' + id, peer, alias: 'alias' + id, active: true, capacitySat: '1000000', localSat: '900000', remoteSat: '100000', reserveSat: '10000', pendingSat: '0', baseMsat: '0', ppm: 100, cltv: 80, minMsat: '1', maxMsat: '990000000', ...over });
const snapshot = (over: Partial<Snapshot> = {}): Snapshot => ({ at: now(), identity: self, synced: true, confirmedSat: '3000000', channels: [channel('1', peerA), channel('2', peerB)], ...over });
const effects = ['connectPeer', 'openChannel', 'closeChannel'];

function setup(rpcOver: any = {}, withChannels = true) {
  const s = new Store(':memory:'); s.set('bootstrapReady', true); s.set('automationProof', { ok: true, at: now() });
  let state = snapshot(); s.saveSnapshot(state);
  const node: any = { snapshot: async () => ({ ...state, at: now() }) };
  const calls: any[][] = [];
  const pending = { opens: [] as any[], closing: [] as any[] }, closed: any[] = [];
  const rpc: any = {
    listPeers: async () => { calls.push(['listPeers']); return [peerA, peerB]; },
    connectPeer: async (...a: any[]) => { calls.push(['connectPeer', ...a]); },
    estimateFee: async (...a: any[]) => { calls.push(['estimateFee', ...a]); return { feeSat: '2000', satPerVbyte: '10' }; },
    openChannel: async (...a: any[]) => { calls.push(['openChannel', ...a]); return { txid: openTx, outputIndex: 0 }; },
    closeChannel: async (...a: any[]) => { calls.push(['closeChannel', ...a]); return { txid: closeTx }; },
    pendingChannels: async () => pending, closedChannels: async () => closed,
    nodeInfo: async () => ({ alias: 'Candidate', channels: 40, capacitySat: '90000000', addresses: ['node.example:9735'] }),
    ...rpcOver,
  };
  const executor = new Executor(s, node); if (withChannels) executor.channels = new ChannelLifecycle(s, node, rpc);
  const c = new ApplicationControl(s, new Queue(s), executor), job = c.admit('channel-' + Math.random(), 'Proponi una chiusura da approvare', 'telegram');
  const evidence = s.evidence('fixture', 'channel measurement');
  const draft = (over: Partial<ChannelProposal> = {}) => ({ kind: 'channel_open', peer: fresh, amountSat: '1000000', evidenceIds: [evidence], problem: 'local-heavy', evidence: '30d forwards', whyAct: 'return routes', alternatives: 'wait', verify: '30d', hypothesis: 'balance improves', ...over }) as ChannelProposal;
  const op = (): ChannelOperation => JSON.parse(s.one("SELECT value FROM meta WHERE key LIKE 'channelOperation:%'").value);
  return { s, c, executor, rpc, calls, job, draft, op, pending, closed, effects: () => calls.filter(x => effects.includes(x[0])), set: (next: Snapshot) => { state = next; s.saveSnapshot(next); } };
}

test('channel operations dispatch only after the owner approval; other paths cannot dispatch', async () => {
  const f = setup();
  const p = await f.c.createChannelProposal(f.draft(), f.job.id);
  assert.equal(p!.status, 'pending'); assert.equal(p!.content.satPerVbyte, '10'); assert.equal(p!.content.maxFeeSat, '2500'); assert.equal(p!.content.address, 'node.example:9735');
  assert.equal(f.effects().length, 0);
  await assert.rejects(f.executor.channels!.execute(p!.id, { validate: () => {}, reserved: () => {} }), /Owner approval required/);
  await assert.rejects(f.executor.execute(p!.content), /Unsupported operation/);
  const chat = f.c.admit('plain-chat', 'Come va il nodo?', 'telegram');
  await assert.rejects(f.c.createChannelProposal(f.draft(), chat.id), /capability/);
  assert.equal(f.c.reject(p!.id), true); assert.equal((await f.c.approve(p!.id)).consumed, false);
  assert.equal(f.effects().length, 0); assert.equal(f.s.one("SELECT count(*) n FROM meta WHERE key LIKE 'channelOperation:%'").n, 0);
  const q = await f.c.createChannelProposal(f.draft({ amountSat: '1500000' }), f.job.id);
  const results = await Promise.all([f.c.approve(q!.id), f.c.approve(q!.id)]);
  assert.equal(results.filter(r => r.consumed).length, 1);
  assert.deepEqual(f.effects(), [['connectPeer', fresh, 'node.example:9735'], ['openChannel', fresh, '1500000', '10']]);
  const op = f.op(); assert.equal(op.state, 'pending'); assert.equal(op.point, openTx + ':0'); assert.equal(op.proposalId, q!.id);
  assert.equal(f.c.proposal(q!.id).status, 'executed'); assert.equal(f.c.proposal(q!.id).operation_id, op.id);
  assert.equal((await f.c.approve(q!.id)).consumed, false); assert.equal(f.effects().length, 2);
  f.s.close();
});

test('open size, protected reserve with pending obligations, monthly budget and fee-rate cap are enforced', async () => {
  const f = setup();
  for (const amountSat of ['499999', '2000001']) await assert.rejects(f.c.createChannelProposal(f.draft({ amountSat }), f.job.id), /size/);
  await assert.rejects(f.c.createChannelProposal(f.draft({ peer: peerA }), f.job.id), /already has a channel/);
  f.set(snapshot({ confirmedSat: '1502499' }));
  await assert.rejects(f.c.createChannelProposal(f.draft(), f.job.id), /reserve/);
  f.set(snapshot({ confirmedSat: '1502500' }));
  assert.ok(await f.c.createChannelProposal(f.draft(), f.job.id));
  f.s.set('pendingOnchainObligationsSat', '1');
  await assert.rejects(f.c.createChannelProposal(f.draft(), f.job.id), /reserve/);
  f.s.set('pendingOnchainObligationsSat', '0'); f.set(snapshot());
  // A pending open is an on-chain obligation for the next open.
  const first = await f.c.createChannelProposal(f.draft({ hypothesis: 'fresh state' }), f.job.id); await f.c.approve(first!.id); assert.equal(f.op().state, 'pending');
  assert.equal(channelBudget(f.s).pendingObligationsSat, '1002500');
  await assert.rejects(f.c.createChannelProposal(f.draft({ peer: other, amountSat: '1500000' }), f.job.id), /reserve/);
  assert.ok(await f.c.createChannelProposal(f.draft({ peer: other, amountSat: '1495000' }), f.job.id));
  // Monthly on-chain fee budget counts the current Europe/Rome month only.
  const spent = (id: string, at: string, fee: string) => f.s.set('channelOperation:' + id, { id, proposalId: id, kind: 'channel_close', at, month: month(at), state: 'confirmed', peer: peerB, amountSat: '0', satPerVbyte: '10', maxFeeSat: fee, feeChargedSat: fee, history: [] });
  spent('old', '2020-01-15T12:00:00.000Z', '20000'); spent('now', now(), '15000');
  assert.equal(channelBudget(f.s).remainingSat, '2500');
  assert.ok(await f.c.createChannelProposal(f.draft({ kind: 'channel_close', peer: peerB, channel: '2', amountSat: '0' }), f.job.id));
  spent('now2', now(), '1000');
  await assert.rejects(f.c.createChannelProposal(f.draft({ kind: 'channel_close', peer: peerB, channel: '2', amountSat: '0' }), f.job.id), /monthly on-chain fee budget/);
  const capped = setup({ estimateFee: async () => ({ feeSat: '9000', satPerVbyte: '51' }) });
  await assert.rejects(capped.c.createChannelProposal(capped.draft(), capped.job.id), /fee rate/);
  assert.equal(f.effects().filter(x => x[0] === 'openChannel').length, 1); f.s.close(); capped.s.close();
});

test('close is cooperative only; offline or refusing peer is reported once with no retry and no force', async () => {
  const f = setup({ closeChannel: async (...a: any[]) => { f.calls.push(['closeChannel', ...a]); throw Object.assign(Error('peer refused'), { category: 'rpc_failure' }); } });
  f.set(snapshot({ channels: [channel('1', peerA), channel('2', peerB, { active: false })] }));
  await assert.rejects(f.c.createChannelProposal(f.draft({ kind: 'channel_close', peer: peerB, channel: '2', amountSat: '0' }), f.job.id), /peer offline/);
  const p = await f.c.createChannelProposal(f.draft({ kind: 'channel_close', peer: peerA, channel: '1', amountSat: '0' }), f.job.id);
  assert.equal(p!.content.maxFeeSat, '2500'); assert.equal(p!.content.point, funding + ':1');
  await assert.rejects(f.c.approve(p!.id), /peer refused/);
  assert.deepEqual(f.effects(), [['closeChannel', funding + ':1', '10']]);
  assert.equal(f.op().state, 'uncertain'); assert.equal(f.op().rejected, true); assert.equal(f.c.proposal(p!.id).status, 'reconcile_required');
  // The link is still active, so no shutdown is in progress: failed, nothing charged, nothing re-sent.
  await f.executor.channels!.reconcile(); await f.executor.channels!.reconcile();
  assert.equal(f.op().state, 'failed'); assert.equal(f.op().feeChargedSat, '0'); assert.equal(channelBudget(f.s).spentSat, '0');
  assert.equal(f.effects().length, 1); assert.equal((await f.c.approve(p!.id)).consumed, false); f.s.close();
});

test('reconciliation moves opens and closes from pending to confirmed from LND evidence only', async () => {
  const f = setup();
  const open = await f.c.createChannelProposal(f.draft(), f.job.id); await f.c.approve(open!.id);
  const openId = f.op().id, read = (id: string) => f.s.get<ChannelOperation>('channelOperation:' + id)!;
  f.pending.opens.push({ peer: fresh, point: openTx + ':0', capacitySat: '1000000' });
  await f.executor.channels!.reconcile(); assert.equal(read(openId).state, 'pending');
  f.pending.opens.length = 0; f.set(snapshot({ channels: [channel('1', peerA), channel('2', peerB), channel('3', fresh, { point: openTx + ':0' })] }));
  await f.executor.channels!.reconcile(); assert.equal(read(openId).state, 'confirmed'); assert.equal(read(openId).channel, '3');
  const close = await f.c.createChannelProposal(f.draft({ kind: 'channel_close', peer: peerA, channel: '1', amountSat: '0' }), f.job.id); await f.c.approve(close!.id);
  const closeId = f.s.one('SELECT operation_id FROM owner_proposals WHERE id=?', close!.id).operation_id;
  assert.equal(read(closeId).state, 'pending'); assert.equal(read(closeId).txid, closeTx);
  f.pending.closing.push({ peer: peerA, point: funding + ':1', txid: closeTx });
  await f.executor.channels!.reconcile(); assert.equal(read(closeId).state, 'pending');
  f.pending.closing.length = 0; f.closed.push({ point: funding + ':1', peer: peerA, txid: closeTx, type: 'COOPERATIVE_CLOSE' });
  await f.executor.channels!.reconcile(); assert.equal(read(closeId).state, 'confirmed'); assert.equal(read(closeId).closeType, 'COOPERATIVE_CLOSE');
  assert.deepEqual(read(closeId).history.map(h => h.state), ['reserved', 'sending', 'pending', 'confirmed']);
  assert.equal(channelBudget(f.s).spentSat, '5000'); assert.equal(channelBudget(f.s).pendingObligationsSat, '0');
  assert.equal(f.effects().filter(x => x[0] !== 'connectPeer').length, 2); f.s.close();
});

test('a crash between intent and dispatch, or during dispatch, is never replayed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'satssurge-channel-')), path = join(dir, 'state.sqlite');
  try {
    let hang!: () => void;
    const f = setup({ openChannel: (...a: any[]) => { f.calls.push(['openChannel', ...a]); return new Promise((_, reject) => { hang = () => reject(Error('process ended')); }); } });
    const p = await f.c.createChannelProposal(f.draft(), f.job.id);
    const running = f.c.approve(p!.id); await new Promise(r => setTimeout(r, 10));
    assert.equal(f.op().state, 'sending');
    // Same process: reconciliation cannot steal a live dispatch.
    await f.executor.channels!.reconcile(); assert.equal(f.op().state, 'sending');
    hang(); await assert.rejects(running); assert.equal(f.op().state, 'uncertain');
    await f.executor.channels!.reconcile(); assert.equal(f.op().state, 'uncertain');
    assert.equal(f.effects().filter(x => x[0] === 'openChannel').length, 1);
    await assert.rejects(f.c.createChannelProposal(f.draft({ peer: other }), f.job.id), /uncertain/);
    f.pending.opens.push({ peer: fresh, point: openTx + ':0', capacitySat: '1000000' });
    await f.executor.channels!.reconcile(); assert.equal(f.op().state, 'pending'); f.s.close();
    // Persisted intent without dispatch marker, then restart.
    let s = new Store(path); s.set('bootstrapReady', true); s.set('automationProof', { ok: true, at: now() });
    const at = now(); s.set('channelOperation:crash', { id: 'crash', proposalId: 'proposal', kind: 'channel_open', at, month: month(at), state: 'reserved', peer: fresh, amountSat: '1000000', satPerVbyte: '10', maxFeeSat: '2500', feeChargedSat: '2500', history: [{ at, state: 'reserved' }] });
    s.run("INSERT INTO owner_proposals VALUES('proposal',?,?,?,'digest','executing',?,'crash',?,NULL,'job')", at, json(f.draft()), 'x', new Date(Date.now() + 300000).toISOString(), at);
    s.close(); s = new Store(path);
    const g = setup(); const lifecycle = new ChannelLifecycle(s, { snapshot: async () => snapshot() } as any, g.rpc), executor = new Executor(s, {} as any); executor.channels = lifecycle;
    const c = new ApplicationControl(s, new Queue(s), executor); c.recover();
    await lifecycle.reconcile();
    const op = s.get<ChannelOperation>('channelOperation:crash')!; assert.equal(op.state, 'failed'); assert.equal(op.feeChargedSat, '0');
    assert.equal(c.proposal('proposal').status, 'reconcile_required'); assert.equal((await c.approve('proposal')).consumed, false);
    await assert.rejects(lifecycle.execute('proposal', { validate: () => {}, reserved: () => {} }), /Owner approval required/);
    assert.equal(g.effects().length, 0); s.close(); g.s.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('without the channel credential channel features are unavailable and nothing else changes', async () => {
  const f = setup({}, false);
  await assert.rejects(f.c.createChannelProposal(f.draft(), f.job.id), /unavailable/);
  const at = now(), content = json({ ...f.draft(), satPerVbyte: '10', maxFeeSat: '2500' });
  f.s.run("INSERT INTO owner_proposals VALUES('stored-row',?,?,?,?,'pending',?,NULL,NULL,NULL,?)", at, content, hash(content), channelApprovalState(f.s.get('snapshot')!, JSON.parse(content)), new Date(Date.now() + 300000).toISOString(), f.job.id);
  f.s.set('proposalAuthority:stored-row', { generation: null });
  await assert.rejects(f.c.approve('stored-row'), /unavailable/); assert.equal(f.c.proposal('stored-row').status, 'invalidated');
  assert.equal(f.effects().length, 0); assert.equal(f.executor.channels, undefined); f.s.close();
});

function certificate(dir: string) {
  const key = join(dir, 'k.key'), cert = join(dir, 'c.pem'), csr = join(dir, 'c.csr');
  execFileSync('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', csr, '-subj', '/CN=isolated-fixture', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  execFileSync('openssl', ['x509', '-req', '-in', csr, '-signkey', key, '-out', cert, '-days', '30', '-copy_extensions', 'copy'], { stdio: 'ignore' });
  return { key: readFileSync(key), cert: readFileSync(cert) };
}
test('gRPC channel client: separate credential, absent credential unavailable, close stops at close_pending without force', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'satssurge-channel-grpc-')), pair = certificate(dir), seen: { method: string; request: any; token: any }[] = [];
  const ca = join(dir, 'tls.cert'), read = join(dir, 'read'), write = join(dir, 'write'), chan = join(dir, 'channel');
  writeFileSync(ca, pair.cert); writeFileSync(read, Buffer.from('010203', 'hex')); writeFileSync(write, Buffer.from('040506', 'hex')); writeFileSync(chan, Buffer.from('070809', 'hex'));
  const wire = Buffer.from('00' + '11'.repeat(31), 'hex'), display = '11'.repeat(31) + '00';
  let closeCalls = 0, cancelled = false;
  const handlers: any = {
    estimateFee: (_c: any, cb: any) => cb(null, { fee_sat: '1234', sat_per_vbyte: '7' }),
    openChannelSync: (_c: any, cb: any) => cb(null, { funding_txid_bytes: wire, output_index: 1 }),
    closeChannel: (call: any) => { closeCalls++; call.on('cancelled', () => { cancelled = true; }); call.write({ close_pending: { txid: wire, output_index: 0 } }); },
    pendingChannels: (_c: any, cb: any) => cb(null, { pending_open_channels: [{ channel: { remote_node_pub: fresh, channel_point: display + ':1', capacity: '1000000' } }], waiting_close_channels: [] }),
  };
  const server = new grpc.Server();
  server.addService(lndPackage.lnrpc.Lightning.service, Object.fromEntries(Object.entries(handlers).map(([name, h]) => [name, (call: any, cb: any) => { seen.push({ method: name, request: call.request, token: call.metadata.get('macaroon')[0] }); (h as any)(call, cb); }])));
  const port = await new Promise<number>((resolve, reject) => server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createSsl(null, [{ private_key: pair.key, cert_chain: pair.cert }], false), (e, p) => e ? reject(e) : resolve(p)));
  const limits = { unaryMs: 1500, paymentMs: 1500, htlcMs: 1500, maxChannels: 4, maxCalls: 64, historyBytes: 1024 * 1024, streamBytes: 1024 * 1024 };
  const absent = new Lnd('127.0.0.1:' + port, ca, read, write, limits), client = new Lnd('127.0.0.1:' + port, ca, read, write, limits);
  try {
    assert.equal(absent.enableChannels(join(dir, 'missing.macaroon')), false); assert.equal(absent.channelRpc(), undefined);
    assert.equal(client.enableChannels(chan), true); const rpc = client.channelRpc()!;
    assert.deepEqual(await rpc.estimateFee('1000000', 6), { feeSat: '1234', satPerVbyte: '7' });
    assert.deepEqual(await rpc.openChannel(fresh, '1000000', '7'), { txid: display, outputIndex: 1 });
    assert.deepEqual(await rpc.closeChannel(funding + ':1', '7'), { txid: display });
    assert.deepEqual((await rpc.pendingChannels()).opens, [{ peer: fresh, point: display + ':1', capacitySat: '1000000' }]);
    await new Promise(r => setTimeout(r, 50)); assert.equal(cancelled, true); assert.equal(closeCalls, 1);
    const close = seen.find(r => r.method === 'closeChannel')!.request;
    assert.equal(close.force, false); assert.equal(close.no_wait, false); assert.equal(close.sat_per_vbyte, '7'); assert.equal(close.max_fee_per_vbyte, '7'); assert.equal(close.channel_point.funding_txid_str, funding); assert.equal(close.channel_point.output_index, 1);
    const open = seen.find(r => r.method === 'openChannelSync')!.request;
    assert.equal(Buffer.from(open.node_pubkey, 'base64').toString('hex'), fresh); assert.equal(open.local_funding_amount, '1000000'); assert.equal(open.push_sat, '0'); assert.equal(open.sat_per_vbyte, '7'); assert.equal(open.spend_unconfirmed, false);
    assert.equal(Object.keys(seen.find(r => r.method === 'estimateFee')!.request.AddrToAmount).length, 1);
    for (const row of seen) assert.equal(row.token, '070809', row.method);
    await assert.rejects(rpc.openChannel(fresh, '1000000', '0'), /fee rate/); await assert.rejects(rpc.connectPeer(fresh, 'bad host'), /address/);
    assert.equal(seen.filter(r => r.method === 'openChannelSync').length, 1);
  } finally { absent.close(); client.close(); server.forceShutdown(); rmSync(dir, { recursive: true, force: true }); }
});
