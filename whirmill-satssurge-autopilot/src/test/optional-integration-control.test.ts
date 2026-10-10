import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, readFileSync, readdirSync, mkdirSync, writeFileSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OptionalIntegrationControl, type OptionalGates } from '../optional-integration-control.js';
const gates = (): OptionalGates => ({ core: true, m24: true, m3: true, m4: true });
const flags = { robosats: true, ambossSpace: true, magma: true };
const authorized = () => true;
const token = 'synthetic-existing-amboss-key';
const id = '12345678-1234-1234-1234-123456789abc';
function fixture(options: ConstructorParameters<typeof OptionalIntegrationControl>[1] = {}) { const dir = mkdtempSync(join(tmpdir(), 'm5-config-')); return { dir, control: new OptionalIntegrationControl(dir, options), close: () => rmSync(dir, { recursive: true, force: true }) }; }
function reason(r: any) { assert.equal(r.ok, false); return r.reason; }
test('default status is disabled, no secrets or network/storage writes', async () => {
 let calls = 0; const f = fixture({ fetch: async () => { calls++; throw new Error(); } });
 try { assert.equal(f.control.status().ambossKeyConfigured, false); assert.equal(f.control.status().runtimeReady, false); assert.equal(reason(await f.control.probe('magma-account-auth', authorized)), 'roadmap_blocked'); assert.equal(calls, 0); assert.deepEqual(readdirSync(f.dir), []); assert.equal(JSON.stringify(f.control), '{}'); } finally { f.close(); }
});
test('atomic private config, write-only key, reopen and clear; no OAuth or operational schema', () => {
 const f = fixture(); try {
  const saved = f.control.configure({ flags, ambossKey: token }, authorized); assert.equal(saved.ok, true); assert.doesNotMatch(JSON.stringify(saved), /synthetic-existing/);
  const path = join(f.dir, 'optional-integrations', 'private.json'); assert.equal(statSync(path).mode & 0o777, 0o600); assert.equal(statSync(join(f.dir, 'optional-integrations')).mode & 0o777, 0o700);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).ambossKey, token); assert.deepEqual(readdirSync(f.dir), ['optional-integrations']); assert.deepEqual(readdirSync(join(f.dir, 'optional-integrations')), ['private.json']);
  const reopened = new OptionalIntegrationControl(f.dir); assert.equal(reopened.status().ambossKeyConfigured, true);
  assert.equal(reopened.configure({ flags }, authorized).ok, true); assert.equal(reopened.status().ambossKeyConfigured, true);
  assert.equal(reopened.configure({ flags, clearAmbossKey: true }, authorized).ok, true); assert.equal(reopened.status().ambossKeyConfigured, false); assert.doesNotMatch(readFileSync(path, 'utf8'), /synthetic-existing/);
 } finally { f.close(); }
});
test('unknown fields, accessors, inherited flags and conflicting/invalid keys rejected without reflection', () => {
 const f = fixture(); let getter = 0; try {
  for (const input of [{ flags, subscription: true }, { flags: Object.create({ magma: true }) }, { flags, ambossKey: 'key\nsecret' }, { flags, ambossKey: token, clearAmbossKey: true }, { flags, clearAmbossKey: false }, Object.defineProperty({ flags }, 'ambossKey', { enumerable: true, get() { getter++; return token; } })]) {
    const r = f.control.configure(input, authorized); assert.equal(reason(r), 'invalid_config'); assert.doesNotMatch(JSON.stringify(r), /synthetic-existing|secret/);
  }
  assert.equal(getter, 0); assert.deepEqual(readdirSync(f.dir), []);
 } finally { f.close(); }
});
test('owner admission is checked twice before config writes', () => {
 const f = fixture(); try { let checks = 0; assert.equal(reason(f.control.configure({ flags, ambossKey: token }, () => ++checks === 1)), 'unauthorized'); assert.deepEqual(readdirSync(f.dir), []); } finally { f.close(); }
});
test('corrupt/insecure/symlink private settings fail optional module closed and preserve target', () => {
 for (const variant of ['corrupt', 'insecure', 'symlink', 'broken-symlink']) {
  const f = fixture(); try { const dir = join(f.dir, 'optional-integrations'); mkdirSync(dir, { mode: 0o700 }); const p = join(dir, 'private.json'), target = join(f.dir, 'target'); writeFileSync(target, 'preserve', { mode: 0o600 });
   if (variant.includes('symlink')) symlinkSync(variant === 'symlink' ? target : join(f.dir, 'missing'), p); else { writeFileSync(p, '{bad', { mode: 0o600 }); if (variant === 'insecure') chmodSync(p, 0o644); }
   const c = new OptionalIntegrationControl(f.dir); assert.equal(c.status().storageAvailable, false); assert.equal(reason(c.configure({ flags }, authorized)), 'storage_unavailable'); assert.equal(readFileSync(target, 'utf8'), 'preserve');
  } finally { f.close(); }
 }
});
test('roadmap gates cannot come from request configuration, missing own gate fails closed', async () => {
 const f = fixture({ gates: () => Object.create(gates()) }); try { assert.equal(f.control.configure({ flags }, authorized).ok, true); assert.equal(reason(await f.control.probe('magma-estimate', authorized)), 'roadmap_blocked'); assert.equal(reason(f.control.configure({ flags, gates: gates() }, authorized)), 'invalid_config'); } finally { f.close(); }
});
test('account auth probe selects only official user id, discards all identity and token, never model callable', async () => {
 let calls = 0; const f = fixture({ gates, fetch: async (url, init) => { calls++; assert.equal(url, 'https://magma.amboss.tech/graphql'); assert.equal(init?.redirect, 'error'); assert.equal(init?.credentials, 'omit'); assert.equal((init?.headers as any).Authorization, 'Bearer '+token); assert.deepEqual(JSON.parse(String(init?.body)), { query: 'query M5AccountCredentialProbe { user { id } }' }); return new Response(JSON.stringify({ data: { user: { id, email: 'synthetic-email', invoice: 'synthetic-invoice' } } }), { headers: { 'Content-Type': 'application/json' } }); } });
 try { f.control.configure({ flags, ambossKey: token }, authorized); assert.equal(reason(await f.control.probe('magma-account-auth', authorized, true)), 'unsupported'); const r = await f.control.probe('magma-account-auth', authorized); assert.equal(r.ok, true); assert.doesNotMatch(JSON.stringify([r, f.control.status(), f.control]), /synthetic-existing|synthetic-email|synthetic-invoice|12345678/); assert.equal(calls, 1); } finally { f.close(); }
});
test('missing existing key is concrete block and never triggers authenticated network', async () => {
 let calls = 0; const f = fixture({ gates, fetch: async () => { calls++; throw new Error(token); } }); try { f.control.configure({ flags }, authorized); assert.equal(reason(await f.control.probe('magma-account-auth', authorized)), 'credential_missing'); assert.equal(calls, 0); } finally { f.close(); }
});
test('authority/roadmap/config change after await discards response and cannot turn stale probe into success', async () => {
 for (const variant of ['owner', 'gates', 'config']) {
  let allow = true, ready = true; const f = fixture({ gates: () => ({ ...gates(), core: ready }), fetch: async () => { if (variant === 'owner') allow = false; if (variant === 'gates') ready = false; if (variant === 'config') f.control.configure({ flags }, authorized); return new Response(JSON.stringify({ data: { user: { id } } }), { headers: { 'Content-Type': 'application/json' } }); } });
  try { f.control.configure({ flags, ambossKey: token }, authorized); assert.equal(reason(await f.control.probe('magma-account-auth', () => allow)), 'unauthorized'); } finally { f.close(); }
 }
});
test('config changes cannot reset shared network cooldown; all mutation names unsupported', async () => {
 const f = fixture({ gates, fetch: async () => new Response(JSON.stringify({ data: { user: { id } } }), { headers: { 'Content-Type': 'application/json' } }) }); try { f.control.configure({ flags, ambossKey: token }, authorized); await f.control.probe('magma-account-auth', authorized); f.control.configure({ flags, ambossKey: token }, authorized); assert.equal(reason(await f.control.probe('space-availability', authorized)), 'cooldown'); for (const name of ['liquidity.buy', 'trade', 'subscription', 'lease', 'mutation', 'magma-account-auth?key=x']) assert.equal(reason(await f.control.probe(name, authorized)), 'unsupported'); } finally { f.close(); }
});
test('GraphQL errors, HTTP failures, identity shape and flood all fail sanitized', async () => {
 for (const variant of ['graphql', 'http', 'shape', 'flood']) {
  let cancelled = false; const f = fixture({ gates, fetch: async () => variant === 'flood' ? new Response(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array()); }, cancel() { cancelled = true; } }, { highWaterMark: 0 }), { headers: { 'Content-Type': 'application/json' } }) : new Response(JSON.stringify(variant === 'graphql' ? { errors: [{ message: token }], data: { user: { id } } } : { data: { user: { id: token } } }), { status: variant === 'http' ? 403 : 200, headers: { 'Content-Type': 'application/json' } }) });
  try { f.control.configure({ flags, ambossKey: token }, authorized); const r = await f.control.probe('magma-account-auth', authorized); assert.equal(reason(r), variant === 'http' ? 'http' : variant === 'flood' ? 'too_large' : 'schema'); assert.doesNotMatch(JSON.stringify(r), /synthetic-existing/); if (variant === 'flood') assert.equal(cancelled, true); } finally { f.close(); }
 }
});
test('private child works under non-writable owned755 parent; writable parent fails without permission repair', () => {
 const f = fixture(); try { chmodSync(f.dir, 0o755); assert.equal(f.control.configure({ flags, ambossKey: token }, authorized).ok, true); assert.equal(statSync(f.dir).mode & 0o777, 0o755); chmodSync(f.dir, 0o777); assert.equal(reason(f.control.configure({ flags }, authorized)), 'storage_unavailable'); assert.equal(statSync(f.dir).mode & 0o777, 0o777); } finally { f.close(); }
});
test('acceptance references require all four stages and ordered own dated proof hashes; no seeding', async () => {
 const { optionalRoadmapGates } = await import('../optional-integration-gates.js');
 const receipt = { accepted: true, proofSha256: 'a'.repeat(64), acceptedAt: '2026-10-09T00:00:00Z' };
 const complete = { version: 1, core: receipt, m24: receipt, m3: receipt, m4: receipt };
 assert.deepEqual(optionalRoadmapGates(complete), gates());
 for (const bad of [undefined, {}, Object.create(complete), { ...complete, m4: undefined }, { ...complete, m3: { ...receipt, accepted: false } }, { ...complete, m24: { ...receipt, proofSha256: 'not-proof' } }, { ...complete, core: { ...receipt, acceptedAt: '2099-01-01T00:00:00Z' } }, { ...complete, m4: { ...receipt, acceptedAt: '2026-10-08T00:00:00Z' } }]) assert.equal(optionalRoadmapGates(bad).core, false);
});
test('authenticated429 keeps shared60s backoff through credential rotation', async () => {
 let calls = 0; const f = fixture({ gates, fetch: async () => { calls++; return new Response('{}', { status: 429, headers: { 'Content-Type': 'application/json' } }); } });
 try { f.control.configure({ flags, ambossKey: token }, authorized); assert.equal(reason(await f.control.probe('magma-account-auth', authorized)), 'cooldown'); f.control.configure({ flags, ambossKey: 'synthetic-rotated-key' }, authorized); assert.equal(reason(await f.control.probe('magma-account-auth', authorized)), 'cooldown'); assert.equal(calls, 1); } finally { f.close(); }
});
test('authenticated oversized body is discarded without exposing the injected token', async () => {
 const f = fixture({ gates, fetch: async () => new Response(' '.repeat(256 * 1024 + 1), { headers: { 'Content-Type': 'application/json' } }) });
 try { f.control.configure({ flags, ambossKey: token }, authorized); assert.equal(reason(await f.control.probe('magma-account-auth', authorized)), 'too_large'); } finally { f.close(); }
});
test('native authenticated redirect rejection never reaches the second server', async () => {
 const { createServer } = await import('node:http'); let hits = 0;
 const target = createServer((_req, res) => { hits++; res.end('{}'); }); await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve)); const ta = target.address(); assert.ok(ta && typeof ta === 'object');
 const source = createServer((_req, res) => { res.writeHead(307, { Location: `http://127.0.0.1:${ta.port}/` }); res.end(); }); await new Promise<void>(resolve => source.listen(0, '127.0.0.1', resolve)); const sa = source.address(); assert.ok(sa && typeof sa === 'object');
 const f = fixture({ gates, fetch: (_url, init) => fetch(`http://127.0.0.1:${sa.port}/`, init) });
 try { f.control.configure({ flags, ambossKey: token }, authorized); assert.equal(reason(await f.control.probe('magma-account-auth', authorized)), 'transport'); assert.equal(hits, 0); }
 finally { f.close(); for (const server of [source, target]) { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); } }
});
test('native authenticated stalled-body timeout aborts its owned connection', async () => {
 const { createServer } = await import('node:http'); const server = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.write('{'); }); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert.ok(address && typeof address === 'object');
 const f = fixture({ gates, fetch: (_url, init) => fetch(`http://127.0.0.1:${address.port}/`, init) });
 try { f.control.configure({ flags, ambossKey: token }, authorized); assert.equal(reason(await f.control.probe('magma-account-auth', authorized)), 'timeout'); }
 finally { f.close(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
});

test('encoded private-record size is validated before any write, including escaping overhead', () => {
 const f = fixture(); try { assert.equal(reason(f.control.configure({ flags, ambossKey: '"'.repeat(4096) }, authorized)), 'invalid_config'); assert.deepEqual(readdirSync(f.dir), []); assert.equal(f.control.status().storageAvailable, true); } finally { f.close(); }
});
test('FIFO startup and existing-file configure fail closed under watchdog; child is reaped', async () => {
 const { spawn } = await import('node:child_process');
 const moduleUrl = new URL('../optional-integration-control.js', import.meta.url).href;
 for (const mode of ['startup', 'configure']) {
  const f = fixture();
  const code = `import { OptionalIntegrationControl } from ${JSON.stringify(moduleUrl)};
    import { mkdirSync } from 'node:fs'; import { join } from 'node:path'; import { spawnSync } from 'node:child_process';
    const directory = process.argv[1], mode = process.argv[2];
    const control = mode === 'configure' ? new OptionalIntegrationControl(directory) : undefined;
    const privateDir = join(directory, 'optional-integrations'); mkdirSync(privateDir, { mode: 0o700 });
    const made = spawnSync('mkfifo', ['-m', '600', join(privateDir, 'private.json')], { timeout: 1500 });
    if (made.status !== 0) process.exit(3);
    const actual = control ?? new OptionalIntegrationControl(directory);
    if (mode === 'startup') { if (actual.status().storageAvailable !== false) process.exit(4); }
    else { const r = actual.configure({flags:{robosats:false,ambossSpace:false,magma:false}}, () => true);
      if (r.ok || r.reason !== 'storage_unavailable') process.exit(5); }
    console.log('FIFO_REJECTED');`;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', code, f.dir, mode], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', timedOut = false;
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
  });
  child.stdout.on('data', b => { output += String(b); if (output.length > 4096) child.kill('SIGKILL'); });
  // Drain diagnostics without exposing child payloads in test logs.
  child.stderr.on('data', () => {});
  const watchdog = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 5000);
  try {
    const result = await closed; assert.equal(timedOut, false, 'FIFO operation exceeded watchdog'); assert.equal(result.code, 0); assert.equal(result.signal, null); assert.equal(output.trim(), 'FIFO_REJECTED');
    if (child.pid) assert.throws(() => process.kill(child.pid!, 0), (e: any) => e.code === 'ESRCH');
  } finally {
    clearTimeout(watchdog);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await closed.catch(() => {}); f.close();
  }
 }
});
test('UTC gate timestamps round-trip strictly, with supported fractional precision retained', async () => {
 const { optionalRoadmapGates } = await import('../optional-integration-gates.js');
 const receipts = (acceptedAt: string) => { const r = { accepted: true, proofSha256: 'a'.repeat(64), acceptedAt }; return { version: 1, core: r, m24: r, m3: r, m4: r }; };
 for (const valid of ['2024-02-29T00:00:00Z', '2024-02-29T00:00:00.1Z', '2024-02-29T00:00:00.12Z', '2024-02-29T00:00:00.123Z', '2024-02-29T00:00:00.000Z']) assert.deepEqual(optionalRoadmapGates(receipts(valid)), gates());
 for (const invalid of ['2026-02-31T00:00:00Z', '2025-02-29T00:00:00.1Z', '2026-04-31T00:00:00.12Z', '2026-02-31T00:00:00.123Z', '2026-01-01T24:00:00Z', '2026-01-01T00:00:60Z', '2024-02-29T00:00:00.1234Z', '2024-02-29T00:00:00+00:00']) assert.equal(optionalRoadmapGates(receipts(invalid)).core, false);
});
