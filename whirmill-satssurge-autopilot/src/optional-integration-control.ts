import { constants, openSync, closeSync, fstatSync, lstatSync, existsSync, mkdirSync, readSync, writeFileSync, fsyncSync, renameSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { OptionalIntegrationReads, OPTIONAL_INTEGRATIONS_DISABLED, parseOptionalIntegrationConfig, type OptionalIntegrationConfig } from './optional-integrations.js';

export const OPTIONAL_PUBLIC_PROBES = ['robosats-info', 'robosats-book', 'magma-estimate', 'magma-offers', 'space-availability'] as const;
export type PublicProbe = typeof OPTIONAL_PUBLIC_PROBES[number];
export type OwnerProbe = PublicProbe | 'magma-account-auth';
export interface OptionalGates { core: boolean; m24: boolean; m3: boolean; m4: boolean }
export interface OptionalStatus { flags: Readonly<OptionalIntegrationConfig>; ambossKeyConfigured: boolean; storageAvailable: boolean; runtimeReady: boolean; financialEffects: false; authenticationQualified: false }
export type OptionalReply = { ok: true; status?: OptionalStatus; result?: unknown; financialEffects: false } | { ok: false; reason: 'unauthorized' | 'invalid_config' | 'storage_unavailable' | 'roadmap_blocked' | 'unsupported' | 'disabled' | 'cooldown' | 'credential_missing' | 'timeout' | 'transport' | 'http' | 'schema' | 'too_large'; financialEffects: false };
interface PrivateState { version: 1; flags: Readonly<OptionalIntegrationConfig>; ambossKey?: string }
function present(path: string): boolean { try { lstatSync(path); return true; } catch (e: any) { if (e.code === 'ENOENT') return false; throw e; } }
const fail = (reason: Extract<OptionalReply, { ok: false }>['reason']): OptionalReply => ({ ok: false, reason, financialEffects: false });
function plain(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) throw new Error('Invalid optional config');
  const descriptors = Object.getOwnPropertyDescriptors(v);
  if (Reflect.ownKeys(descriptors).some(k => typeof k !== 'string' || !('value' in descriptors[k]!))) throw new Error('Invalid optional config');
  return v as Record<string, unknown>;
}
function key(v: unknown): string { if (typeof v !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(v)) throw new Error('Invalid optional config'); return v; }
function flags(v: unknown): Readonly<OptionalIntegrationConfig> { const o = plain(v); return parseOptionalIntegrationConfig(o); }
function state(v: unknown): PrivateState {
  const o = plain(v); if (Object.keys(o).some(k => !['version', 'flags', 'ambossKey'].includes(k)) || o.version !== 1) throw new Error('Invalid optional config');
  return { version: 1, flags: flags(o.flags), ...(Object.hasOwn(o, 'ambossKey') ? { ambossKey: key(o.ambossKey) } : {}) };
}
/** One private atomic record: not OAuth, not operational.sqlite, never exposed to tools. */
class ProtectedSettings {
  #parent: string; #dir: string; #path: string;
  constructor(dataDirectory: string) { this.#parent = resolve(dataDirectory); this.#dir = join(this.#parent, 'optional-integrations'); this.#path = join(this.#dir, 'private.json'); }
  #secureDirectory(path: string, privateMode = true) { const s = lstatSync(path); if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & (privateMode ? 0o077 : 0o022)) !== 0 || s.uid !== process.getuid?.()) throw new Error('Optional configuration unavailable'); }
  load(): PrivateState {
    if (!present(this.#dir)) return { version: 1, flags: OPTIONAL_INTEGRATIONS_DISABLED };
    this.#secureDirectory(this.#parent, false); this.#secureDirectory(this.#dir);
    if (!present(this.#path)) return { version: 1, flags: OPTIONAL_INTEGRATIONS_DISABLED };
    const fd = openSync(this.#path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try { const s = fstatSync(fd); if (!s.isFile() || s.nlink !== 1 || (s.mode & 0o077) !== 0 || s.uid !== process.getuid?.() || s.size > 8192) throw new Error('Optional configuration unavailable');
      const bytes = Buffer.alloc(8193); let size = 0; while (size < bytes.length) { const n = readSync(fd, bytes, size, bytes.length - size, size); if (!n) break; size += n; } if (size > 8192) throw new Error('Optional configuration unavailable');
      return state(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size))));
    } finally { closeSync(fd); }
  }
  save(value: PrivateState) {
    const content = JSON.stringify(value); if (Buffer.byteLength(content) > 8192) throw new Error('Optional configuration unavailable');
    this.#secureDirectory(this.#parent, false);
    if (!present(this.#dir)) mkdirSync(this.#dir, { mode: 0o700 });
    this.#secureDirectory(this.#dir);
    if (present(this.#path)) this.load(); // Refuse symlink/insecure existing records; never chmod them.
    const temp = join(this.#dir, `.pending-${randomUUID()}`); let fd: number | undefined;
    try {
      fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      writeFileSync(fd, content, 'utf8'); fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temp, this.#path);
      const directory = openSync(this.#dir, constants.O_RDONLY); try { fsyncSync(directory); } finally { closeSync(directory); }
    } finally { if (fd !== undefined) closeSync(fd); if (existsSync(temp)) unlinkSync(temp); }
  }
}
/** Backend authority callback must recheck session/job identity; never construct it from request body. */
export class OptionalIntegrationControl {
  #settings: ProtectedSettings; #state: PrivateState = { version: 1, flags: OPTIONAL_INTEGRATIONS_DISABLED }; #available = true;
  #gates: () => OptionalGates; #fetch: typeof fetch; #reads: OptionalIntegrationReads; #next = 0; #version = 0;
  constructor(dataDirectory: string, options: { gates?: () => OptionalGates; fetch?: typeof fetch } = {}) {
    this.#settings = new ProtectedSettings(dataDirectory); this.#fetch = options.fetch ?? fetch;
    this.#gates = options.gates ?? (() => ({ core: false, m24: false, m3: false, m4: false }));
    try { this.#state = this.#settings.load(); } catch { this.#available = false; }
    this.#reads = new OptionalIntegrationReads(this.#state.flags, { fetch: this.#fetch });
  }
  #ready() { try { const g = this.#gates(); return ['core', 'm24', 'm3', 'm4'].every(k => Object.hasOwn(g, k) && g[k as keyof OptionalGates] === true); } catch { return false; } }
  status(): OptionalStatus { return { flags: { ...this.#state.flags }, ambossKeyConfigured: !!this.#state.ambossKey, storageAvailable: this.#available, runtimeReady: this.#ready(), financialEffects: false, authenticationQualified: false }; }
  configure(input: unknown, authorized: () => boolean): OptionalReply {
    if (!authorized()) return fail('unauthorized'); if (!this.#available) return fail('storage_unavailable');
    let next: PrivateState;
    try { const o = plain(input); if (Object.keys(o).some(k => !['flags', 'ambossKey', 'clearAmbossKey'].includes(k)) || (Object.hasOwn(o, 'clearAmbossKey') && o.clearAmbossKey !== true) || (Object.hasOwn(o, 'ambossKey') && o.clearAmbossKey)) throw new Error('Invalid optional config');
      next = { version: 1, flags: flags(o.flags), ...(o.clearAmbossKey ? {} : { ...(this.#state.ambossKey ? { ambossKey: this.#state.ambossKey } : {}), ...(Object.hasOwn(o, 'ambossKey') ? { ambossKey: key(o.ambossKey) } : {}) }) };
      if (Buffer.byteLength(JSON.stringify(next)) > 8192) throw new Error('Invalid optional config');
    } catch { return fail('invalid_config'); }
    if (!authorized()) return fail('unauthorized');
    try { this.#settings.save(next); } catch { this.#available = false; return fail('storage_unavailable'); }
    this.#state = next; this.#version++; this.#reads = new OptionalIntegrationReads(next.flags, { fetch: this.#fetch });
    // Config writes do not reset global admission/cooldown.
    return { ok: true, status: this.status(), financialEffects: false };
  }
  async probe(name: unknown, authorized: () => boolean, modelVisible = false): Promise<OptionalReply> {
    if (!authorized()) return fail('unauthorized'); if (!this.#available) return fail('storage_unavailable');
    if (!this.#ready()) return fail('roadmap_blocked');
    if (typeof name !== 'string' || !(OPTIONAL_PUBLIC_PROBES as readonly string[]).includes(name) && name !== 'magma-account-auth') return fail('unsupported');
    if (modelVisible && name === 'magma-account-auth') return fail('unsupported');
    const providerFlag = name.startsWith('robosats') ? 'robosats' : name.startsWith('magma') ? 'magma' : 'ambossSpace';
    if (!this.#state.flags[providerFlag]) return fail('disabled');
    const now = performance.now(); if (now < this.#next) return fail('cooldown'); this.#next = now + 5000;
    const version = this.#version;
    const stillAuthorized = () => authorized() && this.#ready() && this.#available && this.#version === version;
    let result: unknown;
    if (name === 'magma-account-auth') result = await this.#accountProbe();
    else if (name === 'robosats-info') result = await this.#reads.roboSatsInfo();
    else if (name === 'robosats-book') result = await this.#reads.roboSatsBook();
    else if (name === 'magma-estimate') result = await this.#reads.magmaEstimate();
    else if (name === 'magma-offers') result = await this.#reads.magmaOffers();
    else result = await this.#reads.ambossSpaceAvailability();
    if (!stillAuthorized()) return fail('unauthorized');
    if (result && typeof result === 'object' && 'reason' in result && result.reason === 'rate_limited') this.#next = performance.now() + 60000;
    return name === 'magma-account-auth' ? result as OptionalReply : { ok: true, result, financialEffects: false };
  }
  async #accountProbe(): Promise<OptionalReply> {
    if (!this.#state.ambossKey) return fail('credential_missing');
    const controller = new AbortController(), deadline = performance.now() + 10000, timer = setTimeout(() => controller.abort(), 10000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const check = () => { if (controller.signal.aborted || performance.now() >= deadline) throw new Error('timeout'); };
    try {
      const r = await this.#fetch('https://magma.amboss.tech/graphql', { method: 'POST', redirect: 'error', credentials: 'omit', signal: controller.signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.#state.ambossKey}` }, body: JSON.stringify({ query: 'query M5AccountCredentialProbe { user { id } }' }) });
      check(); if (r.status === 429) { this.#next = performance.now() + 60000; return fail('cooldown'); } if (!r.ok) return fail('http');
      if (!r.body || !r.headers.get('content-type')?.toLowerCase().includes('application/json')) return fail('schema');
      reader = r.body.getReader(); const chunks: Uint8Array[] = []; let size = 0, reads = 0;
      while (true) { check(); if (reads >= 4096) return fail('too_large'); const part = await reader.read(); reads++; check(); if (part.done) break; size += part.value.byteLength; if (size > 256 * 1024) return fail('too_large'); if (part.value.byteLength) chunks.push(part.value); if (reads % 64 === 0) { await new Promise<void>(resolve => setImmediate(resolve)); check(); } }
      const bytes = new Uint8Array(size); let at = 0; for (const c of chunks) { bytes.set(c, at); at += c.byteLength; }
      let v: any; try { v = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { return fail('schema'); }
      if (!v || typeof v !== 'object' || Array.isArray(v)) return fail('schema');
      if (v.errors !== undefined && (!Array.isArray(v.errors) || v.errors.length) || typeof v.data?.user?.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v.data.user.id)) return fail('schema');
      check(); return { ok: true, result: { credentialAccepted: true, endpoint: 'magma', identityDiscarded: true, financialEffects: false }, financialEffects: false };
    } catch { return fail(controller.signal.aborted || performance.now() >= deadline ? 'timeout' : 'transport'); }
    finally { clearTimeout(timer); controller.abort(); if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); } }
  }
}
