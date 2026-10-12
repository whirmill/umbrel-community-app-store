/** Content generation/renderer IPC only. No provider, finance, store or Telegram capability. */
import { constants } from 'node:fs';
import { open, mkdir, lstat, readdir, realpath, link, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';

export const DLS_VERSION = '1.0.0';
export const OUTPUT_CONFORMANCE_VERSION = 'puppeteer-visible-v1';
export const DLS_CSS_SHA256 = 'cf6ebc2cf9f7a2092d303ef20eb61eef3b2358d1ca5cbd04ba5fc2c88f817940';
export const DLS_FONT_SHA256 = Object.freeze(["f9696798e2d82d52207ac00c4462bc86999d371ab87401db4067feb3def4d27b", "8d1faea152c356d6f6135233f6676b6d3d44b4153e6937f03e9c74a8978a0e2b", "258c181dff27a230c87310fd22f55152c07d50a9cc92b01daa767da9c4ffea7b"]);
export const CONTENT_LIMITS = Object.freeze({ inputBytes:524288, outputBytes:20*1024*1024, jobs:128, pending:8, totalBytes:128*1024*1024, pages:24 });
const id = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/;
export type RenderFormat = 'pdf' | 'png';
export interface RenderRequest {
  protocol:1; requestId:string; artifactId:string; format:RenderFormat;
  inputSha256:string; dlsVersion:typeof DLS_VERSION; evidenceRefs:string[];
  observedAt:string; coverage:string; revisionOf:string|null;
}
export interface ArtifactManifest {
  protocol:1; rendererVersion:string; request:RenderRequest; requestSha256:string;
  artifactSha256:string; bytes:number; mime:string; filename:string;
  proof:{layout:{version:typeof OUTPUT_CONFORMANCE_VERSION;textBoxes:number;svgBoxes:number;minFontPt:number};pages:number;selectedPage:number|null;width:number|null;height:number|null;versions:Record<string,string>;fontSha256:string[];dlsSha256:string;inputSha256:string;requestSha256:string};
}
export const checksum = (data:Uint8Array|string):string => createHash('sha256').update(data).digest('hex');
export const escapeHtml = (text:string):string => text.replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function kpi(label:string,value:string,unit:string):string { return `<div class="kpi"><div class="kpi-label">${escapeHtml(label)}</div><div class="kpi-value">${escapeHtml(value)}</div><div>${escapeHtml(unit)}</div></div>`; }
export function reportTable(headers:string[],rows:string[][]):string {
  if(!headers.length || headers.length>12 || rows.length>2000 || rows.some(row=>row.length!==headers.length)) throw new Error('Invalid report table');
  return `<table><thead><tr>${headers.map(h=>`<th scope="col">${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map(cell=>`<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}
export function provenance(observedAt:string,coverage:string,refs:string[]):string { return `<div class="provenance">Osservato: ${escapeHtml(observedAt)} · ${escapeHtml(coverage)}<br>Fonti: ${refs.map(escapeHtml).join(', ')}</div>`; }
export function reportDocument(title:string,body:string,metadata:string):string { return `<!doctype html><html lang="it"><head><title>${escapeHtml(title)}</title></head><body><main><p class="eyebrow">SatsSurge</p><h1>${escapeHtml(title)}</h1><p class="metadata">${escapeHtml(metadata)}</p>${body}</main></body></html>`; }
export function validateRenderRequest(value:RenderRequest):void {
  const expected=['protocol','requestId','artifactId','format','inputSha256','dlsVersion','evidenceRefs','observedAt','coverage','revisionOf'].sort();
  if(JSON.stringify(Object.keys(value).sort())!==JSON.stringify(expected) || value.protocol!==1 || value.dlsVersion!==DLS_VERSION || !['pdf','png'].includes(value.format) || typeof value.requestId!=='string' || typeof value.artifactId!=='string' || !id.test(value.requestId) || !id.test(value.artifactId) || !/^[a-f0-9]{64}$/.test(value.inputSha256)) throw new Error('Invalid render request');
  if(value.revisionOf!==null && (typeof value.revisionOf!=='string'||!id.test(value.revisionOf)||value.revisionOf===value.artifactId)) throw new Error('Invalid artifact revision');
  if(!Array.isArray(value.evidenceRefs)||value.evidenceRefs.length<1||value.evidenceRefs.length>32||value.evidenceRefs.some(ref=>typeof ref!=='string'||!id.test(ref))) throw new Error('Invalid evidence references');
  for(const text of [value.observedAt,value.coverage]) if(typeof text!=='string'||text.length<1||text.length>256||/[\x00-\x1f]/.test(text)) throw new Error('Invalid artifact metadata');
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value.observedAt)||(!Number.isFinite(Date.parse(value.observedAt))||new Date(value.observedAt).toISOString().slice(0,19)!==value.observedAt.slice(0,19))) throw new Error('Invalid observation timestamp');
}
async function safeRoot(root:string):Promise<string> { const path=resolve(root); if((await lstat(path)).isSymbolicLink() || await realpath(path)!==path) throw new Error('Unsafe artifact root'); return path; }
async function readClosed(path:string,max:number):Promise<Buffer> {
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try { const info=await file.stat(); if(!info.isFile()||info.nlink!==1||info.size>max) throw new Error('Invalid artifact file'); const chunks:Buffer[]=[];let size=0;
    while(size<=max){const chunk=Buffer.alloc(Math.min(65536,max+1-size));const {bytesRead}=await file.read(chunk,0,chunk.length,null);if(!bytesRead)break;chunks.push(chunk.subarray(0,bytesRead));size+=bytesRead;}
    if(size>max)throw new Error('Artifact file too large');return Buffer.concat(chunks,size); } finally { await file.close(); }
}
async function writeExclusive(path:string,data:Uint8Array|string):Promise<void> { const file=await open(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600); try{await file.writeFile(data);await file.sync();}finally{await file.close();} }
const serialize=(value:unknown):string=>JSON.stringify(value)+'\n';
/** Single application admission owner serializes calls. Worker publication is request.json last. */
async function submitRenderUnlocked(root:string,request:RenderRequest,html:string):Promise<'submitted'|'existing'> {
  validateRenderRequest(request);const input=Buffer.from(html,'utf8');
  if(input.length>CONTENT_LIMITS.inputBytes||checksum(input)!==request.inputSha256) throw new Error('Input checksum or size mismatch');
  const directory=await safeRoot(root), job=join(directory,request.artifactId);
  let partial=false;
  try { const info=await lstat(job);if(!info.isDirectory()||info.isSymbolicLink()||await realpath(job)!==job)throw Error('Unsafe job directory');partial=true; }
  catch(error) { if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error; }
  const sameRequest=(existing:RenderRequest)=>Object.keys(request).every(key=>JSON.stringify(existing[key as keyof RenderRequest])===JSON.stringify(request[key as keyof RenderRequest]));
  if(partial){
    // A persisted application receipt owns the exact job/revision and HTML. A
    // crash after input fsync but before request publication must reuse that
    // input, never rewrite it or allocate a new artifact identity.
    const original=await readClosed(join(job,'input.html'),CONTENT_LIMITS.inputBytes);
    if(checksum(original)!==request.inputSha256||!original.equals(input))throw Error('Artifact input identity conflict');
    try { const existing=await readRenderRequest(directory,request.artifactId);if(!sameRequest(existing))throw Error('Artifact identity conflict');return 'existing'; }
    catch(error) { if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error; }
    // Only the pre-publication input and matching orphan staging records are
    // recoverable. Output/claim/failure evidence without a request is ambiguous.
    for(const name of await readdir(job)){
      if(name==='input.html')continue;
      if(!/^\.request-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(name))throw Error('Incomplete IPC publication conflict');
      const staged=JSON.parse((await readClosed(join(job,name),16384)).toString()) as RenderRequest;
      validateRenderRequest(staged);if(!sameRequest(staged))throw Error('Artifact staged identity conflict');
    }
  }
  const entries=await readdir(directory,{withFileTypes:true});let pending=0,total=0,count=0;
  for(const entry of entries){if(entry.name==='worker.lock')continue;if(!entry.isDirectory()||!id.test(entry.name))throw new Error('Unsafe job root entry');count++;const p=join(directory,entry.name);const names=await readdir(p);if(!names.includes('manifest.json')&&!names.includes('failure.json'))pending++;for(const name of names){const info=await lstat(join(p,name));if(!info.isFile()||info.isSymbolicLink())throw new Error('Unsafe job entry');total+=info.size;}}
  const added=partial?0:1;
  if(count+added>CONTENT_LIMITS.jobs||pending+added>CONTENT_LIMITS.pending||total+(partial?0:input.length)+(pending+added)*CONTENT_LIMITS.outputBytes>CONTENT_LIMITS.totalBytes)throw new Error('Artifact capacity reached');
  if(!partial){await mkdir(job,{mode:0o700});await writeExclusive(join(job,'input.html'),input);}
  const staging=join(job,`.request-${randomUUID()}`);
  await writeExclusive(staging,serialize(request));
  try{await link(staging,join(job,'request.json'));}finally{await unlink(staging);}
  const dir=await open(job,constants.O_RDONLY);try{await dir.sync();}finally{await dir.close();}
  return 'submitted';
}
const admissions=new Map<string,Promise<void>>();
export async function submitRender(root:string,request:RenderRequest,html:string):Promise<'submitted'|'existing'> {
  // Freeze before awaits so a caller cannot mutate authorized request identity mid-admission.
  const frozen=JSON.parse(JSON.stringify(request)) as RenderRequest;const key=resolve(root);
  const previous=admissions.get(key)??Promise.resolve();let release!:()=>void;
  const current=new Promise<void>(done=>{release=done;});admissions.set(key,current);
  await previous;
  try{return await submitRenderUnlocked(root,frozen,html);}finally{release();if(admissions.get(key)===current)admissions.delete(key);}
}
export async function readRenderRequest(root:string,artifactId:string):Promise<RenderRequest>{
  if(!id.test(artifactId))throw new Error('Invalid artifact identity');const directory=await safeRoot(root),job=join(directory,artifactId);
  if((await lstat(job)).isSymbolicLink()||await realpath(job)!==job)throw new Error('Unsafe job directory');
  const request=JSON.parse((await readClosed(join(job,'request.json'),16384)).toString()) as RenderRequest;validateRenderRequest(request);if(request.artifactId!==artifactId)throw new Error('Artifact identity mismatch');return request;
}
export async function readRenderedArtifact(root:string,artifactId:string):Promise<{manifest:ArtifactManifest;data:Buffer}> {
  const request=await readRenderRequest(root,artifactId),job=join(resolve(root),artifactId),rawRequest=await readClosed(join(job,'request.json'),16384);
  if(checksum(await readClosed(join(job,'input.html'),CONTENT_LIMITS.inputBytes))!==request.inputSha256)throw new Error('Input snapshot checksum mismatch');
  const manifest=JSON.parse((await readClosed(join(job,'manifest.json'),32768)).toString()) as ArtifactManifest;
  validateRenderRequest(manifest.request);
  const layout=manifest.proof?.layout;
  if(layout?.version!==OUTPUT_CONFORMANCE_VERSION||!Number.isInteger(layout.textBoxes)||layout.textBoxes<1||layout.textBoxes>1000000||!Number.isInteger(layout.svgBoxes)||layout.svgBoxes<0||layout.svgBoxes>10000||!Number.isFinite(layout.minFontPt)||layout.minFontPt<7.99||layout.minFontPt>48)throw Error('Unqualified visible layout proof');
  if(manifest.proof?.versions?.puppeteer!=='25.12.0'||!/^(?:HeadlessChrome|Chrome)\/154\.0\.8037\.92$/.test(manifest.proof?.versions?.chromium??'')||!Array.isArray(manifest.proof.fontSha256)||manifest.proof.fontSha256.length!==DLS_FONT_SHA256.length||new Set(manifest.proof.fontSha256).size!==DLS_FONT_SHA256.length||manifest.proof.fontSha256.some(hash=>!DLS_FONT_SHA256.includes(hash))||manifest.proof.dlsSha256!==DLS_CSS_SHA256||manifest.proof.inputSha256!==request.inputSha256||manifest.proof.requestSha256!==checksum(rawRequest))throw new Error('Unqualified renderer proof');
  // Compare semantic request fields, independent of JSON key order from the worker.
  for(const key of Object.keys(request) as (keyof RenderRequest)[])if(JSON.stringify(manifest.request?.[key])!==JSON.stringify(request[key]))throw new Error('Artifact receipt request mismatch');
  if(manifest.protocol!==1||manifest.rendererVersion!==DLS_VERSION||manifest.requestSha256!==checksum(rawRequest)||manifest.filename!==`artifact.${request.format}`||manifest.mime!==(request.format==='pdf'?'application/pdf':'image/png')||!Number.isInteger(manifest.proof?.pages)||manifest.proof.pages<1||manifest.proof.pages>CONTENT_LIMITS.pages)throw new Error('Invalid artifact receipt');
  if(request.format==='png'&&(manifest.proof.selectedPage!==1||manifest.proof.width!==993||manifest.proof.height!==1404))throw new Error('Invalid PNG profile');
  const data=await readClosed(join(job,manifest.filename),CONTENT_LIMITS.outputBytes);
  if(data.length!==manifest.bytes||checksum(data)!==manifest.artifactSha256||!(request.format==='pdf'?data.subarray(0,5).equals(Buffer.from('%PDF-')):data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))))throw new Error('Artifact checksum or signature mismatch');
  return {manifest,data};
}
/** Closed failure receipt; callers first prefer a complete validated manifest. */
export async function readRenderFailure(root:string,artifactId:string):Promise<boolean> {
  await readRenderRequest(root,artifactId);
  try {
    const value=JSON.parse((await readClosed(join(resolve(root),artifactId,'failure.json'),1024)).toString());
    if(Object.keys(value).sort().join(',')!=='artifactId,code,protocol'||value.protocol!==1||value.code!=='render_rejected'||value.artifactId!==artifactId)throw Error('Invalid render failure');return true;
  }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}
}
/** Ready CSV/XLSX files never invoke or enter renderer IPC. Delivery integration is separate. */
export function artifactRoute(format:string):'renderer'|'ready-file' { return format==='pdf'||format==='png'?'renderer':'ready-file'; }
/** Prevent spreadsheet formula interpretation, including leading whitespace/control characters. */
export function csvCell(value:string):string { const safe=/^[\s\u0000-\u001f]*[=+@-]/.test(value)?`'${value}`:value;return `"${safe.replace(/"/g,'""')}"`; }

/** Closed cancellation sidecar; never overwrites request, output or failure evidence. */
export async function cancelRender(root:string,artifactId:string):Promise<void> {
 const request=await readRenderRequest(root,artifactId),path=join(resolve(root),artifactId,'cancel.json');
 const value=serialize({protocol:1,artifactId:request.artifactId,inputSha256:request.inputSha256});
 try{await writeExclusive(path,value);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;if((await readClosed(path,1024)).toString()!==value)throw Error('Render cancellation identity conflict');}
}
