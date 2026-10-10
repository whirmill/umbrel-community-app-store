import {fixture} from './pi-fixture.js';
import {ApplicationControl} from '../application-control.js';
import {TelegramTurns} from '../telegram-turns.js';
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai/utils/event-stream';
import {now} from '../domain.js';
if(process.argv[2]==='active-correction-crash'){
 const f=fixture(process.argv[3]!,'state'),turns=new TelegramTurns(f.store,f.queue);let release!:()=>void,entered!:()=>void,correctionEntered!:()=>void,calls=0;
 const first=new Promise<void>(r=>release=r),firstEntered=new Promise<void>(r=>entered=r),correctionReady=new Promise<void>(r=>correctionEntered=r);
 f.store.set('telegramBinding',{generation:'g',chatId:42,userId:42,since:now()});
 f.agent.models.streamSimple=()=>{const stream=createAssistantMessageEventStream(),n=++calls,message:any={role:'assistant',api:'openai-responses',provider:'openai',model:'gpt-6.1-sol',timestamp:Date.now(),usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',content:[{type:'text',text:n===1?'Original before crash':'Active correction partial'}]};if(n===1){entered();void first.then(()=>{stream.push({type:'start',partial:message});stream.push({type:'done',reason:'stop',message});});}else{stream.push({type:'start',partial:message});correctionEntered();}return stream;};
 await f.agent.open();const job=new ApplicationControl(f.store,f.queue).admit('active-correction-crash','hello','telegram');f.store.set('jobTelegramGeneration:'+job.id,'g');turns.attach(job,'g',42);const claimed=f.queue.claim('coordinator','crashing-process')!;void f.agent.runJob(claimed);await firstEntered;const c=turns.receive('active-at-crash',turns.get(job.id)!,'required correction');await turns.steer(c.id);release();await correctionReady;await turns.stop(job.id,'g',turns.get(job.id)!.version,'active-crash-stop');process.send?.({type:'ready',jobId:job.id,submissions:turns.get(job.id)!.submissions});await new Promise(()=>{});
}
if(process.argv[2]==='scoped-terminal-crash'){
 const f=fixture(process.argv[3]!,'state');await f.agent.open();f.queue.recoverAfterRestart();const turns=new TelegramTurns(f.store,f.queue),stop=f.store.get<any>('telegramStop:active-crash-stop'),job=f.queue.get(stop.jobId)!;
 const native=await (f.agent as any).harness.cancelConversationScoped(Number(job.conversation_id),(await import('@earendil-works/chord/context')).BACKGROUND_CONTEXT);
 process.send?.({type:'native-idle',jobId:job.id,native,turn:turns.get(job.id)});await new Promise(()=>{});
}
if(process.argv[2]==='original-before-bind-crash'){
 const f=fixture(process.argv[3]!,'state'),turns=new TelegramTurns(f.store,f.queue);f.store.set('telegramBinding',{generation:'g',chatId:42,userId:42,since:now()});await f.agent.open();
 const job=new ApplicationControl(f.store,f.queue).admit('original-before-bind-crash','hello','telegram');f.store.set('jobTelegramGeneration:'+job.id,'g');turns.attach(job,'g',42);
 // Suppress only operational binding writes, then halt at the first write after the real native submit commit.
 f.queue.bindConversation=()=>{};
 f.queue.markSubmitted=(_id,_token,submission)=>{
  const correction=turns.receive('unplaced-at-original-crash',turns.get(job.id)!,'unplaced correction');void turns.steer(correction.id);void turns.stop(job.id,'g',turns.get(job.id)!.version,'active-crash-stop');
  process.send?.({type:'ready',jobId:job.id,submissions:[submission]});process.kill(process.pid,'SIGSTOP');
 };
 await f.agent.runJob(f.queue.claim('coordinator','crashing-process')!);
}
if(['app-terminal-before-stop-crash','atomic-stop-transaction-crash'].includes(process.argv[2]!)){
 const f=fixture(process.argv[3]!,'state');await f.agent.open();f.queue.recoverAfterRestart();const turns=new TelegramTurns(f.store,f.queue),stop=f.store.get<any>('telegramStop:active-crash-stop'),job=f.queue.get(stop.jobId)!;
 if(process.argv[2]==='app-terminal-before-stop-crash'){
  const native=await (f.agent as any).harness.cancelConversationScoped(Number(job.conversation_id),(await import('@earendil-works/chord/context')).BACKGROUND_CONTEXT);
  // Reproduce the previous committed app-terminal/received-Stop gap with genuine native idle.
  turns.finalize(job.id,'interrupted',{reason:'owner_stop_native_idle',submissionIds:turns.get(job.id)!.submissions,nativeCancellation:native,remoteCancellation:'not_required'});
  process.send?.({type:'app-terminal',jobId:job.id,terminal:f.store.get('telegramTerminal:'+job.id),stop:f.store.get('telegramStop:active-crash-stop')});await new Promise(()=>{});
 }else{
  const set=f.store.set.bind(f.store);f.store.set=(key:string,value:any)=>{
   if(key==='telegramStop:active-crash-stop'&&value.state==='idle_confirmed'){
    process.send?.({type:'atomic-before-stop-write',jobId:job.id});process.kill(process.pid,'SIGSTOP');
   }return set(key,value);
  };
  await f.agent.recoverTelegramStops();
 }
}
