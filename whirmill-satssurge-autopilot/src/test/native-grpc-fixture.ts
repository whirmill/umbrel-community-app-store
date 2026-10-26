import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import * as grpc from '@grpc/grpc-js';
import {Lnd,lndPackage,grpcTarget} from '../lnd.js';
import {hash,json} from '../domain.js';
export const identity='02'+'11'.repeat(32),peer='03'+'22'.repeat(32),big='9007199254740993';
const limits={unaryMs:1500,paymentMs:1500,maxChannels:4,maxCalls:64,historyBytes:128*1024*1024,streamBytes:32*1024*1024};
export function nativeCertificate(dir:string,name:string,days='365',san='IP:127.0.0.1') {
 const key=join(dir,name+'.key'),cert=join(dir,name+'.pem'),csr=join(dir,name+'.csr');
 execFileSync('openssl',['req','-new','-newkey','rsa:2048','-nodes','-keyout',key,'-out',csr,'-subj','/CN=isolated-fixture','-addext','subjectAltName='+san],{stdio:'ignore'});
 execFileSync('openssl',['x509','-req','-in',csr,'-signkey',key,'-out',cert,'-days',days,'-copy_extensions','copy'],{stdio:'ignore'});
 return {key:readFileSync(key),cert:readFileSync(cert),path:cert};
}
export async function nativeGrpcFixture(lightning:any={},router:any={},override:Partial<typeof limits>={}) {
 const dir=mkdtempSync(join(tmpdir(),'satssurge-grpc-')),pair=nativeCertificate(dir,'one');
 const ca=join(dir,'tls.cert'),read=join(dir,'read'),write=join(dir,'write');writeFileSync(ca,pair.cert);writeFileSync(read,Buffer.from('010203','hex'));writeFileSync(write,Buffer.from('040506','hex'));
 const seen:{method:string;request:any;token:any}[]=[];
 const wrap=(methods:any)=>Object.fromEntries(Object.entries(methods).map(([name,handler])=>[name,(call:any,callback:any)=>{seen.push({method:name,request:call.request,token:call.metadata.get('macaroon')[0]});(handler as any)(call,callback);}])) ;
 const server=new grpc.Server();server.addService(lndPackage.lnrpc.Lightning.service,wrap(lightning));server.addService(lndPackage.routerrpc.Router.service,wrap(router));
 const credentials=grpc.ServerCredentials.createSsl(null,[{private_key:pair.key,cert_chain:pair.cert}],false);
 const port=await new Promise<number>((resolve,reject)=>server.bindAsync('127.0.0.1:0',credentials,(e,p)=>e?reject(e):resolve(p)));
 const client=new Lnd('127.0.0.1:'+port,ca,read,write,{...limits,...override});
 return {dir,pair,server,client,ca,read,write,seen,port,rotate:(next:ReturnType<typeof nativeCertificate>)=>(credentials as any).updateSecureContextOptions({key:next.key,cert:next.cert}),close:()=>{client.close();server.forceShutdown();rmSync(dir,{recursive:true,force:true});}};
}
