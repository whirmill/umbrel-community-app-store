import { integer, type Proposal, type Snapshot, type Forecast } from './domain.js';
import { Store } from './store.js';

/** Calculated by trusted code, never accepted as an LLM supplied number. */
export function forecast(store:Store, p:Proposal, s:Snapshot):Forecast {
  const target=s.channels.find(c=>c.id===p.target), source=s.channels.find(c=>c.id===p.source);
  if(!target) throw new Error('Unknown target');
  const start=new Date(Date.parse(s.at)-30*86400_000).toISOString();
  let rows=store.all("SELECT * FROM events WHERE type='external_forward' AND source=? AND target=? AND occurred_at>=? AND occurred_at<=?",p.source,p.target,start,s.at);
  const snapshots=store.all('SELECT at,content FROM snapshots WHERE at>=? AND at<=? ORDER BY at',start,s.at).map(r=>JSON.parse(r.content) as Snapshot);
  const intervals:[string,string][]=[]; let hours=0; const days=new Set<string>();
  let hours7=0; const cut7=new Date(Date.parse(s.at)-7*86400_000).toISOString();
  // Only measured connected, sufficiently liquid, same-price intervals count.
  for(let i=1;i<snapshots.length;i++) {
    const a=snapshots[i-1]!,b=snapshots[i]!,dt=(Date.parse(b.at)-Date.parse(a.at))/3600_000;
    if(dt<=0 || dt>2/60 || !a.synced || !b.synced)continue;
    const ac=a.channels.find(c=>c.id===p.target),sc=a.channels.find(c=>c.id===p.source);
    if(!ac?.active || !sc?.active || ac.ppm!==target.ppm || ac.baseMsat!==target.baseMsat || integer(ac.localSat)<=integer(ac.reserveSat)+integer(ac.pendingSat) || integer(sc.remoteSat)===0n)continue;
    intervals.push([a.at,b.at]);hours+=dt;days.add(a.at.slice(0,10));if(a.at>=cut7)hours7+=dt;
  }
  rows=rows.filter(r=>intervals.some(([a,b])=>r.occurred_at>=a&&r.occurred_at<b));
  const eligible=hours>=48 && days.size>=2 && rows.length>=10;
  const volume=rows.reduce<bigint>((a,r)=>a+integer(r.amount_msat),0n);
  const volume7=rows.filter(r=>r.occurred_at>=cut7).reduce<bigint>((a,r)=>a+integer(r.amount_msat),0n);
  const rate30=hours>0?volume/BigInt(Math.max(1,Math.ceil(hours))):0n;
  const rate7=hours7>0?volume7/BigInt(Math.max(1,Math.ceil(hours7))):rate30;
  const q=(rate7<rate30?rate7:rate30)*720n/2n;
  const local=integer(target.localSat)-integer(target.reserveSat)-integer(target.pendingSat);
  const inbound=source?integer(source.remoteSat):0n;
  const baseline=(local<inbound?local:inbound)*1000n;
  const extraDemand=q>baseline?q-baseline:0n;
  const amount=integer(p.amountSat)*1000n;
  const incremental=extraDemand<amount?extraDemand:amount;
  // Base fees are not forecast as a guaranteed payment count.
  let benefit=incremental*BigInt(target.ppm)/1_000_000n;
  // Losing source outbound/target inbound can cannibalize other corridors.
  const competing=store.all("SELECT amount_msat,fee_msat FROM events WHERE type='external_forward' AND occurred_at>=? AND occurred_at<=? AND (source=? OR target=?)",start,s.at,p.target,p.source);
  const competingVolume=competing.reduce<bigint>((a,r)=>a+integer(r.amount_msat),0n);
  const competingFees=competing.reduce<bigint>((a,r)=>a+integer(r.fee_msat),0n);
  const lost=competingVolume?((amount<competingVolume?amount:competingVolume)*competingFees/competingVolume):0n;
  benefit=benefit>lost?benefit-lost:0n;
  if(p.kind==='fee_change') benefit=0n; // pricing changes are controlled experiments in M1.
  return {eligible,samples:rows.length,observedHours:Math.floor(hours*100)/100,observedDays:days.size,benefitMsat:benefit.toString(),requestedMsat:extraDemand.toString(),
    explanation:'v1: measured same-price/liquid hours; min(7d,30d) rate × 720h × 50%; no invented recirculation; subtract source-out/target-in opportunity. Forecast not realized revenue.'};
}

export function evaluate(store:Store, at=new Date().toISOString()) {
  for(const d of store.all("SELECT * FROM decisions WHERE status='observing'")) {
    const age=Date.parse(at)-Date.parse(d.at),p=JSON.parse(d.proposal) as Proposal;
    if(age<48*3600_000)continue;
    const holds=store.all('SELECT * FROM channel_holds WHERE at>=? AND channel_id IN (?,?)',d.at,p.source,p.target);
    const manual=store.all("SELECT id FROM events WHERE occurred_at>=? AND type IN ('manual_operation','manual_policy') AND (source IN (?,?) OR target IN (?,?))",d.at,p.source,p.target,p.source,p.target);
    const rows=store.all("SELECT * FROM events WHERE type='external_forward' AND occurred_at>=? AND occurred_at<=? AND source=? AND target=?",d.at,at,p.source,p.target);
    if(!manual.length && !holds.length && rows.length<10 && age<7*86400_000)continue;
    const fees=rows.reduce<bigint>((a,r)=>a+integer(r.fee_msat),0n);
    const costs=store.all("SELECT amount_msat FROM ledger WHERE operation_id IN (SELECT id FROM operations WHERE decision_id=?) AND classification='expense'",d.id).reduce<bigint>((a,r)=>a+integer(r.amount_msat),0n);
    const status=manual.length||holds.length?'confounded':rows.length<10?'inconclusive':fees>costs?'observed-positive':'observed-negative';
    store.tx(()=>{
      store.run('INSERT INTO evaluations VALUES(?,?,?,?,?)',d.id,d.id,at,status,JSON.stringify({version:1,samples:rows.length,observedCorridorFeesMsat:fees.toString(),costMsat:costs.toString(),causalProfitCertified:false,note:'Corridor contribution, not causal attribution. No overlap: one observing decision per corridor.'}));
      store.run("UPDATE decisions SET status='evaluated' WHERE id=?",d.id);
      if(status==='observed-negative' || status==='inconclusive') {
        store.run("INSERT INTO strategies VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET status=excluded.status,fingerprint=excluded.fingerprint,reason=excluded.reason",p.demandKey,'suspended',store.get<string>('fingerprint:'+d.id)??'',status);
      }
    });
  }
}
