import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { initWasm, Resvg } from '@resvg/resvg-wasm';
import type { Store } from './store.js';
import { APP_VERSION } from './version.js';
import { now, type Snapshot, type Proposal } from './domain.js';
/**
 * Telegram charts. Data comes from the database (snapshots, forwards, ledger, operations) and is
 * frozen into the outbox receipt, so a retried delivery renders the same image. The model never
 * supplies numbers. Static PNG on a light surface; palette validated with the dataviz skill.
 */
export const CHART_KINDS = ['canali', 'storico', 'inoltri', 'guadagni', 'rebalance', 'fee'] as const;
export type ChartKind = typeof CHART_KINDS[number];
export interface ChartRequest { kind: ChartKind; days?: number; channel?: string; operation?: string }
type Point = [number, number];
export type ChartData = { at: string } & (
  | { kind: 'canali'; rows: { alias: string; localSat: number; remoteSat: number; capacitySat: number }[] }
  | { kind: 'storico'; from: string; panels: { alias: string; points: Point[] }[] }
  | { kind: 'inoltri'; from: string; out: { alias: string; feeMsat: number; count: number; volumeMsat: number }[]; inbound: { alias: string; count: number; volumeMsat: number }[] }
  | { kind: 'guadagni'; from: string; revenue: Point[]; costs: Point[] }
  | { kind: 'rebalance'; operation: { id: string; at: string; source: string; target: string; amountSat: number; feeMsat: number }; balance: Point[]; fees: Point[] }
  | { kind: 'fee'; from: string; alias: string; ppm: Point[]; daily: { day: string; count: number }[] });

const DAY = 86400000;
const ROME = 'Europe/Rome';
const C = { surface: '#fcfcfb', ink: '#0b0b0b', secondary: '#52514e', muted: '#898781', grid: '#e1e0d9', axis: '#c3c2b7', s1: '#2a78d6', s2: '#eb6834', track: '#cde2fb', serious: '#ec835a' };
const FONT = 'DejaVu Sans';
/** Peer aliases are gossip: drop pictographs the font lacks and bound the length. */
export const cleanAlias = (alias: string, max = 28) => { const s = alias.replace(/[\p{Extended_Pictographic}️‍]/gu, '').replace(/\s+/g, ' ').trim() || '?'; return s.length > max ? s.slice(0, max - 1) + '…' : s; };
const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const thousands = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const compact = (n: number) => { const a = Math.abs(n); return a >= 1e6 ? (n / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace('.', ',').replace(/,0$/, '') + 'M' : a >= 1e3 ? (n / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace('.', ',').replace(/,0$/, '') + 'k' : String(Math.round(n)); };
const sat = (msat: number) => msat / 1000;
const satText = (msat: number) => { const s = sat(msat); return (Number.isInteger(s) || s >= 100 ? thousands(s) : s.toFixed(1).replace('.', ',')) + ' sat'; };
const date = (t: number) => new Intl.DateTimeFormat('it-IT', { timeZone: ROME, day: '2-digit', month: '2-digit' }).format(new Date(t));
const romeDay = (t: number) => new Intl.DateTimeFormat('sv-SE', { timeZone: ROME }).format(new Date(t));

// --- data -----------------------------------------------------------------

function aliases(store: Store) { const s = store.get<Snapshot>('snapshot'); return new Map((s?.channels ?? []).map(c => [c.id, c.alias || c.id])); }
const nameOf = (names: Map<string, string>, id: string) => names.get(id) ?? id;
/** One snapshot per hour (the last of each), oldest first. */
function hourly(store: Store, from: string): Snapshot[] {
  return store.all("SELECT s.content FROM snapshots s JOIN (SELECT max(rowid) r FROM snapshots WHERE at>=? GROUP BY substr(at,1,13)) m ON m.r=s.rowid ORDER BY s.at", from).map(r => JSON.parse(r.content));
}
function channelId(store: Store, query: string | undefined, names: Map<string, string>) {
  if (!query) return undefined;
  const q = query.toLowerCase(), hit = [...names].find(([id, alias]) => id === query || alias.toLowerCase().includes(q));
  if (!hit) throw Error(`Canale non trovato: ${query}`);
  return hit[0];
}

export function chartData(store: Store, request: ChartRequest, at = now()): ChartData {
  const days = Math.min(30, Math.max(1, Math.round(request.days ?? (request.kind === 'storico' ? 7 : 30))));
  const end = Date.parse(at), from = new Date(end - days * DAY).toISOString(), names = aliases(store);
  switch (request.kind) {
    case 'canali': {
      const s = store.get<Snapshot>('snapshot');
      if (!s?.channels.length) throw Error('Nessuna fotografia dei canali disponibile');
      const rows = s.channels.map(c => ({ alias: c.alias || c.id, localSat: Number(c.localSat), remoteSat: Number(c.remoteSat), capacitySat: Number(c.capacitySat) }));
      rows.sort((a, b) => a.localSat / (a.capacitySat || 1) - b.localSat / (b.capacitySat || 1));
      return { kind: 'canali', at: s.at, rows };
    }
    case 'storico': {
      const snaps = hourly(store, from), ids = [...names.keys()];
      if (snaps.length < 2) throw Error('Storico dei saldi insufficiente');
      const panels = ids.map(id => ({ alias: nameOf(names, id), points: snaps.flatMap(s => { const c = s.channels.find(x => x.id === id); return c && Number(c.capacitySat) ? [[Date.parse(s.at), Number(c.localSat) / Number(c.capacitySat) * 100] as Point] : []; }) }));
      return { kind: 'storico', at, from, panels };
    }
    case 'inoltri': {
      const rows = store.all("SELECT source,target,amount_msat,fee_msat FROM events WHERE type='external_forward' AND occurred_at>=? AND occurred_at<=?", from, at);
      const out = new Map<string, { feeMsat: number; count: number; volumeMsat: number }>(), inbound = new Map<string, { count: number; volumeMsat: number }>();
      for (const id of names.keys()) { out.set(id, { feeMsat: 0, count: 0, volumeMsat: 0 }); inbound.set(id, { count: 0, volumeMsat: 0 }); }
      for (const r of rows) {
        const o = out.get(r.target) ?? { feeMsat: 0, count: 0, volumeMsat: 0 }; o.feeMsat += Number(r.fee_msat); o.count++; o.volumeMsat += Number(r.amount_msat); out.set(r.target, o);
        const i = inbound.get(r.source) ?? { count: 0, volumeMsat: 0 }; i.count++; i.volumeMsat += Number(r.amount_msat); inbound.set(r.source, i);
      }
      return { kind: 'inoltri', at, from, out: [...out].map(([id, v]) => ({ alias: nameOf(names, id), ...v })).sort((a, b) => b.feeMsat - a.feeMsat || b.volumeMsat - a.volumeMsat), inbound: [...inbound].map(([id, v]) => ({ alias: nameOf(names, id), ...v })).sort((a, b) => b.volumeMsat - a.volumeMsat) };
    }
    case 'guadagni': {
      const cumulative = (rows: any[]): Point[] => { let total = 0; const out: Point[] = [[Date.parse(from), 0]]; for (const r of rows) { total += Number(r.amount_msat); out.push([Date.parse(r.at), total]); } out.push([end, total]); return out; };
      const revenue = cumulative(store.all("SELECT at,amount_msat FROM ledger WHERE classification='revenue' AND category='routing' AND at>=? AND at<=? ORDER BY at", from, at));
      const costs = cumulative(store.all("SELECT at,amount_msat FROM ledger WHERE classification='expense' AND category IN ('ordinary','exploratory','manual_rebalance') AND at>=? AND at<=? ORDER BY at", from, at));
      return { kind: 'guadagni', at, from, revenue, costs };
    }
    case 'rebalance': {
      const row = request.operation
        ? store.one("SELECT o.id,o.at,o.state,o.details,d.proposal FROM operations o JOIN decisions d ON d.id=o.decision_id WHERE o.id=? OR o.id LIKE ?", request.operation, request.operation + '%')
        : store.one("SELECT o.id,o.at,o.state,o.details,d.proposal FROM operations o JOIN decisions d ON d.id=o.decision_id WHERE o.state='SUCCEEDED' AND json_extract(d.proposal,'$.kind')='rebalance' ORDER BY o.at DESC LIMIT 1");
      if (!row) throw Error('Nessun rebalance riuscito da mostrare');
      const p = JSON.parse(row.proposal) as Proposal, d = JSON.parse(row.details ?? '{}');
      if (p.kind !== 'rebalance' || row.state !== 'SUCCEEDED') throw Error('L’operazione indicata non è un rebalance riuscito');
      const start = Date.parse(d.completedAt ?? row.at), before = new Date(start - 2 * 3600000).toISOString();
      const balance = hourly(store, before).flatMap(s => { const c = s.channels.find(x => x.id === p.target); return c ? [[Date.parse(s.at), Number(c.localSat)] as Point] : []; });
      const current = store.get<Snapshot>('snapshot')?.channels.find(c => c.id === p.target); if (current) balance.push([end, Number(current.localSat)]);
      let total = 0; const fees: Point[] = [[start, 0]];
      for (const r of store.all("SELECT occurred_at,fee_msat FROM events WHERE type='external_forward' AND target=? AND occurred_at>? ORDER BY occurred_at", p.target, new Date(start).toISOString())) { total += Number(r.fee_msat); fees.push([Date.parse(r.occurred_at), total]); }
      fees.push([end, total]);
      return { kind: 'rebalance', at, operation: { id: row.id, at: new Date(start).toISOString(), source: nameOf(names, p.source), target: nameOf(names, p.target), amountSat: Number(p.amountSat), feeMsat: Number(d.feeMsat ?? 0) }, balance, fees };
    }
    case 'fee': {
      let id = channelId(store, request.channel, names);
      if (!id) id = store.one("SELECT target FROM events WHERE type='external_forward' AND occurred_at>=? GROUP BY target ORDER BY sum(CAST(fee_msat AS INTEGER)) DESC LIMIT 1", from)?.target ?? [...names.keys()][0];
      if (!id) throw Error('Nessun canale disponibile');
      const ppm = hourly(store, from).flatMap(s => { const c = s.channels.find(x => x.id === id); return c ? [[Date.parse(s.at), c.ppm] as Point] : []; });
      const counts = new Map<string, number>(); for (let t = Date.parse(from); t <= end; t += DAY) counts.set(romeDay(t), 0);
      for (const r of store.all("SELECT occurred_at FROM events WHERE type='external_forward' AND target=? AND occurred_at>=? AND occurred_at<=?", id, from, at)) { const k = romeDay(Date.parse(r.occurred_at)); counts.set(k, (counts.get(k) ?? 0) + 1); }
      return { kind: 'fee', at, from, alias: nameOf(names, id), ppm, daily: [...counts].map(([day, count]) => ({ day, count })) };
    }
  }
}

/** The caption is the readable table view of the chart (Telegram limit 1024 characters). */
export function chartCaption(d: ChartData): string {
  switch (d.kind) {
    case 'canali': return ['Bilanciamento dei canali (saldo locale su capacità):', ...d.rows.map(r => (`${cleanAlias(r.alias, 32)}: ${Math.round(r.localSat / (r.capacitySat || 1) * 100)}% · ${compact(r.localSat)} su ${compact(r.capacitySat)}${r.localSat / (r.capacitySat || 1) < 0.2 ? ' · scarico' : ''}`))].join('\n').slice(0, 1024);
    case 'storico': return [`Saldo locale dal ${date(Date.parse(d.from))} (% della capacità, campione orario):`, ...d.panels.map(p => { const a = p.points[0]?.[1], b = p.points.at(-1)?.[1]; return `${cleanAlias(p.alias, 32)}: ${a === undefined ? '—' : Math.round(a) + '%'} → ${b === undefined ? '—' : Math.round(b) + '%'}`; })].join('\n').slice(0, 1024);
    case 'inoltri': { const total = d.out.reduce((n, r) => n + r.feeMsat, 0), count = d.out.reduce((n, r) => n + r.count, 0); return [`Inoltri dal ${date(Date.parse(d.from))}: ${count}, commissioni ${satText(total)}.`, ...d.out.filter(r => r.count).map(r => `${cleanAlias(r.alias, 32)}: ${satText(r.feeMsat)} da ${r.count} inoltri in uscita (${compact(sat(r.volumeMsat))} sat)`)].join('\n').slice(0, 1024); }
    case 'guadagni': { const r = d.revenue.at(-1)![1], c = d.costs.at(-1)![1]; return `Dal ${date(Date.parse(d.from))}: commissioni di routing ${satText(r)}, costi dei rebalance ${satText(c)}, saldo ${r - c >= 0 ? '+' : '−'}${satText(Math.abs(r - c))}. Esclusi costi on-chain, swap e spese iniziali.`; }
    case 'rebalance': { const o = d.operation, earned = d.fees.at(-1)![1], first = d.balance.find(p => p[0] >= Date.parse(o.at))?.[1], last = d.balance.at(-1)?.[1]; return `Rebalance del ${date(Date.parse(o.at))}: ${thousands(o.amountSat)} sat da ${cleanAlias(o.source, 32)} verso ${cleanAlias(o.target, 32)}, costo ${satText(o.feeMsat)}. Commissioni rientrate da allora su ${cleanAlias(o.target, 32)}: ${satText(earned)} (${o.feeMsat ? Math.round(earned / o.feeMsat * 100) : 0}% del costo).${first !== undefined && last !== undefined ? ` Saldo locale ${compact(first)} → ${compact(last)} sat.` : ''}`; }
    case 'fee': { const first = d.ppm[0]?.[1], last = d.ppm.at(-1)?.[1], changes = d.ppm.filter((p, i) => i && p[1] !== d.ppm[i - 1]![1]).length, total = d.daily.reduce((n, r) => n + r.count, 0); return `${cleanAlias(d.alias, 32)} dal ${date(Date.parse(d.from))}: fee ${first ?? '—'} → ${last ?? '—'} ppm (${changes} modifiche), ${total} inoltri in uscita.`; }
  }
}

// --- svg ------------------------------------------------------------------

const W = 1200, PAD = 48;
const text = (x: number, y: number, s: string, o: { size?: number; fill?: string; anchor?: 'start' | 'middle' | 'end'; weight?: 'bold' } = {}) => `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="${FONT}" font-size="${o.size ?? 18}" fill="${o.fill ?? C.secondary}"${o.anchor ? ` text-anchor="${o.anchor}"` : ''}${o.weight ? ' font-weight="bold"' : ''}>${xml(s)}</text>`;
const line = (x1: number, y1: number, x2: number, y2: number, stroke = C.grid, width = 1) => `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${stroke}" stroke-width="${width}"/>`;
/** Horizontal bar from x with a 4px rounded data end and a square baseline. */
const hbar = (x: number, y: number, w: number, h: number, fill: string) => { if (w <= 0) return ''; const r = Math.min(4, w, h / 2); return `<path d="M${x},${y}h${w - r}a${r},${r} 0 0 1 ${r},${r}v${h - 2 * r}a${r},${r} 0 0 1 -${r},${r}h-${w - r}z" fill="${fill}"/>`; };
/** Vertical column grown from the baseline with a 4px rounded top. */
const vbar = (x: number, base: number, w: number, h: number, fill: string) => { if (h <= 0) return ''; const r = Math.min(4, w / 2, h); return `<path d="M${x},${base}v-${h - r}a${r},${r} 0 0 1 ${r},-${r}h${w - 2 * r}a${r},${r} 0 0 1 ${r},${r}v${h - r}z" fill="${fill}"/>`; };
/** About four ticks on 1/2/5×10ⁿ steps; counts get whole steps. The axis top is a whole number of steps. */
function scale(raw: number, integer = false) { const target = Math.max(raw, 1e-9) / 4, p = 10 ** Math.floor(Math.log10(target)), n = target / p; let step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; if (integer) step = Math.max(1, Math.round(step)); const max = Math.max(step, Math.ceil(raw / step) * step); return { max, ticks: Math.round(max / step) }; }
const header = (title: string, subtitle: string) => text(PAD, 52, title, { size: 30, fill: C.ink, weight: 'bold' }) + text(PAD, 84, subtitle, { size: 19 });
const legend = (x: number, y: number, items: [string, string][]) => { let cx = x, out = ''; for (const [label, color] of items) { out += `<rect x="${cx}" y="${y - 13}" width="16" height="16" rx="3" fill="${color}"/>` + text(cx + 24, y, label, { size: 18 }); cx += 40 + label.length * 10.5; } return out; };
const svg = (h: number, body: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${h}" viewBox="0 0 ${W} ${h}"><rect width="${W}" height="${h}" fill="${C.surface}"/>${body}</svg>`;

interface Panel { x: number; y: number; w: number; h: number; from: number; to: number; max: number; min?: number; format: (v: number) => string; ticks?: number }
/** Time panel frame: recessive hairline grid, y ticks, first/last date. One y-axis only. */
function frame(p: Panel, title?: string) {
  const min = p.min ?? 0, ticks = p.ticks ?? 4; let out = title ? text(p.x, p.y - 14, title, { size: 19, fill: C.ink }) : '';
  for (let i = 0; i <= ticks; i++) { const v = min + (p.max - min) * i / ticks, y = p.y + p.h - (v - min) / (p.max - min) * p.h; out += line(p.x + 56, y, p.x + p.w, y, i ? C.grid : C.axis) + text(p.x + 48, y + 6, p.format(v), { size: 15, fill: C.muted, anchor: 'end' }); }
  out += text(p.x + 56, p.y + p.h + 24, date(p.from), { size: 15, fill: C.muted }) + text(p.x + p.w, p.y + p.h + 24, date(p.to), { size: 15, fill: C.muted, anchor: 'end' });
  return out;
}
const sx = (p: Panel, t: number) => p.x + 56 + (t - p.from) / Math.max(1, p.to - p.from) * (p.w - 56);
const sy = (p: Panel, v: number) => { const min = p.min ?? 0; return p.y + p.h - (Math.min(p.max, Math.max(min, v)) - min) / (p.max - min) * p.h; };
function path(p: Panel, points: Point[], color: string, o: { area?: boolean; step?: boolean } = {}) {
  if (!points.length) return '';
  let d = ''; points.forEach(([t, v], i) => { const x = sx(p, t), y = sy(p, v); if (!i) d += `M${x.toFixed(1)},${y.toFixed(1)}`; else { if (o.step) d += `H${x.toFixed(1)}`; d += `${o.step ? 'V' : 'L'}${o.step ? y.toFixed(1) : x.toFixed(1) + ',' + y.toFixed(1)}`; } });
  const last = points.at(-1)!, base = sy(p, p.min ?? 0);
  const area = o.area ? `<path d="${d}L${sx(p, last[0]).toFixed(1)},${base}L${sx(p, points[0]![0]).toFixed(1)},${base}Z" fill="${color}" fill-opacity="0.1"/>` : '';
  return area + `<path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>` + `<circle cx="${sx(p, last[0]).toFixed(1)}" cy="${sy(p, last[1]).toFixed(1)}" r="5" fill="${color}" stroke="${C.surface}" stroke-width="2"/>`;
}

export function chartSvg(d: ChartData): string {
  const subtitleAt = `Dati del nodo · ${new Intl.DateTimeFormat('it-IT', { timeZone: ROME, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(d.at))}`;
  switch (d.kind) {
    case 'canali': {
      const rowH = 54, top = 150, labelW = 330, barW = W - 2 * PAD - labelW - 230, h = top + d.rows.length * rowH + 40;
      let body = header('Bilanciamento dei canali', `Saldo locale (uscita) e remoto (entrata) su capacità · ${subtitleAt}`) + legend(PAD, 122, [['Locale', C.s1], ['Remoto', C.track]]);
      d.rows.forEach((r, i) => {
        const y = top + i * rowH, share = r.capacitySat ? r.localSat / r.capacitySat : 0, lw = Math.round(barW * Math.min(1, share)), x = PAD + labelW;
        body += text(PAD, y + 23, cleanAlias(r.alias), { size: 19, fill: C.ink });
        // 2px surface gap between the local and remote segments.
        body += hbar(x, y + 6, Math.max(0, lw - 1), 24, C.s1) + (lw < barW ? `<rect x="${x + lw + 1}" y="${y + 6}" width="${Math.max(0, barW - lw - 1)}" height="24" rx="4" fill="${C.track}"/>` : '');
        body += text(x + barW + 14, y + 23, `${Math.round(share * 100)}% · ${compact(r.localSat)}/${compact(r.capacitySat)}`, { size: 17 });
        // Status: icon plus label, never color alone.
        if (share < 0.2) body += `<circle cx="${x + barW + 20}" cy="${y + 40}" r="5" fill="${C.serious}"/>` + text(x + barW + 32, y + 45, 'scarico in uscita', { size: 14, fill: C.secondary });
      });
      return svg(h, body);
    }
    case 'storico': {
      const cols = 2, gap = 36, pw = (W - 2 * PAD - gap) / cols, ph = 150, top = 140, rows = Math.ceil(d.panels.length / cols), from = Date.parse(d.from), to = Date.parse(d.at);
      let body = header('Saldo locale nel tempo', `% della capacità in uscita, un pannello per canale · ${subtitleAt}`);
      d.panels.forEach((p, i) => {
        const panel: Panel = { x: PAD + (i % cols) * (pw + gap), y: top + Math.floor(i / cols) * (ph + 76) + 20, w: pw, h: ph, from, to, max: 100, format: v => Math.round(v) + '%', ticks: 2 };
        body += frame(panel, cleanAlias(p.alias, 34)) + path(panel, p.points, C.s1, { area: true });
        const last = p.points.at(-1); if (last) body += text(Math.min(sx(panel, last[0]) - 10, panel.x + panel.w - 10), sy(panel, last[1]) - 12, Math.round(last[1]) + '%', { size: 16, fill: C.ink, anchor: 'end' });
      });
      return svg(top + rows * (ph + 76) + 30, body);
    }
    case 'inoltri': {
      const rowH = 44, top = 140, half = (W - 2 * PAD - 60) / 2, labelW = 210, rows = Math.max(d.out.length, d.inbound.length), h = top + 50 + rows * rowH + 30;
      const maxFee = Math.max(1, ...d.out.map(r => r.feeMsat)), maxIn = Math.max(1, ...d.inbound.map(r => r.volumeMsat));
      let body = header('Inoltri e commissioni per canale', `Dal ${date(Date.parse(d.from))} · ${subtitleAt}`);
      body += text(PAD, top + 20, 'Commissioni guadagnate per canale di uscita', { size: 19, fill: C.ink }) + text(PAD + half + 60, top + 20, 'Volume ricevuto per canale di entrata', { size: 19, fill: C.ink });
      const column = (x0: number, list: { alias: string; value: number; label: string }[], max: number) => list.map((r, i) => { const y = top + 50 + i * rowH, bw = half - labelW - 120, w = Math.round(bw * r.value / max); return text(x0, y + 20, cleanAlias(r.alias, 18), { size: 16, fill: C.ink }) + hbar(x0 + labelW, y + 5, w, 20, C.s1) + text(x0 + labelW + w + 10, y + 20, r.label, { size: 15 }); }).join('');
      body += column(PAD, d.out.map(r => ({ alias: r.alias, value: r.feeMsat, label: r.count ? `${compact(sat(r.feeMsat))} sat · ${r.count} inoltri` : '0' })), maxFee);
      body += column(PAD + half + 60, d.inbound.map(r => ({ alias: r.alias, value: r.volumeMsat, label: r.count ? `${compact(sat(r.volumeMsat))} sat` : '0' })), maxIn);
      return svg(h, body);
    }
    case 'guadagni': {
      const from = Date.parse(d.from), to = Date.parse(d.at), y = scale(sat(Math.max(d.revenue.at(-1)![1], d.costs.at(-1)![1], 1000)));
      const p: Panel = { x: PAD, y: 150, w: W - 2 * PAD - 150, h: 420, from, to, ...y, format: v => compact(v) };
      const r = d.revenue.map(([t, v]) => [t, sat(v)] as Point), c = d.costs.map(([t, v]) => [t, sat(v)] as Point);
      let body = header('Commissioni di routing e costi dei rebalance', `Valori cumulati in sat dal ${date(from)} · ${subtitleAt}`) + legend(PAD, 122, [['Commissioni di routing', C.s1], ['Costi dei rebalance', C.s2]]);
      body += frame(p) + path(p, c, C.s2, { step: true }) + path(p, r, C.s1, { step: true });
      body += text(p.x + p.w + 14, sy(p, r.at(-1)![1]) + 6, satText(r.at(-1)![1] * 1000), { size: 17, fill: C.ink }) + text(p.x + p.w + 14, sy(p, c.at(-1)![1]) + 6 + (Math.abs(sy(p, r.at(-1)![1]) - sy(p, c.at(-1)![1])) < 22 ? 22 : 0), satText(c.at(-1)![1] * 1000), { size: 17, fill: C.ink });
      return svg(620, body);
    }
    case 'rebalance': {
      const o = d.operation, from = Math.min(d.balance[0]?.[0] ?? Date.parse(o.at), Date.parse(o.at)), to = Date.parse(d.at), cost = sat(o.feeMsat);
      const a: Panel = { x: PAD, y: 160, w: W - 2 * PAD - 120, h: 230, from, to, ...scale(Math.max(1, ...d.balance.map(p => p[1]))), format: v => compact(v) };
      const earned = d.fees.map(([t, v]) => [t, sat(v)] as Point);
      const b: Panel = { x: PAD, y: 470, w: W - 2 * PAD - 120, h: 230, from, to, ...scale(Math.max(cost, earned.at(-1)![1], 1) * 1.1), format: v => compact(v) };
      let body = header(`Ritorno del rebalance verso ${cleanAlias(o.target, 30)}`, `${thousands(o.amountSat)} sat da ${cleanAlias(o.source, 24)}, ${date(Date.parse(o.at))} · ${subtitleAt}`);
      body += frame(a, `Saldo locale di ${cleanAlias(o.target, 30)} (sat)`) + path(a, d.balance, C.s1, { area: true });
      const xo = sx(a, Date.parse(o.at)); body += line(xo, a.y, xo, a.y + a.h, C.axis) + text(xo + 6, a.y + 18, 'rebalance', { size: 15, fill: C.muted });
      body += frame(b, 'Commissioni guadagnate da allora in uscita su questo canale (sat), rispetto al costo') + line(b.x + 56, sy(b, cost), b.x + b.w, sy(b, cost), C.s2, 2) + text(b.x + b.w + 10, sy(b, cost) + 6, `costo ${compact(cost)}`, { size: 16, fill: C.ink });
      body += path(b, earned, C.s1, { step: true }) + text(b.x + b.w + 10, sy(b, earned.at(-1)![1]) + 6 + (Math.abs(sy(b, earned.at(-1)![1]) - sy(b, cost)) < 22 ? 22 : 0), compact(earned.at(-1)![1]), { size: 16, fill: C.ink });
      return svg(760, body);
    }
    case 'fee': {
      const from = Date.parse(d.from), to = Date.parse(d.at);
      const a: Panel = { x: PAD, y: 160, w: W - 2 * PAD - 100, h: 220, from, to, ...scale(Math.max(1, ...d.ppm.map(p => p[1])) * 1.1, true), format: v => String(Math.round(v)) };
      const b: Panel = { x: PAD, y: 460, w: W - 2 * PAD - 100, h: 200, from, to, ...scale(Math.max(1, ...d.daily.map(r => r.count)), true), format: v => String(Math.round(v)) };
      let body = header(`Fee e traffico di ${cleanAlias(d.alias, 34)}`, `Dal ${date(from)} · ${subtitleAt}`);
      body += frame(a, 'Fee in uscita (ppm)') + path(a, d.ppm, C.s1, { step: true });
      const lastPpm = d.ppm.at(-1); if (lastPpm) body += text(a.x + a.w + 10, sy(a, lastPpm[1]) + 6, `${lastPpm[1]} ppm`, { size: 16, fill: C.ink });
      body += frame(b, 'Inoltri in uscita al giorno');
      const slot = (b.w - 56) / Math.max(1, d.daily.length), cw = Math.min(24, slot - 2);
      d.daily.forEach((r, i) => { const x = b.x + 56 + i * slot + (slot - cw) / 2; body += vbar(x, b.y + b.h, cw, r.count / b.max * b.h, C.s1); });
      return svg(720, body);
    }
  }
}

// --- png and outbox --------------------------------------------------------

let ready: Promise<void> | undefined, fonts: Uint8Array[] | undefined;
/** Loads the WebAssembly rasterizer and the bundled DejaVu fonts once; no browser, no system fonts. */
export function chartsReady() {
  return ready ??= (async () => {
    const require = createRequire(import.meta.url);
    await initWasm(readFileSync(require.resolve('@resvg/resvg-wasm/index_bg.wasm')));
    fonts = ['DejaVuSans.ttf', 'DejaVuSans-Bold.ttf'].map(f => readFileSync(require.resolve('dejavu-fonts-ttf/ttf/' + f)));
  })();
}
export function chartPng(d: ChartData): Uint8Array {
  if (!fonts) throw Error('Chart renderer not initialized');
  const r = new Resvg(chartSvg(d), { font: { fontBuffers: fonts, defaultFontFamily: FONT, sansSerifFamily: FONT }, fitTo: { mode: 'original' }, background: C.surface });
  try { return r.render().asPng(); } finally { r.free(); }
}
/** Queues one chart on the owner's chat; the data is frozen with the outbox receipt. Idempotent by event id. */
export function enqueueChart(store: Store, eventId: string, d: ChartData, generation: unknown, at = now()) {
  return store.tx(() => {
    if ((store.get('telegramBinding')?.generation ?? null) !== generation) return false;
    const inserted = store.run("INSERT OR IGNORE INTO telegram_outbox(event_id,created_at,kind,text,generation) VALUES(?,?,?,?,?)", eventId, at, 'reply', chartCaption(d), generation);
    if (inserted.changes === 1) { store.set('telegramChart:' + eventId, d); store.set('telegramOutboxVersion:' + eventId, APP_VERSION); }
    return inserted.changes === 1;
  });
}
