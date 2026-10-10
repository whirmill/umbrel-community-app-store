import {Research} from './research.js';
import {AutomaticAdmission} from './automatic-admission.js';
import {ReviewWaits} from './review-waits.js';
import { Queue, type Job } from './queue.js';
import { id, now, hash } from './domain.js';

export class ModelUnavailable extends Error {}
export interface JobRunner {
  available():Promise<boolean>;
  recoverTelegramStops?():Promise<void>;
  runJob(job:Job,analystSlot?:number):Promise<unknown>;
}
/** One process, one coordinator, up to two isolated read-only conversations. */
export class Scheduler {
  private pumping=false;private coordinator=false;private chat=false;private chatDispatching=false;private analysts=new Set<number>();
  private owner=id();private stopped=false;private heartbeats=new Map<string,ReturnType<typeof setInterval>>();
  private active=new Set<Promise<void>>();
  constructor(readonly queue:Queue,private runner:JobRunner){}
  async pump() {
    if(this.stopped||this.pumping)return;this.pumping=true;
    try {
      if(this.runner.recoverTelegramStops)await this.runner.recoverTelegramStops();this.queue.reconcileTelegramTerminals();this.queue.releaseWaiting();if(!await this.runner.available()||this.stopped)return;
      for(let slot=0;slot<2;slot++)if(!this.analysts.has(slot)){
        const job=this.queue.claim('analyst',this.owner);if(job){this.analysts.add(slot);this.start(job,slot);}
      }
      await this.dispatchTelegram();
      if(!this.coordinator){const job=this.queue.claim('coordinator',this.owner,now(),'financial');if(job){this.coordinator=true;this.start(job);}}
    }finally{this.pumping=false;}
  }
  /** Telegram coordinator dispatches immediately; future turns stay durably admitted. */
  async dispatchTelegram(){if(this.stopped||this.chat||this.chatDispatching)return;this.chatDispatching=true;
    try{if(this.runner.recoverTelegramStops)await this.runner.recoverTelegramStops();this.queue.reconcileTelegramTerminals();if(!await this.runner.available()||this.stopped)return;const job=this.queue.claim('coordinator',this.owner,now(),'chat');if(job){this.chat=true;this.start(job,2);}}
    finally{this.chatDispatching=false;}
  }
  private start(job:Job,slot?:number){
    const task=this.launch(job,slot);this.active.add(task);
    void task.finally(()=>this.active.delete(task));
  }
  private async launch(job:Job,slot?:number) {
    const token=job.run_token!;
    const timer=setInterval(()=>this.queue.renew(job.id,token),15000);this.heartbeats.set(job.id,timer);
    try {
      const result=await this.runner.runJob(job,slot);this.queue.finish(job.id,token,'completed',result);new Research(this.queue.store).continue(this.queue,this.queue.get(job.id)!);
    }catch(e){
      if(e instanceof ModelUnavailable)this.queue.wait(job.id,token,'model_unavailable');
      else {this.queue.finish(job.id,token,'failed',e instanceof Error?e.message:'Task failed');new Research(this.queue.store).continue(this.queue,this.queue.get(job.id)!);}
    }finally{clearInterval(timer);this.heartbeats.delete(job.id);if(slot===undefined)this.coordinator=false;else if(slot===2)this.chat=false;else this.analysts.delete(slot);void this.pump();}
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
  // Stop admission immediately; retain leases while already submitted work drains.
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
