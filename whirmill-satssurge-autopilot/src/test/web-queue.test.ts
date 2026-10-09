import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {webcrypto} from 'node:crypto';

// Exercise the shipped browser script with an ambiguous acknowledgement, not a copy of its algorithm.
function browser(){
  const fields=new Map<string,any>();
  const element=()=>({value:'',disabled:false,textContent:'',innerHTML:'',hidden:false,children:[] as any[],append(...x:any[]){this.children.push(...x);},replaceChildren(){this.children=[];}});
  const get=(key:string)=>{if(!fields.has(key))fields.set(key,element());return fields.get(key);};
  const storage=new Map<string,string>();
  const ctx:any={sessionStorage:{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>storage.set(k,v),removeItem:(k:string)=>storage.delete(k)},document:{getElementById:get,createElement:element},crypto:webcrypto,Uint8Array,Intl,JSON,console,setInterval:()=>0,alert:()=>{},fetch:async()=>{throw new Error('not connected');}};
  runInNewContext(readFileSync('public/app.js','utf8')+'\nglobalThis.web={api,submitMessage,renderJobs,renderDiagnostics,renderCompetition,sats};',ctx);
  return {ctx,get};
}
test('web reinvites same receipt after ambiguous acknowledgement and accepts concurrent queued messages',async()=>{
  const {ctx,get}=browser();get('message').value='Analizza le rotte';const requests:any[]=[];let fail=true;
  ctx.fetch=async(path:string,options:any)=>{
    if(path==='/api/chat'){
      const payload=JSON.parse(options.body);requests.push(payload);
      if(fail){fail=false;throw new Error('connection lost after admission');}
      return {ok:true,json:async()=>({job:{id:'stable-receipt',state:'queued'}})};
    }
    throw new Error('status unavailable');
  };
  await ctx.web.submitMessage('chat');assert.equal(get('message').value,'Analizza le rotte');
  await ctx.web.submitMessage('chat');assert.equal(requests[0].requestId,requests[1].requestId);assert.match(requests[0].requestId,/^owner:[a-f0-9]{32}$/);
  assert.equal(get('message').value,'');assert.match(get('chat-status').textContent,/accettata/);
  get('message').value='Seconda richiesta';await ctx.web.submitMessage('chat');assert.notEqual(requests[2].requestId,requests[1].requestId);
});
test('browser keeps owner bearer origin-scoped while allowing same-origin Umbrel proxy authentication',async()=>{
  const {ctx,get}=browser();const token='a'.repeat(64),requests:any[]=[];
  get('owner-password').value='private-fixture';
  ctx.fetch=async(path:string,options:any)=>{
    requests.push({path,options});
    if(path==='/api/owner/login')return {ok:true,status:200,json:async()=>({session:token})};
    return {ok:false,status:401,json:async()=>({error:'expired'})};
  };
  await get('owner-form').onsubmit({preventDefault(){}});
  assert.equal(requests[1].options.headers.Authorization,'Bearer '+token);
  assert.equal(requests.every(r=>r.options.credentials==='same-origin'),true);
  assert.equal(requests.every(r=>r.path.startsWith('/api/')),true);
  assert.equal(requests[0].options.headers.Authorization,'Bearer '); // Empty header is not owner authority.
  assert.equal(ctx.sessionStorage.getItem('satssurge.ownerSession'),null);
  assert.equal(get('owner-panel').hidden,false);
  assert.equal(get('owner-password').value,'');
});
test('old unauthorized request cannot erase a subsequently established owner session',async()=>{
  const {ctx,get}=browser();let release!:(value:any)=>void;const token='b'.repeat(64);
  ctx.fetch=async()=>new Promise(r=>release=r);
  const old=ctx.web.api('status');
  ctx.fetch=async(path:string)=>path==='/api/owner/login'?{ok:true,status:200,json:async()=>({session:token})}:{ok:false,status:503,json:async()=>({error:'fixture'})};
  get('owner-password').value='private-fixture';await get('owner-form').onsubmit({preventDefault(){}});
  assert.equal(ctx.sessionStorage.getItem('satssurge.ownerSession'),token);
  release({ok:false,status:401,json:async()=>({error:'old expired response'})});
  await assert.rejects(old,/old expired response/);
  assert.equal(ctx.sessionStorage.getItem('satssurge.ownerSession'),token);
});
test('web renders queued and terminal analyses as literal text and allows cancellation only before submission',()=>{
  const {ctx,get}=browser();ctx.web.renderJobs({queue:{states:[{state:'queued',count:1}]},pool:{analystRunning:2,maxAnalysts:2},jobs:[
    {id:'a',kind:'chat',state:'queued',created_at:'now'},
    {id:'b',kind:'analysis',state:'completed',created_at:'now',result:JSON.stringify({answer:'<img src=x onerror=attack()>'})},
    {id:'c',kind:'chat',state:'waiting',submitted:1,created_at:'now'}
  ]});
  const rows=get('jobs').children;assert.equal(rows.length,3);assert.equal(rows[0].children.at(-1).textContent,'Annulla richiesta');
  assert.equal(rows[1].children.at(-1).textContent,'<img src=x onerror=attack()>');assert.equal(rows[2].children.length,2);
  assert.match(get('pool-status').textContent,/2 \/ 2/);
});


test('diagnostic UI keeps sources separate and formats integer msat without floating point loss',()=>{
  const {ctx,get}=browser();assert.equal(ctx.web.sats('9007199254740993003'),'9.007.199.254.740.993,003');assert.equal(ctx.web.sats('-1378000'),'−1.378');
  ctx.web.renderDiagnostics({diagnostics:{lndg:{version:'1.11.1',status:'qualified',capturedAt:'now',coverage:{complete:false,note:'Attempt identities unknown'},failures:[{source:'a',target:'b',amountMsat:'1000'}],rebalances:[]},lightningMate:{status:'unavailable',reason:'Capture unavailable'}}});
  const rows=get('diagnostics').children;assert.equal(rows.length,2);assert.match(rows[0].children[1].textContent,/copertura parziale/);assert.match(rows[1].children[1].textContent,/unavailable/i);
});

test('competitive price UI shows unknown liquidity and missing median explicitly as literal text',()=>{
  const {ctx,get}=browser();ctx.web.renderCompetition({competition:{status:'qualified',channels:[{alias:'<script>peer</script>',status:'partial',capturedChannels:1,graphChannelCount:'2',missingPolicies:1,capturedAt:'now',quotes:[{amountSat:'100000',ourFeeMsat:'31000',medianFeeMsat:null,cheaperThanUs:0,announcedEligible:0}]}]}});
  const row=get('competition').children[0];assert.equal(row.children[0].textContent,'<script>peer</script> · partial');
  assert.match(row.children[2].textContent,/mediana annunciata sconosciuta/);assert.match(row.children[3].textContent,/non prova rotte eseguibili/);
});
