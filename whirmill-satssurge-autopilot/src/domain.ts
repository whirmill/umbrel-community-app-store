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
export const SCHEMA_VERSION = 7;
export const MANDATE = Object.freeze({
  version: 1, totalMsat: '30000000', dailyMsat: '1500000', exploratoryDailyMsat: '750000',
  attemptMsat: '100000', reserveSat: '500000', feeWindowHours: 48,
  maxAttempts: 3, maxObservationDays: 7,
  allowed: ['fee_change', 'rebalance'], economicView: 'net-operating-30-days', timezone: 'Europe/Rome'
});
export const month = (at: string) => day(at).slice(0, 7);
/** Mandate v2 adds owner-approved channel lifecycle on top of v1; v1 fee/rebalance caps and receipts are unchanged. */
export const CHANNEL_MANDATE = Object.freeze({
  version: 2, base: MANDATE.version, allowed: ['channel_open', 'channel_close'], approval: 'owner_each_operation',
  onchainMonthlyFeeSat: '20000', minOpenSat: '500000', maxOpenSat: '2000000', reserveSat: MANDATE.reserveSat,
  maxSatPerVbyte: 50, targetConf: 6, closeVbytes: 250, close: 'cooperative_only', timezone: 'Europe/Rome'
});
export interface ChannelProposal {
  kind: 'channel_open' | 'channel_close'; peer: string; address?: string; channel?: string; amountSat: string;
  evidenceIds: string[]; problem: string; evidence: string; whyAct: string; alternatives: string; verify: string; hypothesis: string;
  // Bound at proposal creation from EstimateFee and the snapshot; the owner approves exactly these values.
  point?: string; alias?: string; satPerVbyte?: string; maxFeeSat?: string; forecast?: Record<string, unknown>;
}
export const channelKind = (kind: unknown): kind is ChannelProposal['kind'] => kind === 'channel_open' || kind === 'channel_close';
/** Telegram chat turns; `read_only_chat` is the pre-0.7.4 id of the same profile. */
export const telegramChat=(capability:unknown)=>capability==='telegram_chat'||capability==='read_only_chat';
/** Capabilities that may record owner-review proposals; none may dispatch them. */
export const proposalCapability=(capability:unknown)=>capability==='guarded_manual_proposal'||telegramChat(capability);

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
  reasons?:string[]; coverageComplete?:boolean; inputAvailability?:boolean; rawRequestedMsat?:string; version?:number; baseline?:{at:string;sourceInboundMsat:string;targetOutboundMsat:string;targetPpm:number;targetBaseMsat:string;rate7MsatPerHour:string;rate30MsatPerHour:string;conservativeDemand30Msat:string;opportunityCostMsat:string};
}
export interface PaymentOutcome { status: 'SUCCEEDED' | 'FAILED' | 'IN_FLIGHT'; feeMsat: string; amountSat: string; source?: string; target?: string; index?: string; }
export const terminal = (s: string) => s === 'SUCCEEDED' || s === 'FAILED';
/** Public conversation projection excludes internal thinking and provider metadata. */
export function publicAnswer(value:unknown):string {
  if(typeof value==='string') { try{return publicAnswer(JSON.parse(value));}catch{return value;} }
  const messages=Array.isArray(value)?value:[value];
  const assistant=messages.filter(m=>m && typeof m==='object' && m.role==='assistant').at(-1);
  if(!assistant || !Array.isArray(assistant.content))return 'Risposta completata senza testo pubblico.';
  return assistant.content.filter((c:any)=>c.type==='text' && typeof c.text==='string').map((c:any)=>c.text).join('\n').trim() || 'Risposta completata senza testo pubblico.';
}
export function scrub(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => !/(preimage|payment_request|seed|mnemonic|macaroon|password|secret|credential|^auth$|oauth|authentication|token|destination_address|payment_addr)/i.test(k)).map(([k,x]) => [k,scrub(x)]));
  if (typeof v === 'string' && /^[\s]*[\[{]/.test(v)) {try{const parsed=JSON.parse(v);if(parsed&&typeof parsed==='object')return json(scrub(parsed));}catch{}}
  if (typeof v === 'string') return v.replace(/\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/g,'[REDACTED]').replace(/\b(?:nsec1|sk-[a-zA-Z0-9]|gh[op]_)[a-zA-Z0-9_-]+/g, '[REDACTED]');
  return v;
}
