import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../store.js';
import {Queue} from '../queue.js';
import {Collector} from '../collector.js';
import {AutomaticAdmission,HTLC_FAILURE_SETTLE_MS} from '../automatic-admission.js';

test('channel lifecycle updates become events; active/inactive flaps do not',async()=>{
 const s=new Store(':memory:'),node:any={channelEvents:async(onEvent:(e:any)=>void)=>{
  onEvent({type:'OPEN_CHANNEL',open_channel:{chan_id:'11',remote_pubkey:'02aa',capacity:'500000'}});
  onEvent({type:'ACTIVE_CHANNEL',active_channel:{output_index:1}});onEvent({type:'INACTIVE_CHANNEL',inactive_channel:{output_index:1}});
  onEvent({type:'CLOSED_CHANNEL',closed_channel:{chan_id:'12',remote_pubkey:'02bb',close_type:'REMOTE_FORCE_CLOSE',capacity:'1000000'}});
 }};
 try{await new Collector(s,node,{} as any,'unused').channels(new AbortController().signal);
  const rows=s.all("SELECT type,source,target,details FROM events ORDER BY source").map(r=>({...r,details:JSON.parse(r.details)}));
  assert.deepEqual(rows.map(r=>[r.type,r.source,r.target,r.details.update,r.details.closeType]),[['channel_lifecycle','11','02aa','open_channel',null],['channel_lifecycle','12','02bb','closed_channel','REMOTE_FORCE_CLOSE']]);
 }finally{s.close();}
});

test('a channel event or a settled burst of three HTLC failures admits one coordinator review',()=>{
 const s=new Store(':memory:'),q=new Queue(s);let time=Date.parse('2026-10-26T12:00:00Z');const a=new AutomaticAdmission(q,()=>time);
 const event=(id:string,type:string,ago:number)=>s.event({id,at:new Date(time-ago).toISOString(),type,source:'1',target:'2',amountMsat:'1000',feeMsat:'0'});
 const done=(id:string)=>s.run("UPDATE jobs SET state='completed' WHERE id=?",id);
 try{
  done(a.admit('node','coordinator')!.id);assert.equal(a.admit('node','coordinator'),undefined);
  event('f1','htlc_rejected',600000);event('f2','htlc_rejected',600000);assert.equal(a.admit('node','coordinator'),undefined,'two failures are not a trigger');
  event('f3','htlc_rejected',30000);assert.equal(a.admit('node','coordinator'),undefined,'the third failure is still settling');
  time+=HTLC_FAILURE_SETTLE_MS;const burst=a.admit('node','coordinator')!;assert.ok(burst);done(burst.id);
  assert.equal(a.admit('node','coordinator'),undefined,'the burst is consumed once');
  event('c1','channel_lifecycle',0);const channel=a.admit('node','coordinator')!;assert.ok(channel);done(channel.id);
  assert.equal(a.admit('node','coordinator'),undefined);
 }finally{s.close();}
});
