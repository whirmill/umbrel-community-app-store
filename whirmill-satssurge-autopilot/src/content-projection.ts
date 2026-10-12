import { canonicalRead } from './canonical-consumers.js';
import { checksum } from './content-artifacts.js';
import { parseContentRequest } from './content-requests.js';
import { validateContentSnapshot, type ContentSnapshot } from './content-generation.js';
import type { Store } from './store.js';

/** Only the public canonical allowlist enters this immutable bounded projection.
 * Rows retain source-specific evidence, never deduplicated totals or external intent. */
export function projectContent(store:Store,message:string,at=new Date().toISOString()):ContentSnapshot {
 const request=parseContentRequest(message);if(!request)throw Error('Explicit export command required');
 const page=canonicalRead(store,request.query),headers=['record','reference','kind','meaning/status','source','occurredAt/start','acquiredAt','sourceChannel','targetChannel/end','amountMsat','feeMsat','provenance'];
 const cell=(v:unknown)=>v===null||v===undefined?'unknown':typeof v==='string'?v:JSON.stringify(v);
 const row=(values:unknown[])=>values.map(cell);
 const lineage=request.query.section==='coverage'?page:canonicalRead(store,{section:'coverage',start:request.query.start,end:request.query.end,limit:32});
 const coverage=lineage.rows as {id:string;capability:string;status:string;source:string;start:string;end:string;observed_at:string;scope:string}[],rows:string[][]=[];
 const meta={projection:'content-canonical-v1',query:request.query,canonicalVersion:page.version,through:page.through,nextAfter:page.nextAfter,selected:page.rows.length,truncated:page.projectionLimits.truncated,coverageSelected:coverage.length,coverageThrough:lineage.through,coverageNextAfter:lineage.nextAfter,coverageVersion:lineage.version,coverageTruncated:lineage.projectionLimits.truncated,complete:false,sourceHistoryComplete:false,accountingAuthority:'none',financialQualified:false,note:page.note,...('scopeEvidenceUnknown' in page?{scopeEvidenceUnknown:page.scopeEvidenceUnknown,temporalValidity:page.temporalValidity}:{})};
 rows.push(row(['projection','metadata','','partial','canonical public allowlist','',at,'','','','',meta]));
 if(request.query.section!=='coverage')for(const r of page.rows){
  // Canonical coverage and observations are a union; only the observation branch is used here.
  if(!('meaning' in r))throw Error('Unexpected canonical export row');
  rows.push(row(['observation',r.id,r.kind,r.meaning,r.source,r.occurredAt,r.acquiredAt,r.sourceChannel,r.targetChannel,r.amountMsat,r.feeMsat,{sourceVersion:r.sourceVersion,originalChecksum:r.originalChecksum,granularity:r.granularity,endpointScope:r.endpointScope,calculationVersion:r.calculationVersion,accountingAuthority:r.accountingAuthority,financialQualified:r.financialQualified,reconciliation:r.reconciliation,status:r.status,externalIntent:r.externalIntent,htlc:r.htlc,policy:r.policy}]));
 }
 for(const r of coverage)rows.push(row(['coverage',r.id,r.capability,r.status,r.source,r.start,r.observed_at,'',r.end,'','',{scope:r.scope,checkpointOnly:true,historyComplete:false,accountingAuthority:'none'}]));
 const snapshotRef=checksum(JSON.stringify({meta,rows}));
 return validateContentSnapshot(request.format,{title:'Osservazioni canoniche · '+(request.query.section??'observations'),observedAt:at,coverage:`Parziale: ${page.rows.length} righe; ${coverage.length} coverage; righe troncate=${page.projectionLimits.truncated}; lineage troncata=${lineage.projectionLimits.truncated}; storia non completa; autorità contabile none`,evidenceRefs:[snapshotRef,...coverage.slice(0,31).map(r=>r.id)],table:{headers,rows}});
}
