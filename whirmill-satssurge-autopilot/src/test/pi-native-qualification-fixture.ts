// Native-only, isolated SQLite fixtures. No Agent, credentials, network or financial tools.
import {BACKGROUND_CONTEXT as context} from '@earendil-works/chord/context';
import {Harness,createRegistry,DEFAULT_COMPACTION_POLICY,LiveDoc,defineDoc,defineTask,defineExtension,type Conversation,type ConversationId,type TaskId} from '@earendil-works/pi-durable';
import {createModels} from '@earendil-works/pi-ai/models';
import {fauxProvider,fauxAssistantMessage} from '@earendil-works/pi-ai/providers/faux';
import type {AssistantMessage,TranscriptContext} from '@earendil-works/pi-ai';
import {openNodeSqliteDatabase} from '@earendil-works/pi-durable/storage/sqlite/node';
import {SqliteStorage} from '@earendil-works/pi-durable/storage/sqlite';
import {join} from 'node:path';

export {context,DEFAULT_COMPACTION_POLICY};
export const Plan=defineDoc<{steps:string[],phase:string}>({kind:'fixture.plan',version:1,scope:'conversation',history:'rewindable',fork:'asOf',initial:()=>({steps:[],phase:'new'})});
export const Checkpoint=defineTask<{}, {phase:'prepare'}|{phase:'finish'}, string>({
  name:'fixture.checkpoint',version:1,initial:()=>({phase:'prepare'}),phases:{
    prepare:async (_task,runtime,ctx)=>{await runtime.commit(async tx=>{const plan=await tx.doc(Plan,runtime.conversationId);plan.steps.push('committed preparation');plan.phase='prepared';return {status:'running',checkpoint:{phase:'finish'}};},ctx);},
    finish:async (_task,runtime,ctx)=>{process.send?.({type:'checkpoint',taskId:runtime.taskId,conversationId:runtime.conversationId});await runtime.sleep(runtime.now()+60_000,ctx);await runtime.commit(async tx=>{(await tx.doc(Plan,runtime.conversationId)).phase='finished';return {status:'terminal',outcome:{status:'completed',result:'done'}};},ctx);},
  },abort:async (_task,runtime,ctx)=>runtime.commit(()=>({status:'terminal',outcome:{status:'aborted'}}),ctx),
});
export const AnalystOwner=defineTask<{}, {phase:'create'}|{phase:'wait',child:ConversationId,task:TaskId<string>}, string>({
  name:'fixture.analyst-owner',version:1,initial:()=>({phase:'create'}),phases:{
    create:async (task,runtime,ctx)=>runtime.commit(async tx=>{const child=await tx.createConversation({ownership:{kind:'task',taskId:task.id}});const work=await tx.createTask(Checkpoint,{},{ownership:{kind:'conversation'},conversationId:child.id});return {status:'waiting',checkpoint:{phase:'wait',child:child.id,task:work},on:[work],policy:'allSettled'};},ctx),
    wait:async (_task,runtime,ctx)=>runtime.commit(()=>({status:'terminal',outcome:{status:'completed',result:'child finished'}}),ctx),
  },abort:async (_task,runtime,ctx)=>runtime.commit(async tx=>{(await tx.doc(Plan,runtime.conversationId)).phase='owner-aborted';return {status:'terminal',outcome:{status:'aborted'}};},ctx),
});

export function summaryRequest(c:{messages:readonly any[]}){return c.messages[0]?.role==='system'&&String(c.messages[0].content).includes('summarization');}
export async function nativeFixture(directory:string,options:{settings?:any,respond?:(c:TranscriptContext)=>AssistantMessage|Promise<AssistantMessage>}={}){
  const path=join(directory,'native.sqlite');const faux=fauxProvider({models:[{id:'qualified-64k',contextWindow:65536,maxTokens:30000}],tokenSize:{min:200000,max:200000}});
  const models=createModels();models.setProvider(faux.provider);const responses:{summary:boolean,message:AssistantMessage}[]=[];
  const stream=models.streamSimple.bind(models);models.streamSimple=(m,c,o)=>{const s=stream(m,c,o);void s.result().then(message=>responses.push({summary:summaryRequest(c),message}));return s;};
  faux.setResponses(Array.from({length:80},()=>options.respond??(c=>fauxAssistantMessage(summaryRequest(c)?'## Goal\nDeterministic checkpoint':'DETAIL '.repeat(15000)))));
  let db:Awaited<ReturnType<typeof openNodeSqliteDatabase>>;let harness:Harness;let root:Conversation;let closed=true;
  async function open(){db=await openNodeSqliteDatabase(path);await db.exec('PRAGMA synchronous=FULL');const registry=createRegistry();registry.install(defineExtension({name:'fixture',tasks:[Checkpoint,AnalystOwner]}));harness=await Harness.open(await SqliteStorage.open(db),{models,registry,settings:{retry:{maxRetries:0},...options.settings}},context);closed=false;root=await harness.root(context,{agent:{model:{provider:'faux',modelId:'qualified-64k'}}});}
  async function close(){if(!closed){await harness.close(context);closed=true;}}
  await open();return {get harness(){return harness},get db(){return db},get root(){return root},get closed(){return closed},responses,faux,open,close,path};
}
export async function settle(f:Awaited<ReturnType<typeof nativeFixture>>,requestId:string){const s=await f.root.submit({type:'input',content:'Question '+requestId,requestId},context);const outcome=await s.wait(context);await f.root.waitForIdle(context);for(const {taskId} of (await f.harness.snapshot(LiveDoc,f.root.id,context))?.compactions??[])await f.harness.waitForTask(taskId,context);return {id:s.id,outcome};}
export async function rows(f:Awaited<ReturnType<typeof nativeFixture>>,table:'entries'|'documents'|'submissions'|'tasks'){return f.db.all<any>('SELECT * FROM '+table+' ORDER BY id');}

if(['native-crash','native-owned-crash'].includes(process.argv[2]??'')){
  const f=await nativeFixture(process.argv[3]!);const taskId=await f.root.commit(tx=>process.argv[2]==='native-owned-crash'?tx.createTask(AnalystOwner,{},{ownership:{kind:'conversation'}}):tx.createTask(Checkpoint,{},{ownership:{kind:'conversation'}}),context);
  process.send?.({type:'identity',conversationId:f.root.id,taskId});await f.harness.waitForTask(taskId,context);
}
if(process.argv[2]==='native-summary-crash'){
  const f=await nativeFixture(process.argv[3]!,{respond:async c=>{if(summaryRequest(c)){process.send?.({type:'summary'});await new Promise<void>(()=>{});}return fauxAssistantMessage('DETAIL '.repeat(15000));}});
  await settle(f,'summary-before-crash');const submission=await f.root.submit({type:'input',content:'trigger default summary',requestId:'summary-at-crash'},context);process.send?.({type:'identity',conversationId:f.root.id,submissionId:submission.id});await submission.wait(context);
}
