import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OptionalIntegrationReads, parseOptionalIntegrationConfig, type ReadResult } from '../optional-integrations.js';
const enabled = { robosats: true, ambossSpace: true, magma: true };
function response(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }); }
function client(value: unknown, status = 200) { return new OptionalIntegrationReads(enabled, { fetch: async () => response(value, status) }); }
function reason(result: ReadResult<unknown>) { assert.equal(result.ok, false); if (!result.ok) return result.reason; }
const estimate = { data: { market: { liquidity: { liquidity_per_usd: { sats: '543260', usd: '501.09', secret: 'fixture-sensitive' } } } } };
const offer = { id: '12345678-1234-1234-1234-123456789abc', min_amount: { satoshi: { sats: '100000' } }, max_amount: { satoshi: { sats: '500000' } }, total_amount: { satoshi: { sats: '9007199254740993000' } }, locked_amount: { satoshi: { sats: '0' } }, fees: { fixed: { sats: '100' }, variable: { sats: '1000' }, amboss: { sats: '200' } }, promises: { min_block_length: 4320 }, private_note: 'fixture-sensitive' };
function page(list: unknown[], total: number) { return { data: { market: { offer: { offers: { list, total } } } } }; }
test('disabled defaults make no network or credential reads', async () => {
  let calls = 0; const c = new OptionalIntegrationReads(undefined, { fetch: async () => { calls++; throw new Error(); }, ambossCredential: () => { calls++; return 'fixture-key'; } });
  for (const r of await Promise.all([c.roboSatsInfo(), c.roboSatsBook(), c.magmaEstimate(), c.magmaOffers(), c.ambossSpaceAvailability(true)])) assert.equal(reason(r), 'disabled');
  assert.equal(calls, 0);
});
test('config is strict, copied and immutable', () => {
  assert.deepEqual(parseOptionalIntegrationConfig({}), { robosats: false, ambossSpace: false, magma: false });
  for (const x of [null, [], { magma: 'true' }, { key: 'fixture' }, { magma: 1 }]) assert.throws(() => parseOptionalIntegrationConfig(x));
  const config = { ...enabled }; const c = new OptionalIntegrationReads(config); config.magma = false; assert.equal(JSON.stringify(c), '{}');
});
test('Magma estimate uses exact public query without credentials and strips extras', async () => {
  const c = new OptionalIntegrationReads(enabled, { ambossCredential: () => { throw new Error('must not read'); }, fetch: async (url, init) => {
    assert.equal(url, 'https://magma.amboss.tech/graphql'); assert.equal(init?.method, 'POST'); assert.equal(init?.redirect, 'error'); assert.equal(init?.credentials, 'omit');
    assert.equal((init?.headers as Record<string, string>).Authorization, undefined);
    assert.match(JSON.parse(String(init?.body)).query, /^query M5Estimate/); return response(estimate);
  } });
  const r = await c.magmaEstimate(); assert.equal(r.ok, true); if (r.ok) assert.deepEqual(r.value, { satsPerUsd: '543260', expectedReceivingUsdPerUsd: '501.09' }); assert.doesNotMatch(JSON.stringify(r), /fixture-sensitive/);
});
test('GraphQL partial errors and incompatible schemas fail closed without raw error output', async () => {
  for (const v of [{ ...estimate, errors: [{ message: 'fixture-key' }] }, { ...estimate, errors: {} }, { data: null }, { data: { market: { liquidity: { liquidity_per_usd: { sats: 543260, usd: '1' } } } } }]) {
    const r = await client(v).magmaEstimate(); assert.equal(reason(r), 'schema'); assert.doesNotMatch(JSON.stringify(r), /fixture-key/);
  }
});
test('HTTP errors, rate limit and exception messages are sanitized', async () => {
  assert.equal(reason(await client({}, 403).magmaEstimate()), 'http');
  const c = client({}, 429); assert.equal(reason(await c.magmaEstimate()), 'rate_limited'); assert.equal(reason(await c.magmaEstimate()), 'cooldown');
  const bad = new OptionalIntegrationReads(enabled, { fetch: async () => { throw new Error('fixture-key'); } }); assert.equal(reason(await bad.magmaEstimate()), 'transport');
});
test('one instance reserves provider rate budget before concurrent awaits', async () => {
  let calls = 0; const c = new OptionalIntegrationReads(enabled, { fetch: async () => { calls++; return response(estimate); } });
  const [a, b] = await Promise.all([c.magmaEstimate(), c.magmaOffers()]); assert.equal(a.ok, true); assert.equal(reason(b), 'cooldown'); assert.equal(calls, 1);
});
test('body cap cancels bounded streaming response', async () => {
  let cancelled = false;
  const c = new OptionalIntegrationReads(enabled, { fetch: async () => new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(256 * 1024 + 1)); }, cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'application/json' } }) });
  assert.equal(reason(await c.magmaEstimate()), 'too_large'); assert.equal(cancelled, true);
});
test('bad UTF8, HTML and invalid JSON are rejected', async () => {
  for (const r of [new Response('<html/>', { headers: { 'Content-Type': 'text/html' } }), new Response('oops', { headers: { 'Content-Type': 'application/json' } }), new Response(new Uint8Array([255]), { headers: { 'Content-Type': 'application/json' } })]) {
    const c = new OptionalIntegrationReads(enabled, { fetch: async () => r }); assert.equal(reason(await c.magmaEstimate()), 'schema');
  }
});
test('Magma page preserves bigint strings, cursor and partial coverage; never qualifies ambiguous fee units', async () => {
  const r = await client(page([offer], 2)).magmaOffers(0, 1); assert.equal(r.ok, true);
  if (r.ok) { assert.equal(r.coverage, 'partial'); assert.equal(r.value.nextOffset, 1); assert.equal(r.value.offers[0]?.totalSats, '9007199254740993000'); assert.equal(r.value.feeUnitsQualified, false); }
  assert.doesNotMatch(JSON.stringify(r), /fixture-sensitive/);
  const last = await client(page([offer], 2)).magmaOffers(1, 1); if (last.ok) assert.equal(last.value.nextOffset, null);
});
test('invalid pages, duplicate IDs, asset amounts and inconsistent bounds fail closed', async () => {
  for (const p of [page([], 1), page([offer, offer], 2), page([offer], 0), page([{ ...offer, total_amount: { satoshi: null } }], 1), page([{ ...offer, locked_amount: { satoshi: { sats: '9007199254740993001' } } }], 1)]) assert.equal(reason(await client(p).magmaOffers()), 'schema');
  for (const [offset, limit] of [[-1, 1], [0, 51], [0.1, 1], [0, 0]]) assert.equal(reason(await client({}).magmaOffers(offset, limit)), 'schema');
});
test('RoboSats info accepts mainnet only and strips identifiers/notices', async () => {
  const v = { network: 'mainnet', maker_fee: 0.025, taker_fee: 0.175, bond_size: 3, num_public_buy_orders: 1, num_public_sell_orders: 2, min_order_size: 20000, max_order_size: 5000000, node_id: 'fixture-sensitive', notice_message: 'fixture-sensitive' };
  const r = await client(v).roboSatsInfo(); assert.equal(r.ok, true); assert.doesNotMatch(JSON.stringify(r), /fixture-sensitive/);
  for (const bad of [{ ...v, network: 'regtest' }, { ...v, bond_size: -1 }, { ...v, min_order_size: 6000000 }]) assert.equal(reason(await client(bad).roboSatsInfo()), 'schema');
});
test('public RoboSats book excludes identity, payment method, location and retains partial scope', async () => {
  const v = [{ id: 1, type: 0, currency: 1, premium: '-2.50', satoshis_now: 25000, bond_size: '3.0', expires_at: '2026-10-10T20:00:00Z', maker_nick: 'fixture-sensitive', payment_method: 'fixture-sensitive', latitude: 'fixture-sensitive' }];
  const r = await client(v).roboSatsBook(); assert.equal(r.ok, true); if (r.ok) assert.equal(r.coverage, 'partial'); assert.doesNotMatch(JSON.stringify(r), /fixture-sensitive/);
  assert.equal(reason(await client([{ ...v[0], type: 2 }]).roboSatsBook()), 'schema');
});
test('Space greeting is discarded and cannot qualify authentication; key remains server-only', async () => {
  const c = new OptionalIntegrationReads(enabled, { ambossCredential: () => 'fixture-key', fetch: async (url, init) => {
    assert.equal(url, 'https://api.amboss.space/graphql'); assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer fixture-key'); return response({ data: { getHello: 'fixture-sensitive', email: 'fixture-sensitive' } });
  } });
  const r = await c.ambossSpaceAvailability(true); assert.equal(r.ok, true); if (r.ok) assert.equal(r.value.authenticationQualified, false); assert.doesNotMatch(JSON.stringify([c, r]), /fixture-key|fixture-sensitive/);
  assert.equal(reason(await client({}).ambossSpaceAvailability(true)), 'credential_missing');
});
test('unsupported effects have explicit fail-closed response', () => {
  const c = new OptionalIntegrationReads(enabled); for (const p of ['robosats', 'magma', 'amboss-space'] as const) assert.deepEqual(c.unsupported(p), { ok: false, provider: p, reason: 'unsupported', financialEffects: false });
  assert.equal('execute' in c, false);
});
test('timeout aborts an in-flight native fetch and clears owned socket resources', async () => {
  const { createServer } = await import('node:http');
  const server = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  try {
    const c = new OptionalIntegrationReads(enabled, { fetch: (_url, init) => fetch(`http://127.0.0.1:${address.port}`, init) });
    assert.equal(reason(await c.magmaEstimate()), 'timeout');
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
});

test('provider ignoring pagination fails explicitly unsupported; never treats oversized list as a complete page', async () => {
  assert.equal(reason(await client(page([offer, offer], 2)).magmaOffers(0, 1)), 'unsupported');
});

test('inherited flags and non-plain configs cannot enable network reads', async () => {
  let calls = 0;
  for (const provider of ['robosats', 'ambossSpace', 'magma']) {
    const inherited = Object.create({ [provider]: true });
    assert.equal(Object.keys(inherited).length, 0);
    assert.throws(() => new OptionalIntegrationReads(inherited, { fetch: async () => { calls++; return response(estimate); } }));
  }
  const nullPrototype = Object.assign(Object.create(null), { magma: false });
  const c = new OptionalIntegrationReads(nullPrototype, { fetch: async () => { calls++; return response(estimate); } });
  assert.equal(reason(await c.magmaEstimate()), 'disabled');
  assert.equal(calls, 0);
});

function streamedClient(makeStream: (signal: AbortSignal) => ReadableStream<Uint8Array>) {
  return new OptionalIntegrationReads(enabled, { fetch: async (_url, init) => {
    assert.ok(init?.signal);
    return new Response(makeStream(init.signal), { headers: { 'Content-Type': 'application/json' } });
  } });
}

test('empty-chunk flood is work-bounded, yields to timers and cancels its signal-honoring stream', async () => {
  let pulls = 0, cancelled = false, timerRan = false;
  const timer = setTimeout(() => { timerRan = true; }, 0);
  const c = streamedClient(signal => new ReadableStream({ pull(controller) {
    if (signal.aborted) { controller.error(new Error('aborted')); return; }
    pulls++;
    controller.enqueue(new Uint8Array());
  }, cancel() { cancelled = true; } }, { highWaterMark: 0 }));
  try {
    assert.equal(reason(await c.magmaEstimate()), 'too_large');
    assert.ok(pulls <= 4096); assert.equal(cancelled, true); assert.equal(timerRan, true);
  } finally { clearTimeout(timer); }
});

test('valid fragmented body with empty chunks stays exact and gives timers a turn', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify(estimate)); let index = 0, empty = true, timerRan = false;
  const timer = setTimeout(() => { timerRan = true; }, 0);
  const c = streamedClient(signal => new ReadableStream({ pull(controller) {
    if (signal.aborted) { controller.error(new Error('aborted')); return; }
    if (index === bytes.length) { controller.close(); return; }
    if (empty) controller.enqueue(new Uint8Array()); else controller.enqueue(bytes.slice(index, ++index));
    empty = !empty;
  } }, { highWaterMark: 0 }));
  try { const r = await c.magmaEstimate(); assert.equal(r.ok, true); if (r.ok) assert.equal(r.value.satsPerUsd, '543260'); assert.equal(timerRan, true); }
  finally { clearTimeout(timer); }
});

test('monotonic deadline rejects a signal-honoring read that starves the abort timer', async () => {
  let timerFired = false, cancelled = false;
  const c = streamedClient(signal => {
    signal.addEventListener('abort', () => { timerFired = true; }, { once: true });
    return new ReadableStream({ pull(controller) {
      if (signal.aborted) { controller.error(new Error('aborted')); return; }
      // Backend-trusted synthetic callback blocks the timer queue beyond the deadline.
      const end = performance.now() + 10_050;
      while (performance.now() < end) { /* bounded negative fixture */ }
      assert.equal(timerFired, false);
      controller.enqueue(new TextEncoder().encode(JSON.stringify(estimate))); controller.close();
    }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
  });
  assert.equal(reason(await c.magmaEstimate()), 'timeout');
  assert.equal(timerFired, true); // finally aborts even when the timer was starved.
  // A closed stream needs no cancel callback; it has no retained reader/resource.
  assert.equal(cancelled, false);
});


test('Magma BTC offer bounds use the fixed anonymous query and preserve integer precision', async () => {
  const large = { ...offer, min_amount: { satoshi: { sats: '9007199254740993000' } }, max_amount: { satoshi: { sats: '9007199254740993001' } } };
  const c = new OptionalIntegrationReads(enabled, { ambossCredential: () => { throw new Error('must not read'); }, fetch: async (_url, init) => {
    assert.equal((init?.headers as Record<string, string>).Authorization, undefined);
    const body = JSON.parse(String(init?.body));
    assert.match(body.query, /min_amount \{ satoshi \{ sats \} \}/);
    assert.match(body.query, /max_amount \{ satoshi \{ sats \} \}/);
    assert.deepEqual(body.variables, { offset: 0, limit: 25 });
    return response(page([large], 200));
  } });
  const r = await c.magmaOffers(); assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.coverage, 'partial'); assert.equal(r.value.total, 200); assert.equal(r.value.nextOffset, 1);
    assert.equal(r.value.offers[0]?.minSats, '9007199254740993000'); assert.equal(r.value.offers[0]?.maxSats, '9007199254740993001');
    assert.equal(r.value.sizeBoundsQualified, true); assert.equal(r.value.feeUnitsQualified, false);
    assert.equal(r.value.offers[0]?.variableFeeValue, '1000');
  }
});

test('Magma bounds reject invalid or conflicting integers; absent BTC wrappers remain unsupported', async () => {
  for (const bad of [1, '-1', '1.5', '1e3', '', '1'.repeat(49), null]) {
    assert.equal(reason(await client(page([{ ...offer, min_amount: { satoshi: { sats: bad } } }], 1)).magmaOffers()), 'schema');
    assert.equal(reason(await client(page([{ ...offer, max_amount: { satoshi: { sats: bad } } }], 1)).magmaOffers()), 'schema');
  }
  assert.equal(reason(await client(page([{ ...offer, min_amount: offer.max_amount, max_amount: offer.min_amount }], 1)).magmaOffers()), 'schema');
  const equal = await client(page([{ ...offer, max_amount: offer.min_amount }], 1)).magmaOffers(); assert.equal(equal.ok, true);
  for (const bound of [undefined, null, { satoshi: null }, { asset: { amount: '100' } }]) {
    for (const field of ['min_amount', 'max_amount']) assert.equal(reason(await client(page([{ ...offer, [field]: bound }], 1)).magmaOffers()), 'unsupported');
  }
});
