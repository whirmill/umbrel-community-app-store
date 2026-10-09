import {hash,json,scrub} from './domain.js';

// Smaller than the harness output window. Pagination never silently omits rows.
export const STATE_PAGE_BYTES=12000;
export const STATE_SECTIONS=['channels','competition','competition_alternatives','diagnostics','decisions','operations','evaluations','evaluationWindows','coverage','claims','holds'] as const;
export type StateSection=typeof STATE_SECTIONS[number];
export interface StatePageQuery {section:StateSection;offset?:number;version?:string;provider?:'lndg'|'lightningMate';collection?:'forwards'|'failures'|'failureRollups'|'rebalances';channel?:string;}
function providerSummary(p:any){if(!p)return null;const {forwards,failures,failureRollups,rebalances,...meta}=p;return {...meta,counts:{forwards:forwards?.length??null,failures:failures?.length??null,failureRollups:failureRollups?.length??null,rebalances:rebalances?.length??null}};}
function competitionRows(s:any){return (s.competition?.channels??[]).map((c:any)=>{const {alternatives,...meta}=c;return {...meta,availableAlternativeRows:alternatives?.length??null};});}
export function stateSummary(s:any){
  const {diagnostics,competition,snapshot,operations,decisions,evaluations,evaluationWindows,coverage,claims,holds}=s;
  return scrub({enabled:s.enabled,bootstrapReady:s.bootstrapReady,blockers:s.blockers,mandate:s.mandate,budget:s.budget,pnl30:s.pnl30,cumulative:s.cumulative,partial:s.partial,
    agent:s.agent?{at:s.agent.at,status:s.agent.status,model:s.agent.model,thinkingLevel:s.agent.thinkingLevel,until:s.agent.until}:null,
    importReport:s.importReport?{at:s.importReport.at,fileCount:s.importReport.files?.length??null,ledgerEntriesRead:s.importReport.ledgerEntriesRead,problemCount:s.importReport.problems?.length??null,coverageComplete:s.importReport.coverageComplete,note:s.importReport.note}:null,
    snapshot:snapshot?{at:snapshot.at,identity:snapshot.identity,synced:snapshot.synced,confirmedSat:snapshot.confirmedSat,channelCount:snapshot.channels.length}:null,
    diagnostics:diagnostics?{at:diagnostics.at,lndg:providerSummary(diagnostics.lndg),lightningMate:providerSummary(diagnostics.lightningMate)}:null,
    competition:competition?{status:competition.status,at:competition.at,capturedAt:competition.capturedAt,coverage:competition.coverage,reason:competition.reason,channelCount:competition.channels?.length??null}:null,
    counts:{operations:operations?.length??null,decisions:decisions?.length??null,evaluations:evaluations?.length??null,evaluationWindows:evaluationWindows?.length??null,coverage:coverage?.length??null,claims:claims?.length??null,holds:holds?.length??null},
    detailAccess:{tool:'state_page (same analyst suffix as node_state)',sections:STATE_SECTIONS,diagnosticProviders:['lndg','lightningMate'],diagnosticCollections:['forwards','failures','failureRollups','rebalances'],note:'Read all nextOffset pages with the first page version. A changed version requires restarting that section. Counts describe the retained projection, not full historical coverage.'}});
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
    if(!['lndg','lightningMate'].includes(q.provider??'')||!['forwards','failures','failureRollups','rebalances'].includes(q.collection??''))throw new Error('Diagnostic provider and collection required');
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
