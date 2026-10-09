import { sats } from "./ui-client.js";
/** Exact integer inputs; approximation is confined to bounded drawing coordinates. */
export function chartInteger(value: unknown): bigint | null {
  if (typeof value === "number" && !Number.isSafeInteger(value)) return null;
  if (
    !["string", "number", "bigint"].includes(typeof value) ||
    !/^-?\d+$/.test(String(value))
  )
    return null;
  try {
    return BigInt(String(value));
  } catch {
    return null;
  }
}
export function satLabel(value: unknown, msat = true): string {
  const n = chartInteger(value);
  return n === null
    ? "Non disponibile"
    : (msat
        ? sats(n)
        : new Intl.NumberFormat("it-IT", { useGrouping: "always" }).format(n)) +
        " sat";
}
export function percentOf(value: unknown, total: unknown): number | null {
  const n = chartInteger(value),
    d = chartInteger(total);
  if (n === null || d === null || n < 0n || d <= 0n) return null;
  return Number(((n > d ? d : n) * 10000n) / d) / 100;
}
export function percentageLabel(value: unknown, total: unknown): string {
  const n = chartInteger(value),
    d = chartInteger(total);
  if (n === null || d === null || n < 0n || d <= 0n) return "Non disponibile";
  const hundredths = (n * 10000n) / d;
  return `${hundredths / 100n},${(hundredths % 100n).toString().padStart(2, "0")}%`;
}
export function liquidityData(channels: any[] = []) {
  let local = 0n,
    remote = 0n,
    unknown = 0;
  const rows = channels.map((c, index) => {
    const l = chartInteger(c.localSat),
      r = chartInteger(c.remoteSat),
      known = l !== null && r !== null && l >= 0n && r >= 0n;
    const total = known ? l + r : null;
    if (known) {
      local += l;
      remote += r;
    } else unknown++;
    return {
      id: String(c.id ?? index),
      alias: String(c.alias ?? "Canale"),
      active: c.active === true,
      local: known ? l : null,
      remote: known ? r : null,
      total,
      localPercent: total === null ? null : percentOf(l, total),
      remotePercent: total === null ? null : percentOf(r, total),
      ppm: c.ppm,
      baseMsat: c.baseMsat,
      capacitySat: c.capacitySat,
      reserveSat: c.reserveSat,
      pendingSat: c.pendingSat,
    };
  });
  return {
    local,
    remote,
    total: local + remote,
    unknown,
    rows,
    active: rows.filter((r) => r.active).length,
  };
}
export function comparisonScale(values: unknown[]) {
  const known = values
    .map(chartInteger)
    .filter((v): v is bigint => v !== null && v >= 0n);
  const max = known.reduce((a, b) => (b > a ? b : a), 0n);
  return values.map((v) => ({
    value: chartInteger(v),
    percent: percentOf(v, max) ?? 0,
    known: chartInteger(v) !== null && chartInteger(v)! >= 0n,
  }));
}
export function queueDistribution(
  states: { state: string; count: unknown }[] = [],
) {
  const rows = states
    .map((s) => ({ ...s, count: chartInteger(s.count) }))
    .filter(
      (s): s is { state: string; count: bigint } =>
        s.count !== null && s.count >= 0n,
    );
  const total = rows.reduce((n, s) => n + s.count, 0n);
  return {
    total,
    rows: rows.map((s) => ({ ...s, percent: percentOf(s.count, total) ?? 0 })),
    unknown: states.length - rows.length,
  };
}
export function financialTone(value: unknown) {
  const n = chartInteger(value);
  return n === null ? "neutral" : n < 0n ? "danger" : "success";
}
