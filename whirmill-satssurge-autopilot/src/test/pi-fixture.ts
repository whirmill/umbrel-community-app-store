import {Agent} from '../agent.js';
import {Store} from '../store.js';
import {Queue} from '../queue.js';
import {join} from 'node:path';
import {appendFileSync} from 'node:fs';
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai/utils/event-stream';

export const proposal={kind:'rebalance',category:'exploratory',strategy:'fake-only',source:'a',target:'b',amountSat:'1',maxFeeMsat:'1',decisionCapMsat:'1',demandKey:'a->b',evidenceIds:[],problem:'test',evidence:'test',whyAct:'test',alternatives:'wait',verify:'test',hypothesis:'test'};
export function fixture(directory:string,mode:'unsafe'|'analyst'|'quota'|'caller'|'state'|'manual',interrupt=false){
  const store=new Store(join(directory,'operational.sqlite'));store.set('bootstrapReady',true);store.set('model','gpt-6.1-sol');
  const queue=new Queue(store);const calls:{tools:string[],thinking:string[],conversations:string[]}= {tools:[],thinking:[],conversations:[]};
  const executor={execute:async()=>{
    appendFileSync(join(directory,'effects.jsonl'),JSON.stringify({effect:'simulated financial RPC'})+'\n');
    if(interrupt){process.send?.({type:'effect'});await new Promise(()=>{});}
    return {status:'SUCCEEDED'};
  }};
  const agent=new Agent(store,executor as any,directory,queue);
  // Replace only the model boundary. The actual Agent, registry, Pi Durable,
  // SQLite and caller fencing run unchanged; no credentials or network needed.
  agent.credentials.read=async()=>({type:'oauth'} as any);
  agent.models.getModel=()=>({id:'gpt-6.1-sol',name:'fixture',api:'openai-responses',provider:'openai',baseUrl:'https://invalid.test',input:['text'],reasoning:true,contextWindow:32768,maxTokens:1000,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}} as any);
  agent.models.streamSimple=(_model,request,options)=>{
    calls.thinking.push(String(options?.reasoning));const stream=createAssistantMessageEventStream();
    const hasResult=request.messages.some((m:any)=>m.role==='toolResult');
    const heldOwner=mode==='caller'&&JSON.stringify(request.messages).includes('hold-owner');
    const tool=mode==='state'?'state_page_analyst_0':mode==='manual'?'create_manual_proposal':'execute_decision';
    calls.tools.push(...(request as any).messages.filter((m:any)=>m.role==='system').flatMap((m:any)=>m.tools??[]).map((t:any)=>t.name));
    const message:any={role:'assistant',api:'openai-responses',provider:'openai',model:'gpt-6.1-sol',timestamp:Date.now(),usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},
      stopReason:mode==='quota'?'error':hasResult||heldOwner?'stop':'toolUse',
      content:mode==='quota'?[]:hasResult||heldOwner?[{type:'text',text:mode==='state'?JSON.stringify(request.messages.filter((m:any)=>m.role==='toolResult')):'Verified terminal tool receipt'}]:[{type:'toolCall',id:'fixture-call',name:tool,arguments:mode==='state'?{section:'competition'}:proposal}]};
    const emit=()=>{
      if(mode==='quota'){message.errorMessage='Quota exceeded; private-provider-detail';stream.push({type:'error',reason:'error',error:message});}
      else{stream.push({type:'start',partial:message});stream.push({type:'done',reason:message.stopReason,message});}
    };if(heldOwner)setTimeout(emit,300);else queueMicrotask(emit);
    return stream;
  };
  return {store,queue,agent,calls};
}

if(process.argv[2]==='crash-fixture'){
  const f=fixture(process.argv[3]!,'unsafe',true);await f.agent.open();
  const job=f.queue.enqueue({requestId:'durable-crash',kind:'chat',payload:{message:'simulated effect'}});
  const claimed=f.queue.claim('coordinator','fixture')!;
  process.send?.({type:'claimed',job:job.id});await f.agent.runJob(claimed);
}
