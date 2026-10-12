import {constants,openSync,fstatSync,readSync,closeSync,lstatSync} from 'node:fs';
import {dirname,basename,isAbsolute,normalize,parse} from 'node:path';
import {runtimeBindingMatches,type InterlockContract,type HostRuntimeBinding,type InterlockState} from './interlocks.js';
export const APP_CONTROL_IDS=['lightningmate','lndg','lightning-terminal','albyhub'] as const;
export interface AppControlContract extends Omit<InterlockContract,'schema'|'appIds'> {schema:1;scope:'apps-only';appIds:typeof APP_CONTROL_IDS|[...typeof APP_CONTROL_IDS]}
export interface AppControlProof {schema:1;scope:'apps-only';ok:boolean;at:string|null;endedAt:string|null;apps:{id:typeof APP_CONTROL_IDS[number];state:InterlockState;reason:'verified'|'unavailable'|'changed'}[];standalone:'unknown';financialEligible:false;reason:string}
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const timestamp=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(v)&&Number.isFinite(Date.parse(v));
const node=(v:unknown):v is string=>typeof v==='string'&&/^(02|03)[a-f0-9]{64}$/.test(v);
const exact=(v:any,keys:string[])=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join('|')===[...keys].sort().join('|');
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
/** Unknown evidence keeps its acquisition time; observing it never grants freshness. */
export function unavailableAppControls(at:string|null=null):AppControlProof{return {schema:1,scope:'apps-only',ok:false,at,endedAt:null,apps:APP_CONTROL_IDS.map(id=>({id,state:'unknown',reason:'unavailable'})),standalone:'unknown',financialEligible:false,reason:'Four-app controls unavailable; owner-wide standalone automation unknown'};}
/** Separate mode can only narrow financial authority, including malformed contracts. */
export function scopedAppControls(store:{get<T=any>(key:string):T|undefined}):boolean{return (store.get('appControlContract')!==undefined||store.get('appControlProof')!==undefined)||!!process.env.APP_CONTROL_CONTRACT_FILE||!!process.env.APP_CONTROL_FILE;}
function protectedBytes(path:string):Buffer {
 if(!isAbsolute(path)||normalize(path)!==path)throw Error('Protected absolute path required');
 const descriptors:number[]=[];let parent=dirname(path);
 try{
  // NOFOLLOW directory descriptors pin each root-owned ancestor, including root.
  const chain:string[]=[];for(;;){chain.unshift(parent);if(parent===parse(parent).root)break;parent=dirname(parent);}
  for(const directory of chain){const prior=descriptors.at(-1);const relative=prior===undefined?'/':`/proc/self/fd/${prior}/${basename(directory)}`;
   const fd=openSync(relative,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);descriptors.push(fd);const st=fstatSync(fd);if(st.uid!==0||(st.mode&0o022)!==0)throw Error('Unprotected ancestor');}
  const bound=`/proc/self/fd/${descriptors.at(-1)}/${basename(path)}`;
  const fd=openSync(bound,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);descriptors.push(fd);const st=fstatSync(fd);
  if(!st.isFile()||st.uid!==0||st.nlink!==1||(st.mode&0o022)!==0||st.size>65536)throw Error('Unprotected proof');
  const bytes=Buffer.alloc(65537);let length=0;while(length<bytes.length){const n=readSync(fd,bytes,length,bytes.length-length,null);if(!n)break;length+=n;}
  const after=fstatSync(fd),selected=lstatSync(path);if(length>65536||length!==st.size||['ino','dev','size','mtimeMs','ctimeMs','uid','mode','nlink'].some(k=>st[k as keyof typeof st]!==after[k as keyof typeof st]||after[k as keyof typeof st]!==selected[k as keyof typeof st]))throw Error('Proof changed');
  for(let i=0;i<chain.length;i++){const a=fstatSync(descriptors[i]!),b=lstatSync(chain[i]!);if(a.ino!==b.ino||a.dev!==b.dev||b.uid!==0||(b.mode&0o022)!==0||!b.isDirectory())throw Error('Ancestor changed');}
  return bytes.subarray(0,length);
 }finally{for(const fd of descriptors.reverse())closeSync(fd);}
}
export function readAppControlContract(path:string):AppControlContract|undefined {try{const value=JSON.parse(protectedBytes(path).toString('utf8'));return validContract(value)?value:undefined;}catch{return undefined;}}
function validContract(c:any):c is AppControlContract {
 const keys=['schema','scope','hostBootId','sourceHash','generation','appIds','producerHash','runtimeBinding','expectedLndNodeId','installedQualifications','albyQualification'];
 const qualifications=c?.installedQualifications;
 if(qualifications!==undefined){
  if(!qualifications||typeof qualifications!=='object'||Array.isArray(qualifications)||Object.keys(qualifications).some(k=>!APP_CONTROL_IDS.includes(k as any)))return false;
  for(const [id,q] of Object.entries(qualifications) as [string,any][]){
   if(!exact(q,id==='albyhub'?['runtimeBinding']:['runtimeBinding','version','hook'])||!exact(q.runtimeBinding,['containerId','imageRef','imageId'])||!runtimeBindingMatches(q.runtimeBinding,q.runtimeBinding))return false;
   if(id!=='albyhub'&&(typeof q.version!=='string'||!/^[a-zA-Z0-9.+_-]{1,64}$/.test(q.version)||!exact(q.hook,['sourceHash'])||!hash(q.hook.sourceHash)))return false;
  }
 }
 if(c?.albyQualification!==undefined&&(!exact(c.albyQualification,['contract','version','sourceHash'])||c.albyQualification.contract!=='albyhub-v1.24.0-native-read-v1'||c.albyQualification.version!=='1.24.0-patch.1'||!hash(c.albyQualification.sourceHash)))return false;
 return c&&Object.keys(c).every(k=>keys.includes(k))&&c.schema===1&&c.scope==='apps-only'&&same(c.appIds,APP_CONTROL_IDS)&&typeof c.hostBootId==='string'&&/^[a-f0-9-]{36}$/.test(c.hostBootId)&&Number.isSafeInteger(c.generation)&&c.generation>=0&&hash(c.sourceHash)&&hash(c.producerHash)&&node(c.expectedLndNodeId)&&exact(c.runtimeBinding,['containerId','imageRef','imageId'])&&runtimeBindingMatches(c.runtimeBinding,c.runtimeBinding);
}
/** Only protected inode admission is used in production; the pure validator is for fixtures. */
export function readAppControls(path:string,clock=Date.now,contract?:AppControlContract):AppControlProof {try{return validateAppControls(JSON.parse(protectedBytes(path).toString('utf8')),clock,contract);}catch{return unavailableAppControls();}}
export function validateAppControls(p:any,clock=Date.now,c?:AppControlContract):AppControlProof {
 const at=timestamp(p?.at)?p.at:null,unknown=()=>unavailableAppControls(at);
 try{
  if(!validContract(c)||!exact(p,['schema','scope','at','endedAt','hostBootId','sourceHash','producerHash','generation','appIds','runtimeBinding','node','registryBeforeHash','registryAfterHash','before','after','standalone'])||p.schema!==1||p.scope!=='apps-only'||p.standalone!=='unknown')return unknown();
  const start=Date.parse(p.at),end=Date.parse(p.endedAt),current=clock();if(!timestamp(p.at)||!timestamp(p.endedAt)||!Number.isFinite(current)||!Number.isFinite(start)||!Number.isFinite(end)||start>end||end>current||current-start>90000||p.hostBootId!==c.hostBootId||p.sourceHash!==c.sourceHash||p.producerHash!==c.producerHash||p.generation!==c.generation||!same(p.appIds,APP_CONTROL_IDS)||!exact(p.runtimeBinding,['containerId','imageRef','imageId'])||!runtimeBindingMatches(p.runtimeBinding,c.runtimeBinding)||!exact(p.node,['nodeId','network'])||p.node.nodeId!==c.expectedLndNodeId||p.node.network!=='bitcoin/mainnet'||!hash(p.registryBeforeHash)||p.registryBeforeHash!==p.registryAfterHash||!Array.isArray(p.before)||!Array.isArray(p.after)||p.before.length!==4||p.after.length!==4)return unknown();
  const apps:AppControlProof['apps']=[];
  for(let i=0;i<4;i++){
   const a=p.before[i],b=p.after[i],id=APP_CONTROL_IDS[i]!;
   if(!exact(a,['id','durableInstalled','lifecycle','containers','qualification'])||!exact(b,['id','durableInstalled','lifecycle','containers','qualification'])||a.id!==id||b.id!==id)return unknown();
   for(const observation of [a,b]){
    if(![true,false,null].includes(observation.durableInstalled)||!['not-installed','running','stopped','unknown'].includes(observation.lifecycle)||!Array.isArray(observation.containers)||observation.containers.length>32)return unknown();
    for(const row of observation.containers)if(!exact(row,['id','name','project','state','imageRef','imageId','startedAt','restartCount'])||!hash(row.id)||typeof row.name!=='string'||!/^[a-zA-Z0-9_.-]{1,128}$/.test(row.name)||typeof row.project!=='string'||row.project.length>64||!['running','exited','created'].includes(row.state)||typeof row.startedAt!=='string'||row.startedAt.length>64||!Number.isSafeInteger(row.restartCount)||row.restartCount<0||typeof row.imageRef!=='string'||!/^[a-zA-Z0-9./:@_-]{1,256}$/.test(row.imageRef)||typeof row.imageId!=='string'||!/^sha256:[a-f0-9]{64}$/.test(row.imageId))return unknown();
   }
   if(!same(a,b)){apps.push({id,state:'unknown',reason:'changed'});continue;}
   if(a.durableInstalled===false&&a.lifecycle==='not-installed'&&a.containers.length===0&&a.qualification===null){apps.push({id,state:'verified_absent',reason:'verified'});continue;}
   const q=a.qualification,review=c.installedQualifications?.[id];let qualified=a.durableInstalled===true&&['running','stopped'].includes(a.lifecycle)&&review&&q&&a.containers.some((r:any)=>runtimeBindingMatches({containerId:r.id,imageRef:r.imageRef,imageId:r.imageId},review.runtimeBinding))&&runtimeBindingMatches(q.runtimeBinding,review.runtimeBinding);
   if(qualified&&id==='albyhub'){
    const expected=c.albyQualification;qualified=exact(q.runtimeBinding,['containerId','imageRef','imageId'])&&exact(q,['runtimeBinding','contract','version','sourceHash','nodeId','backend','autoSwapOutEnabled'])&&expected&&expected.contract==='albyhub-v1.24.0-native-read-v1'&&expected.version==='1.24.0-patch.1'&&q.contract===expected.contract&&q.version===expected.version&&q.sourceHash===expected.sourceHash&&hash(q.sourceHash)&&node(q.nodeId)&&typeof q.autoSwapOutEnabled==='boolean'&&(q.backend==='lnd'?(q.nodeId!==c.expectedLndNodeId||q.autoSwapOutEnabled===false):q.backend==='ldk'&&q.nodeId!==c.expectedLndNodeId);
   }else if(qualified){
    const keys=id==='lightningmate'?['fee','rebalance','channel','sell','autoclose','relist','reprice','size','maxHTLC','lsp']:id==='lndg'?['lndgAF','lndgAR','lndgAutopilot']:['loop'];
    qualified=exact(q.runtimeBinding,['containerId','imageRef','imageId'])&&exact(q,['runtimeBinding','version','sourceHash','settingsDigest','nodeId','flags'])&&q.version===review!.version&&q.sourceHash===review!.hook?.sourceHash&&hash(q.sourceHash)&&hash(q.settingsDigest)&&q.nodeId===c.expectedLndNodeId&&exact(q.flags,keys)&&keys.every(k=>q.flags[k]===false);
   }
   apps.push({id,state:qualified?'installed_disabled':'unknown',reason:qualified?'verified':'unavailable'});
  }
  return {schema:1,scope:'apps-only',ok:apps.every(a=>a.state!=='unknown'),at:p.at,endedAt:p.endedAt,apps,standalone:'unknown',financialEligible:false,reason:'Four-app replacement controls only; owner-wide standalone automation unknown'};
 }catch{return unknown();}
}
