import { createServer } from 'node:http';
import { readFileSync,mkdirSync,existsSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { randomBytes,timingSafeEqual,createHash } from 'node:crypto';
import { Store } from './store.js';
import { Lnd } from './lnd.js';
import { Executor } from './executor.js';
import { Collector } from './collector.js';
import { Agent } from './agent.js';
import { importHistory } from './importer.js';
import { now,json,publicAnswer } from './domain.js';
const directory=resolve(process.env.DATA_DIR??'/data');mkdirSync(directory,{recursive:true,mode:0o700});
const store=new Store(join(directory,'operational.sqlite'));if(!store.get('installedAt'))store.set('installedAt',now());
const importDir=process.env.HISTORY_DIR??'/history';if(existsSync(importDir))importHistory(store,importDir);
const csrf=randomBytes(32).toString('hex');
const ownerPath=join(directory,'owner.secret');if(!existsSync(ownerPath)){const {writeFileSync}=await import('node:fs');writeFileSync(ownerPath,randomBytes(24).toString('hex'),{mode:0o600});}
const owner=readFileSync(ownerPath,'utf8').trim();const ownerDigest=createHash('sha256').update(owner).digest();
const sessions=new Set<string>();
const cookieSession=(cookie:string|undefined)=>cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('satssurge='))?.slice(10);
let agent:Agent|undefined,collector:Collector|undefined;
try{
  const node=new Lnd(process.env.LND_URL??'https://10.21.21.9:8080','/credentials/tls.cert','/credentials/read.macaroon','/credentials/write.macaroon');
  const expected=readFileSync('/credentials/node-pubkey','utf8').trim();if(!/^[0-9a-f]{66}$/.test(expected))throw new Error('Invalid node binding');store.set('expectedIdentity',expected);
  const executor=new Executor(store,node);collector=new Collector(store,node,executor,process.env.INTERLOCK_FILE??'/interlock/status.json');
  agent=new Agent(store,executor,directory);await agent.open();
  await collector.collect();
  setInterval(()=>void collector!.collect(),60000);
  setInterval(()=>void agent!.tick(),60000);void agent.tick();
  const streamLoop=async()=>{try{await collector!.stream(new AbortController().signal);}catch{}setTimeout(()=>void streamLoop(),5000);};void streamLoop();
}catch{store.set('bootstrapReady',false);store.set('blockers',['LND credentials/configuration unavailable; provision dedicated restricted macaroons']);}
const staticFiles:Record<string,[string,string]>={'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8']};
const server=createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'");
  const url=new URL(req.url??'/', 'http://localhost');
  const send=(data:unknown,status=200)=>{res.statusCode=status;res.setHeader('Content-Type','application/json');res.end(json(data));};
  try{
    if(req.method==='GET'&&staticFiles[url.pathname]){const [file,type]=staticFiles[url.pathname]!;res.setHeader('Content-Type',type);res.end(readFileSync(resolve('public',file)));return;}
    if(req.method==='GET'&&url.pathname==='/health'){send({ok:true});return;}
    if(req.method==='POST'&&url.pathname==='/api/owner/login'){
      if(!req.headers.origin || new URL(req.headers.origin).host!==(req.headers['x-forwarded-host']??req.headers.host)) {send({error:'Origin rejected'},403);return;}
      let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>2048){send({error:'Too large'},413);return;}}
      const password=JSON.parse(raw).password;if(typeof password!=='string'||!timingSafeEqual(createHash('sha256').update(password).digest(),ownerDigest)){send({error:'Owner password rejected'},403);return;}
      const session=randomBytes(32).toString('hex');sessions.add(session);res.setHeader('Set-Cookie','satssurge='+session+'; HttpOnly; SameSite=Strict; Path=/'+(req.headers['x-forwarded-proto']==='https'?'; Secure':''));send({connected:true});return;
    }
    if(!sessions.has(cookieSession(req.headers.cookie)??'')){send({error:'Owner authentication required'},401);return;}
    if(req.method==='GET'&&url.pathname==='/api/status'){send({...store.stats(),csrf,chat:(store.get<any[]>('chat')??[]).map(c=>({...c,answer:publicAnswer(c.answer)})),collector:store.get('collector')??{}});return;}
    if(req.method==='GET'&&url.pathname==='/api/auth'){send(agent?await agent.authStatus():{connected:false,events:[]});return;}
    if(req.method!=='POST'){send({error:'Not found'},404);return;}
    // Umbrel app proxy supplies authentication. Every write also requires same-origin + anti-CSRF.
    const origin=req.headers.origin,forwardedHost=req.headers['x-forwarded-host'];const host=typeof forwardedHost==='string'?forwardedHost.split(',')[0]!.trim():req.headers.host;
    if(!origin||new URL(origin).host!==host){send({error:'Origin rejected'},403);return;}
    const token=String(req.headers['x-csrf-token']??'');if(token.length!==csrf.length||!timingSafeEqual(Buffer.from(token),Buffer.from(csrf))){send({error:'CSRF rejected'},403);return;}
    let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>32768){send({error:'Request too large'},413);return;}}
    const body=JSON.parse(raw||'{}');
    if(url.pathname==='/api/pause'){store.set('enabled',false);send({paused:true,note:'Pending operations will still be reconciled'});return;}
    if(url.pathname==='/api/resume'){if(!store.get('bootstrapReady'))throw new Error('Resolve initialization blockers first');store.set('enabled',true);send({enabled:true});void agent?.tick();return;}
    if(!agent)throw new Error('Agent unavailable until LND provisioning');
    if(url.pathname==='/api/auth/start'){agent.login();send({started:true});return;}
    if(url.pathname==='/api/auth/respond'){if(typeof body.value!=='string')throw new Error('Invalid login response');agent.answer(body.value);send({accepted:true});return;}
    if(url.pathname==='/api/model'){if(typeof body.model!=='string'||!(await agent.models.getAvailable('openai')).some(m=>m.id===body.model))throw new Error('Unavailable model');store.set('model',body.model);send({saved:true});return;}
    if(url.pathname==='/api/chat'){if(typeof body.message!=='string'||!body.message.trim())throw new Error('Empty message');send(await agent.run(body.message));return;}
    send({error:'Not found'},404);
  }catch(e){send({error:e instanceof Error?e.message:'Request failed'},400);}
});
server.listen(Number(process.env.PORT??8080),'0.0.0.0');
