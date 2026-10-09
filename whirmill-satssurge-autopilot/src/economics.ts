import { integer, hash, json, type Proposal, type Snapshot, type Forecast } from './domain.js';
import { Store } from './store.js';

/** Calculated by trusted code, never accepted as an LLM supplied number. */
export function forecast(store:Store, p:Proposal, s:Snapshot):Forecast {
  const target=s.channels.find(c=>c.id===p.target), source=s.channels.find(c=>c.id===p.source);
  if(!target) throw new Error('Unknown target');
  const start=new Date(Date.parse(s.at)-30*86400_000).toISOString();
  let rows=store.all("SELECT * FROM events WHERE type='external_forward' AND source=? AND target=? AND occurred_at>=? AND occurred_at<=?",p.source,p.target,start,s.at);
  const snapshots=store.all('SELECT at,content FROM snapshots WHERE at>=? AND at<=? ORDER BY at',start,s.at).map(r=>JSON.parse(r.content) as Snapshot);
  const intervals:[string,string][]=[]; let hours=0,measuredMs=0,measured7Ms=0; const days=new Set<string>();
  let hours7=0; const cut7=new Date(Date.parse(s.at)-7*86400_000).toISOString();
  // Only measured connected, sufficiently liquid, same-price intervals count.
  for(let i=1;i<snapshots.length;i++) {
    const a=snapshots[i-1]!,b=snapshots[i]!,dt=(Date.parse(b.at)-Date.parse(a.at))/3600_000;
    if(dt<=0 || dt>2/60 || !a.synced || !b.synced)continue;
    const ac=a.channels.find(c=>c.id===p.target),sc=a.channels.find(c=>c.id===p.source),bc=b.channels.find(c=>c.id===p.target),bs=b.channels.find(c=>c.id===p.source);
    if(!bc?.active || !bs?.active || bc.ppm!==target.ppm || bc.baseMsat!==target.baseMsat || integer(bc.localSat)<=integer(bc.reserveSat)+integer(bc.pendingSat) || integer(bs.remoteSat)===0n || !ac?.active || !sc?.active || ac.ppm!==target.ppm || ac.baseMsat!==target.baseMsat || integer(ac.localSat)<=integer(ac.reserveSat)+integer(ac.pendingSat) || integer(sc.remoteSat)===0n)continue;
    intervals.push([a.at,b.at]);measuredMs+=Date.parse(b.at)-Date.parse(a.at);days.add(a.at.slice(0,10));if(a.at>=cut7)measured7Ms+=Date.parse(b.at)-Date.parse(a.at);
  }
  hours=measuredMs/3600000;hours7=measured7Ms/3600000;
  rows=rows.filter(r=>intervals.some(([a,b])=>r.occurred_at>=a&&r.occurred_at<b));
  const coverageComplete=!!store.one("SELECT id FROM coverage WHERE kind='LND forwards' AND complete=1 AND start<=? AND end>=?",start,s.at);
  const inputAvailability=!store.one("SELECT count FROM expired_intervals WHERE start<? AND end>=? AND (type='snapshot' OR (type='external_forward' AND source=? AND target=?))",s.at,start,p.source,p.target);
  const reasons=[...(!coverageComplete?['authoritative_coverage_unavailable']:[]),...(!inputAvailability?['relevant_inputs_expired']:[]),...(hours<48?['measured_hours_insufficient']:[]),...(days.size<2?['measured_days_insufficient']:[]),...(rows.length<10?['samples_insufficient']:[])];
  const eligible=reasons.length===0;
  const volume=rows.reduce<bigint>((a,r)=>a+integer(r.amount_msat),0n);
  const volume7=rows.filter(r=>r.occurred_at>=cut7).reduce<bigint>((a,r)=>a+integer(r.amount_msat),0n);
  const rate30=hours>0?volume/BigInt(Math.max(1,Math.ceil(hours))):0n;
  const rate7=hours7>0?volume7/BigInt(Math.max(1,Math.ceil(hours7))):rate30;
  const q=(rate7<rate30?rate7:rate30)*720n/2n;
  const local=integer(target.localSat)-integer(target.reserveSat)-integer(target.pendingSat);
  const inbound=source?integer(source.remoteSat):0n;
  const baseline=(local<inbound?local:inbound)*1000n;
  const rawDemand=q>baseline?q-baseline:0n;
  const extraDemand=integer(store.uncommittedDemand(p.source,p.target,rawDemand.toString(),s.at));
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
  return {reasons,coverageComplete,inputAvailability,rawRequestedMsat:rawDemand.toString(),eligible,samples:rows.length,observedHours:Math.floor(hours*100)/100,observedDays:days.size,benefitMsat:benefit.toString(),requestedMsat:extraDemand.toString(),
    version:2,baseline:{at:s.at,sourceInboundMsat:(inbound*1000n).toString(),targetOutboundMsat:(local*1000n).toString(),targetPpm:target.ppm,targetBaseMsat:target.baseMsat,rate7MsatPerHour:rate7.toString(),rate30MsatPerHour:rate30.toString(),conservativeDemand30Msat:q.toString(),opportunityCostMsat:lost.toString()},
    explanation:'v2: measured same-price/liquid hours; min(7d,30d) rate × 720h × 50%; no invented recirculation; subtract source-out/target-in opportunity. Forecast not realized revenue.'};
}

export function evaluate(store:Store, at=new Date().toISOString()) {
  for(const raw of store.all("SELECT * FROM decisions WHERE status='observing'")) {
    const d={...raw,decided_at:raw.at,at:completionAt(store,raw.id,raw.at)};
    const age=Date.parse(at)-Date.parse(d.at),p=JSON.parse(d.proposal) as Proposal;
    if(age<48*3600_000)continue;
    const holds=store.all('SELECT * FROM channel_holds WHERE at>=? AND channel_id IN (?,?)',d.at,p.source,p.target);
    const manual=store.all("SELECT id FROM events WHERE occurred_at>=? AND type IN ('manual_operation','manual_policy') AND (source IN (?,?) OR target IN (?,?))",d.at,p.source,p.target,p.source,p.target);
    const rows=p.kind==='fee_change'?store.all("SELECT * FROM events WHERE type='external_forward' AND occurred_at>=? AND occurred_at<=? AND target=?",d.at,at,p.target):store.all("SELECT * FROM events WHERE type='external_forward' AND occurred_at>=? AND occurred_at<=? AND source=? AND target=?",d.at,at,p.source,p.target);
    const price=p.kind==='fee_change'?priceComparison(store,d,p,JSON.parse(d.forecast),at,Math.min(7,age/86400000)):null;
    if(!manual.length && !holds.length && (rows.length<10||(p.kind==='fee_change'&&!price?.comparable)) && age<7*86400_000)continue;
    const fees=rows.reduce<bigint>((a,r)=>a+integer(r.fee_msat),0n);
    const costs=store.all("SELECT amount_msat FROM ledger WHERE operation_id IN (SELECT id FROM operations WHERE decision_id=?) AND classification='expense'",d.id).reduce<bigint>((a,r)=>a+integer(r.amount_msat),0n);
    const costComplete=store.one("SELECT count(*) n FROM ledger WHERE operation_id IN (SELECT id FROM operations WHERE decision_id=?) AND classification='expense'",d.id).n>0;
    const complete=costComplete&&!store.one("SELECT count FROM expired_intervals WHERE start<? AND end>=? AND type='external_forward'",at,d.at)&&!!store.one("SELECT id FROM coverage WHERE kind='LND forwards' AND complete=1 AND start<=? AND end>=?",d.at,at);
    const common=windowResult(store,d,p,JSON.parse(d.forecast),at,Math.min(7,age/86400000));
    const status=common.status;
    store.tx(()=>{
      store.run('INSERT INTO evaluations VALUES(?,?,?,?,?)',d.id,d.id,at,status,json({...common,calculation:'initial-and-window-common-v3'}));
      store.run("UPDATE decisions SET status='evaluated' WHERE id=?",d.id);
      if(status==='observed-negative' || status==='inconclusive') {
        store.run("INSERT INTO strategies VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET status=excluded.status,fingerprint=excluded.fingerprint,reason=excluded.reason",p.demandKey,'suspended',store.get<string>('fingerprint:'+d.id)??'',status);
      }
    });
  }
  evaluateWindows(store,at);
}


/** Immutable snapshots of 7/30-day comparisons. Missing coverage never certifies a result. */
export function evaluateWindows(store:Store,at=new Date().toISOString()) {
  const successful=store.all("SELECT DISTINCT d.* FROM decisions d JOIN operations o ON o.decision_id=d.id WHERE o.state='SUCCEEDED'");
  for(const raw of successful){
    const d={...raw,decided_at:raw.at,at:completionAt(store,raw.id,raw.at)};
    const p=JSON.parse(d.proposal) as Proposal,original=JSON.parse(d.forecast) as Forecast;
    for(const horizon of [7,30]){
      const end=new Date(Date.parse(d.at)+horizon*86400000).toISOString();if(end>at)continue;
      // Once published, a comparison stays immutable. Late data/corrections need an explicit revision.
      if(store.one('SELECT id FROM evaluation_windows WHERE decision_id=? AND horizon_days=?',d.id,horizon))continue;
      const result=windowResult(store,d,p,original,end,horizon);
      store.tx(()=>{
        store.run('INSERT INTO evaluation_windows VALUES(?,?,?,?,?,?,?)',d.id+':'+horizon+':1',d.id,horizon,1,at,result.status,json(result));
        if(result.status==='observed-negative'||(horizon===7&&result.status==='inconclusive'))store.run("INSERT INTO strategies VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET status=excluded.status,fingerprint=excluded.fingerprint,reason=excluded.reason",p.demandKey,'suspended',store.get<string>('fingerprint:'+d.id)??'','window-'+horizon+':'+result.status);
      });
    }
  }
}
function windowResult(store:Store,d:any,p:Proposal,original:Forecast,end:string,horizon:number){
  const scope=p.kind==='fee_change'?"target=?":"source=? AND target=?",args=p.kind==='fee_change'?[p.target]:[p.source,p.target];
  const events=store.all("SELECT * FROM events WHERE type='external_forward' AND occurred_at>=? AND occurred_at<? AND "+scope,d.at,end,...args);
  const coverage=store.all("SELECT * FROM coverage WHERE kind='LND forwards' AND complete=1 AND start<=? AND end>=?",d.at,end);
  const manual=store.all("SELECT id FROM events WHERE (occurred_at>=? OR (json_extract(details,'$.settlementUncertain')=1 AND acquired_at>=?)) AND occurred_at<? AND type IN ('manual_operation','manual_policy') AND (source IN (?,?) OR target IN (?,?) OR EXISTS(SELECT 1 FROM json_each(events.details,'$.affectedChannels') c WHERE c.value IN (?,?)))",d.at,d.at,end,p.source,p.target,p.source,p.target,p.source,p.target);
  const overlaps=store.all("SELECT id,at FROM decisions WHERE EXISTS (SELECT 1 FROM operations o WHERE o.decision_id=decisions.id AND o.state IN ('SUCCEEDED','sending','uncertain','in_flight')) AND id<>? AND at<? AND (json_extract(proposal,'$.source') IN (?,?) OR json_extract(proposal,'$.target') IN (?,?)) AND status<>'failed'",d.id,end,p.source,p.target,p.source,p.target)
    .map(r=>({...r,effectiveAt:completionAt(store,r.id,r.at)}))
    .filter(r=>r.effectiveAt<end&&Date.parse(r.effectiveAt)+30*86400000>Date.parse(d.at));
  const holds=store.all('SELECT channel_id,at,reason FROM channel_holds WHERE at>=? AND at<? AND channel_id IN (?,?)',d.at,end,p.source,p.target);
  const fees=events.reduce<bigint>((a,r)=>a+integer(r.fee_msat),0n),volume=events.reduce<bigint>((a,r)=>a+integer(r.amount_msat),0n);
  const costRows=store.all("SELECT * FROM ledger WHERE classification='expense' AND operation_id IN (SELECT id FROM operations WHERE decision_id=?)",d.id);
  const costs=costRows.reduce<bigint>((a,r)=>a+integer(r.amount_msat),0n);
  const net=fees-costs;
  const price=p.kind==='fee_change'?priceComparison(store,d,p,original,end,horizon):null;
  const inputAvailability=!store.one("SELECT count FROM expired_intervals WHERE type IN ('external_forward','snapshot') AND start<? AND end>=?",end,d.at);
  const status=manual.length||overlaps.length||holds.length?'confounded':!inputAvailability||!coverage.length||events.length<10||!costRows.length||(price&&!price.comparable)?'inconclusive':price?(BigInt(price.afterFeeRateMsatPerHour!)>BigInt(price.beforeFeeRateMsatPerHour!)?'observed-positive':'observed-negative'):net>0n?'observed-positive':'observed-negative';
  let modelComparison:any=null;
  if(p.kind==='rebalance'&&original.eligible&&original.baseline&&inputAvailability&&costRows.length&&coverage.length&&events.length>=10&&!manual.length&&!overlaps.length&&!holds.length){
    const b=original.baseline,baseline=integer(b.sourceInboundMsat)<integer(b.targetOutboundMsat)?integer(b.sourceInboundMsat):integer(b.targetOutboundMsat);
    const projected=integer(b.conservativeDemand30Msat)*BigInt(Math.max(0,Date.parse(end)-Date.parse(d.at)))/BigInt(30*86400000);
    const incremental=projected>baseline?projected-baseline:0n,amount=integer(p.amountSat)*1000n;
    const expectedGross=(incremental<amount?incremental:amount)*BigInt(b.targetPpm)/1000000n;
    const noInterventionVolume=volume<baseline?volume:baseline;
    const conditionalIncrement=fees-noInterventionVolume*BigInt(b.targetPpm)/1000000n;
    modelComparison={kind:'conditional finite-inventory model comparison',expectedIncrementalGrossMsat:expectedGross.toString(),conditionalObservedIncrementalGrossMsat:conditionalIncrement.toString(),errorMsat:(conditionalIncrement-expectedGross).toString(),verifiedCausalError:false,assumption:'Counterfactual consumes initial inventory once, excludes unobserved return flows and source opportunity changes; not proof of causal profit'};
  }
  const snapRows=store.all('SELECT at,content FROM snapshots WHERE at>=? AND at<? ORDER BY at',d.at,end);
  const inventory=snapRows.map(r=>{const s=JSON.parse(r.content) as Snapshot;return {at:r.at,source:s.channels.find(c=>c.id===p.source),target:s.channels.find(c=>c.id===p.target)};});
  let depleted=0,measured=0;
  for(let i=1;i<inventory.length;i++){
    const prev=inventory[i-1]!,next=inventory[i]!,dt=Date.parse(next.at)-Date.parse(prev.at);if(dt<=0||dt>120000||!prev.target?.active)continue;
    measured+=dt;if(integer(prev.target.localSat)<=integer(prev.target.reserveSat)+integer(prev.target.pendingSat)||(prev.source&&integer(prev.source.remoteSat)===0n))depleted+=dt;
  }
  return {version:2,status,horizonDays:horizon,decisionCreatedAt:d.decided_at??d.at,start:d.at,end,originalForecast:original,forecastDigest:hash(d.forecast),
    samples:events.length,observedCorridorFeesMsat:coverage.length&&inputAvailability?fees.toString():null,observedVolumeMsat:coverage.length&&inputAvailability?volume.toString():null,
    costMsat:costRows.length?costs.toString():null,observedContributionMsat:inputAvailability&&coverage.length&&costRows.length?net.toString():null,
    inputAvailability,reproducible:inputAvailability,directOperationCostComplete:costRows.length>0,coverageComplete:!!coverage.length&&inputAvailability,costCoverageComplete:store.get('historicalCoverageComplete')===true,
    manualEventIds:manual.map(r=>r.id),channelHolds:holds,overlappingDecisionIds:overlaps.map(r=>r.id),modelComparison,
    priceComparison:price,
    measuredInventoryHours:measured/3600000,depletedInventoryHours:depleted/3600000,causalProfitCertified:false,
    reproduction:{calculation:'window-v2',eventIds:events.map(r=>r.id),ledgerIds:costRows.map(r=>r.id),snapshotCount:snapRows.length,eventDetailRetentionDays:90},
    note:'Observed contribution is not incremental causal profit. Predictions remain unchanged; absence of complete coverage is not zero.'};
}


export function reviseEvaluation(store:Store,decisionId:string,horizon:7|30,reason:string,at=new Date().toISOString()) {
  if(!reason.trim())throw new Error('Correction reason required');
  return store.tx(()=>{
    const raw=store.one('SELECT * FROM decisions WHERE id=?',decisionId);if(!raw)throw new Error('Unknown decision');const d={...raw,decided_at:raw.at,at:completionAt(store,raw.id,raw.at)};
    const old=store.one('SELECT * FROM evaluation_windows WHERE decision_id=? AND horizon_days=? ORDER BY revision DESC LIMIT 1',decisionId,horizon);if(!old)throw new Error('Original evaluation required');
    const end=new Date(Date.parse(d.at)+horizon*86400000).toISOString();if(end>at)throw new Error('Observation horizon incomplete');
    const result={...windowResult(store,d,JSON.parse(d.proposal),JSON.parse(d.forecast),end,horizon),correction:{reason,supersedes:old.id}};
    const revision=old.revision+1,key=d.id+':'+horizon+':'+revision;
    store.run('INSERT INTO evaluation_windows VALUES(?,?,?,?,?,?,?)',key,decisionId,horizon,revision,at,result.status,json(result));return key;
  });
}


function priceComparison(store:Store,d:any,p:Proposal,f:Forecast,end:string,horizon:number){
  const beforeStart=new Date(Date.parse(d.at)-horizon*86400000).toISOString();
  function sample(start:string,end:string,ppm:number|undefined,base:string|undefined){
    const raw=store.all('SELECT at,content FROM snapshots WHERE at>=? AND at<=? ORDER BY at',start,end);
    const intervals:[string,string][]=[];let duration=0;const days=new Set<string>();
    for(let i=1;i<raw.length;i++){
      const a=JSON.parse(raw[i-1].content) as Snapshot,b=JSON.parse(raw[i].content) as Snapshot;
      const c=a.channels.find(x=>x.id===p.target),next=b.channels.find(x=>x.id===p.target),dt=Date.parse(b.at)-Date.parse(a.at);
      if(dt<=0||dt>120000||!a.synced||!b.synced||!c?.active||!next?.active||c.ppm!==ppm||next.ppm!==ppm||c.baseMsat!==base||next.baseMsat!==base||integer(c.localSat)<=integer(c.reserveSat)+integer(c.pendingSat)||integer(next.localSat)<=integer(next.reserveSat)+integer(next.pendingSat))continue;
      intervals.push([a.at,b.at]);duration+=dt;days.add(a.at.slice(0,10));
    }
    const rows=store.all("SELECT * FROM events WHERE type='external_forward' AND target=? AND occurred_at>=? AND occurred_at<?",p.target,start,end).filter(r=>intervals.some(([a,b])=>r.occurred_at>=a&&r.occurred_at<b));
    const fee=rows.reduce<bigint>((n,r)=>n+integer(r.fee_msat),0n),volume=rows.reduce<bigint>((n,r)=>n+integer(r.amount_msat),0n);
    const covered=!!store.one("SELECT id FROM coverage WHERE kind='LND forwards' AND complete=1 AND start<=? AND end>=?",start,end);
    const inputAvailability=!store.one("SELECT count FROM expired_intervals WHERE type IN ('snapshot','external_forward') AND start<? AND end>=?",end,start);
    const qualified=inputAvailability&&duration>=48*3600000&&days.size>=2&&rows.length>=10&&covered;
    return {qualified,inputAvailability,samples:rows.length,hours:duration/3600000,days:days.size,ppm:ppm??null,baseMsat:base??null,feeMsat:covered?fee.toString():null,volumeMsat:covered?volume.toString():null,feeRateMsatPerHour:qualified?(fee*3600000n/BigInt(duration)).toString():null,coverageComplete:covered};
  }
  const before=sample(beforeStart,d.at,f.baseline?.targetPpm,f.baseline?.targetBaseMsat),after=sample(d.at,end,p.newPpm,f.baseline?.targetBaseMsat);
  return {before,after,comparable:before.qualified&&after.qualified,beforeFeeRateMsatPerHour:before.feeRateMsatPerHour,afterFeeRateMsatPerHour:after.feeRateMsatPerHour,causalProfitCertified:false,note:'Qualified same-price active/liquid observation intervals; demand, incoming composition and source liquidity remain possible confounders. Negative observed performance suspends retries, not a causal price claim.'};
}


function completionAt(store:Store,decisionId:string,fallback:string):string {
  const row=store.one("SELECT max(COALESCE(json_extract(o.details,'$.completedAt'),(SELECT max(l.at) FROM ledger l WHERE l.operation_id=o.id AND l.classification='expense'))) at FROM operations o WHERE o.decision_id=? AND o.state='SUCCEEDED'",decisionId);
  return row?.at??fallback;
}
