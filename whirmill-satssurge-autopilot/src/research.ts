import {UiEvents} from './ui-events.js';
import {channelScid} from './diagnostics.js';
import { Store } from './store.js';
import { Queue,type Job } from './queue.js';
import { hash,json,now } from './domain.js';
import {normalizeEvidenceQuery,type EvidenceQuery } from './evidence-views.js';
export const REQUIRED_RESEARCH=['state_budget','channels','coverage','manual_events','policy_events','diagnostics:lndg:forwards','diagnostics:lndg:failures','diagnostics:lightningMate:forwards','diagnostics:lightningMate:failures','competition','alternatives'] as const;
type Progress={query:any;version:string|null;offset:number;total:number|null;done:boolean;available:boolean;reason:string|null};
export class Research {
 constructor(private store:Store){}
 get(jobId:string):any{return this.store.get('research:'+jobId);}
 initialize(job:Job){
  let r=this.get(job.id);if(r)return r;
  const payload=JSON.parse(job.payload);const prior=payload.researchParent?this.get(payload.researchParent):undefined;
  r=prior?{...prior,segmentIndex:prior.segmentIndex+1,parentReceipt:payload.researchParent,segmentStartProgress:prior.progress,segmentStartCalls:prior.calls}:
   {researchId:job.id,revisionId:hash(job.id+':'+job.snapshot_at),segmentIndex:0,parentReceipt:null,start:new Date(Date.parse(job.created_at)-30*86400000).toISOString(),end:job.created_at,sections:{},progress:0,calls:0,segmentStartProgress:0,segmentStartCalls:0};
  if(!r.required){
    r.required=[...REQUIRED_RESEARCH];
    if(job.scope.includes('->'))try{const scoped=job.scope.split('->').map(channelScid).join('->');r.required=r.required.map((k:string)=>['manual_events','policy_events'].includes(k)?k+':'+scoped:k);}catch{}
    const channels=this.store.get<any>('snapshot')?.channels??[];
    let corridors=job.scope.includes('->')?[job.scope]:this.store.all("SELECT DISTINCT source,target FROM events WHERE type='external_forward'").map(x=>x.source+'->'+x.target);
    if(!corridors.length&&job.scope.includes('->'))corridors=[job.scope];
    for(const corridor of corridors)try{r.required.push('corridor_events:'+corridor.split('->').map(channelScid).join('->'));}catch{r.required.push('corridor_events:invalid_scope');}
    const selected=job.scope.includes('->')?job.scope.split('->'):channels.map((c:any)=>c.id);
    for(const channel of selected)try{r.required.push('competition_alternatives:'+channelScid(channel));}catch{r.required.push('competition_alternatives:invalid_scope');}
  }
  r.jobs=[...(r.jobs??[]).filter((x:string)=>x!==job.id),job.id];r.jobId=job.id;r.status='partial';this.store.set('research:'+job.id,r);return r;
 }
 query(job:Job,q:EvidenceQuery):EvidenceQuery{
  const r=this.initialize(job);
  const scoped=['corridor_events','manual_events','policy_events'].includes(q.section)&&job.scope.includes('->')?{source:job.scope.split('->')[0],target:job.scope.split('->')[1]}:{};
  return {...scoped,...q,...(['corridor_events','manual_events','policy_events','coverage','decisions','operations','evaluations','evaluationWindows','holds','claims'].includes(q.section)?{start:q.start??r.start,end:q.end??r.end}:{})};
 }
 state(job:Job){const r=this.initialize(job);const digest=hash(json({budget:this.store.budget(),mandate:this.store.get('mandate'),blockers:this.store.get('blockers')}));if(r.sections.state_budget?.version!==digest)r.progress++;r.sections.state_budget={done:true,available:true,query:{tool:'node_state'},version:digest,offset:1,total:1};r.calls++;this.save(r);}
 page(job:Job,q:EvidenceQuery,page:any){
  q={...q,...page.metadata?.scope};
  const r=this.initialize(job);let key:string=q.section==='diagnostics'?'diagnostics:'+q.provider+':'+q.collection:q.section;
  if(q.section==='competition_alternatives'&&q.channel)key+=':'+channelScid(q.channel);
  if(['corridor_events','manual_events','policy_events'].includes(q.section)&&q.source&&q.target)key+=':'+channelScid(q.source)+'->'+channelScid(q.target);
  const {cursor,offset:queryOffset,version:queryVersion,...canonical}=normalizeEvidenceQuery(q);
  const queryKey=hash(json(canonical));const previous:any=r.queries?.[queryKey];
  const offset=page.available?(page.nextOffset??((page.offset??0)+(page.rows?.length??0))):0;
  const signature=hash(json({query:canonical,version:page.version,offset,available:page.available,reason:page.available?null:page.note}));
  r.calls++;
  if(!page.changed&&!page.expired&&!page.capacity&&previous?.signature!==signature&&(!previous||page.version!==previous.version||offset>previous.offset))r.progress++;
  const record={query:{...q,cursor:page.cursor},version:page.version??null,offset,total:page.total??null,done:page.available? !page.changed&&!page.restartOffset&&page.nextOffset===null:!page.expired&&!page.capacity&&!page.changed,available:page.available===true,coverageGap:page.metadata?.projectionLimits?.truncated===true||page.metadata?.captureComplete===false||page.metadata?.upstreamHistoryComplete===false,reason:page.available?null:page.note??'source unavailable',signature};
  r.queries??={};r.queries[queryKey]=record;
  const intervalRequired=['corridor_events','manual_events','policy_events','coverage'].includes(q.section);
  const fullInterval=!intervalRequired||(Date.parse(q.start??'')===Date.parse(r.start)&&Date.parse(q.end??'')===Date.parse(r.end));
  const wholeCollection=!['channels','competition','diagnostics'].includes(q.section)||(!q.channel&&!q.source&&!q.target&&!q.start&&!q.end);
  const exactAlternative=q.section!=='competition_alternatives'||(!q.start&&!q.end&&!q.source&&!q.target);
  const fullManual=!['manual_events','policy_events'].includes(q.section)||((!q.source&&!q.target&&!q.channel)||(!!q.source&&!!q.target&&!q.channel));
  if(fullInterval&&wholeCollection&&exactAlternative&&fullManual)r.sections[key]=record;
  this.save(r);
 }
 alternatives(job:Job,input:{wait:string;priceChange:string;smallerRebalance:string;proposedAction:string}){const r=this.initialize(job);const digest=hash(json(input));if(!r.sections.alternatives)r.progress++;r.sections.alternatives={done:true,available:true,version:digest,comparison:input};this.save(r);}
 forecast(job:Job,estimate?:any){const r=this.initialize(job);r.forecastProposed=true;r.forecast=estimate??null;if(!r.sections.forecast)r.progress++;r.sections.forecast={done:true,available:true};this.save(r);}
 private save(r:any){this.store.set('research:'+r.jobId,r);new UiEvents(this.store).append(r.jobId,'job',this.status(r.jobId));}
 status(jobId:string){
  const r=this.get(jobId);if(!r)return {researchStatus:'legacy_unknown',researchProgress:null,researchGaps:[],nextTrigger:null};
  const required=[...r.required,...(r.forecastProposed?['forecast']:[])];
  const missing=required.filter(k=>!r.sections[k]?.done);
  const gaps=required.filter(k=>r.sections[k]?.done&&(!r.sections[k]?.available||r.sections[k]?.coverageGap)).map(k=>({section:k,reason:r.sections[k].reason??'retained projection or source coverage incomplete'}));
  const advanced=r.progress>r.segmentStartProgress;
  const budgets=(r.jobs??[jobId]).map((id:string)=>this.store.get<any>('runBudget:'+id)).filter(Boolean);
  const aggregate={calls:budgets.reduce((n:number,b:any)=>n+b.calls,0),elapsedMs:budgets.reduce((n:number,b:any)=>n+(b.endedMs??Math.min(b.hardMs,Math.max(0,Date.now()-b.started))),0),researchCalls:budgets.reduce((n:number,b:any)=>n+b.researchCalls,0),usage:budgets.map((b:any)=>b.usage??{available:false})};
  const terminal=['completed','failed','cancelled'].includes(this.store.one('SELECT state FROM jobs WHERE id=?',jobId)?.state);
  const status=!missing.length?'complete':terminal&&(!advanced||r.segmentIndex>=2||aggregate.calls>=72||aggregate.elapsedMs>=540000)?'blocked':'partial';
  const outcome=this.store.get<any>('followUpOutcome:'+jobId);
  const blockers=this.store.get<any[]>('blockers')??[];
  const projection={followUpState:blockers.length?'operational_blocked':status==='complete'&&outcome?.outcome==='wait'?'observation_wait':'research_partial',triggerDetails:{dueAt:outcome?.dueAt??null,newExternalForwards:10,newManualEvent:true,newBlocker:true},economicEligible:r.forecast?.eligible===true,economicReasons:r.forecast?.reasons??['trusted_forecast_not_computed'],operationOutcome:this.store.get('jobOperationOutcome:'+jobId)??null,researchStatus:status,researchProgress:{researchId:r.researchId,revisionId:r.revisionId,segmentIndex:r.segmentIndex,parentReceipt:r.parentReceipt,requiredSections:required,sections:r.sections,progress:r.progress,calls:r.calls,aggregate,start:r.start,end:r.end},researchGaps:[...missing.map(section=>({section,reason:'required section not processed'})),...gaps],nextTrigger:blockers.length?'new blocker resolution':status==='blocked'?'specific new material facts':status==='partial'?'bounded read-only continuation':outcome?.outcome==='wait'?'due '+outcome.dueAt+' or 10 new forwards, manual intervention or changed blocker':null};
  // Semantic projection freshness is independent of the queue lifecycle clock.
  // The single process persists this monotonic per-job receipt atomically via one meta upsert.
  const digest=hash(json(projection)),key='researchProjection:'+jobId;
  const previous=this.store.get<any>(key);
  const version=previous?.digest===digest?previous.version:(previous?.version??0)+1;
  if(previous?.digest!==digest)this.store.set(key,{version,digest});
  return {...projection,researchProjectionVersion:version};
 }
 continue(queue:Queue,job:Job){
  const status=this.status(job.id),r=this.get(job.id);
  if(!r||status.researchStatus!=='partial'||!['completed','failed'].includes(job.state))return;
  return this.store.tx(()=>{
   const existing=this.store.get<string>('researchContinuation:'+job.id);if(existing)return queue.get(existing);
   const next=queue.enqueueWithinTransaction({requestId:'continuation:'+job.id,kind:'analysis',scope:job.scope,origin:'scheduler',purpose:'economic',payload:{researchParent:job.id,message:'Read-only continuation of research '+r.researchId+'. Frozen interval '+r.start+' to '+r.end+'. Resume saved queries, versions and offsets; do not repeat completed pages. Missing sections '+json(status.researchGaps)+'. Previous progress '+json(r.sections)}});
   this.store.set('researchContinuation:'+job.id,next.id);
   this.store.set('jobCapability:'+next.id,'read_only_research');
   const ownership=this.store.get<any>('automaticOwnership:'+job.id);
   if(ownership){this.store.set('automaticOwnership:'+next.id,ownership);this.store.run('UPDATE automatic_scopes SET job_id=? WHERE scope=? AND generation=? AND job_id=?',next.id,ownership.scope,ownership.generation,job.id);}
   return next;
  });
 }
}
