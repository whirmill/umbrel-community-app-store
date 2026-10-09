import {test} from 'node:test';
import assert from 'node:assert/strict';
import {researchPresentation,accountingPresentation} from '../ui-research.js';
import {mergeEvents,mergeJobs,type Projection,type Job} from '../ui-client.js';
import {accountingPartition} from '../accounting.js';
import {Store} from '../store.js';
import {Queue} from '../queue.js';
import {Research} from '../research.js';
import {UiEvents} from '../ui-events.js';
import {publicJob} from '../public-job.js';
const job:Job={id:'research',kind:'analysis',state:'completed',updated_at:'2026-10-09T00:00:00Z',researchStatus:'partial',followUpState:'research_partial',researchProgress:{segmentIndex:1,start:'2026-09-09T00:00:00Z',end:'2026-10-09T00:00:00Z',requiredSections:['state_budget','channels','coverage'],sections:{state_budget:{done:true,available:true,offset:1,query:{tool:'node_state'}},channels:{done:false,available:true,offset:20,total:103}},aggregate:{calls:15,elapsedMs:8200}},researchGaps:[{section:'coverage',reason:'required section not processed'}],nextTrigger:'bounded read-only continuation',economicEligible:false,economicReasons:['trusted_forecast_not_computed'],operationOutcome:null};
test('research presentation separates terminal receipt, persisted measured progress, gaps, eligibility and effect outcome after refresh/SSE',()=>{
 const empty:Projection={jobs:{},events:[],cursor:0};let state=mergeJobs(empty,[job]);let view=researchPresentation(state.jobs.research!);assert.equal(view.status,'Parziale');assert.equal(view.segment,2);assert.equal(view.processedSections,1);assert.equal(view.requiredSections,3);assert.equal(view.knownRows,20);assert.equal(view.calls,15);assert.equal(view.elapsedSeconds,8.2);assert.equal(view.start,job.researchProgress.start);assert.equal(view.economic,'Idoneità non dimostrata');assert.match(view.operation,/non registrato/);assert.match(view.gaps[0]!.reason,/obbligatoria/);assert.match(view.nextTrigger,/analista in sola lettura/);
 state=mergeEvents(state,[{id:1,job_id:job.id,at:'2026-10-09T00:01:00Z',type:'job',data:{researchStatus:'blocked',researchProgress:{...job.researchProgress,segmentIndex:2},nextTrigger:'specific new material facts'}}]);view=researchPresentation(state.jobs.research!);assert.equal(state.jobs.research!.state,'completed');assert.equal(view.status,'Bloccata');assert.equal(view.segment,3);assert.match(view.nextTrigger,/fatti materiali/);const refreshed=mergeJobs(empty,[state.jobs.research!]);assert.deepEqual(researchPresentation(refreshed.jobs.research!),view);
});
test('complete observation wait and operational blocker keep next trigger visible without gaps; unknown counts remain unknown',()=>{
 const wait=researchPresentation({...job,researchStatus:'complete',followUpState:'observation_wait',researchGaps:[],nextTrigger:'due 2026-10-11T00:00:00Z or 10 new forwards, manual intervention or changed blocker',triggerDetails:{dueAt:'2026-10-11T00:00:00Z'}});assert.equal(wait.followUp,'Osservazione in corso');assert.equal(wait.gaps.length,0);assert.match(wait.nextTrigger,/Scadenza/);assert.equal(wait.dueAt,'2026-10-11T00:00:00Z');
 const blocked=researchPresentation({...job,followUpState:'operational_blocked',researchGaps:[],nextTrigger:'new blocker resolution',researchProgress:null});assert.equal(blocked.followUp,'Blocco operativo');assert.match(blocked.nextTrigger,/blocco operativo/);assert.equal(blocked.calls,null);assert.equal(blocked.elapsedSeconds,null);assert.equal(blocked.knownRows,null);
});
test('readable accounting exact partition reconciles original totals and withholds routing net for unassigned/shared costs',()=>{
 const rows=[{id:'routing',classification:'revenue',amount_msat:'364358',category:'routing',details:'{}'},{id:'swap',classification:'revenue',amount_msat:'1958000',category:'historical',details:'{"scope":"swap"}'},{id:'cost',classification:'expense',amount_msat:'10705169',category:'historical',details:'{}'}];const pnl={revenueMsat:'2322358',costMsat:'10705169',netMsat:'-8382811'},partition=accountingPartition(rows);let view=accountingPresentation(partition,pnl);assert.equal(view.reconciled,true);assert.equal(view.costAllocationComplete,false);assert.equal(view.routingContribution,null);assert.equal(view.sectors[0]!.revenueMsat,'364358');assert.equal(view.sectors[1]!.revenueMsat,'1958000');assert.equal(view.sectors[3]!.attribution.unattributed.costMsat,'10705169');assert.equal(view.causalProfitCertified,false);
 view=accountingPresentation(accountingPartition(rows,[{ledger_id:'cost',version:1,sector:'routing',attribution:'shared'}]),pnl);assert.equal(view.routingContribution,null);assert.equal(view.reconciled,true);assert.equal(accountingPresentation(null,null).reconciled,false);
});

test('fresh public research blocker survives stored terminal-event replay and slow lifecycle polling',()=>{
 const store=new Store(':memory:'),queue=new Queue(store),research=new Research(store),events=new UiEvents(store);
 const created=queue.enqueue({requestId:'projection-refresh',kind:'analysis',scope:'node',origin:'scheduler',purpose:'economic',payload:{}});
 research.initialize(created);research.state(created);
 const receipt=research.get(created.id);for(const section of receipt.required)receipt.sections[section]={done:true,available:false,reason:'synthetic source unavailable'};
 store.set('research:'+created.id,receipt);store.set('followUpOutcome:'+created.id,{outcome:'wait',dueAt:'2026-10-11T00:00:00Z'});
 store.run("UPDATE jobs SET state='completed',updated_at=?,result=? WHERE id=?",'2026-10-09T00:00:00Z','{"answer":"terminal receipt"}',created.id);queue.event(created.id,'completed',{});
 const completed=publicJob(store,queue.get(created.id)),past=events.after(0);
 assert.equal(completed.followUpState,'observation_wait');let state=mergeEvents(mergeJobs({jobs:{},events:[],cursor:0},[completed]),past);
 assert.ok(state.jobs[created.id]!.updated_at>completed.updated_at,'Persisted terminal UI event was later than lifecycle receipt');
 store.set('blockers',['synthetic operational blocker']);const fresh=publicJob(store,queue.get(created.id));assert.ok(fresh.researchProjectionVersion!>completed.researchProjectionVersion!);
 state=mergeEvents(mergeJobs(state,[fresh]),[],false);
 assert.equal(state.jobs[created.id]!.state,'completed');assert.equal(state.jobs[created.id]!.followUpState,'operational_blocked');assert.equal(state.jobs[created.id]!.nextTrigger,'new blocker resolution');assert.equal(researchPresentation(state.jobs[created.id]!).followUp,'Blocco operativo');
 state=mergeJobs(state,[{...completed,state:'running',result:'stale response',updated_at:'2026-10-08T00:00:00Z'}]);assert.equal(state.jobs[created.id]!.state,'completed');assert.equal(state.jobs[created.id]!.followUpState,'operational_blocked');assert.equal(state.jobs[created.id]!.result,completed.result);
 assert.equal(publicJob(store,queue.get(created.id)).researchProjectionVersion,fresh.researchProjectionVersion,'Identical projection reads do not advance semantic version');
 store.set('blockers',[]);const resolved=publicJob(store,queue.get(created.id));assert.ok(resolved.researchProjectionVersion!>fresh.researchProjectionVersion!);
 state=mergeEvents(mergeJobs(state,[resolved]),[],false);assert.equal(state.jobs[created.id]!.followUpState,'observation_wait');assert.equal(state.jobs[created.id]!.state,'completed');store.close();
});
test('new research-only event updates progress independently without advancing lifecycle clock; legacy replay cannot erase receipt',()=>{
 const current={...job,researchProjectionVersion:4},empty:Projection={jobs:{},events:[],cursor:0};let state=mergeJobs(empty,[current]);
 state=mergeEvents(state,[{id:1,job_id:job.id,at:'2026-10-08T00:00:00Z',type:'job',data:{researchProjectionVersion:5,researchProgress:{...job.researchProgress,calls:16},economicEligible:true,economicReasons:[]}}]);
 assert.equal(state.jobs[job.id]!.researchProgress.calls,16);assert.equal(state.jobs[job.id]!.updated_at,job.updated_at);assert.equal(state.jobs[job.id]!.state,'completed');assert.equal(state.jobs[job.id]!.economicEligible,true);
 state=mergeEvents(state,[{id:2,job_id:job.id,at:'2026-10-10T00:00:00Z',type:'job',data:{state:'completed',researchStatus:'legacy_unknown',researchProgress:null}}]);assert.equal(state.jobs[job.id]!.researchProgress.calls,16);assert.equal(state.jobs[job.id]!.researchStatus,'partial');assert.equal(state.jobs[job.id]!.researchProjectionVersion,5);
 const legacy=mergeJobs(empty,[{id:'legacy',kind:'analysis',state:'completed',researchStatus:'legacy_unknown',researchProgress:null}]);assert.equal(legacy.jobs.legacy!.researchProjectionVersion,undefined);assert.equal(legacy.jobs.legacy!.researchStatus,'legacy_unknown');
});
