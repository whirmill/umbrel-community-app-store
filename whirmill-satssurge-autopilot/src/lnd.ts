import https from 'node:https';
import { readFileSync } from 'node:fs';
import { now, integer, type Channel, type Snapshot, type PaymentOutcome } from './domain.js';

export interface NodeClient {
  snapshot():Promise<Snapshot>;
  forwards(start:number,end:number):Promise<any[]>;
  payments():Promise<any[]>;
  invoice(amountSat:string,memo:string):Promise<{hash:string;request:string}>;
  send(request:string,source:string,lastPeer:string,capMsat:string):Promise<PaymentOutcome>;
  track(hash:string):Promise<PaymentOutcome | undefined>;
  updateFee(channel:Channel,ppm:number):Promise<void>;
  htlc(onEvent:(e:any)=>void,signal:AbortSignal):Promise<void>;
}
export class Lnd implements NodeClient {
  private agent:https.Agent;
  private readToken:string;private writeToken:string;
  constructor(private base:string, caFile:string, readFile:string,writeFile:string) {
    const u=new URL(base);if(u.protocol!=='https:')throw new Error('LND requires TLS');
    this.agent=new https.Agent({ca:readFileSync(caFile),keepAlive:true});
    this.readToken=readFileSync(readFile).toString('hex');this.writeToken=readFileSync(writeFile).toString('hex');
  }
  async call(path:string,body?:unknown,write=false,stream?:((row:any)=>void),signal?:AbortSignal):Promise<any> {
    return new Promise((resolve,reject)=>{
      const req=https.request(new URL(path,this.base),{agent:this.agent,method:body===undefined?'GET':'POST',headers:{'Grpc-Metadata-macaroon':write?this.writeToken:this.readToken,'Content-Type':'application/json'},signal},res=>{
        let buf='';let bytes=0;let last:any;
        if(res.statusCode!==200){res.resume();reject(new Error(`LND HTTP ${res.statusCode}`));return;}
        res.setEncoding('utf8');res.on('data',(chunk:string)=>{
          bytes+=Buffer.byteLength(chunk);if(!stream&&bytes>32*1024*1024){req.destroy(new Error('LND response size limit'));return;}
          buf+=chunk;
          if(stream){let nl;while((nl=buf.indexOf('\n'))>=0){const line=buf.slice(0,nl);buf=buf.slice(nl+1);if(line.trim())try{const row=JSON.parse(line);if(row.error)throw new Error('LND stream failure');last=row.result??row;stream(last);}catch(e){req.destroy(e as Error);}}}
        });
        res.on('error',reject);res.on('end',()=>{try{if(stream){if(buf.trim()){const row=JSON.parse(buf);if(row.error)throw new Error('LND stream failure');last=row.result??row;stream(last);}resolve(last);}else resolve(JSON.parse(buf));}catch(e){reject(e);}});
      });
      if(!signal)req.setTimeout(stream?45_000:20_000,()=>req.destroy(new Error('LND timeout; outcome may be uncertain')));
      req.on('error',reject);if(body!==undefined)req.write(JSON.stringify(body));req.end();
    });
  }
  async snapshot():Promise<Snapshot> {
    const [info,wallet,list]=await Promise.all([this.call('/v1/getinfo'),this.call('/v1/balance/blockchain'),this.call('/v1/channels')]);
    if(!Array.isArray(list.channels) || typeof info.identity_pubkey!=='string' || wallet.confirmed_balance===undefined)throw new Error('Incompatible LND snapshot schema');
    const channels:Channel[]=[];
    for(const c of list.channels??[]) {
      const edge=await this.call('/v1/graph/edge/'+c.chan_id);
      const p=edge.node1_pub===info.identity_pubkey?edge.node1_policy:edge.node2_policy;
      if(!p)throw new Error('Missing local graph policy');
      channels.push({id:String(c.chan_id),point:c.channel_point,peer:c.remote_pubkey,alias:c.peer_alias??c.remote_pubkey.slice(0,12),active:c.active===true,capacitySat:String(c.capacity),localSat:String(c.local_balance),remoteSat:String(c.remote_balance),reserveSat:String(c.local_constraints?.chan_reserve_sat??0),pendingSat:(c.pending_htlcs??[]).reduce((n:bigint,h:any)=>n+integer(h.amount),0n).toString(),baseMsat:String(p.fee_base_msat),ppm:Number(p.fee_rate_milli_msat),cltv:Number(p.time_lock_delta),minMsat:String(p.min_htlc),maxMsat:String(p.max_htlc_msat)});
    }
    return {at:now(),identity:info.identity_pubkey,synced:info.synced_to_chain===true&&info.synced_to_graph===true,confirmedSat:String(wallet.confirmed_balance),channels};
  }
  async forwards(start:number,end:number) {
    let offset=0;const rows:any[]=[];
    for(let pages=0;pages<10000;pages++) {
      const p=await this.call('/v1/switch',{start_time:String(start),end_time:String(end),index_offset:offset,num_max_events:1000});
      if(!Array.isArray(p.forwarding_events))throw new Error('Invalid forward page');rows.push(...p.forwarding_events);
      if(p.forwarding_events.length<1000)return rows;
      const next=Number(p.last_offset_index);if(!Number.isSafeInteger(next)||next<=offset)throw new Error('Forward pagination stalled');offset=next;
    }throw new Error('Forward pagination limit; incomplete');
  }
  async payments() {
    let offset='0';const out:any[]=[];
    for(let i=0;i<1000;i++){
      const p=await this.call('/v1/payments?include_incomplete=true&max_payments=1000&index_offset='+offset);
      if(!Array.isArray(p.payments))throw new Error('Invalid payments page');out.push(...p.payments);
      if(p.payments.length<1000)return out;
      const next=String(p.last_index_offset);if(integer(next)<=integer(offset))throw new Error('Payment pagination stalled');offset=next;
    }throw new Error('Payments incomplete');
  }
  async invoice(amountSat:string,memo:string) {
    const r=await this.call('/v1/invoices',{value:amountSat,memo,expiry:'300'},true);
    if(!r.r_hash || !r.payment_request)throw new Error('Invalid self invoice');
    return {hash:Buffer.from(r.r_hash,'base64').toString('hex'),request:r.payment_request};
  }
  private outcome(p:any):PaymentOutcome {
    const routes=(p.htlcs??[]).filter((h:any)=>h.status==='SUCCEEDED').map((h:any)=>h.route);
    const route=routes[0];
    const endpointsValid=routes.length>0 && routes.every((r:any)=>r.hops?.[0]?.chan_id===route?.hops?.[0]?.chan_id && r.hops?.at(-1)?.chan_id===route?.hops?.at(-1)?.chan_id);
    return {status:p.status,feeMsat:String(p.fee_msat??0),amountSat:String(p.value_sat??0),source:endpointsValid?route?.hops?.[0]?.chan_id:undefined,target:endpointsValid?route?.hops?.at(-1)?.chan_id:undefined,index:p.payment_index?String(p.payment_index):undefined};
  }
  async send(request:string,source:string,lastPeer:string,capMsat:string) {
    const r=await this.call('/v2/router/send',{payment_request:request,outgoing_chan_ids:[source],last_hop_pubkey:Buffer.from(lastPeer,'hex').toString('base64'),fee_limit_msat:capMsat,timeout_seconds:30,max_parts:8,allow_self_payment:true,no_inflight_updates:true},true,()=>{});
    if(!r || !['SUCCEEDED','FAILED','IN_FLIGHT'].includes(r.status))throw new Error('No authoritative terminal payment response');return this.outcome(r);
  }
  async track(hash:string) {
    // TrackPaymentV2 is streaming. A 404 after an uncertain send is not proof of failure.
    const r=await this.call('/v2/router/track/'+encodeURIComponent(Buffer.from(hash,'hex').toString('base64'))+'?no_inflight_updates=true',undefined,false,()=>{});
    return r?this.outcome(r):undefined;
  }
  async updateFee(c:Channel,ppm:number) {
    const [tx,index]=c.point.split(':');
    const r=await this.call('/v1/chanpolicy',{chan_point:{funding_txid_str:tx,output_index:Number(index)},base_fee_msat:c.baseMsat,fee_rate:ppm/1_000_000,time_lock_delta:c.cltv,min_htlc_msat:c.minMsat,min_htlc_msat_specified:true,max_htlc_msat:c.maxMsat},true);
    if(r.failed_updates?.length)throw new Error('LND rejected channel policy');
  }
  async htlc(onEvent:(e:any)=>void,signal:AbortSignal) {await this.call('/v2/router/htlcevents',undefined,false,onEvent,signal);}
}
