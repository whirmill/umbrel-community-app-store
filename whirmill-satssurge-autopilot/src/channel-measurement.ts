import type { Store } from './store.js';
import type { ChannelRpc } from './lnd.js';
import { now, integer, type Snapshot, type Channel } from './domain.js';

/** A channel whose local share is below this is treated as depleted (remote-heavy) for candidate route-back checks. */
export const DEPLETED_LOCAL_SHARE = 0.2;
const PAGE = 25, ROUTES_BACK = 20, WINDOW_MS = 30 * 86400_000;
const ratio = (n: number) => Math.round(n * 10000) / 10000;
const share = (c: Channel) => { const capacity = Number(c.capacitySat); return capacity > 0 ? Number(c.localSat) / capacity : NaN; };

/**
 * Read-only 30-day measurement per current channel. Aggregation runs inside SQLite (json_each over the
 * minute snapshots), so production-size history is never materialised in JS. Missing coverage is
 * reported as 'unknown' and never as zero.
 */
export function channelPerformance(store: Store, at = now(), offset = 0) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid page offset');
  const s = store.get<Snapshot>('snapshot');
  if (!s) return { available: false, reason: 'Snapshot unavailable; unknown is not zero', rows: null };
  const start = new Date(Date.parse(at) - WINDOW_MS).toISOString();
  const coverage = store.one("SELECT start,end FROM coverage WHERE kind='LND forwards' AND complete=1 ORDER BY end DESC LIMIT 1");
  const forwardsExpired = !!store.one("SELECT 1 FROM expired_intervals WHERE type='external_forward' AND end>=? LIMIT 1", start);
  const forwardsComplete = !!coverage && coverage.start <= start && Date.parse(coverage.end) >= Date.parse(at) - 10 * 60000 && !forwardsExpired;
  const sum = (sql: string) => new Map(store.all(sql, start, at).map(r => [String(r.channel), r]));
  const outgoing = sum("SELECT target channel,count(*) n,sum(CAST(amount_msat AS INTEGER)) amount,sum(CAST(fee_msat AS INTEGER)) fee FROM events WHERE type='external_forward' AND occurred_at>=? AND occurred_at<=? GROUP BY target");
  const incoming = sum("SELECT source channel,count(*) n,sum(CAST(amount_msat AS INTEGER)) amount,sum(CAST(fee_msat AS INTEGER)) fee FROM events WHERE type='external_forward' AND occurred_at>=? AND occurred_at<=? GROUP BY source");
  const samples = sum(`WITH c AS (SELECT s.at at,json_extract(j.value,'$.id') channel,json_extract(j.value,'$.active') active,
      CAST(json_extract(j.value,'$.localSat') AS REAL)/NULLIF(CAST(json_extract(j.value,'$.capacitySat') AS REAL),0) share
      FROM snapshots s,json_each(s.content,'$.channels') j WHERE s.at>=? AND s.at<=?),
    f AS (SELECT *,CASE WHEN active<>lag(active) OVER (PARTITION BY channel ORDER BY at) THEN 1 ELSE 0 END flip FROM c)
    SELECT channel,count(*) n,min(share) lo,avg(share) mean,max(share) hi,sum(active) up,sum(flip) flips,min(at) first FROM f GROUP BY channel`);
  const snapshotCount = Number(store.one('SELECT count(*) n FROM snapshots WHERE at>=? AND at<=?', start, at).n);
  const snapshotsExpired = !!store.one("SELECT 1 FROM expired_intervals WHERE type='snapshot' AND end>=? LIMIT 1", start);
  const rebalances = new Map<string, { asSource: Record<string, number>; asTarget: Record<string, number> }>();
  const count = (channel: string, side: 'asSource' | 'asTarget', key: string) => {
    const r = rebalances.get(channel) ?? { asSource: { autopilotSucceeded: 0, autopilotAttempts: 0, manual: 0 }, asTarget: { autopilotSucceeded: 0, autopilotAttempts: 0, manual: 0 } };
    r[side][key] = (r[side][key] ?? 0) + 1; rebalances.set(channel, r);
  };
  for (const r of store.all("SELECT json_extract(d.proposal,'$.source') source,json_extract(d.proposal,'$.target') target,o.state FROM operations o JOIN decisions d ON d.id=o.decision_id WHERE json_extract(d.proposal,'$.kind')='rebalance' AND o.at>=? AND o.at<=?", start, at)) {
    for (const [channel, side] of [[r.source, 'asSource'], [r.target, 'asTarget']] as const) { count(String(channel), side, 'autopilotAttempts'); if (r.state === 'SUCCEEDED') count(String(channel), side, 'autopilotSucceeded'); }
  }
  for (const r of store.all("SELECT source,target FROM events WHERE type='manual_operation' AND occurred_at>=? AND occurred_at<=?", start, at)) { count(String(r.source), 'asSource', 'manual'); count(String(r.target), 'asTarget', 'manual'); }
  const rows = s.channels.slice().sort((a, b) => a.id.localeCompare(b.id)).map(c => {
    const o = outgoing.get(c.id), i = incoming.get(c.id), m = samples.get(c.id), capacity = integer(c.capacitySat);
    const forwards = { in: { count: Number(i?.n ?? 0), amountMsat: String(i?.amount ?? 0) }, out: { count: Number(o?.n ?? 0), amountMsat: String(o?.amount ?? 0) }, feesEarnedMsat: String(o?.fee ?? 0) };
    const volumeSat = (integer(String(i?.amount ?? 0)) + integer(String(o?.amount ?? 0))) / 1000n;
    return {
      channel: c.id, alias: c.alias, peer: c.peer, capacitySat: c.capacitySat, activeNow: c.active, localShareNow: ratio(share(c)),
      // Forward and fee figures are exact only with complete coverage; otherwise only an observed lower bound is given.
      forwards: forwardsComplete ? forwards : 'unknown', ...(forwardsComplete ? {} : { observedForwardsLowerBound: forwards }),
      utilisation: forwardsComplete && capacity > 0n ? ratio(Number(volumeSat) / Number(capacity)) : 'unknown',
      localShare: m && m.lo !== null ? { samples: Number(m.n), min: ratio(m.lo), avg: ratio(m.mean), max: ratio(m.hi), current: ratio(share(c)), firstSampleAt: m.first } : 'unknown',
      activity: m ? { samples: Number(m.n), activeSamples: Number(m.up), activeShare: ratio(Number(m.up) / Number(m.n)), transitions: Number(m.flips), firstSampleAt: m.first } : 'unknown',
      rebalances: rebalances.get(c.id) ?? { asSource: { autopilotSucceeded: 0, autopilotAttempts: 0, manual: 0 }, asTarget: { autopilotSucceeded: 0, autopilotAttempts: 0, manual: 0 } },
    };
  });
  const page = rows.slice(offset, offset + PAGE);
  return {
    available: true, window: { start, end: at }, total: rows.length, offset, nextOffset: offset + PAGE < rows.length ? offset + PAGE : null, rows: page,
    coverage: {
      forwards: forwardsComplete ? 'complete' : 'incomplete', forwardsCoveredUntil: coverage?.end ?? null,
      snapshots: { samples: snapshotCount, expectedAtOnePerMinute: Math.floor(WINDOW_MS / 60000), retentionGap: snapshotsExpired },
      rebalances: 'Autopilot operations plus circular LND payments observed by the collector; other tools are counted only when they settle through LND payments.',
    },
    notes: ['Local share and active figures are sample statistics over retained snapshots, not time-weighted.', 'Utilisation is forwarded volume in plus out over 30 days divided by capacity.', 'Channels closed during the window are not listed.'],
  };
}

/** Candidate peer from GetNodeInfo with channels: capacity, fee policy and direct adjacency to the peers of our depleted channels. */
export async function channelCandidate(store: Store, rpc: ChannelRpc, peer: string) {
  const s = store.get<Snapshot>('snapshot');
  if (!s) return { available: false, reason: 'Snapshot unavailable' };
  const g = await rpc.nodeGraph(peer);
  const depleted = s.channels.filter(c => share(c) < DEPLETED_LOCAL_SHARE).sort((a, b) => share(a) - share(b));
  const ppm = g.edges.map(e => e.outgoing).filter(p => p && !p.disabled).map(p => p!.ppm).sort((a, b) => a - b);
  return {
    available: true, peer, alias: g.alias, channels: g.channels, capacitySat: g.capacitySat, edgesRead: g.edges.length, edgesTruncated: g.truncated,
    existingChannelWithUs: s.channels.some(c => c.peer === peer),
    feePolicy: ppm.length ? { enabledOutgoingEdges: ppm.length, outgoingPpm: { min: ppm[0], median: ppm[Math.floor(ppm.length / 2)], max: ppm.at(-1) } } : 'unknown',
    depletedThreshold: DEPLETED_LOCAL_SHARE,
    routesBack: depleted.slice(0, ROUTES_BACK).map(c => {
      const edges = g.edges.filter(e => e.peer === c.peer);
      return {
        channel: c.id, alias: c.alias, peer: c.peer, localShare: ratio(share(c)),
        // A truncated edge list cannot prove absence.
        directChannels: edges.length || !g.truncated ? edges.length : 'unknown',
        capacitySat: edges.reduce((n, e) => n + integer(e.capacitySat), 0n).toString(),
        candidateToPeerPpm: edges.map(e => e.outgoing).filter(p => p && !p.disabled).map(p => p!.ppm).sort((a, b) => a - b)[0] ?? null,
        peerToCandidatePpm: edges.map(e => e.incoming).filter(p => p && !p.disabled).map(p => p!.ppm).sort((a, b) => a - b)[0] ?? null,
      };
    }),
    depletedTruncated: depleted.length > ROUTES_BACK,
    note: 'Direct graph adjacency from public gossip only; it does not prove liquidity, uptime or route success.',
  };
}
