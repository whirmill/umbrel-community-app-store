'use strict';
// Root-reviewed fixed GetInfo only. Public configuration stdin; existing app RO files.
const fs=require('node:fs'),crypto=require('node:crypto'),net=require('node:net');
const HASH=/^[a-f0-9]{64}$/,PUB=/^(02|03)[a-f0-9]{64}$/;
const need=v=>{if(!v)throw Error('unavailable');};
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
function read(path,hash,cap){need(typeof path==='string'&&path.startsWith('/')&&HASH.test(hash));const fd=fs.openSync(path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);let raw;try{const a=fs.fstatSync(fd);need(a.isFile()&&a.nlink===1&&a.size>0&&a.size<=cap);raw=fs.readFileSync(fd);const b=fs.fstatSync(fd);need(raw.length===a.size&&a.ino===b.ino&&a.dev===b.dev&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs&&sha(raw)===hash);const result=raw;raw=undefined;return result;}finally{raw?.fill(0);fs.closeSync(fd);}}
async function main(){let client,metadata,mac,tls,timer,stdinTimer;const chunks=[];try{
 need(process.getuid()===1000&&process.version==='v24.21.0'&&process.cwd()==='/app');
 const raw=await new Promise((resolve,reject)=>{let size=0;stdinTimer=setTimeout(()=>reject(Error('unavailable')),1000);process.stdin.on('data',c=>{size+=c.length;if(size>8192){process.stdin.pause();reject(Error('unavailable'));}else chunks.push(c);});process.stdin.once('end',()=>resolve(Buffer.concat(chunks)));process.stdin.once('error',reject);});clearTimeout(stdinTimer);
 const c=JSON.parse(raw);need(c&&Object.keys(c).sort().join('|')===['target','tlsPath','readPath','tlsSha256','readSha256','nodeId','lndVersion','packageVersion','sourcePins'].sort().join('|'));
 need(PUB.test(c.nodeId)&&typeof c.target==='string'&&/^[a-zA-Z0-9.-]+:10009$/.test(c.target)&&c.tlsPath==='/credentials/tls.cert'&&c.readPath==='/credentials/read.macaroon');
 const paths=['/app/package.json','/app/node_modules/@grpc/grpc-js/package.json','/app/node_modules/@grpc/proto-loader/package.json','/app/lnd-proto/lightning.proto'];need(c.sourcePins&&Object.keys(c.sourcePins).sort().join('|')===paths.sort().join('|'));for(const path of paths)read(path,c.sourcePins[path],1048576);
 need(require('/app/package.json').version===c.packageVersion&&require('/app/node_modules/@grpc/grpc-js/package.json').version==='1.14.6'&&require('/app/node_modules/@grpc/proto-loader/package.json').version==='0.8.1');
 mac=read(c.readPath,c.readSha256,8192);tls=read(c.tlsPath,c.tlsSha256,16384);const cert=new crypto.X509Certificate(tls),host=c.target.split(':')[0];need(Date.parse(cert.validFrom)<=Date.now()&&Date.parse(cert.validTo)>Date.now()&&(net.isIP(host)?cert.checkIP(host):cert.checkHost(host,{subject:'never'}))&&!tls.toString().includes('PRIVATE KEY'));
 const grpc=require('/app/node_modules/@grpc/grpc-js'),loader=require('/app/node_modules/@grpc/proto-loader'),d=loader.loadSync('/app/lnd-proto/lightning.proto',{keepCase:false,longs:String,enums:String,bytes:Buffer,defaults:true,arrays:true,objects:true}),service=d['lnrpc.Lightning'];need(service?.GetInfo?.path==='/lnrpc.Lightning/GetInfo'&&!service.GetInfo.requestStream&&!service.GetInfo.responseStream);
 client=new (grpc.loadPackageDefinition(d).lnrpc.Lightning)(c.target,grpc.credentials.createSsl(tls),{'grpc.enable_retries':0,'grpc.max_receive_message_length':32768,'grpc.max_send_message_length':4096});metadata=new grpc.Metadata();metadata.set('macaroon',mac.toString('hex'));
 const info=await new Promise((resolve,reject)=>{let call;timer=setTimeout(()=>{call?.cancel();reject(Error('unavailable'));},5000);call=client.getInfo({},metadata,{deadline:new Date(Date.now()+5000)},(e,v)=>{clearTimeout(timer);e?reject(e):resolve(v);});});
 need(service.GetInfo.responseSerialize(info).length<=32768&&info.identityPubkey===c.nodeId&&info.chains?.length===1&&info.chains[0].chain==='bitcoin'&&info.chains[0].network==='mainnet'&&typeof info.version==='string'&&info.version.split(' ')[0]===c.lndVersion);
 for(const path of paths)read(path,c.sourcePins[path],1048576);for(const [path,digest] of [[c.readPath,c.readSha256],[c.tlsPath,c.tlsSha256]])read(path,digest,path===c.readPath?8192:16384).fill(0);
 client.close();client=undefined;metadata.remove('macaroon');metadata=undefined;process.stdout.write(JSON.stringify({schema:1,nodeId:c.nodeId,network:'bitcoin/mainnet',resourcesClosed:true})+'\n');
 }catch{process.stderr.write('App node acquisition unavailable\n');process.exitCode=2;}finally{clearTimeout(timer);clearTimeout(stdinTimer);try{client?.close();metadata?.remove('macaroon');}catch{process.exitCode=2;}mac?.fill(0);tls?.fill(0);for(const c of chunks)c.fill(0);process.stdin.pause();}}
process.stdout.on('error',()=>{process.exitCode=2;});
void main().catch(()=>{process.exitCode=2;process.stderr.write('App node acquisition unavailable\n');});
