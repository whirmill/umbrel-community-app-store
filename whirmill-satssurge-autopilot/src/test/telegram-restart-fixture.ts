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
