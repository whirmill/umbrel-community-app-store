import { createHash, randomUUID } from 'node:crypto';

export const now = () => new Date().toISOString();
export const id = () => randomUUID();
export const hash = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
export const json = (v: unknown) => JSON.stringify(v, (_, x) => typeof x === 'bigint' ? x.toString() : x);
export function integer(v: unknown): bigint {
  if (typeof v === 'number' && (!Number.isSafeInteger(v) || v < 0)) throw new Error('Invalid integer');
  if (!/^[0-9]+$/.test(String(v))) throw new Error('Expected nonnegative decimal integer');
  const n = BigInt(String(v));
  if (n > 2_100_000_000_000_000_000n) throw new Error('Amount too large');
  return n;
}
export const day = (at: string) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));
export const SCHEMA_VERSION = 1;
export const MANDATE = Object.freeze({
  version: 1, totalMsat: '30000000', dailyMsat: '1500000', exploratoryDailyMsat: '750000',
  attemptMsat: '100000', reserveSat: '500000', feeWindowHours: 48,
  maxAttempts: 3, maxObservationDays: 7,
  allowed: ['fee_change', 'rebalance'], economicView: 'net-operating-30-days', timezone: 'Europe/Rome'
});

export interface Channel {
  id: string; point: string; peer: string; alias: string; active: boolean; capacitySat: string;
  localSat: string; remoteSat: string; reserveSat: string; pendingSat: string;
  baseMsat: string; ppm: number; cltv: number; minMsat: string; maxMsat: string;
}
export interface Snapshot {
  at: string; identity: string; synced: boolean; confirmedSat: string; channels: Channel[];
}
export interface Proposal {
  kind: 'rebalance' | 'fee_change'; category: 'ordinary' | 'exploratory';
  strategy: string; source: string; target: string; amountSat: string; maxFeeMsat: string;
  decisionCapMsat: string; newPpm?: number; demandKey: string; evidenceIds: string[];
  problem: string; evidence: string; whyAct: string; alternatives: string;
  verify: string; hypothesis: string;
}
export interface Forecast {
  eligible: boolean; samples: number; observedHours: number; observedDays: number;
  benefitMsat: string; requestedMsat: string; explanation: string;
}
export interface PaymentOutcome { status: 'SUCCEEDED' | 'FAILED' | 'IN_FLIGHT'; feeMsat: string; amountSat: string; source?: string; target?: string; index?: string; }
export const terminal = (s: string) => s === 'SUCCEEDED' || s === 'FAILED';
export function scrub(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !/(preimage|payment_request|seed|mnemonic|macaroon|password|secret|credential|^auth$|oauth|authentication|token|destination_address|payment_addr)/i.test(k)).map(([k,x]) => [k,scrub(x)]));
  if (typeof v === 'string') return v.replace(/\b(?:nsec1|sk-[a-zA-Z0-9]|gh[op]_)[a-zA-Z0-9_-]+/g, '[REDACTED]');
  return v;
}
