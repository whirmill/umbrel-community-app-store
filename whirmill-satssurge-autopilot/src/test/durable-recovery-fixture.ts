import {fixture} from './pi-fixture.js';
import {ApplicationControl} from '../application-control.js';
import {TelegramTurns} from '../telegram-turns.js';
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai/utils/event-stream';
import {now} from '../domain.js';

/** One run started before the crash. `unbound` halts at the first app write after the native submit commit. */
export interface CrashJob {name:string;kind:'chat'|'analysis'|'autonomy';telegram?:boolean;stop?:boolean;unbound?:boolean}
export interface Started {jobId:string;conversationId:string|null;submissionId:string}

if(process.argv[2]==='held-runs'){
 const directory=process.argv[3]!,jobs=JSON.parse(process.argv[4]!) as CrashJob[];
 const f=fixture(directory,'state'),turns=new TelegramTurns(f.store,f.queue),control=new ApplicationControl(f.store,f.queue),entered=new Set<string>();
 f.store.set('enabled',true);f.store.set('telegramBinding',{generation:'g',chatId:42,userId:42,since:now()});
 // The provider never answers: every run is mid-generation when the process is killed.
 f.agent.models.streamSimple=(_model,request)=>{const text=JSON.stringify(request.messages);for(const job of jobs)if(text.includes('marker-'+job.name))entered.add(job.name);return createAssistantMessageEventStream();};
 await f.agent.open();
 const started:Record<string,Started>={},markSubmitted=f.queue.markSubmitted.bind(f.queue);let analyst=0;
 const until=async(condition:()=>boolean)=>{const deadline=Date.now()+5000;while(!condition()){if(Date.now()>deadline)throw Error('fixture condition timeout');await new Promise(r=>setTimeout(r,2));}};
 for(const spec of jobs){
  const message='marker-'+spec.name;
  const job=spec.telegram?control.admit('crash-'+spec.name,message,'telegram',spec.kind==='analysis'):f.queue.enqueue({requestId:'crash-'+spec.name,kind:spec.kind,payload:{message}});
  if(spec.telegram){f.store.set('jobTelegramGeneration:'+job.id,'g');turns.attach(job,'g',42);}
  const chat=!!spec.telegram&&spec.kind==='chat';
  const claimed=job.lane==='analyst'?f.queue.claim('analyst','crashing'):f.queue.claim('coordinator','crashing',now(),chat?'chat':'financial');
  if(claimed?.id!==job.id)throw Error('fixture claim mismatch');
  if(spec.unbound)f.queue.markSubmitted=(id,token,submission)=>{
   if(id===job.id){started[spec.name]={jobId:job.id,conversationId:f.queue.get(job.id)!.conversation_id,submissionId:submission};process.send?.({type:'ready',started});process.kill(process.pid,'SIGSTOP');}
   return markSubmitted(id,token,submission);
  };
  void f.agent.runJob(claimed,job.lane==='analyst'?analyst++:chat?2:undefined).catch(()=>{});
  if(spec.unbound){await new Promise(()=>{});}
  await until(()=>entered.has(spec.name)&&f.queue.get(job.id)?.submitted===1);
  const row=f.queue.get(job.id)!;started[spec.name]={jobId:job.id,conversationId:row.conversation_id,submissionId:row.submission_id!};
  // Stop accepted and acknowledged, but the process dies before any native abort.
  if(spec.stop&&(await turns.stop(job.id,'g',turns.get(job.id)!.version,'stop-'+spec.name)).state!=='received')throw Error('fixture stop rejected');
 }
 process.send?.({type:'ready',started});await new Promise(()=>{});
}
