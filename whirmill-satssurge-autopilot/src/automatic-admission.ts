import { Queue } from './queue.js';
import { ReviewWaits } from './review-waits.js';
import { channelScid } from './diagnostics.js';
import { hash,json,now } from './domain.js';
export function canonicalScope(scope:string,lane:'coordinator'|'analyst') {
  if(lane==='coordinator')return 'node';
  const channels=scope.split('->');
  if(channels.length!==2)throw Error('Analyst admission requires corridor');
  return channels.map(channelScid).join('->');
}
function decimal(scid:string){const [h,t,o]=scid.split('x').map(BigInt);return ((h!<<40n)+(t!<<16n)+o!).toString();}
/** All automatic ingresses share this atomic, durable gate. Owner work bypasses it. */
export class AutomaticAdmission {
  constructor(private queue:Queue,private clock=Date.now){}
  admit(scope:string,lane:'coordinator'|'analyst') {
    const store=this.queue.store,canonical=canonicalScope(scope,lane),at=new Date(this.clock()).toISOString();
    return store.tx(()=>{
      store.run('INSERT OR IGNORE INTO automatic_scopes(scope) VALUES(?)',canonical);
      const previous=store.one('SELECT * FROM automatic_scopes WHERE scope=?',canonical);
      if(store.one("SELECT j.id FROM jobs j JOIN automatic_admissions a ON a.job_id=j.id WHERE a.scope=? AND j.state IN ('queued','running','waiting')",canonical))return;
      if(previous.job_id&&store.one("SELECT id FROM jobs WHERE id=? AND state IN ('queued','running','waiting')",previous.job_id))return;
      const args=lane==='analyst'?canonical.split('->').map(decimal):[];
      const forwards=store.one("SELECT count(*) n,max(sequence) cursor FROM event_ingestion WHERE baseline=0 AND type='external_forward' AND sequence>?"+(lane==='analyst'?' AND source=? AND target=?':''),previous.forward_sequence,...args);
      const materialFilter=lane==='analyst'?" AND (i.source IN (?,?) OR i.target IN (?,?) OR EXISTS (SELECT 1 FROM json_each(e.details,'$.affectedChannels') c WHERE c.value IN (?,?)))":'';
      const material=store.one("SELECT count(*) n,max(i.sequence) cursor FROM event_ingestion i LEFT JOIN events e ON e.id=i.event_id WHERE i.baseline=0 AND i.type IN ('manual_policy','manual_operation') AND i.sequence>?"+materialFilter,previous.material_sequence,...args,...args,...args);
      const blocker=hash(json(store.get('blockers')??[]));
      const reviews=new ReviewWaits(store,this.clock);
      const wait=reviews.get(canonical)??(lane==='analyst'?reviews.all().find(r=>{try{return canonicalScope(r.scope,lane)===canonical;}catch{return false;}}):undefined);
      const triggered=!!wait?.trigger&&wait.trigger!==previous.trigger_consumed;
      const due=!!wait&&Date.parse(wait.dueAt)<=this.clock()&&previous.due_consumed!==wait.dueAt;
      const changedBlocker=previous.blocker_digest!==null&&blocker!==previous.blocker_digest;
      if((previous.generation||wait)&&!due&&!triggered&&forwards.n<10&&!material.n&&!changedBlocker)return;
      if(store.one('SELECT count(*) n FROM automatic_admissions WHERE scope=? AND at>?',canonical,new Date(this.clock()-86400000).toISOString()).n>=4)return;
      const generation=previous.generation+1;
      const job=this.queue.enqueueWithinTransaction({requestId:'automatic:'+hash(canonical)+':'+generation,kind:lane==='analyst'?'analysis':'autonomy',scope:canonical,origin:'scheduler',purpose:'economic',payload:{message:'Review '+canonical+' using new material evidence. Compare observation, costs, alternatives and mandate. Missing inputs are unknown; propose only in analyst lane.',generation}},at);
      store.run('INSERT INTO automatic_admissions VALUES(?,?,?,?)',canonical,generation,job.id,at);
      store.run('UPDATE automatic_scopes SET generation=?,job_id=?,forward_sequence=?,material_sequence=?,blocker_digest=?,due_consumed=?,trigger_consumed=? WHERE scope=?',generation,job.id,forwards.cursor??previous.forward_sequence,material.cursor??previous.material_sequence,blocker,due?wait!.dueAt:previous.due_consumed,triggered?wait!.trigger:previous.trigger_consumed,canonical);
      if(wait){wait.consumedTrigger=triggered?wait.trigger:due?'due:'+wait.dueAt:wait.consumedTrigger;wait.lastAdmissionAt=at;wait.checks++;store.set('reviewWait:'+hash(wait.scope),wait);}
      store.set('automaticOwnership:'+job.id,{scope:canonical,generation});
      return job;
    });
  }
}
