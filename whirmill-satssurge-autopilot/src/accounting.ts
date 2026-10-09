import {integer} from './domain.js';
export function accountingPartition(rows:any[],annotations:any[]=[]){
 const sectors:Record<string,{revenueMsat:string;costMsat:string;netMsat:string;attribution:Record<string,{revenueMsat:string;costMsat:string}>}>=Object.fromEntries(['routing','swap','other','unknown'].map(k=>[k,{revenueMsat:'0',costMsat:'0',netMsat:'0',attribution:{verified:{revenueMsat:'0',costMsat:'0'},shared:{revenueMsat:'0',costMsat:'0'},unattributed:{revenueMsat:'0',costMsat:'0'}}}]));
 const latest=new Map<string,any>();for(const a of annotations)if(!latest.has(a.ledger_id)||latest.get(a.ledger_id).version<a.version)latest.set(a.ledger_id,a);
 for(const r of rows){
  if(!['revenue','expense'].includes(r.classification))continue;
  const d=JSON.parse(r.details??'{}'),annotation=latest.get(r.id);
  const scope=d.scope??d.evidence?.scope;
  const sector=annotation?.sector??(scope==='swap'||r.category==='swap'?'swap':r.category==='routing'||['ordinary','exploratory','manual_rebalance'].includes(r.category)||d.kind==='rebalance'?'routing':scope==='other'?'other':'unknown');
  const attribution=annotation?.attribution??(r.operation_id||r.evidence_id||r.category==='routing'?'verified':'unattributed');
  const bucket=sectors[sector]!,field=r.classification==='revenue'?'revenueMsat':'costMsat';
  bucket[field]=(integer(bucket[field])+integer(r.amount_msat)).toString();
  bucket.attribution[attribution]![field]=(integer(bucket.attribution[attribution]![field])+integer(r.amount_msat)).toString();
 }
 for(const bucket of Object.values(sectors))bucket.netMsat=(BigInt(bucket.revenueMsat)-BigInt(bucket.costMsat)).toString();
 const unassigned=BigInt(sectors.unknown!.costMsat)>0n||Object.values(sectors).some(s=>BigInt(s.attribution.unattributed!.costMsat)>0n||BigInt(s.attribution.shared!.costMsat)>0n);
 return {schema:1,sectors,unassignedCosts:unassigned,routingNetCertified:false,routingContributionMsat:unassigned?null:sectors.routing!.netMsat,note:'Exact partition of original ledger; attribution is receipt-based. Contribution is not causal profit.'};
}
