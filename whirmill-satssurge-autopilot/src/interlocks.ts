import {constants,openSync,fstatSync,readSync,closeSync} from 'node:fs';
/** Open the original inode without following links; never wait for special files. */
function boundedInput(path:string):Buffer {
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try {
  const before=fstatSync(fd);
  if(!before.isFile()||before.nlink!==1||before.size>65536||before.uid!==0||(before.mode&0o022)!==0)throw Error('Invalid interlock input');
  const data=Buffer.alloc(65537);let length=0;
  while(length<data.length){const count=readSync(fd,data,length,data.length-length,null);if(!count)break;length+=count;}
  const after=fstatSync(fd);
  if(length>65536||!after.isFile()||after.nlink!==1||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs)throw Error('Changed or oversized interlock input');
  return data.subarray(0,length);
 }finally{closeSync(fd);}
}
export const INTERLOCK_FLAGS=['fee','rebalance','channel','sell','autoclose','relist','reprice','size','maxHTLC','lsp','lndgAF','lndgAR','lndgAutopilot','loop'] as const;
export type InterlockState='verified_absent'|'installed_disabled'|'unknown';
export interface HostRuntimeBinding {containerId:string;imageRef:string;imageId:string}
export interface InterlockContract {schema:2;hostBootId:string;sourceHash:string;generation:number;appIds:string[];producerHash?:string;runtimeBinding?:HostRuntimeBinding;expectedLndNodeId?:string;installedQualifications?:Record<string,{runtimeBinding:HostRuntimeBinding;version?:string;hook?:{sourceHash:string}}>;albyQualification?:{contract:'albyhub-v1.24.0-native-read-v1';version:'1.24.0-patch.1';sourceHash:string}}
/** A syntactically valid digest is insufficient: compare every actual field to the reviewed binding. */
export function runtimeBindingMatches(actual:unknown,expected:unknown):boolean {
 const a=actual as HostRuntimeBinding|undefined,e=expected as HostRuntimeBinding|undefined;
 return !!a&&!!e&&/^[a-f0-9]{64}$/.test(e.containerId??'')&&/^[a-z0-9./:_-]+@sha256:[a-f0-9]{64}$/.test(e.imageRef??'')&&/^sha256:[a-f0-9]{64}$/.test(e.imageId??'')&&a.containerId===e.containerId&&a.imageRef===e.imageRef&&a.imageId===e.imageId;
}
export interface InterlockProof {ok:boolean;at:string;reason:string;state:InterlockState;source:string;generation?:number;hostBootId?:string;sourceHash?:string}
/** Acquisition time belongs to the host producer. Reading never refreshes old evidence. */
export function readInterlock(path:string,clock=Date.now,expected?:InterlockContract):InterlockProof {
 try{return validateInterlock(JSON.parse(boundedInput(path).toString('utf8')),path,clock,expected);}
 catch{return {ok:false,at:new Date(clock()).toISOString(),state:'unknown',source:path,reason:'Host automation inventory unavailable, conflicting or stale'};}
}
/** Pure validator for sanitized fixtures. Production admission always uses the protected inode reader above. */
export function validateInterlock(p:any,path:string,clock=Date.now,expected?:InterlockContract):InterlockProof {
 const unavailable=():InterlockProof=>({ok:false,at:new Date(clock()).toISOString(),state:'unknown',source:path,reason:'Host automation inventory unavailable, conflicting or stale'});
 try {
  if(!expected||expected.schema!==2||!Array.isArray(expected.appIds)||!expected.appIds.includes('lightningmate')||!expected.appIds.includes('lndg')||!expected.appIds.includes('lightning-terminal')||!expected.appIds.includes('albyhub'))return unavailable();
  const time=Date.parse(p.at),current=clock();
  if(p.schema!==2||!Number.isFinite(time)||time>current||current-time>90000||!Number.isSafeInteger(p.generation)||p.generation<0||typeof p.hostBootId!=='string'||!p.hostBootId||! /^[a-f0-9]{64}$/.test(p.sourceHash??'')||p.ownerScope!=='owner')return unavailable();
  if(p.hostBootId!==expected.hostBootId||p.sourceHash!==expected.sourceHash||p.generation!==expected.generation)return unavailable();
  if(!/^[a-f0-9]{64}$/.test(expected.producerHash??'')||p.producerHash!==expected.producerHash||!runtimeBindingMatches(p.runtimeBinding,expected.runtimeBinding))return unavailable();
  if(!Array.isArray(p.appIds)||!p.appIds.length||p.appIds.length>32||new Set(p.appIds).size!==p.appIds.length||p.appIds.some((id:unknown)=>typeof id!=='string'||! /^[a-z0-9-]{1,64}$/.test(id)))return unavailable();
  if(!Array.isArray(p.before)||!Array.isArray(p.after)||JSON.stringify(p.before)!==JSON.stringify(p.after)||p.before.length!==p.appIds.length)return unavailable();
  if(JSON.stringify(p.appIds)!==JSON.stringify(expected.appIds))return unavailable();
  if(!/^[a-f0-9]{64}$/.test(p.registryBeforeHash??'')||p.registryBeforeHash!==p.registryAfterHash)return unavailable();
  let installed=false;
  for(let i=0;i<p.appIds.length;i++){
   const a=p.before[i];if(a?.id!==p.appIds[i]||typeof a.durableInstalled!=='boolean'||!Array.isArray(a.containers)||a.containers.some((c:unknown)=>typeof c!=='string'))return unavailable();
   if(!a.durableInstalled){if(a.lifecycle!=='not-installed'||a.containers.length)return unavailable();}
   else {
    if(!['running','stopped'].includes(a.lifecycle))return unavailable();
    const installedQualification=expected.installedQualifications?.[a.id];
    if(!installedQualification||!runtimeBindingMatches(a.runtimeBinding,installedQualification.runtimeBinding))return unavailable();
    if(a.id==='albyhub'){
     const qualification=expected.albyQualification,facts=a.backendFacts,acquired=Date.parse(facts?.at??'');
     if(!qualification||qualification.version!=='1.24.0-patch.1'||!/^[a-f0-9]{64}$/.test(qualification.sourceHash)||qualification.contract!=='albyhub-v1.24.0-native-read-v1'||facts?.contract!==qualification.contract||facts.version!==qualification.version||facts.sourceHash!==qualification.sourceHash||! /^[a-f0-9]{64}$/.test(facts.checksum??'')||!Number.isFinite(acquired)||acquired>current||current-acquired>90000||! /^(02|03)[a-f0-9]{64}$/.test(facts.nodeId??'')||! /^(02|03)[a-f0-9]{64}$/.test(expected.expectedLndNodeId??''))return unavailable();
     if(facts.backend==='lnd'){if(facts.nodeId===expected.expectedLndNodeId&&facts.autoSwapOutEnabled!==false)return unavailable();}
     else if(facts.backend!=='ldk'||facts.nodeId===expected.expectedLndNodeId)return unavailable();
    }else{
     const facts=a.settingsFacts;
     if(!['lightningmate','lndg','lightning-terminal'].includes(a.id)||! /^[a-f0-9]{64}$/.test(installedQualification.hook?.sourceHash??'')||facts?.sourceHash!==installedQualification.hook?.sourceHash||!installedQualification.version||facts.version!==installedQualification.version||! /^[a-f0-9]{64}$/.test(facts.settingsDigest??'')||! /^(02|03)[a-f0-9]{64}$/.test(expected.expectedLndNodeId??'')||facts.nodeId!==expected.expectedLndNodeId)return unavailable();
    }
    installed=true;
   }
  }
  if(!Array.isArray(p.otherAutomationBefore)||!Array.isArray(p.otherAutomationAfter)||p.otherAutomationBefore.length||p.otherAutomationAfter.length)return unavailable();
  if(INTERLOCK_FLAGS.some(flag=>p.flags?.[flag]!==false))return unavailable();
  return {ok:true,at:p.at,source:path,state:installed?'installed_disabled':'verified_absent',reason:'Owner host inventory and disabled automation verified',generation:p.generation,hostBootId:p.hostBootId,sourceHash:p.sourceHash};
 }catch{return unavailable();}
}
