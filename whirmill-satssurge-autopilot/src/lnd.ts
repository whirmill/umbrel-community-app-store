import { readFileSync, statSync } from 'node:fs';
import { X509Certificate, createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import * as grpc from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { now, integer, type Channel, type Snapshot, type PaymentOutcome } from './domain.js';

export type TransportFailure = 'certificate_missing'|'certificate_invalid'|'certificate_expired'|'certificate_not_yet_valid'|'endpoint_mismatch'|'authentication'|'permission_denied'|'deadline'|'cancelled'|'unavailable'|'resource_limit'|'rpc_failure'|'acquisition_failure';
const RPC_METHODS=['getInfo','walletBalance','listChannels','getChanInfo','forwardingHistory','listPayments','addInvoice','updateChannelPolicy','sendPaymentV2','trackPaymentV2','subscribeHtlcEvents','subscribeChannelGraph','listPeers','connectPeer','estimateFee','openChannelSync','closeChannel','pendingChannels','closedChannels','getNodeInfo'] as const;
const ACQUISITION_REASONS=['malformed_response','binding_mismatch','callback_error','not_subscribed','size_limit','invalid_request','invalid_config'] as const;
export type LndFailureContext={failureAt:string;origin:'rpc'|'local_acquisition'|'transport';method?:typeof RPC_METHODS[number];grpcStatus?:number;reason?:typeof ACQUISITION_REASONS[number]};
/** Only closed labels and a timestamp cross owner diagnostics boundaries. */
export function safeLndFailureContext(value:unknown):LndFailureContext|undefined {
 const v=value as any;if(!v||!['rpc','local_acquisition','transport'].includes(v.origin)||typeof v.failureAt!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v.failureAt)||!Number.isFinite(Date.parse(v.failureAt)))return undefined;
 return {failureAt:v.failureAt,origin:v.origin,...(RPC_METHODS.includes(v.method)?{method:v.method}:{}),...(Number.isInteger(v.grpcStatus)&&v.grpcStatus>=0&&v.grpcStatus<=16?{grpcStatus:v.grpcStatus}:{}),...(ACQUISITION_REASONS.includes(v.reason)?{reason:v.reason}:{})};
}
export function certificateTransportFailure(failure:unknown):boolean{return ['certificate_missing','certificate_invalid','certificate_expired','certificate_not_yet_valid','endpoint_mismatch'].includes(failure as string);}
export type LndTransportStatus = {transport:'grpc-tls';inspectedAt:string;certificateDigest?:string;validFrom?:string;validTo?:string;warning:'healthy'|'expires_30d'|'expires_7d'|'expired'|'unavailable';failure?:TransportFailure;failureContext?:LndFailureContext;activeChannels:number;activeCalls:number};
export interface NodeClient {
  snapshot():Promise<Snapshot>;
  forwards(start:number,end:number):Promise<any[]>;
  payments():Promise<any[]>;
  invoice(amountSat:string,memo:string):Promise<{hash:string;request:string}>;
  send(request:string,source:string,lastPeer:string,capMsat:string):Promise<PaymentOutcome>;
  track(hash:string):Promise<PaymentOutcome | undefined>;
  updateFee(channel:Channel,ppm:number):Promise<void>;
  htlc(onEvent:(e:any)=>void,signal:AbortSignal):Promise<void>;
  channelRpc?():ChannelRpc|undefined;
  transportStatus?():LndTransportStatus;
  beginCollection?():()=>void;
  close?():void;
}
/** Channel lifecycle under the separate channel credential. Close is cooperative only: no force argument exists. */
export interface ChannelRpc {
  listPeers():Promise<string[]>;
  connectPeer(peer:string,host:string):Promise<void>;
  estimateFee(amountSat:string,targetConf:number):Promise<{feeSat:string;satPerVbyte:string}>;
  openChannel(peer:string,amountSat:string,satPerVbyte:string):Promise<{txid:string;outputIndex:number}>;
  closeChannel(point:string,satPerVbyte:string):Promise<{txid:string}>;
  pendingChannels():Promise<{opens:{peer:string;point:string;capacitySat:string}[];closing:{peer:string;point:string;txid:string}[]}>;
  closedChannels():Promise<{point:string;peer:string;txid:string;type:string}[]>;
  nodeInfo(peer:string):Promise<{alias:string;channels:number;capacitySat:string;addresses:string[]}>;
}
// BIP173 mainnet P2WSH vector, sized like a funding output. Used only to price EstimateFee; nothing is ever sent to it.
const ESTIMATE_ADDRESS='bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3';
/** Closed, read-credential-only acquisition capability. No target, credentials or generic RPC method. */
export interface NativeReadLimits {deadlineMs:number;bodyBytes:number;frameBytes:number;streamBytes:number;frames:number;idleMs:number}
export interface NativeLndRead {
 getInfo(signal:AbortSignal,limits:NativeReadLimits):Promise<unknown>;
 forwardingHistory(request:{start_time:string;end_time:string;index_offset:number;num_max_events:number},signal:AbortSignal,limits:NativeReadLimits):Promise<unknown>;
 listPayments(request:{creation_date_start:string;creation_date_end:string;index_offset:string;max_payments:string;reversed:true;include_incomplete:true;omit_hops:false},signal:AbortSignal,limits:NativeReadLimits):Promise<unknown>;
 listChannels(signal:AbortSignal,limits:NativeReadLimits):Promise<unknown>;
 getChanInfo(channelId:string,signal:AbortSignal,limits:NativeReadLimits):Promise<unknown>;
 subscribeHtlcEvents(onFrame:(row:unknown,bindingSignal?:AbortSignal)=>Promise<void>,onReady:()=>void,signal:AbortSignal,limits:NativeReadLimits):Promise<void>;
 subscribeChannelGraph(onFrame:(row:unknown,bindingSignal?:AbortSignal)=>Promise<void>,onReady:()=>void,signal:AbortSignal,limits:NativeReadLimits):Promise<void>;
}
const protoRoot=fileURLToPath(new URL('../lnd-proto/',import.meta.url));
// Compiled digests bind the vendored runtime schema to the existing lifecycle fingerprint.
for(const [path,digest] of Object.entries({
  'lightning.proto':'9c0f9a8649312711bd849b82430bb5bcd17a3d85bb8c5627c3456214c2aa87b0',
  'routerrpc/router.proto':'d5e42b6d7307cb200c0989d4931b9180d4be2a42b681f0344223472477e1a65e',
}))if(createHash('sha256').update(readFileSync(protoRoot+path)).digest('hex')!==digest)throw new Error('LND runtime schema integrity failure');
export const lndPackage = grpc.loadPackageDefinition(loadSync([protoRoot+'lightning.proto',protoRoot+'routerrpc/router.proto'],{includeDirs:[protoRoot],keepCase:true,longs:String,enums:String,bytes:String,defaults:true,arrays:true,objects:true,oneofs:false})) as any;
type ChannelLease={lightning:grpc.Client;router:grpc.Client;digest:string;validTo:number;active:number;retired:boolean};
const MAX_MESSAGE=32*1024*1024;
export function grpcTarget(target:string):{target:string;host:string} {
  // Only a concrete TLS host:port. No URI resolvers, credentials, paths, or authority overrides.
  const match=/^(\[[0-9a-fA-F:]+\]|[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?):([0-9]{1,5})$/.exec(target);
  if(!match||Number(match[2])<1||Number(match[2])>65535)throw new Error('Invalid LND gRPC target');
  const host=match[1]!.replace(/^\[|\]$/g,'');
  if(host.includes(':')&&!isIP(host))throw new Error('Invalid LND gRPC target');
  return {target,host};
}
class TransportError extends Error {constructor(readonly category:TransportFailure,readonly failureContext?:LndFailureContext){super('LND gRPC '+category+'; outcome may be uncertain');}}
class NativeReadBoundaryError extends Error {constructor(readonly code:'idle_timeout'|'time_budget'){super('LND native read '+code);}}
function category(error:any):TransportFailure {
  switch(error?.code){case grpc.status.UNAUTHENTICATED:return 'authentication';case grpc.status.PERMISSION_DENIED:return 'permission_denied';case grpc.status.DEADLINE_EXCEEDED:return 'deadline';case grpc.status.CANCELLED:return 'cancelled';case grpc.status.UNAVAILABLE:return 'unavailable';case grpc.status.RESOURCE_EXHAUSTED:return 'resource_limit';default:return 'rpc_failure';}
}
export class Lnd implements NodeClient {
  private channels:ChannelLease[]=[];
  private current?:ChannelLease;
  private readToken:string;private writeToken:string;private channelToken?:string;
  private endpoint:{target:string;host:string};
  private closed=false;
  private activeCancellations=new Set<()=>void>();
  private streamBindingCleanup=new WeakSet<AbortSignal>();
  private failureEpoch=0;
  private status:LndTransportStatus={transport:'grpc-tls',inspectedAt:now(),warning:'unavailable',activeChannels:0,activeCalls:0};
  constructor(target:string,private caFile:string,readFile:string,writeFile:string,private limits={unaryMs:20000,paymentMs:45000,htlcMs:300000,maxChannels:4,maxCalls:64,historyBytes:128*1024*1024,streamBytes:32*1024*1024}) {
    this.endpoint=grpcTarget(target);
    this.readToken=readFileSync(readFile).toString('hex');this.writeToken=readFileSync(writeFile).toString('hex');
    if(!this.readToken||!this.writeToken)throw new Error('LND restricted credentials unavailable');
    // Certificate failure is operational state, allowing diagnostics and subsequent renewal recovery.
    this.refresh();
  }
  private refresh() {
    if(this.closed)return;
    let failure:TransportFailure|undefined;let ca:Buffer|undefined;let cert:X509Certificate|undefined;let digest:string|undefined;
    try {
      if(statSync(this.caFile).size>65536)throw new TransportError('certificate_invalid');
      ca=readFileSync(this.caFile);const pem=ca.toString('ascii');if(pem.split('-----BEGIN CERTIFICATE-----').length!==2||pem.includes('PRIVATE KEY'))throw new TransportError('certificate_invalid');cert=new X509Certificate(ca);digest=createHash('sha256').update(cert.raw).digest('hex');
      const from=Date.parse(cert.validFrom),to=Date.parse(cert.validTo),at=Date.now();
      this.status={...this.status,inspectedAt:now(),certificateDigest:digest,validFrom:new Date(from).toISOString(),validTo:new Date(to).toISOString(),failureContext:certificateTransportFailure(this.status.failure)?undefined:this.status.failureContext,warning:to<=at?'expired':to-at<=7*86400000?'expires_7d':to-at<=30*86400000?'expires_30d':'healthy',failure:this.status.failure&&['authentication','permission_denied','deadline','cancelled','unavailable','resource_limit','rpc_failure','acquisition_failure'].includes(this.status.failure)?this.status.failure:undefined};
      if(from>at)throw new TransportError('certificate_not_yet_valid');
      if(to<=at)throw new TransportError('certificate_expired');
      if(!(isIP(this.endpoint.host)?cert.checkIP(this.endpoint.host):cert.checkHost(this.endpoint.host)))throw new TransportError('endpoint_mismatch');
      if(this.current?.digest===digest)return;
      this.reap();
      if(this.channels.length>=this.limits.maxChannels&&this.current?.active!==0)throw new TransportError('resource_limit');
      const credentials=grpc.credentials.createSsl(ca);
      const options={'grpc.enable_retries':0,'grpc.max_receive_message_length':MAX_MESSAGE,'grpc.max_send_message_length':MAX_MESSAGE};
      const next:ChannelLease={lightning:new lndPackage.lnrpc.Lightning(this.endpoint.target,credentials,options),router:new lndPackage.routerrpc.Router(this.endpoint.target,credentials,options),digest,validTo:to,active:0,retired:false};
      if(this.current)this.current.retired=true;
      this.channels.push(next);this.current=next;this.reap();
    } catch(e:any) {failure=e instanceof TransportError?e.category:e?.code==='ENOENT'?'certificate_missing':'certificate_invalid';}
    if(failure)this.status={...this.status,inspectedAt:now(),failure,failureContext:this.status.failure===failure?this.status.failureContext:{failureAt:now(),origin:'transport'},warning:failure==='certificate_expired'?'expired':'unavailable'};
  }
  private reap(){this.channels=this.channels.filter(c=>{if(c.retired&&c.active===0){c.lightning.close();c.router.close();return false;}return true;});}
  transportStatus():LndTransportStatus {this.refresh();return {...this.status,activeChannels:this.channels.length,activeCalls:this.channels.reduce((n,c)=>n+c.active,0)};}
  private lease():ChannelLease {
    if(this.closed)throw new TransportError('cancelled');this.refresh();
    if(!this.current||this.current.validTo<=Date.now())throw this.fail(new TransportError(this.status.failure??'certificate_expired'));
    if(this.channels.reduce((n,c)=>n+c.active,0)>=this.limits.maxCalls)throw this.fail(new TransportError('resource_limit'));
    this.current.active++;return this.current;
  }
  private release(c:ChannelLease){c.active--;this.reap();}
  private metadata(write:boolean|'channel'){const metadata=new grpc.Metadata();metadata.set('macaroon',write==='channel'?this.channelToken!:write?this.writeToken:this.readToken);return metadata;}
  private success(){if(this.status.warning!=='unavailable'&&this.status.warning!=='expired')this.status={...this.status,failure:undefined,failureContext:undefined};}
  beginCollection(){const epoch=this.failureEpoch;return ()=>{if(epoch===this.failureEpoch)this.success();};}
  private fail(error:any,method?:string,localAcquisition=false){
    this.failureEpoch++;const reason=localAcquisition&&ACQUISITION_REASONS.includes(error?.code)?error.code:undefined;
    const failure=error instanceof TransportError?error.category:localAcquisition?'acquisition_failure':category(error);
    const failureContext=error instanceof TransportError&&error.failureContext?error.failureContext:safeLndFailureContext({failureAt:now(),origin:localAcquisition?'local_acquisition':error instanceof TransportError?'transport':'rpc',method,grpcStatus:localAcquisition?undefined:error?.code,reason});
    this.status={...this.status,failure,failureContext};return new TransportError(failure,failureContext);
  }
  private async unary(service:'lightning'|'router',method:string,request:any,write:boolean|'channel'=false,signal?:AbortSignal,limits?:NativeReadLimits):Promise<any> {
    const c=this.lease();return new Promise((resolve,reject)=>{
      let call:grpc.ClientUnaryCall|undefined,settled=false;
      const finish=(error?:unknown,result?:unknown,localBoundary=false)=>{if(settled)return;settled=true;signal?.removeEventListener('abort',abort);this.activeCancellations.delete(abort);this.release(c);if(error)reject(localBoundary?error:this.fail(error,method));else resolve(result);};
      const abort=()=>{
        if(service==='lightning'&&method==='getInfo'&&!write&&limits&&signal&&this.streamBindingCleanup.has(signal)){finish(signal.reason,undefined,true);call?.cancel();}
        else{call?.cancel();finish(new TransportError('cancelled'));}
      };
      if(limits)this.activeCancellations.add(abort);signal?.addEventListener('abort',abort,{once:true});
      try {if(signal?.aborted||this.closed){abort();return;}
        call=(c[service] as any)[method](request,this.metadata(write),{deadline:Date.now()+Math.min(limits?.deadlineMs??this.limits.unaryMs,this.limits.unaryMs),waitForReady:false},(error:any,result:any)=>{
          if(!error&&limits)try {if(Buffer.byteLength(JSON.stringify(result))>limits.bodyBytes)error=new TransportError('resource_limit');}catch{error=new TransportError('rpc_failure');}finish(error,result);
        });
      }catch(e){finish(e);}
    });
  }
  private nativeLimits(l:NativeReadLimits):void {
    const max={deadlineMs:1200000,bodyBytes:MAX_MESSAGE,frameBytes:1024*1024,streamBytes:256*1024*1024,frames:1000000,idleMs:60000};
    if(!l||Object.keys(l).length!==Object.keys(max).length||Object.entries(max).some(([k,v])=>!Number.isSafeInteger(l[k as keyof NativeReadLimits])||l[k as keyof NativeReadLimits]<1||l[k as keyof NativeReadLimits]>v))throw new TransportError('resource_limit');
  }
  private async nativeSubscription(service:'lightning'|'router',method:'subscribeHtlcEvents'|'subscribeChannelGraph',onFrame:(row:unknown,bindingSignal?:AbortSignal)=>Promise<void>,onReady:()=>void,signal:AbortSignal,limits:NativeReadLimits):Promise<void> {
    this.nativeLimits(limits);const c=this.lease();return new Promise((resolve,reject)=>{
      let call:grpc.ClientReadableStream<any>|undefined,settled=false,processing=false,ended=false,frames=0,bytes=0,idle:ReturnType<typeof setTimeout>|undefined;
      // A private signal binds frame GetInfo cleanup to this stream, never an independent unary.
      const frameBinding=new AbortController();
      // Only our timers/abort own a coverage boundary; remote status codes remain failures.
      const finish=(error?:unknown,localBoundary=false,localAcquisition=false)=>{if(settled)return;if(localAcquisition&&!error)error=Object.assign(new Error('LND acquisition callback failed'),{code:'callback_error'});settled=true;clearTimeout(idle);clearTimeout(budget);signal.removeEventListener('abort',abort);this.activeCancellations.delete(abort);if(localBoundary)this.streamBindingCleanup.add(frameBinding.signal);frameBinding.abort(error??new TransportError('cancelled'));call?.cancel();this.release(c);if(error)reject(localBoundary?error:this.fail(error,method,localAcquisition));else resolve();};
      const abort=()=>finish(new TransportError('cancelled'),true);
      const reset=()=>{clearTimeout(idle);idle=setTimeout(()=>finish(new NativeReadBoundaryError('idle_timeout'),true),limits.idleMs);};
      const budget=setTimeout(()=>finish(new NativeReadBoundaryError('time_budget'),true),Math.min(limits.deadlineMs,this.limits.htlcMs));
      this.activeCancellations.add(abort);signal.addEventListener('abort',abort,{once:true});
      try {
        if(signal.aborted||this.closed){abort();return;}reset();
        // Local budget still cancels at the original cap; RPC deadline is a later safety backstop.
        call=(c[service] as any)[method]({},this.metadata(false),{deadline:Date.now()+Math.min(limits.deadlineMs,this.limits.htlcMs)+1000,waitForReady:false});
        call!.on('metadata',()=>{if(settled)return;try{onReady();}catch(e){finish(e,false,true);}});
        call!.on('data',row=>{if(settled)return;call!.pause();processing=true;reset();
          void (async()=>{try {const size=Buffer.byteLength(JSON.stringify(row));bytes+=size;if(++frames>limits.frames||size>limits.frameBytes||bytes>Math.min(limits.streamBytes,this.limits.streamBytes))throw new TransportError('resource_limit');await onFrame(row,frameBinding.signal);}catch(e){finish(e,false,true);}finally{processing=false;if(!settled){if(ended)finish();else call!.resume();}}})();
        });
        call!.on('error',error=>finish(error));call!.on('end',()=>{ended=true;if(!processing)finish();});
      }catch(e){finish(e);}
    });
  }
  nativeRead():NativeLndRead {
    const exact=(v:unknown,max=18446744073709551615n)=>typeof v==='string'&&/^\d{1,20}$/.test(v)&&BigInt(v)<=max;
    const keys=(r:any,wanted:string[])=>r&&typeof r==='object'&&!Array.isArray(r)&&Object.keys(r).length===wanted.length&&wanted.every(k=>Object.hasOwn(r,k));
    const invalid=()=>{throw new TransportError('resource_limit');};
    const unary=(method:string,request:unknown,signal:AbortSignal,limits:NativeReadLimits)=>{this.nativeLimits(limits);return this.unary('lightning',method,request,false,signal,limits);};
    return Object.freeze({
      getInfo:(signal:AbortSignal,limits:NativeReadLimits)=>unary('getInfo',{},signal,limits),
      forwardingHistory:(request:any,signal:AbortSignal,limits:NativeReadLimits)=>{if(!keys(request,['start_time','end_time','index_offset','num_max_events'])||!exact(request.start_time,253402300799n)||!exact(request.end_time,253402300799n)||BigInt(request.start_time)>BigInt(request.end_time)||!Number.isInteger(request.index_offset)||request.index_offset<0||request.index_offset>4294967295||!Number.isInteger(request.num_max_events)||request.num_max_events<1||request.num_max_events>1000)invalid();return unary('forwardingHistory',request,signal,limits);},
      listPayments:(request:any,signal:AbortSignal,limits:NativeReadLimits)=>{if(!keys(request,['creation_date_start','creation_date_end','index_offset','max_payments','reversed','include_incomplete','omit_hops'])||!exact(request.creation_date_start,253402300799n)||!exact(request.creation_date_end,253402300799n)||!exact(request.index_offset)||!exact(request.max_payments,1000n)||BigInt(request.max_payments)<1n||request.reversed!==true||request.include_incomplete!==true||request.omit_hops!==false)invalid();return unary('listPayments',request,signal,limits);},
      listChannels:(signal:AbortSignal,limits:NativeReadLimits)=>unary('listChannels',{},signal,limits),
      getChanInfo:(channelId:string,signal:AbortSignal,limits:NativeReadLimits)=>{if(!exact(channelId))invalid();return unary('getChanInfo',{chan_id:channelId},signal,limits);},
      subscribeHtlcEvents:(onFrame:(row:unknown,bindingSignal?:AbortSignal)=>Promise<void>,onReady:()=>void,signal:AbortSignal,limits:NativeReadLimits)=>this.nativeSubscription('router','subscribeHtlcEvents',onFrame,onReady,signal,limits),
      subscribeChannelGraph:(onFrame:(row:unknown,bindingSignal?:AbortSignal)=>Promise<void>,onReady:()=>void,signal:AbortSignal,limits:NativeReadLimits)=>this.nativeSubscription('lightning','subscribeChannelGraph',onFrame,onReady,signal,limits),
    });
  }
  private async stream(method:string,request:any,write:boolean,onEvent?:((e:any)=>void),signal?:AbortSignal):Promise<any> {
    const c=this.lease();return new Promise((resolve,reject)=>{
      let call:grpc.ClientReadableStream<any>|undefined;let last:any;let settled=false;let rows=0;let bytes=0;
      const readSubscription=method==='subscribeHtlcEvents'&&!write&&onEvent!==undefined;
      let budget:ReturnType<typeof setTimeout>|undefined;
      const finish=(error?:any,localBoundary=false)=>{if(settled)return;settled=true;signal?.removeEventListener('abort',abort);if(readSubscription){clearTimeout(budget);this.activeCancellations.delete(abort);if(localBoundary)call?.cancel();}this.release(c);if(error)reject(localBoundary?error:this.fail(error,method));else resolve(last);};
      const abort=()=>{if(readSubscription)finish(new TransportError('cancelled'),true);else{call?.cancel();finish(new TransportError('cancelled'));}};
      // Keep the existing read segment cap, with explicit local ownership of expiry/closure.
      if(readSubscription){this.activeCancellations.add(abort);budget=setTimeout(()=>finish(undefined,true),this.limits.htlcMs);}
      try {
        if(signal?.aborted||(readSubscription&&this.closed)){abort();return;}
        call=(c.router as any)[method](request,this.metadata(write),{deadline:Date.now()+(onEvent?this.limits.htlcMs:this.limits.paymentMs)+(readSubscription?1000:0),waitForReady:false});
        signal?.addEventListener('abort',abort,{once:true});
        call!.on('data',row=>{if(settled)return;try {rows++;bytes+=Buffer.byteLength(JSON.stringify(row));if(rows>100000||(!onEvent&&bytes>this.limits.streamBytes))throw new TransportError('resource_limit');last=row;onEvent?.(row);}catch(e){call?.cancel();finish(e);}});
        call!.on('error',(error:grpc.ServiceError)=>finish(error));call!.on('end',()=>finish());
      }catch(e){finish(e);}
    });
  }
  /** Optional third credential. Absent or unreadable means channel lifecycle is unavailable; other paths are unaffected. */
  enableChannels(file:string):boolean {try{const token=readFileSync(file).toString('hex');if(token)this.channelToken=token;}catch{}return this.channelToken!==undefined;}
  channelRpc():ChannelRpc|undefined {
    if(!this.channelToken)return undefined;
    const txid=(bytes:unknown)=>{const hex=Buffer.from(String(bytes),'base64').reverse().toString('hex');if(!/^[0-9a-f]{64}$/.test(hex))throw new Error('Invalid transaction id');return hex;};
    const pubkey=(v:string)=>{if(!/^0[23][0-9a-f]{64}$/.test(v))throw new Error('Invalid peer public key');return v;};
    const rate=(v:string)=>{const n=integer(v);if(n<1n||n>1000n)throw new Error('Invalid fee rate');return n.toString();};
    const chanPoint=(v:string)=>{const m=/^([0-9a-f]{64}):([0-9]{1,6})$/.exec(v);if(!m)throw new Error('Invalid channel point');return {funding_txid_str:m[1],output_index:Number(m[2])};};
    return Object.freeze({
      listPeers:async()=>{const r=await this.unary('lightning','listPeers',{},'channel');if(!Array.isArray(r.peers))throw new Error('Invalid peer list');return r.peers.map((p:any)=>String(p.pub_key));},
      connectPeer:async(peer:string,host:string)=>{if(!/^(\[[0-9a-fA-F:]+\]|[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?):[0-9]{1,5}$/.test(host))throw new Error('Invalid peer address');await this.unary('lightning','connectPeer',{addr:{pubkey:pubkey(peer),host},perm:false,timeout:'15'},'channel');},
      estimateFee:async(amountSat:string,targetConf:number)=>{
        const r=await this.unary('lightning','estimateFee',{AddrToAmount:{[ESTIMATE_ADDRESS]:integer(amountSat).toString()},target_conf:targetConf,min_confs:1,spend_unconfirmed:false},'channel');
        if(!/^[0-9]+$/.test(String(r.fee_sat))||!/^[0-9]+$/.test(String(r.sat_per_vbyte)))throw new Error('Invalid fee estimate');return {feeSat:String(r.fee_sat),satPerVbyte:String(r.sat_per_vbyte)};
      },
      openChannel:async(peer:string,amountSat:string,satPerVbyte:string)=>{
        const r=await this.unary('lightning','openChannelSync',{node_pubkey:Buffer.from(pubkey(peer),'hex'),local_funding_amount:integer(amountSat).toString(),push_sat:'0',sat_per_vbyte:rate(satPerVbyte),private:false,min_confs:1,spend_unconfirmed:false},'channel');
        return {txid:r.funding_txid_bytes?txid(r.funding_txid_bytes):String(r.funding_txid_str),outputIndex:Number(r.output_index)};
      },
      closeChannel:(point:string,satPerVbyte:string)=>this.cooperativeClose({channel_point:chanPoint(point),force:false,sat_per_vbyte:rate(satPerVbyte),max_fee_per_vbyte:rate(satPerVbyte),no_wait:false},txid),
      pendingChannels:async()=>{
        const r=await this.unary('lightning','pendingChannels',{},'channel');if(!Array.isArray(r.pending_open_channels)||!Array.isArray(r.waiting_close_channels))throw new Error('Invalid pending channels');
        return {opens:r.pending_open_channels.map((p:any)=>({peer:String(p.channel?.remote_node_pub),point:String(p.channel?.channel_point),capacitySat:String(p.channel?.capacity)})),closing:r.waiting_close_channels.map((p:any)=>({peer:String(p.channel?.remote_node_pub),point:String(p.channel?.channel_point),txid:String(p.closing_txid)}))};
      },
      closedChannels:async()=>{const r=await this.unary('lightning','closedChannels',{},'channel');if(!Array.isArray(r.channels))throw new Error('Invalid closed channels');return r.channels.map((c:any)=>({point:String(c.channel_point),peer:String(c.remote_pubkey),txid:String(c.closing_tx_hash),type:String(c.close_type)}));},
      nodeInfo:async(peer:string)=>{const r=await this.unary('lightning','getNodeInfo',{pub_key:pubkey(peer),include_channels:false},'channel');return {alias:String(r.node?.alias??''),channels:Number(r.num_channels),capacitySat:String(r.total_capacity),addresses:(r.node?.addresses??[]).map((a:any)=>String(a.addr))};},
    });
  }
  /** Returns at the first close_pending (or chan_close) update and cancels the stream. One request; never re-sent. */
  private cooperativeClose(request:any,txid:(bytes:unknown)=>string):Promise<{txid:string}> {
    if(request.force!==false)throw new Error('Force close is not permitted');
    const c=this.lease();return new Promise((resolve,reject)=>{
      let call:grpc.ClientReadableStream<any>|undefined,settled=false;
      const finish=(error?:unknown,result?:{txid:string})=>{if(settled)return;settled=true;clearTimeout(timer);call?.cancel();this.release(c);if(error)reject(this.fail(error,'closeChannel'));else resolve(result!);};
      const timer=setTimeout(()=>finish(new TransportError('deadline')),this.limits.paymentMs);
      try {
        call=(c.lightning as any).closeChannel(request,this.metadata('channel'),{deadline:Date.now()+this.limits.paymentMs+1000,waitForReady:false});
        call!.on('data',(u:any)=>{if(settled)return;try{if(u?.close_pending?.txid)finish(undefined,{txid:txid(u.close_pending.txid)});else if(u?.chan_close?.closing_txid)finish(undefined,{txid:txid(u.chan_close.closing_txid)});}catch(e){finish(e);}});
        call!.on('error',(error:grpc.ServiceError)=>finish(error));call!.on('end',()=>finish(new TransportError('rpc_failure')));
      }catch(e){finish(e);}
    });
  }
  close(){this.closed=true;for(const abort of [...this.activeCancellations])abort();for(const c of this.channels)c.retired=true;this.reap();}
  async snapshot():Promise<Snapshot> {
    const [info,wallet,list]=await Promise.all([this.unary('lightning','getInfo',{}),this.unary('lightning','walletBalance',{}),this.unary('lightning','listChannels',{peer_alias_lookup:true})]);
    if(!Array.isArray(list.channels) || !/^([0-9a-f]{66})$/.test(info.identity_pubkey) || wallet.confirmed_balance===undefined)throw new Error('Incompatible LND snapshot schema');
    const channels:Channel[]=[];
    for(const c of list.channels??[]) {
      const edge=await this.unary('lightning','getChanInfo',{chan_id:String(c.chan_id)});
      const p=edge.node1_pub===info.identity_pubkey?edge.node1_policy:edge.node2_policy;
      if(!p)throw new Error('Missing local graph policy');
      channels.push({id:String(c.chan_id),point:c.channel_point,peer:c.remote_pubkey,alias:c.peer_alias||c.remote_pubkey.slice(0,12),active:c.active===true,capacitySat:String(c.capacity),localSat:String(c.local_balance),remoteSat:String(c.remote_balance),reserveSat:String(c.local_constraints?.chan_reserve_sat??0),pendingSat:(c.pending_htlcs??[]).reduce((n:bigint,h:any)=>n+integer(h.amount),0n).toString(),baseMsat:String(p.fee_base_msat),ppm:Number(p.fee_rate_milli_msat),cltv:Number(p.time_lock_delta),minMsat:String(p.min_htlc),maxMsat:String(p.max_htlc_msat)});
    }
    return {at:now(),identity:info.identity_pubkey,synced:info.synced_to_chain===true&&info.synced_to_graph===true,confirmedSat:String(wallet.confirmed_balance),channels};
  }
  async forwards(start:number,end:number) {
    let offset=0;let bytes=0;const rows:any[]=[];
    for(let pages=0;pages<10000;pages++) {
      const p=await this.unary('lightning','forwardingHistory',{start_time:String(start),end_time:String(end),index_offset:offset,num_max_events:1000});
      if(!Array.isArray(p.forwarding_events))throw new Error('Invalid forward page');bytes+=Buffer.byteLength(JSON.stringify(p.forwarding_events));if(bytes>this.limits.historyBytes)throw this.fail(new TransportError('resource_limit'));rows.push(...p.forwarding_events);
      if(p.forwarding_events.length<1000)return rows;
      const next=Number(p.last_offset_index);if(!Number.isSafeInteger(next)||next<=offset)throw new Error('Forward pagination stalled');offset=next;
    }throw new Error('Forward pagination limit; incomplete');
  }
  async payments() {
    let offset='0';let bytes=0;const out:any[]=[];
    for(let i=0;i<1000;i++){
      const p=await this.unary('lightning','listPayments',{include_incomplete:true,max_payments:'1000',index_offset:offset});
      if(!Array.isArray(p.payments))throw new Error('Invalid payments page');bytes+=Buffer.byteLength(JSON.stringify(p.payments));if(bytes>this.limits.historyBytes)throw this.fail(new TransportError('resource_limit'));out.push(...p.payments);
      if(p.payments.length<1000)return out;
      const next=String(p.last_index_offset);if(integer(next)<=integer(offset))throw new Error('Payment pagination stalled');offset=next;
    }throw new Error('Payments incomplete');
  }
  async invoice(amountSat:string,memo:string) {
    const r=await this.unary('lightning','addInvoice',{value:amountSat,memo,expiry:'300'},true);
    if(typeof r.r_hash!=='string' || !/^[A-Za-z0-9+/]{43}=$/.test(r.r_hash) || !r.payment_request)throw new Error('Invalid self invoice');
    return {hash:Buffer.from(r.r_hash,'base64').toString('hex'),request:r.payment_request};
  }
  private outcome(p:any):PaymentOutcome {
    const routes=(p.htlcs??[]).filter((h:any)=>h.status==='SUCCEEDED').map((h:any)=>h.route);
    const route=routes[0];
    const endpointsValid=routes.length>0 && routes.every((r:any)=>r.hops?.[0]?.chan_id===route?.hops?.[0]?.chan_id && r.hops?.at(-1)?.chan_id===route?.hops?.at(-1)?.chan_id);
    return {status:p.status,feeMsat:String(p.fee_msat??0),amountSat:String(p.value_sat??0),source:endpointsValid?route?.hops?.[0]?.chan_id:undefined,target:endpointsValid?route?.hops?.at(-1)?.chan_id:undefined,index:p.payment_index?String(p.payment_index):undefined};
  }
  async send(request:string,source:string,lastPeer:string,capMsat:string) {
    const r=await this.stream('sendPaymentV2',{payment_request:request,outgoing_chan_ids:[source],last_hop_pubkey:Buffer.from(lastPeer,'hex'),fee_limit_msat:capMsat,timeout_seconds:30,max_parts:8,allow_self_payment:true,no_inflight_updates:true},true);
    if(!r || !['SUCCEEDED','FAILED','IN_FLIGHT'].includes(r.status))throw new Error('No authoritative terminal payment response');return this.outcome(r);
  }
  async track(hash:string) {
    // NOT_FOUND after an uncertain send remains unknown; never replay SendPaymentV2.
    const r=await this.stream('trackPaymentV2',{payment_hash:Buffer.from(hash,'hex'),no_inflight_updates:true},false);
    return r?this.outcome(r):undefined;
  }
  async updateFee(c:Channel,ppm:number) {
    const [tx,index]=c.point.split(':');
    const r=await this.unary('lightning','updateChannelPolicy',{chan_point:{funding_txid_str:tx,output_index:Number(index)},base_fee_msat:c.baseMsat,fee_rate:ppm/1_000_000,time_lock_delta:c.cltv,min_htlc_msat:c.minMsat,min_htlc_msat_specified:true,max_htlc_msat:c.maxMsat},true);
    if(r.failed_updates?.length)throw new Error('LND rejected channel policy');
  }
  async htlc(onEvent:(e:any)=>void,signal:AbortSignal) {await this.stream('subscribeHtlcEvents',{},false,onEvent,signal);}
}
