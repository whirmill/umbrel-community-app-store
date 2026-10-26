import {APP_VERSION} from './version.js';
import {safeLndFailureContext} from './lnd.js';
import {hash,json,scrub} from './domain.js';

// Smaller than the harness output window. Pagination never silently omits rows.
export const STATE_PAGE_BYTES=12000;
export const STATE_SECTIONS=['channels','competition','competition_alternatives','diagnostics','decisions','operations','evaluations','evaluationWindows','coverage','claims','holds','corridor_events','manual_events','policy_events','canonical_history'] as const;
export type StateSection=typeof STATE_SECTIONS[number];
export interface StatePageQuery {section:StateSection;offset?:number;version?:string;provider?:'lndg'|'lightningMate'|'native';collection?:'forwards'|'failures'|'failureRollups'|'rebalances'|'paymentAttempts'|'policies';channel?:string;}
function providerSummary(p:any){if(!p)return null;const {forwards,failures,failureRollups,rebalances,paymentAttempts,policies,...meta}=p;return {...meta,counts:{forwards:forwards?.length??null,failures:failures?.length??null,failureRollups:failureRollups?.length??null,rebalances:rebalances?.length??null,paymentAttempts:paymentAttempts?.length??null,policies:policies?.length??null}};}
function competitionRows(s:any){return (s.competition?.channels??[]).map((c:any)=>{const {alternatives,...meta}=c;return {...meta,availableAlternativeRows:alternatives?.length??null};});}
/** Evidence rows imported before the app (historical:) describe that time, never current state or current work. */
export function datedEvidence(rows:{source:string;acquired_at:string}[]){
  return rows.map(r=>r.source.startsWith('historical:')?{...r,note:'Documento storico importato il '+r.acquired_at.slice(0,10)+': descrive quel momento, non lo stato attuale né il lavoro in corso.'}:r);
}
export function stateSummary(s:any){
  const {diagnostics,competition,snapshot,operations,decisions,evaluations,evaluationWindows,coverage,claims,holds}=s;
  return scrub({app:{name:'SatsSurge Autopilot',version:APP_VERSION},appControlProof:s.appControlProof??null,operationalReadiness:s.operationalReadiness??null,enabled:s.enabled,bootstrapReady:s.bootstrapReady,blockers:s.blockers,mandate:s.mandate,budget:s.budget,pnl30:s.pnl30,cumulative:s.cumulative,accounting30:s.accounting30?{sectors:Object.fromEntries(Object.entries(s.accounting30.sectors??{}).map(([k,v]:[string,any])=>[k,{revenueMsat:v.revenueMsat,costMsat:v.costMsat,netMsat:v.netMsat}])),unassignedCosts:s.accounting30.unassignedCosts,note:'pnl30 is the gross ledger total. Judge routing by sectors.routing: owner-classified startup, capital and swap activity is in other/swap.'}:null,partial:s.partial,
    autonomousReviews:s.autonomousReviews?{reviews:s.autonomousReviews,note:'Latest autopilot reviews run by the scheduler (coordinator and analyst lanes), newest first; summary is the start of each answer. Observation-only cycles leave no decisions row, so explain past autopilot behavior from these.'}:null,
    channelMandate:s.channelMandate??null,channelOperations:(s.channelOperations??[]).map((o:any)=>({id:o.id,kind:o.kind,at:o.at,state:o.state,peer:o.peer,channel:o.channel??null,amountSat:o.amountSat,maxFeeSat:o.maxFeeSat,feeChargedSat:o.feeChargedSat,reason:o.reason??null})),
    agent:s.agent?{at:s.agent.at,status:s.agent.status,model:s.agent.model,thinkingLevel:s.agent.thinkingLevel,until:s.agent.until}:null,
    importReport:s.importReport?{at:s.importReport.at,fileCount:s.importReport.files?.length??null,ledgerEntriesRead:s.importReport.ledgerEntriesRead,problemCount:s.importReport.problems?.length??null,coverageComplete:s.importReport.coverageComplete,note:s.importReport.note}:null,
    // Persisted inspection time is independent of snapshot time and does not attest current health.
    lndTransport:s.lndTransport?{transport:s.lndTransport.transport??null,warning:s.lndTransport.warning??null,failure:s.lndTransport.failure??null,...(safeLndFailureContext(s.lndTransport.failureContext)?{failureContext:safeLndFailureContext(s.lndTransport.failureContext)}:{}),inspectedAt:s.lndTransport.inspectedAt??null,certificateDigest:s.lndTransport.certificateDigest??null,validFrom:s.lndTransport.validFrom??null,validTo:s.lndTransport.validTo??null}:null,
    snapshot:snapshot?{at:snapshot.at,identity:snapshot.identity,synced:snapshot.synced,confirmedSat:snapshot.confirmedSat,channelCount:snapshot.channels.length}:null,
    diagnostics:diagnostics?{at:diagnostics.at,lndg:providerSummary(diagnostics.lndg),lightningMate:providerSummary(diagnostics.lightningMate),native:providerSummary(diagnostics.native)}:null,
    competition:competition?{status:competition.status,at:competition.at,capturedAt:competition.capturedAt,coverage:competition.coverage,reason:competition.reason,channelCount:competition.channels?.length??null}:null,
    counts:{operations:operations?.length??null,decisions:decisions?.length??null,evaluations:evaluations?.length??null,evaluationWindows:evaluationWindows?.length??null,coverage:coverage?.length??null,claims:claims?.length??null,holds:holds?.length??null},
    detailAccess:{tool:'state_page (same analyst suffix as node_state)',sections:STATE_SECTIONS,diagnosticProviders:['lndg','lightningMate','native'],diagnosticCollections:['forwards','failures','failureRollups','rebalances','paymentAttempts','policies'],note:'Use nextCall with its full saved query, immutable cursor and nextOffset. A changed or expired view requires explicit reopening; it is never a completed section. Counts describe the retained projection, not full historical coverage.'}});
}
export function statePage(s:any,q:StatePageQuery){
  if(!STATE_SECTIONS.includes(q.section))throw new Error('Unknown state section');
  const offset=q.offset??0;if(!Number.isSafeInteger(offset)||offset<0)throw new Error('Invalid page offset');
  let rows:any[]|undefined,metadata:any={};
  if(q.section==='channels'){rows=s.snapshot?.channels;metadata={at:s.snapshot?.at,synced:s.snapshot?.synced};}
  else if(q.section==='competition'){rows=s.competition?.status==='qualified'&&Array.isArray(s.competition.channels)?competitionRows(s):undefined;metadata={...s.competition,channels:undefined};}
  else if(q.section==='competition_alternatives'){
    const c=s.competition?.channels?.find((c:any)=>c.id===q.channel);rows=c?.alternatives;metadata=c?{channel:c.id,status:c.status,capturedAt:c.capturedAt,alternativesTruncated:c.alternativesTruncated,note:c.note}:null;
  }else if(q.section==='diagnostics'){
    if(!['lndg','lightningMate','native'].includes(q.provider??'')||!['forwards','failures','failureRollups','rebalances','paymentAttempts','policies'].includes(q.collection??''))throw new Error('Diagnostic provider and collection required');
    const p=s.diagnostics?.[q.provider!];rows=p?.[q.collection!];metadata=providerSummary(p);
  }else rows=s[q.section];
  if(!Array.isArray(rows))return {section:q.section,available:false,metadata:metadata??null,total:null,rows:null,nextOffset:null,note:'Unavailable data is not zero.'};
  const safeRows=scrub(rows) as any[];metadata=scrub(metadata);
  const version=hash(json({metadata,rows:safeRows}));
  if(offset>0&&!q.version)throw new Error('Continuation requires section version');
  if(q.version&&q.version!==version)return {section:q.section,available:true,changed:true,version,restartOffset:0,rows:[],nextOffset:null};
  if(offset>safeRows.length)throw new Error('Page offset beyond section');
  const page:any={section:q.section,available:true,version,metadata,total:safeRows.length,offset,rows:[],nextOffset:null};
  for(let i=offset;i<safeRows.length&&page.rows.length<20;i++){
    page.rows.push(safeRows[i]);page.nextOffset=i+1<safeRows.length?i+1:null;
    if(Buffer.byteLength(json(page))>STATE_PAGE_BYTES){page.rows.pop();page.nextOffset=i;break;}
  }
  if(!page.rows.length&&offset<safeRows.length)throw new Error('State record exceeds bounded page; inspect source evidence instead');
  return page;
}
