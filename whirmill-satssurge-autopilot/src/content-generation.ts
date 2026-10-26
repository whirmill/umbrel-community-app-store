/** Application-owned content receipts. No credentials, provider, runtime or finance authority. */
import { Store } from './store.js';
import { telegramChat } from './domain.js';
import type { Turn } from './telegram-turns.js';
import { checksum, cancelRender, submitRender, readRenderedArtifact, readRenderFailure, validateRenderRequest, DLS_VERSION, CONTENT_LIMITS, type RenderRequest } from './content-artifacts.js';
import { exportTable, validateTable, type ContentTable } from './content-exports.js';
export type ContentFormat='pdf'|'png'|'csv'|'xlsx';
export interface ContentSnapshot { title:string; observedAt:string; coverage:string; evidenceRefs:string[]; table:ContentTable }
interface Grant { version:1; id:string; jobId:string; requestId:string; conversationId:string; turnVersion:number; correctionIds:string[]; generation:string; chatId:number; botGeneration:unknown; format:ContentFormat; snapshot:ContentSnapshot; snapshotSha256:string }
export interface ContentReceipt { version:1; createdAt:string; id:string; grantId:string; revision:number; revisionOf:string|null; inputSha256:string; format:ContentFormat; dlsVersion:string|null; profile:string; state:'pending'|'ready'|'rejected'; renderRequest:RenderRequest|null; html:string|null; data:string|null; artifactSha256:string|null; bytes:number|null; pages:number|null; eventId:string|null }
const formats=['pdf','png','csv','xlsx'];
const serial=(value:unknown)=>JSON.stringify(value);
const clone=<T>(value:T):T=>JSON.parse(serial(value)) as T;
const opaque=/^[a-f0-9]{64}$/;
const mime=(format:ContentFormat)=>({pdf:'application/pdf',png:'image/png',csv:'text/csv;charset=utf-8',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}[format]);
export function validateContentSnapshot(format:ContentFormat,snapshot:ContentSnapshot):ContentSnapshot {
  const frozen=clone(snapshot);validateTable(frozen.table);
  if(Object.keys(frozen).sort().join(',')!=='coverage,evidenceRefs,observedAt,table,title'||typeof frozen.title!=='string'||!frozen.title.length||frozen.title.length>200||/[\x00-\x1f]/.test(frozen.title)||!formats.includes(format)||Buffer.byteLength(serial(frozen))>CONTENT_LIMITS.inputBytes)throw Error('Invalid content snapshot');
  validateRenderRequest({protocol:1,requestId:'snapshot-validation',artifactId:'snapshot-validation',format:'pdf',inputSha256:checksum(''),dlsVersion:DLS_VERSION,evidenceRefs:frozen.evidenceRefs,observedAt:frozen.observedAt,coverage:frozen.coverage,revisionOf:null});return frozen;
}
export class ContentGeneration {
  constructor(readonly store:Store,readonly renderRoot:string){}
  private capacity(value:unknown):void {const used=this.store.one("SELECT COALESCE(sum(length(CAST(value AS BLOB))),0) n FROM meta WHERE key LIKE 'contentGrant:%' OR key LIKE 'contentReceipt:%'").n;if(used+Buffer.byteLength(serial(value))>32*1024*1024)throw Error('Content byte capacity reached');}
  private grant(id:string):Grant {if(!opaque.test(id))throw Error('Invalid content grant');const grant=this.store.get<Grant>('contentGrant:'+id);if(!grant||checksum(serial(grant.snapshot))!==grant.snapshotSha256)throw Error('Content snapshot integrity failure');return grant;}
  private authority(grant:Grant,delivery=false):void {
    const binding=this.store.get('telegramBinding'),turn=this.store.get<Turn>('telegramTurn:'+grant.jobId),job=this.store.one('SELECT * FROM jobs WHERE id=?',grant.jobId);
    const stopped=this.store.all("SELECT value FROM meta WHERE key LIKE 'telegramStop:%'").some(row=>{const r=JSON.parse(row.value);return r.jobId===grant.jobId&&r.generation===grant.generation&&['received','idle_confirmed'].includes(r.state);});
    const versionAllowed=turn?.version===grant.turnVersion&&!turn.closed||delivery&&turn?.closed&&turn.state==='completed'&&turn.version===grant.turnVersion+1&&this.store.get<{state:string}>('telegramTerminal:'+grant.jobId)?.state==='completed';
    if(stopped||this.store.get('contentArtifactsEnabled')!==true||!binding||binding.generation!==grant.generation||binding.chatId!==grant.chatId||serial(this.store.get('telegramBotGeneration')??null)!==serial(grant.botGeneration)||this.store.get('telegramTokenTransition')===true||!turn||turn.generation!==grant.generation||turn.chatId!==grant.chatId||!versionAllowed||serial(turn.correctionOrder??[])!==serial(grant.correctionIds)||turn.conversationId!==grant.conversationId||!(telegramChat(turn.capability)||turn.capability==='read_only_research')||this.store.get('jobCapability:'+grant.jobId)!==turn.capability||!job||job.request_id!==grant.requestId||job.conversation_id!==grant.conversationId||(!delivery&&(turn.closed||turn.state!=='running'||job.state!=='running'))||(delivery&&(!['running','completed'].includes(turn.state)||!['running','completed'].includes(job.state))))throw Error('Content authority unavailable');
  }
  /** Trusted host only: snapshot must be a public projection, never a raw store/tool body.
   * Format is selected by the owner's request, not by a tool argument. */
  admit(jobId:string,format:ContentFormat,snapshot:ContentSnapshot):string {
    const frozen=validateContentSnapshot(format,snapshot);
    // Reuse renderer's closed timestamp/coverage/evidence validation on admission.
    const turn=this.store.get<Turn>('telegramTurn:'+jobId),job=this.store.one('SELECT * FROM jobs WHERE id=?',jobId);if(!turn||!job||!turn.conversationId)throw Error('Content owner unavailable');
    const grant:Grant={version:1,id:checksum('content:'+jobId),jobId,requestId:job.request_id,conversationId:turn.conversationId,turnVersion:turn.version,correctionIds:clone(turn.correctionOrder??[]),generation:turn.generation,chatId:turn.chatId,botGeneration:this.store.get('telegramBotGeneration')??null,format,snapshot:frozen,snapshotSha256:checksum(serial(frozen))};
    const probe=this.renderRequest(grant,grant.id,checksum(''),null);
    // submitRender performs the same check later; do not create jobs here.
    validateRenderRequest(probe);this.authority(grant);
    const old=this.store.get<Grant>('contentGrant:'+grant.id);if(old){if(serial(old)!==serial(grant))throw Error('Immutable content grant conflict');return old.id;}
    if(this.store.one("SELECT count(*) n FROM meta WHERE key LIKE 'contentGrant:%'").n>=128)throw Error('Content grant capacity reached');
    this.capacity(grant);this.store.set('contentGrant:'+grant.id,grant);return grant.id;
  }
  call(grantId:string):void {
    const g=this.grant(grantId);this.authority(g);const key='contentBudget:'+g.id;
    const b=this.store.get<{startedAt:number;calls:number}>(key)??{startedAt:Date.now(),calls:0};
    if(b.calls>=12||Date.now()-b.startedAt>120000)throw Error('Finite content budget exhausted');
    this.store.set(key,{...b,calls:b.calls+1});
  }
  snapshot(grantId:string,conversationId:string){const g=this.grant(grantId);this.authority(g);if(g.conversationId!==conversationId)throw Error('Content conversation mismatch');return {grantId:g.id,format:g.format,snapshotSha256:g.snapshotSha256,...clone(g.snapshot),dlsVersion:['pdf','png'].includes(g.format)?DLS_VERSION:null,profile:g.format==='png'?'a4-first-page-120dpi':g.format==='pdf'?'a4-paginated':'table-text-v1'};}
  private renderRequest(g:Grant,id:string,inputSha256:string,revisionOf:string|null):RenderRequest {return {protocol:1,requestId:checksum(g.requestId),artifactId:id,format:g.format==='png'?'png':'pdf',inputSha256,dlsVersion:DLS_VERSION,evidenceRefs:g.snapshot.evidenceRefs,observedAt:g.snapshot.observedAt,coverage:g.snapshot.coverage,revisionOf};}
  private receipt(id:string):ContentReceipt {if(!opaque.test(id))throw Error('Invalid content identity');const r=this.store.get<ContentReceipt>('contentReceipt:'+id);if(!r)throw Error('Unknown content identity');return r;}
  async create(grantId:string,conversationId:string,html?:string,revisionOf:string|null=null):Promise<ContentReceipt> {
    const g=this.grant(grantId);this.authority(g);if(g.conversationId!==conversationId)throw Error('Content conversation mismatch');
    const rendered=g.format==='pdf'||g.format==='png';
    if(typeof html==='string'&&/\b(?:\d{6,12}:[A-Za-z0-9_-]{20,}|lnbc[a-z0-9]+|nsec1[a-z0-9]+|sk-[A-Za-z0-9_-]{12,}|gh[op]_[A-Za-z0-9_-]+)\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(html))throw Error('Sensitive content rejected');
    if(rendered?(typeof html!=='string'||!html.length||Buffer.byteLength(html)>CONTENT_LIMITS.inputBytes):html!==undefined)throw Error('Content input mismatch');
    const data=rendered?null:exportTable(g.snapshot.table,g.format as 'csv'|'xlsx');const digest=checksum(rendered?html!:data!);
    let revision=1;
    if(revisionOf){const previous=this.receipt(revisionOf);if(previous.grantId!==g.id)throw Error('Revision owner mismatch');if(previous.eventId)throw Error('Delivery retains original artifact; new owner request required');revision=previous.revision+1;if(revision>4)throw Error('Content revision capacity reached');}
    // Revision identity is independent of input: retries with changed bytes conflict.
    const id=checksum(g.id+':'+revision);let r=this.store.get<ContentReceipt>('contentReceipt:'+id);
    if(r){if(r.inputSha256!==digest||r.revisionOf!==revisionOf)throw Error('Immutable content revision conflict');}
    else{
      if(this.store.one("SELECT count(*) n FROM meta WHERE key LIKE 'contentReceipt:%'").n>=128)throw Error('Content receipt capacity reached');
      r={version:1,createdAt:new Date().toISOString(),id,grantId:g.id,revision,revisionOf,inputSha256:digest,format:g.format,dlsVersion:rendered?DLS_VERSION:null,profile:g.format==='png'?'a4-first-page-120dpi':g.format==='pdf'?'a4-paginated':'table-text-v1',state:rendered?'pending':'ready',renderRequest:rendered?this.renderRequest(g,id,digest,revisionOf):null,html:rendered?html!:null,data:data?.toString('base64')??null,artifactSha256:data?checksum(data):null,bytes:data?.length??null,pages:null,eventId:null};
      // Commit generation intent/input before IPC. Crash resumes exact original bytes.
      this.capacity(r);this.store.tx(()=>{this.store.set('contentReceipt:'+id,r);this.store.set('contentHead:'+g.id,{id,revision});});
    }
    if(revisionOf){const previous=this.receipt(revisionOf);if(previous.renderRequest&&previous.state==='pending')await cancelRender(this.renderRoot,previous.id);}
    if(r.renderRequest){await submitRender(this.renderRoot,r.renderRequest,r.html!);this.authority(g);}
    return clone(r);
  }
  async status(id:string,conversationId:string):Promise<object> {const r=this.receipt(id),g=this.grant(r.grantId);this.authority(g);if(g.conversationId!==conversationId)throw Error('Content conversation mismatch');await this.complete(r);this.authority(g);return this.publicReceipt(this.receipt(id));}
  private publicReceipt(r:ContentReceipt){const g=this.grant(r.grantId);return {artifactId:r.id,requestId:g.requestId,revision:r.revision,revisionOf:r.revisionOf,state:r.state,format:r.format,profile:r.profile,dlsVersion:r.dlsVersion,snapshotSha256:g.snapshotSha256,inputSha256:r.inputSha256,artifactSha256:r.artifactSha256,bytes:r.bytes,pages:r.pages,selectedPage:r.format==='png'?1:null,observedAt:g.snapshot.observedAt,coverage:g.snapshot.coverage};}
  async complete(r:ContentReceipt):Promise<void> {
    if(!r.renderRequest||r.state==='ready'||r.state==='rejected')return;
    if(Date.now()-Date.parse(r.createdAt)>90000){await cancelRender(this.renderRoot,r.id);this.store.set('contentReceipt:'+r.id,{...this.receipt(r.id),state:'rejected'});return;}
    let output;try{output=await readRenderedArtifact(this.renderRoot,r.id);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'){if(await readRenderFailure(this.renderRoot,r.id)){this.authority(this.grant(r.grantId),true);this.store.set('contentReceipt:'+r.id,{...this.receipt(r.id),state:'rejected'});}return;}throw Error('Content artifact validation failed');}
    const g=this.grant(r.grantId);this.authority(g,true);
    if(serial(output.manifest.request)!==serial(r.renderRequest)){
      // Python sorts JSON keys; compare semantic values, preserving arrays.
      if(Object.keys(r.renderRequest).some(k=>serial(output.manifest.request[k as keyof RenderRequest])!==serial(r.renderRequest![k as keyof RenderRequest])))throw Error('Content render identity mismatch');
    }
    const current=this.receipt(r.id);this.store.set('contentReceipt:'+r.id,{...current,state:'ready',artifactSha256:output.manifest.artifactSha256,bytes:output.data.length,pages:output.manifest.proof.pages});
  }
  /** Root capture invokes this after generation/turn completion. No send occurs here. */
  async enqueue(id:string,at:string):Promise<string|null> {
    let r=this.receipt(id);const g=this.grant(r.grantId);this.authority(g,true);if(this.store.get<{id:string}>('contentHead:'+g.id)?.id!==id)throw Error('Superseded content revision');if(r.renderRequest&&r.state==='pending'){await submitRender(this.renderRoot,r.renderRequest,r.html!);this.authority(g,true);}await this.complete(r);this.authority(g,true);r=this.receipt(id);if(r.state!=='ready')return null;
    const eventId='content:'+r.id;
    this.store.tx(()=>{this.authority(g,true);if(this.store.get<{id:string}>('contentHead:'+g.id)?.id!==id)throw Error('Superseded content revision');const old=this.receipt(id);if(old.eventId&&old.eventId!==eventId)throw Error('Content delivery identity conflict');
      this.store.set('contentReceipt:'+id,{...old,eventId});this.store.set('contentEvent:'+eventId,{artifactId:id});
      this.store.run("INSERT OR IGNORE INTO telegram_outbox(event_id,created_at,kind,text,generation) VALUES(?,?,?,?,?)",eventId,at,'reply',`${g.snapshot.title}\n${g.snapshot.observedAt} · ${g.snapshot.coverage}\nRevisione ${r.revision}${r.format==='png'?` · Anteprima pagina 1 di ${r.pages}`:''}`,g.generation);
    });return eventId;
  }
  /** Called inside the existing serialized Telegram dispatch, BEFORE marking sending.
   * Rechecks authority after file awaits. Existing outbox owns retries/uncertain state. */
  async attachment(eventId:string):Promise<{filename:string;mime:string;data:Buffer;checksum:string;chatId:number;caption:string}|null> {
    const link=this.store.get<{artifactId:string}>('contentEvent:'+eventId);if(!link)return null;
    const r=this.receipt(link.artifactId),g=this.grant(r.grantId);this.authority(g,true);
    if(eventId!=='content:'+r.id||r.eventId!==eventId||r.state!=='ready')throw Error('Content delivery identity mismatch');
    const data=r.renderRequest?(await readRenderedArtifact(this.renderRoot,r.id)).data:Buffer.from(r.data!,'base64');this.authority(g,true);
    const row=this.store.one('SELECT * FROM telegram_outbox WHERE event_id=?',eventId);
    if(row?.status!=='pending'||row.generation!==g.generation||data.length!==r.bytes||checksum(data)!==r.artifactSha256)throw Error('Content delivery integrity or state mismatch');
    return {filename:`satssurge-${r.id.slice(0,16)}-r${r.revision}.${r.format}`,mime:mime(r.format),data,checksum:r.artifactSha256!,chatId:g.chatId,caption:row.text};
  }
  /** Final synchronous fence immediately before existing outbox sending intent. */
  assertDelivery(eventId:string):void {
    const link=this.store.get<{artifactId:string}>('contentEvent:'+eventId);if(!link)return;
    const r=this.receipt(link.artifactId),g=this.grant(r.grantId);this.authority(g,true);
    const row=this.store.one('SELECT status,generation FROM telegram_outbox WHERE event_id=?',eventId);
    if(r.eventId!==eventId||eventId!=='content:'+r.id||r.state!=='ready'||this.store.get<{id:string}>('contentHead:'+g.id)?.id!==r.id||row?.status!=='pending'||row.generation!==g.generation)throw Error('Content final delivery fence');
  }
  describe(id:string){return this.publicReceipt(this.receipt(id));}
  /** Bounded host polling. Do not log internal errors or model HTML. */
  async capture(at:string):Promise<{artifactId:string;state:'pending'|'enqueued'|'blocked'}[]> {
    const results:{artifactId:string;state:'pending'|'enqueued'|'blocked'}[]=[];
    const rows=this.store.all("SELECT value FROM meta WHERE key LIKE 'contentHead:%' ORDER BY rowid LIMIT 128");if(!rows.length)return results;
    const saved=this.store.get<number>('contentCaptureCursor')??0;let cursor=Number.isSafeInteger(saved)&&saved>=0?saved%rows.length:0;
    for(let scanned=0;scanned<rows.length&&results.length<4;scanned++){
      const row=rows[cursor]!;cursor=(cursor+1)%rows.length;
      const head=JSON.parse(row.value) as {id:string};const r=this.receipt(head.id);if(r.eventId||r.state==='rejected')continue;
      try{results.push({artifactId:r.id,state:await this.enqueue(r.id,at)?'enqueued':'pending'});}catch{if(r.renderRequest&&r.state==='pending'){try{await cancelRender(this.renderRoot,r.id);}catch{}this.store.set('contentReceipt:'+r.id,{...this.receipt(r.id),state:'rejected'});}results.push({artifactId:r.id,state:'blocked'});}
    }this.store.set('contentCaptureCursor',cursor);return results;
  }
}
