import type {Job} from './ui-client.js';
const statusLabels:Record<string,string>={complete:'Completa',partial:'Parziale',blocked:'Bloccata',legacy_unknown:'Non registrata'};
const followLabels:Record<string,string>={observation_wait:'Osservazione in corso',research_partial:'Ricerca da completare',operational_blocked:'Blocco operativo'};
const sectionLabels:Record<string,string>={state_budget:'Stato e budget',channels:'Canali',coverage:'Copertura',manual_events:'Interventi manuali',policy_events:'Variazioni di policy',corridor_events:'Forwards del corridoio',diagnostics:'Diagnostica',competition:'Competizione',competition_alternatives:'Alternative per canale',alternatives:'Confronto delle alternative',forecast:'Previsione'};
const reasons:Record<string,string>={authoritative_coverage_unavailable:'Copertura LND autorevole non disponibile',relevant_inputs_expired:'Dettagli originali scaduti',measured_hours_insufficient:'Ore comparabili insufficienti',measured_days_insufficient:'Giorni comparabili insufficienti',samples_insufficient:'Campioni insufficienti',trusted_forecast_not_computed:'Previsione autorevole non calcolata','required section not processed':'Sezione obbligatoria non ancora esaminata','retained projection or source coverage incomplete':'Proiezione conservata o copertura della fonte incompleta','source unavailable':'Fonte non disponibile'};
export function researchSectionLabel(section:string){const [base,...scope]=section.split(':');return (sectionLabels[base!]??section)+(scope.length?' · '+scope.join(' · '):'');}
export function researchReasonLabel(reason:unknown){return typeof reason==='string'?(reasons[reason]??reason):'Motivo non registrato';}
/** Presentation uses persisted measurements only; unknowns never become zero or finance success. */
export function researchPresentation(job:Job){
 const p=job.researchProgress,sections=p?.sections??{},required:string[]=p?.requiredSections??[...new Set([...Object.keys(sections),...(job.researchGaps??[]).map((g:any)=>g.section)])];
 const relevant=required.map(k=>sections[k]).filter(Boolean);
 const rows=relevant.filter(s=>s.available===true&&Number.isSafeInteger(s.offset)&&s.offset>=0&&s.query?.tool!=='node_state');
 const segment=Number.isSafeInteger(p?.segmentIndex)?Math.min(3,p.segmentIndex+1):null;
 const aggregate=p?.aggregate,reasonCodes=Array.isArray(job.economicReasons)?job.economicReasons:[];
 const operation=job.operationOutcome;
 return {status:statusLabels[job.researchStatus]??'Non registrata',followUp:followLabels[job.followUpState]??'Stato del seguito non registrato',segment,
  processedSections:required.filter(k=>sections[k]?.done===true).length,requiredSections:required.length,
  knownRows:rows.length?rows.reduce((n,s)=>n+s.offset,0):null,
  calls:Number.isSafeInteger(aggregate?.calls)?aggregate.calls:null,
  elapsedSeconds:typeof aggregate?.elapsedMs==='number'&&Number.isFinite(aggregate.elapsedMs)?Math.round(aggregate.elapsedMs/100)/10:null,
  start:p?.start??null,end:p?.end??null,
  gaps:(job.researchGaps??[]).map((g:any)=>({section:researchSectionLabel(g.section??'Sezione'),reason:researchReasonLabel(g.reason)})),
  nextTrigger:job.nextTrigger==='bounded read-only continuation'?'Continuazione limitata con un nuovo analista in sola lettura':job.nextTrigger==='specific new material facts'?'Nuovi fatti materiali specifici':job.nextTrigger==='new blocker resolution'?'Risoluzione o variazione del blocco operativo':typeof job.nextTrigger==='string'&&job.nextTrigger.startsWith('due ')?'Scadenza di osservazione, oppure 10 nuovi forwards, un intervento manuale o una variazione del blocco':job.nextTrigger??'Nessun nuovo trigger registrato',dueAt:job.triggerDetails?.dueAt??null,
  economic:job.economicEligible===true?'Previsione idonea · profitto realizzato non certificato':reasonCodes.includes('trusted_forecast_not_computed')?'Idoneità non dimostrata':'Previsione non idonea',economicReasons:reasonCodes.map(researchReasonLabel),
  operation:operation?String(operation.status??operation.state??'Esito non conclusivo'):'Esito operativo non registrato per questa ricerca'};
}
export function accountingPresentation(partition:any,pnl:any){
 const names:Record<string,string>={routing:'Routing',swap:'Swap',other:'Altro',unknown:'Non assegnato'};
 const sectors=['routing','swap','other','unknown'].map(key=>({key,label:names[key]!,...partition?.sectors?.[key]}));
 const complete=partition?.unassignedCosts===false;
 const reconciled=sectors.every(s=>/^\d+$/.test(s.revenueMsat??'')&&/^\d+$/.test(s.costMsat??''))&&/^\d+$/.test(pnl?.revenueMsat??'')&&/^\d+$/.test(pnl?.costMsat??'')&&sectors.reduce((n,s)=>n+BigInt(s.revenueMsat),0n)===BigInt(pnl.revenueMsat)&&sectors.reduce((n,s)=>n+BigInt(s.costMsat),0n)===BigInt(pnl.costMsat);
 return {sectors,costAllocationComplete:complete,reconciled,routingContribution:complete?partition?.routingContributionMsat??null:null,causalProfitCertified:false};
}
