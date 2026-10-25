import {Research} from './research.js';
import {AutomaticAdmission} from './automatic-admission.js';
import {ReviewWaits} from './review-waits.js';
import { Queue, type Job } from './queue.js';
import { id, now, hash } from './domain.js';

export class ModelUnavailable extends Error {}
export interface RecoveredRuns {runs:{job:Job;done:Promise<unknown>}[];settling:Promise<void>}
export interface JobRunner {
  available():Promise<boolean>;
  /** Startup only: attach admitted recovered runs, abort all other native work, then resume. */
  recover?(claim:(job:Job)=>Job|undefined):Promise<RecoveredRuns>;
  runJob(job:Job):Promise<unknown>;
}
/** One process, one coordinator, up to two isolated read-only conversations. Slots count lane capacity only. */
export class Scheduler {
  private pumping=false;private coordinator=false;private chat=false;private chatDispatching=false;private analysts=new Set<number>();
  private owner=id();private stopped=false;private recovering=false;
  private active=new Set<Promise<void>>();
  constructor(readonly queue:Queue,private runner:JobRunner){}
  /** Startup only, before any pump: every recovered run is attached to its lane or aborted before Durable resumes. */
  async recover() {
    if(this.stopped||!this.runner.recover)return;this.recovering=true;
    try {
      this.queue.reconcileTelegramTerminals();
      const slots=new Map<string,number|undefined>();
      const recovered=await this.runner.recover(job=>{
        // A restart recovers at most what was running before it; a lane conflict fails closed.
        const slot=job.lane==='analyst'?[0,1].find(n=>!this.analysts.has(n)):this.queue.chat(job)?2:undefined;
        if(job.lane==='analyst'?slot===undefined:slot===2?this.chat:this.coordinator)return undefined;
        const claimed=this.queue.claimRecovered(job.id,this.owner);if(!claimed)return undefined;
        if(job.lane==='analyst')this.analysts.add(slot!);else if(slot===2)this.chat=true;else this.coordinator=true;
        slots.set(job.id,slot);return claimed;
      });
      for(const run of recovered.runs)this.start(run.job,slots.get(run.job.id),run.done);
      this.active.add(recovered.settling);void recovered.settling.finally(()=>this.active.delete(recovered.settling));
      this.queue.store.set('agentRecoveryFailed',null);
    }catch(e){
      // Durable may hold marks or unowned work that was never swept: nothing may resume it before a restart.
      this.stopped=true;this.queue.store.set('agentRecoveryFailed',{at:now()});throw e;
    }finally{this.recovering=false;}
  }
  async pump() {
    if(this.stopped||this.pumping||this.recovering)return;this.pumping=true;
    try {
      this.queue.reconcileTelegramTerminals();this.queue.releaseWaiting();if(!await this.runner.available()||this.stopped)return;
      for(let slot=0;slot<2;slot++)if(!this.analysts.has(slot)){
        const job=this.queue.claim('analyst',this.owner);if(job){this.analysts.add(slot);this.start(job,slot);}
      }
      await this.dispatchTelegram();
      if(!this.coordinator){const job=this.queue.claim('coordinator',this.owner,now(),'financial');if(job){this.coordinator=true;this.start(job);}}
    }finally{this.pumping=false;}
  }
  /** Telegram coordinator dispatches immediately; future turns stay durably admitted. */
  async dispatchTelegram(){if(this.stopped||this.recovering||this.chat||this.chatDispatching)return;this.chatDispatching=true;
    try{this.queue.reconcileTelegramTerminals();if(!await this.runner.available()||this.stopped)return;const job=this.queue.claim('coordinator',this.owner,now(),'chat');if(job){this.chat=true;this.start(job,2);}}
    finally{this.chatDispatching=false;}
  }
  private start(job:Job,slot?:number,run?:Promise<unknown>){
    const task=this.launch(job,slot,run);this.active.add(task);
    void task.finally(()=>this.active.delete(task));
  }
  private async launch(job:Job,slot?:number,run?:Promise<unknown>) {
    // run_token fences late async work of this run; the process lock excludes other writers.
    const token=job.run_token!;
    try {
      const result=await (run??this.runner.runJob(job));this.queue.finish(job.id,token,'completed',result);new Research(this.queue.store).continue(this.queue,this.queue.get(job.id)!);
    }catch(e){
      if(e instanceof ModelUnavailable)this.queue.wait(job.id,token,'model_unavailable');
      else {this.queue.finish(job.id,token,'failed',e instanceof Error?e.message:'Task failed');new Research(this.queue.store).continue(this.queue,this.queue.get(job.id)!);}
    }finally{if(slot===undefined)this.coordinator=false;else if(slot===2)this.chat=false;else this.analysts.delete(slot);void this.pump();}
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
    const admission=new AutomaticAdmission(this.queue);
    try {
      for(const job of store.all("SELECT * FROM jobs WHERE state IN ('completed','failed') AND id IN (SELECT substr(key,10) FROM meta WHERE key LIKE 'research:%')"))new Research(store).continue(this.queue,job);
      admission.admit('node','coordinator');
      const scopes=new Set<string>(new ReviewWaits(store).all().filter(r=>r.scope.includes('->')).map(r=>r.scope));
      for(const row of store.all("SELECT source,target,count(*) n FROM events WHERE type='external_forward' GROUP BY source,target ORDER BY n DESC LIMIT 2"))scopes.add(row.source+'->'+row.target);
      for(const scope of scopes)admission.admit(scope,'analyst');
    } catch(e) {
      if(!(e instanceof Error)||!e.message.startsWith('Queue full'))throw e;
      store.set('queueBackpressure',{at:now(),reason:'Automatic admission deferred; watermarks remain pending'});
    }
    void this.pump();
  }
  // Stop admission immediately while already submitted work drains.
  // If the process is forcibly killed, original submission IDs survive recovery.
  stop(){this.stopped=true;}
  async drain(timeoutMs=25000):Promise<boolean>{
    this.stop();if(!this.active.size)return true;
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{return await Promise.race([Promise.all([...this.active]).then(()=>true),new Promise<boolean>(r=>{timer=setTimeout(()=>r(false),timeoutMs);})]);}
    finally{if(timer)clearTimeout(timer);}
  }
  status(){return {coordinatorRunning:this.coordinator,telegramRunning:this.chat,analystRunning:this.analysts.size,maxAnalysts:2,stopped:this.stopped,at:now()};}
}
