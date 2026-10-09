import {ReviewWaits} from './review-waits.js';
import { Queue, type Job } from './queue.js';
import { id, now, hash } from './domain.js';

export class ModelUnavailable extends Error {}
export interface JobRunner {
  available():Promise<boolean>;
  runJob(job:Job,analystSlot?:number):Promise<unknown>;
}
/** One process, one coordinator, up to two isolated read-only conversations. */
export class Scheduler {
  private pumping=false;private coordinator=false;private analysts=new Set<number>();
  private owner=id();private stopped=false;private heartbeats=new Map<string,ReturnType<typeof setInterval>>();
  private active=new Set<Promise<void>>();
  constructor(readonly queue:Queue,private runner:JobRunner){}
  async pump() {
    if(this.stopped||this.pumping)return;this.pumping=true;
    try {
      this.queue.releaseWaiting();if(!await this.runner.available()||this.stopped)return;
      for(let slot=0;slot<2;slot++)if(!this.analysts.has(slot)){
        const job=this.queue.claim('analyst',this.owner);if(job){this.analysts.add(slot);this.start(job,slot);}
      }
      if(!this.coordinator){const job=this.queue.claim('coordinator',this.owner);if(job){this.coordinator=true;this.start(job);}}
    }finally{this.pumping=false;}
  }
  private start(job:Job,slot?:number){
    const task=this.launch(job,slot);this.active.add(task);
    void task.finally(()=>this.active.delete(task));
  }
  private async launch(job:Job,slot?:number) {
    const token=job.run_token!;
    const timer=setInterval(()=>this.queue.renew(job.id,token),15000);this.heartbeats.set(job.id,timer);
    try {
      const result=await this.runner.runJob(job,slot);this.queue.finish(job.id,token,'completed',result);
    }catch(e){
      if(e instanceof ModelUnavailable)this.queue.wait(job.id,token,'model_unavailable');
      else this.queue.finish(job.id,token,'failed',e instanceof Error?e.message:'Task failed');
    }finally{clearInterval(timer);this.heartbeats.delete(job.id);if(slot===undefined)this.coordinator=false;else this.analysts.delete(slot);void this.pump();}
  }
  private enqueueScheduled(input:Parameters<Queue['enqueue']>[0]) {
    try{return this.queue.enqueue(input);}
    catch(e){
      if(!(e instanceof Error)||!e.message.startsWith('Queue full'))throw e;
      this.queue.store.set('queueBackpressure',{at:now(),kind:input.kind,reason:'Scheduled work deferred; admitted owner jobs retained'});
      return undefined;
    }
  }
  tick() {
    const store=this.queue.store;if(this.stopped||!store.get('enabled')||!store.get('bootstrapReady'))return;
    const bucket=Math.floor(Date.now()/900000);
    this.enqueueScheduled({requestId:'autonomy:'+bucket,kind:'autonomy',payload:{message:'Review current state, corridor evidence, completed analyst proposals and budgets. Compare waiting and interventions; act only when mandate and evidence justify it.'},origin:'scheduler',purpose:'economic',coalesceKey:'autonomy'});
    // Independent readings, not one AI run per HTLC. Two busiest measured corridors per window.
    const since=new Date(Date.now()-7*86400000).toISOString();
    for(const row of store.all("SELECT source,target,count(*) n FROM events WHERE type='external_forward' AND occurred_at>=? GROUP BY source,target ORDER BY n DESC LIMIT 2",since)){
      const scope=row.source+'->'+row.target;const reviews=new ReviewWaits(store);const waiting=reviews.get(scope);if(waiting){const material=store.one("SELECT max(rowid) cursor FROM events WHERE (source IN (?,?) OR target IN (?,?)) AND type IN ('manual_policy','manual_operation')",row.source,row.target,row.source,row.target)?.cursor;if(material)reviews.signal(scope,'manual:'+material);if(!reviews.due(reviews.get(scope)!))continue;}
      const admitted=this.enqueueScheduled({requestId:'analysis:'+bucket+':'+hash(scope),kind:'analysis',origin:'scheduler',purpose:'economic',scope,coalesceKey:'analysis:'+scope,payload:{message:'Analyze observed corridor '+scope+'. Compare wait, price changes and smaller rebalances. Read fresh evidence and costs; propose only. Never claim graph connectivity proves traffic.'}});if(admitted&&waiting&&['queued','running','waiting'].includes(admitted.state))reviews.admitted(scope,admitted.id);
    }
    const reviews=new ReviewWaits(store);for(const r of reviews.all()){const channels=r.scope.split('->');if(channels.length===2){const material=store.one("SELECT max(rowid) cursor FROM events WHERE (source IN (?,?) OR target IN (?,?)) AND type IN ('manual_policy','manual_operation')",channels[0],channels[1],channels[0],channels[1])?.cursor;if(material)reviews.signal(r.scope,'manual:'+material);const forwards=store.one("SELECT count(*) n FROM events WHERE source=? AND target=? AND type='external_forward' AND occurred_at>?",channels[0],channels[1],r.lastAdmissionAt??'')?.n;if(forwards>=10)reviews.signal(r.scope,'forwards:'+Math.floor(forwards/10)+':'+r.lastAdmissionAt);}if(reviews.due(reviews.get(r.scope)!)){const admitted=this.enqueueScheduled({requestId:'review:'+bucket+':'+hash(r.scope+':'+(r.trigger??'')+':'+r.checks),kind:'analysis',origin:'scheduler',purpose:'economic',scope:r.scope,coalesceKey:'analysis:'+r.scope,payload:{message:'Review due wait for '+r.scope+'. Fixed dueAt '+r.dueAt+'; missing '+r.missing.join(', ')+'. Compare new material evidence; do not restart the observation window or infer completed hours.'}});if(admitted&&['queued','running','waiting'].includes(admitted.state))reviews.admitted(r.scope,admitted.id);}}
    const cursor=store.get<number>('queuedEventCursor')??0;
    const signal=store.one("SELECT max(rowid) cursor,count(*) n FROM events WHERE rowid>? AND type IN ('external_forward','htlc_rejected','manual_policy','manual_operation')",cursor);
    if(signal?.n){
      const accepted=this.enqueueScheduled({requestId:'events:'+signal.cursor,kind:'events',origin:'scheduler',purpose:'economic',coalesceKey:'lightning-events',payload:{message:'New aggregated Lightning observations are available. Read current evidence and reconcile manual interventions; do not assume failed HTLCs are distinct payments or guaranteed demand.'}});
      if(accepted)store.set('queuedEventCursor',signal.cursor);
    }
    void this.pump();
  }
  // Stop admission immediately; retain leases while already submitted work drains.
  // If the process is forcibly killed, original submission IDs survive recovery.
  stop(){this.stopped=true;}
  async drain(timeoutMs=25000):Promise<boolean>{
    this.stop();if(!this.active.size)return true;
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{return await Promise.race([Promise.all([...this.active]).then(()=>true),new Promise<boolean>(r=>{timer=setTimeout(()=>r(false),timeoutMs);})]);}
    finally{if(timer)clearTimeout(timer);}
  }
  status(){return {coordinatorRunning:this.coordinator,analystRunning:this.analysts.size,maxAnalysts:2,stopped:this.stopped,at:now()};}
}
