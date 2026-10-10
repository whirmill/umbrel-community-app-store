/** Optional M5 research-only clients: fixed reads, no executor/store/tool-registry access. */
export type Provider = 'robosats' | 'amboss-space' | 'magma';
export type FailureReason = 'disabled' | 'unsupported' | 'credential_missing' | 'cooldown' | 'timeout' | 'transport' | 'http' | 'rate_limited' | 'schema' | 'too_large';
export type ReadResult<T> = { ok: true; provider: Provider; observedAt: string; coverage: 'snapshot' | 'partial'; financialEffects: false; value: T } | { ok: false; provider: Provider; reason: FailureReason; financialEffects: false };
export interface OptionalIntegrationConfig { robosats: boolean; ambossSpace: boolean; magma: boolean }
export const OPTIONAL_INTEGRATIONS_DISABLED: Readonly<OptionalIntegrationConfig> = Object.freeze({ robosats: false, ambossSpace: false, magma: false });
function object(v: unknown): Record<string, unknown> { if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('schema'); return v as Record<string, unknown>; }
/** Only explicit booleans enable reads. Credentials never belong to this schema. */
export function parseOptionalIntegrationConfig(v: unknown): Readonly<OptionalIntegrationConfig> {
  const o = object(v);
  if ((Object.getPrototypeOf(o) !== Object.prototype && Object.getPrototypeOf(o) !== null) || Object.keys(o).some(k => !['robosats', 'ambossSpace', 'magma'].includes(k)) || Object.values(o).some(v => typeof v !== 'boolean')) throw new Error('Invalid optional integration config');
  return Object.freeze({ robosats: Object.hasOwn(o, 'robosats') && o.robosats === true, ambossSpace: Object.hasOwn(o, 'ambossSpace') && o.ambossSpace === true, magma: Object.hasOwn(o, 'magma') && o.magma === true });
}
function at(v: unknown, ...path: string[]): unknown { for (const p of path) v = object(v)[p]; return v; }
function number(v: unknown, max = Number.MAX_SAFE_INTEGER): number { if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > max) throw new Error('schema'); return v; }
function integer(v: unknown): number { const n = number(v); if (!Number.isSafeInteger(n)) throw new Error('schema'); return n; }
function decimal(v: unknown, signed = false): string { if (typeof v !== 'string' || v.length > 48 || !(signed ? /^-?\d+(\.\d+)?$/ : /^\d+(\.\d+)?$/).test(v)) throw new Error('schema'); return v; }
function sats(v: unknown): string { const s = decimal(v); if (!/^\d+$/.test(s)) throw new Error('schema'); return s; }
class Failure extends Error { constructor(readonly reason: FailureReason) { super(reason); } }
export interface RoboSatsInfo { network: 'mainnet'; makerFeePercent: number; takerFeePercent: number; bondPercent: number; buyOrders: number; sellOrders: number; minOrderSats: number; maxOrderSats: number }
export interface RoboSatsOffer { id: number; type: 0 | 1; currency: number; premiumPercent: string; satoshisNow: number; bondPercent: string; expiresAt: string }
export interface MagmaEstimate { satsPerUsd: string; expectedReceivingUsdPerUsd: string }
export interface MagmaOffer { id: string; minSats: string; maxSats: string; totalSats: string; lockedSats: string; fixedFeeSats: string; variableFeeValue: string; ambossFeeValue: string; minBlockLength: number }
export interface MagmaPage { offset: number; nextOffset: number | null; total: number; offers: MagmaOffer[]; feeUnitsQualified: false; sizeBoundsQualified: true }
const MAGMA = 'https://magma.amboss.tech/graphql';
const SPACE = 'https://api.amboss.space/graphql';
// Public clearnet only. A Tor/coordinator transport must be qualified separately.
const ROBO = 'https://unsafe.templeofsats.org';
const ESTIMATE = 'query M5Estimate { market { liquidity { liquidity_per_usd { sats usd } } } }';
const HELLO = 'query M5Availability { getHello }';
const OFFERS = `query M5Offers($limit: Float!, $offset: Float!) { market { offer { offers(page: {limit: $limit, offset: $offset}) { total list { id min_amount { satoshi { sats } } max_amount { satoshi { sats } } total_amount { satoshi { sats } } locked_amount { satoshi { sats } } fees { fixed { sats } variable { sats } amboss { sats } } promises { min_block_length } } } } } }`;
export class OptionalIntegrationReads {
  #config: Readonly<OptionalIntegrationConfig>; #fetch: typeof fetch;
  #credential: (() => string | undefined) | undefined; #next = new Map<Provider, number>();
  constructor(config: OptionalIntegrationConfig = OPTIONAL_INTEGRATIONS_DISABLED, options: { fetch?: typeof fetch; ambossCredential?: () => string | undefined } = {}) {
    this.#config = parseOptionalIntegrationConfig(config); this.#fetch = options.fetch ?? fetch; this.#credential = options.ambossCredential;
  }
  async #read<T>(provider: Provider, enabled: boolean, url: string, query: string | undefined, project: (v: unknown) => T, options: { variables?: Record<string, number>; authenticated?: boolean; partial?: boolean } = {}): Promise<ReadResult<T>> {
    const fail = (reason: FailureReason): ReadResult<T> => ({ ok: false, provider, reason, financialEffects: false });
    if (!enabled) return fail('disabled');
    const now = performance.now(); if (now < (this.#next.get(provider) ?? 0)) return fail('cooldown');
    this.#next.set(provider, now + 5_000); // Reserve shared instance budget before any await.
    const deadline = performance.now() + 10_000;
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10_000);
    const checkDeadline = () => { if (controller.signal.aborted || performance.now() >= deadline) throw new Failure('timeout'); };
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const headers: Record<string, string> = { Accept: 'application/json' }; if (query) headers['Content-Type'] = 'application/json';
      if (options.authenticated) { const token = this.#credential?.(); if (!token || !/^[\x21-\x7e]{1,4096}$/.test(token)) throw new Failure('credential_missing'); headers.Authorization = `Bearer ${token}`; }
      const response = await this.#fetch(url, { method: query ? 'POST' : 'GET', headers, redirect: 'error', credentials: 'omit', signal: controller.signal, ...(query ? { body: JSON.stringify({ query, ...(options.variables ? { variables: options.variables } : {}) }) } : {}) });
      checkDeadline();
      if (response.status === 429) { this.#next.set(provider, performance.now() + 60_000); throw new Failure('rate_limited'); }
      if (!response.ok) throw new Failure('http');
      if (!response.headers.get('content-type')?.toLowerCase().includes('application/json') || !response.body) throw new Failure('schema');
      reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      let reads = 0;
      while (true) {
        checkDeadline();
        if (reads >= 4096) throw new Failure('too_large');
        const r = await reader.read(); reads++;
        checkDeadline();
        if (r.done) break;
        size += r.value.byteLength;
        if (size > 256 * 1024) throw new Failure('too_large');
        if (r.value.byteLength > 0) chunks.push(r.value);
        // Resolved reads can monopolize microtasks; let timers and I/O run too.
        if (reads % 64 === 0) { await new Promise<void>(resolve => setImmediate(resolve)); checkDeadline(); }
      }
      checkDeadline();
      const joined = new Uint8Array(size); let offset = 0; for (const c of chunks) { joined.set(c, offset); offset += c.length; }
      let v: unknown; try { v = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined)); } catch { throw new Failure('schema'); }
      let projected: T;
      try { if (query) { const envelope = object(v); if (envelope.errors !== undefined && (!Array.isArray(envelope.errors) || envelope.errors.length > 0)) throw new Error('schema'); v = envelope.data; } projected = project(v); } catch (e) { throw e instanceof Failure ? e : new Failure('schema'); }
      checkDeadline();
      return { ok: true, provider, observedAt: new Date().toISOString(), coverage: options.partial ? 'partial' : 'snapshot', financialEffects: false, value: projected };
    } catch (e) { return fail(controller.signal.aborted ? 'timeout' : e instanceof Failure ? e.reason : 'transport'); }
    finally { clearTimeout(timer); controller.abort(); if (reader) { void reader.cancel().catch(() => {}); reader.releaseLock(); } }
  }
  roboSatsInfo(): Promise<ReadResult<RoboSatsInfo>> {
    return this.#read('robosats', this.#config.robosats, `${ROBO}/api/info/`, undefined, v => {
      const o = object(v); if (o.network !== 'mainnet') throw new Error('schema'); const min = integer(o.min_order_size), max = integer(o.max_order_size); if (min > max) throw new Error('schema');
      return { network: 'mainnet', makerFeePercent: number(o.maker_fee, 100), takerFeePercent: number(o.taker_fee, 100), bondPercent: number(o.bond_size, 100), buyOrders: integer(o.num_public_buy_orders), sellOrders: integer(o.num_public_sell_orders), minOrderSats: min, maxOrderSats: max };
    });
  }
  roboSatsBook(): Promise<ReadResult<RoboSatsOffer[]>> {
    return this.#read('robosats', this.#config.robosats, `${ROBO}/api/book/?currency=0&type=2`, undefined, v => {
      if (!Array.isArray(v) || v.length > 1000) throw new Error('schema');
      return v.map(raw => { const o = object(raw); if (o.type !== 0 && o.type !== 1) throw new Error('schema'); if (typeof o.expires_at !== 'string' || o.expires_at.length > 40 || !Number.isFinite(Date.parse(o.expires_at))) throw new Error('schema');
        return { id: integer(o.id), type: o.type, currency: integer(o.currency), premiumPercent: decimal(o.premium, true), satoshisNow: integer(o.satoshis_now), bondPercent: decimal(o.bond_size), expiresAt: new Date(o.expires_at).toISOString() };
      });
    }, { partial: true });
  }
  /** Connectivity only. The greeting is discarded; this cannot prove authentication or analytics. */
  ambossSpaceAvailability(authenticated = false): Promise<ReadResult<{ reachable: true; analyticsQualified: false; authenticationQualified: false }>> {
    return this.#read('amboss-space', this.#config.ambossSpace, SPACE, HELLO, v => { if (typeof object(v).getHello !== 'string') throw new Error('schema'); return { reachable: true, analyticsQualified: false, authenticationQualified: false }; }, { authenticated });
  }
  magmaEstimate(): Promise<ReadResult<MagmaEstimate>> {
    return this.#read('magma', this.#config.magma, MAGMA, ESTIMATE, v => { const o = object(at(v, 'market', 'liquidity', 'liquidity_per_usd')); return { satsPerUsd: decimal(o.sats), expectedReceivingUsdPerUsd: decimal(o.usd) }; });
  }
  magmaOffers(offset = 0, limit = 25): Promise<ReadResult<MagmaPage>> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) return Promise.resolve({ ok: false, provider: 'magma', reason: 'schema', financialEffects: false });
    return this.#read('magma', this.#config.magma, MAGMA, OFFERS, v => {
      const p = object(at(v, 'market', 'offer', 'offers')), total = integer(p.total);
      if (Array.isArray(p.list) && p.list.length > limit) throw new Failure('unsupported');
      if (!Array.isArray(p.list) || offset + p.list.length > total || (offset < total && p.list.length === 0)) throw new Error('schema');
      const offers = p.list.map(raw => { const o = object(raw); if (typeof o.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(o.id)) throw new Error('schema');
        const btcBound = (field: string): string => {
          const size = o[field];
          if (!size || typeof size !== 'object' || Array.isArray(size) || !object(size).satoshi) throw new Failure('unsupported');
          return sats(at(size, 'satoshi', 'sats'));
        };
        const minSats = btcBound('min_amount'), maxSats = btcBound('max_amount');
        if (BigInt(minSats) > BigInt(maxSats)) throw new Error('schema');
        const totalSats = sats(at(o, 'total_amount', 'satoshi', 'sats')), lockedSats = sats(at(o, 'locked_amount', 'satoshi', 'sats')); if (BigInt(lockedSats) > BigInt(totalSats)) throw new Error('schema');
        return { id: o.id, minSats, maxSats, totalSats, lockedSats, fixedFeeSats: sats(at(o, 'fees', 'fixed', 'sats')), variableFeeValue: sats(at(o, 'fees', 'variable', 'sats')), ambossFeeValue: sats(at(o, 'fees', 'amboss', 'sats')), minBlockLength: integer(at(o, 'promises', 'min_block_length')) };
      });
      if (new Set(offers.map(o => o.id)).size !== offers.length) throw new Error('schema');
      return { offset, nextOffset: offset + offers.length < total ? offset + offers.length : null, total, offers, feeUnitsQualified: false, sizeBoundsQualified: true };
    }, { variables: { offset, limit }, partial: true });
  }
  unsupported(provider: Provider): ReadResult<never> { return { ok: false, provider, reason: 'unsupported', financialEffects: false }; }
}
