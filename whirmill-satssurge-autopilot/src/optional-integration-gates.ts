import type { OptionalGates } from './optional-integration-control.js';
/** Read-only projection of orchestrator-owned acceptance references, never request/model input.
 * Hash syntax does not verify referenced evidence; root must verify before seeding these records.
 */
export function optionalRoadmapGates(input: unknown): OptionalGates {
  const blocked = { core: false, m24: false, m3: false, m4: false };
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return blocked;
    const o = input as Record<string, unknown>;
    if (!Object.hasOwn(o, 'version') || o.version !== 1) return blocked;
    let previous = -Infinity;
    for (const stage of ['core', 'm24', 'm3', 'm4']) {
      if (!Object.hasOwn(o, stage)) return blocked;
      const r = o[stage] as Record<string, unknown>;
      if (!r || typeof r !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(r)) || !Object.hasOwn(r, 'accepted') || r.accepted !== true || !Object.hasOwn(r, 'proofSha256') || typeof r.proofSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(r.proofSha256) || !Object.hasOwn(r, 'acceptedAt') || typeof r.acceptedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(r.acceptedAt)) return blocked;
      const at = Date.parse(r.acceptedAt);
      if (!Number.isFinite(at)) return blocked;
      const normalized = r.acceptedAt.replace(/(?:\.(\d{1,3}))?Z$/, (_match, fraction: string | undefined) => '.' + (fraction ?? '').padEnd(3, '0') + 'Z');
      if (new Date(at).toISOString() !== normalized || at < previous || at > Date.now()) return blocked;
      previous = at;
    }
    return { core: true, m24: true, m3: true, m4: true };
  } catch { return blocked; }
}
