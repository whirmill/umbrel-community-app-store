import {researchPresentation} from '../../src/ui-research';
import type {Job} from '../../src/ui-client';
export function ResearchSummary({job}:{job:Job}){
 const r=researchPresentation(job);
 if(!job.researchProgress&&job.researchStatus==='legacy_unknown')return <p className="muted">Ricerca non registrata per questa ricevuta precedente.</p>;
 if(!job.researchStatus)return null;
 return <section className="research-summary" aria-label="Stato della ricerca">
  <p><strong>Ricerca {r.status.toLowerCase()}</strong> · {r.followUp}</p>
  {job.researchProgress&&<>
   <div className="key-metrics">
    <span>Segmento<strong>{r.segment??'Non registrato'} / 3</strong></span>
    <span>Sezioni esaminate<strong>{r.processedSections} / {r.requiredSections}</strong></span>
    <span>Righe note esaminate<strong>{r.knownRows??'Non disponibili'}</strong></span>
    <span>Chiamate effettive<strong>{r.calls??'Non registrate'} / 72</strong></span>
    <span>Tempo effettivo<strong>{r.elapsedSeconds===null?'Non registrato':r.elapsedSeconds+' s'}</strong></span>
   </div>
   <p className="muted">Intervallo congelato · <time dateTime={r.start??undefined}>{r.start??'Inizio non registrato'}</time> → <time dateTime={r.end??undefined}>{r.end??'Fine non registrata'}</time> (UTC)</p>
  </>}
  {r.gaps.length>0&&<div className="notice"><strong>Lacune della ricerca</strong><ul>{r.gaps.map((gap:{section:string;reason:string},i:number)=><li key={i}><strong>{gap.section}:</strong> {gap.reason}</li>)}</ul></div>}
  <p><strong>Prossimo trigger:</strong> {r.nextTrigger}</p>
  {r.dueAt&&<p className="muted">Scadenza di osservazione · <time dateTime={r.dueAt}>{r.dueAt}</time></p>}
  <p><strong>Idoneità economica:</strong> {r.economic}</p>
  {r.economicReasons.length>0&&<p className="muted">{r.economicReasons.join(' · ')}</p>}
  <p className="muted"><strong>Esito operativo:</strong> {r.operation}</p>
 </section>;
}
