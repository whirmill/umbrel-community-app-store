import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
/**
 * Owner configuration: a read-only JSON file in app-data (`config/satssurge.json`, mounted `/config:ro`).
 * The container cannot write it, so neither the agent, Telegram nor the web app can raise a limit.
 * Every key is optional and defaults to the built-in value; bounds stop a typo from authorizing large spend.
 * Read once at startup. Safety rules (allowed kinds, owner approval, cooperative closes, no replay,
 * freshness gates) are not configuration and stay in code.
 */
interface Spec { default: number; min: number; max: number; label: string }
const spec = (value: number, min: number, max: number, label: string): Spec => ({ default: value, min, max, label });
export const CONFIG_SPEC = {
  mandate: {
    attemptSat: spec(100, 1, 2000, 'costo massimo per tentativo (sat)'),
    dailySat: spec(1500, 1, 10000, 'spesa giornaliera (sat)'),
    exploratoryDailySat: spec(750, 0, 10000, 'spesa esplorativa giornaliera (sat)'),
    totalSat: spec(30000, 0, 100000, 'spesa totale (sat)'),
    reserveSat: spec(500000, 100000, 10000000, 'riserva on-chain (sat)'),
    maxAttempts: spec(3, 1, 5, 'tentativi per decisione'),
    feeStepPercent: spec(20, 1, 50, 'passo massimo di una fee (%)'),
    feeStepMinPpm: spec(5, 1, 100, 'passo minimo consentito di una fee (ppm)'),
    feeWindowHours: spec(48, 6, 720, 'attesa tra due modifiche fee (ore)'),
    ordinaryBenefitRatio: spec(2, 1, 10, 'beneficio richiesto per un rebalance ordinario (× costo)'),
  },
  channels: {
    onchainMonthlyFeeSat: spec(20000, 0, 50000, 'fee on-chain dei canali al mese (sat)'),
    minOpenSat: spec(500000, 100000, 5000000, 'apertura minima (sat)'),
    maxOpenSat: spec(2000000, 100000, 5000000, 'apertura massima (sat)'),
    maxSatPerVbyte: spec(50, 1, 200, 'sat/vB massimi'),
  },
  telegram: {
    proposalMinutes: spec(5, 1, 30, 'validità di una proposta (minuti)'),
    quietStartHour: spec(22, 0, 23, 'inizio quiete (ora)'),
    quietEndHour: spec(8, 0, 23, 'fine quiete (ora)'),
    digestHour: spec(9, 0, 23, 'ora del digest'),
    lndAlertMinutes: spec(10, 1, 60, 'allarme LND non raggiungibile (minuti)'),
    lndSyncAlertMinutes: spec(10, 1, 60, 'allarme LND non sincronizzato (minuti)'),
    providerAlertMinutes: spec(10, 1, 60, 'allarme provider del modello (minuti)'),
    uncertainAlertMinutes: spec(10, 1, 60, 'allarme esito incerto (minuti)'),
  },
  agent: {
    softSeconds: spec(120, 30, 600, 'durata morbida di un turno chat o analisi (s)'),
    economicSoftSeconds: spec(60, 30, 600, 'durata morbida di una revisione economica (s)'),
    hardSeconds: spec(180, 60, 900, 'durata massima di un turno (s)'),
    readOnlyResearchCalls: spec(12, 4, 40, 'chiamate di ricerca di chat e analisti'),
    coordinatorResearchCalls: spec(16, 4, 40, 'chiamate di ricerca del coordinatore'),
    automaticReviewsPerDay: spec(4, 0, 24, 'revisioni automatiche per ambito al giorno'),
    htlcFailureTrigger: spec(3, 1, 100, 'inoltri falliti che avviano una revisione'),
    htlcFailureSettleSeconds: spec(120, 10, 3600, 'attesa dopo una raffica di inoltri falliti (s)'),
  },
  lnd: {
    callSeconds: spec(20, 5, 60, 'attesa per una chiamata a LND (s)'),
    paymentWaitSeconds: spec(120, 60, 600, 'attesa di un pagamento (s)'),
    paymentTimeoutSeconds: spec(30, 10, 300, 'timeout del pagamento in LND (s)'),
  },
} as const;
type Section = keyof typeof CONFIG_SPEC;
export type OwnerConfig = { [S in Section]: { [K in keyof (typeof CONFIG_SPEC)[S]]: number } };
export interface LoadedConfig { values: OwnerConfig; source: 'default' | 'file'; file: string; digest: string; errors: string[]; overrides: string[] }

const defaults = (): OwnerConfig => Object.fromEntries(Object.entries(CONFIG_SPEC).map(([s, keys]) => [s, Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, v.default]))])) as OwnerConfig;
const digestOf = (values: OwnerConfig) => createHash('sha256').update(JSON.stringify(values)).digest('hex');

/** Validates a parsed file. Invalid input yields the defaults plus errors: finance then stays blocked. */
export function parseConfig(raw: unknown, file = 'inline'): LoadedConfig {
  const values = defaults(), errors: string[] = [], overrides: string[] = [];
  if (raw === undefined) return { values, source: 'default', file, digest: digestOf(values), errors, overrides };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) errors.push('il file deve contenere un oggetto JSON');
  else for (const [section, entries] of Object.entries(raw as Record<string, unknown>)) {
    const keys = (CONFIG_SPEC as Record<string, Record<string, Spec>>)[section];
    if (!keys) { errors.push(`sezione sconosciuta: ${section}`); continue; }
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) { errors.push(`${section} deve essere un oggetto`); continue; }
    for (const [key, value] of Object.entries(entries as Record<string, unknown>)) {
      const s = keys[key];
      if (!s) { errors.push(`campo sconosciuto: ${section}.${key}`); continue; }
      if (typeof value !== 'number' || !Number.isInteger(value)) { errors.push(`${section}.${key} deve essere un numero intero`); continue; }
      if (value < s.min || value > s.max) { errors.push(`${section}.${key}=${value} fuori dai limiti ${s.min}–${s.max}`); continue; }
      (values as any)[section][key] = value;
      if (value !== s.default) overrides.push(`${section}.${key}`);
    }
  }
  const v = values;
  if (v.mandate.exploratoryDailySat > v.mandate.dailySat) errors.push('mandate.exploratoryDailySat supera mandate.dailySat');
  if (v.mandate.attemptSat > v.mandate.dailySat) errors.push('mandate.attemptSat supera mandate.dailySat');
  if (v.channels.minOpenSat > v.channels.maxOpenSat) errors.push('channels.minOpenSat supera channels.maxOpenSat');
  if (v.agent.hardSeconds < Math.max(v.agent.softSeconds, v.agent.economicSoftSeconds) + 30) errors.push('agent.hardSeconds deve superare di almeno 30 s le durate morbide');
  if (v.lnd.paymentTimeoutSeconds > v.lnd.paymentWaitSeconds - 30) errors.push('lnd.paymentTimeoutSeconds deve stare almeno 30 s sotto lnd.paymentWaitSeconds');
  // An invalid file never applies partially: built-in values with the errors, and finance blocked.
  const applied = errors.length ? defaults() : values;
  return { values: applied, source: errors.length ? 'default' : 'file', file, digest: digestOf(applied), errors, overrides: errors.length ? [] : overrides };
}

export function loadConfig(file = process.env.SATSSURGE_CONFIG_FILE ?? '/config/satssurge.json'): LoadedConfig {
  let text: string;
  try { text = readFileSync(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return parseConfig(undefined, file); return { ...parseConfig(undefined, file), errors: [`file non leggibile: ${(error as NodeJS.ErrnoException)?.code ?? 'errore'}`] }; }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { ...parseConfig(undefined, file), errors: ['JSON non valido'] }; }
  return parseConfig(raw, file);
}

/** Owner-readable differences between two applied configurations, e.g. "costo massimo per tentativo (sat) 100 → 500". */
export function configChanges(before: OwnerConfig | undefined, after: OwnerConfig): string[] {
  const out: string[] = [];
  for (const [section, keys] of Object.entries(CONFIG_SPEC)) for (const [key, s] of Object.entries(keys)) {
    const was = (before as any)?.[section]?.[key] ?? s.default, now = (after as any)[section][key];
    if (was !== now) out.push(`${s.label} ${was} → ${now}`);
  }
  return out;
}

/** The configuration this process runs with. */
export const CONFIG = loadConfig();
export const SETTINGS = CONFIG.values;
