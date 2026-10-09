import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {fixture} from './pi-fixture.js';
import {BACKGROUND_CONTEXT as context} from '@earendil-works/chord/context';

test('actual analyst registry returns current competition tail without the large alternative arrays',{timeout:10000},async()=>{
  const directory=mkdtempSync(join(tmpdir(),'surge-pi-pages-'));const f=fixture(directory,'state');
  try{
    f.store.set('competition',{status:'qualified',coverage:'Public graph only',channels:Array.from({length:10},(_,i)=>({id:String(i),alias:'peer'+i,quotes:[{ourFeeMsat:'40000'}],alternatives:Array.from({length:100},(_,j)=>({id:String(j)})),alternativesTruncated:true}))});
    await f.agent.open();f.queue.enqueue({requestId:'current-price-pages',kind:'analysis',payload:{message:'read current prices'}});
    const result=await f.agent.runJob(f.queue.claim('analyst','owner')!,0);
    assert.match(result.answer,/peer9/);assert.match(result.answer,/40000/);assert.match(result.answer,/availableAlternativeRows/);
    assert.doesNotMatch(result.answer,/Unknown tool|truncated by/);
    assert.equal(existsSync(join(directory,'effects.jsonl')),false);
  }finally{await f.agent.close();f.store.close();rmSync(directory,{recursive:true,force:true});}
});

test('real Pi Durable recovers a killed unsafe tool without a second effect or submission',{timeout:15000},async()=>{
  const directory=mkdtempSync(join(tmpdir(),'surge-pi-crash-'));
  const child=fork(new URL('./pi-fixture.js',import.meta.url),['crash-fixture',directory],{stdio:['ignore','ignore','pipe','ipc']});
  let errors='';child.stderr?.on('data',d=>errors+=d.toString());
  try{
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Fixture did not reach effect: '+errors)),7000);
      child.on('message',(m:any)=>{if(m.type==='effect'){clearTimeout(timer);resolve();}});
      child.once('exit',code=>{clearTimeout(timer);reject(new Error('Fixture exited '+code+': '+errors));});
    });
    const exited=once(child,'exit');child.kill('SIGKILL');await exited;
    const f=fixture(directory,'unsafe');
    try{
      f.queue.recoverAfterRestart();const before=f.queue.list()[0]!;
      assert.equal(before.state,'waiting');assert.ok(before.submission_id);assert.ok(before.conversation_id);
      await f.agent.open();const claimed=f.queue.claim('coordinator','new-process')!;
      const result=await f.agent.runJob(claimed);
      assert.match(result.answer,/terminal tool receipt/);
      assert.equal(f.queue.get(before.id)?.submission_id,before.submission_id);
      assert.equal(f.queue.get(before.id)?.conversation_id,before.conversation_id);
      assert.equal(readFileSync(join(directory,'effects.jsonl'),'utf8').trim().split('\n').length,1);
      assert.ok(f.calls.thinking.every(level=>level==='high'));
    }finally{await f.agent.close();f.store.close();}
  }finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');rmSync(directory,{recursive:true,force:true});}
});

test('real Pi registry denies financial tools to analyst conversations',{timeout:10000},async()=>{
  const directory=mkdtempSync(join(tmpdir(),'surge-pi-analyst-'));const f=fixture(directory,'analyst');
  try{
    await f.agent.open();const job=f.queue.enqueue({requestId:'analyst-isolation',kind:'analysis',payload:{message:'try unavailable financial tool'}});
    const claimed=f.queue.claim('analyst','owner')!;const result=await f.agent.runJob(claimed,0);
    assert.match(result.answer,/terminal tool receipt/);
    assert.equal(existsSync(join(directory,'effects.jsonl')),false);
    assert.ok(f.queue.get(job.id)?.submission_id);
  }finally{await f.agent.close();f.store.close();rmSync(directory,{recursive:true,force:true});}
});

test('real model-error receipt blocks new AI but remains terminal without exposing provider detail',{timeout:10000},async()=>{
  const directory=mkdtempSync(join(tmpdir(),'surge-pi-quota-'));const f=fixture(directory,'quota');
  try{
    await f.agent.open();const job=f.queue.enqueue({requestId:'quota-terminal',kind:'chat',payload:{message:'read'}});
    const claimed=f.queue.claim('coordinator','owner')!;
    await assert.rejects(f.agent.runJob(claimed),/original submission terminal/);
    assert.equal(await f.agent.available(),false);
    assert.equal(f.store.get<any>('agent').status,'unavailable');
    assert.ok(f.queue.get(job.id)?.submission_id);
    assert.equal(existsSync(join(directory,'effects.jsonl')),false);
    assert.doesNotMatch(JSON.stringify(f.store.get('agent')),/private-provider-detail/);
    const reopened=fixture(directory,'unsafe');
    try{assert.equal(await reopened.agent.available(),false);assert.equal(reopened.queue.get(job.id)?.submission_id,f.queue.get(job.id)?.submission_id);}
    finally{await reopened.agent.close();reopened.store.close();}
  }finally{await f.agent.close();f.store.close();rmSync(directory,{recursive:true,force:true});}
});

test('another durable coordinator conversation cannot borrow an active job financial authority',{timeout:10000},async()=>{
  const directory=mkdtempSync(join(tmpdir(),'surge-pi-caller-'));const f=fixture(directory,'caller');
  let ownRun:Promise<unknown>|undefined;
  try{
    await f.agent.open();const job=f.queue.enqueue({requestId:'owned-coordinator',kind:'chat',payload:{message:'hold-owner'}});
    const claimed=f.queue.claim('coordinator','owner')!;ownRun=f.agent.runJob(claimed);
    const deadline=Date.now()+3000;
    while(!f.queue.get(job.id)?.submission_id){if(Date.now()>deadline)throw new Error('Owner did not submit');await new Promise(r=>setTimeout(r,2));}
    const ownedConversation=f.queue.get(job.id)!.conversation_id;
    // Use the real harness to simulate a legacy/foreign conversation selecting
    // the coordinator extension while another job owns execution authority.
    const harness=(f.agent as any).harness;
    const foreign=await harness.createConversation({ownership:{kind:'ownerless'},agent:{model:{provider:'openai',modelId:'gpt-6.1-sol'},thinkingLevel:'high',extensions:[{name:'satssurge'}]}},context);
    const submission=await foreign.submit({type:'input',content:'foreign caller',requestId:'foreign-caller',whenBusy:'reject'},context);
    const outcome=await submission.wait(context);assert.equal(outcome.status,'done');
    const transcript=await foreign.context(context);
    assert.match(JSON.stringify(transcript.entries),/Lost job ownership/);
    assert.equal(existsSync(join(directory,'effects.jsonl')),false);
    await ownRun;
    assert.equal(f.queue.get(job.id)?.conversation_id,ownedConversation);
  }finally{await ownRun?.catch(()=>{});await f.agent.close();f.store.close();rmSync(directory,{recursive:true,force:true});}
});

test('actual fresh continuation analyst denies finance and preserves parent receipt',{timeout:10000},async()=>{
  const {Research}=await import('../research.js');
  const directory=mkdtempSync(join(tmpdir(),'surge-pi-continuation-')),f=fixture(directory,'analyst');
  try{
    const research=new Research(f.store),parent=f.queue.enqueue({requestId:'continuation-parent',kind:'autonomy',scope:'node',origin:'scheduler',purpose:'economic',payload:{message:'parent'}});
    research.initialize(parent);research.state(parent);
    f.store.run("UPDATE jobs SET state='completed',submitted=1,conversation_id='synthetic-parent-conversation',submission_id='synthetic-parent-submission' WHERE id=?",parent.id);
    const next=research.continue(f.queue,f.queue.get(parent.id)!)!;
    await f.agent.open();const claimed=f.queue.claim('analyst','test')!;assert.equal(claimed.id,next.id);const result=await f.agent.runJob(claimed,0);assert.match(result.answer,/terminal tool receipt/);
    assert.equal(existsSync(join(directory,'effects.jsonl')),false);assert.equal(f.queue.get(parent.id)!.submission_id,'synthetic-parent-submission');assert.notEqual(f.queue.get(next.id)!.submission_id,'synthetic-parent-submission');assert.notEqual(f.queue.get(next.id)!.conversation_id,'synthetic-parent-conversation');assert.equal(f.store.get('jobCapability:'+next.id),'read_only_research');
  }finally{await f.agent.close();f.store.close();rmSync(directory,{recursive:true,force:true});}
});
