/** Trusted ingress seam. Call only for an explicit owner's requested export, after
 * normal Telegram admission and public canonical projection. Never exposed as a tool. */
import { Store } from './store.js';
import type { Turn } from './telegram-turns.js';
import { checksum } from './content-artifacts.js';
import { channelScid } from './diagnostics.js';
import type { CanonicalReadQuery } from './canonical-consumers.js';
import { validateContentSnapshot,type ContentFormat,type ContentSnapshot } from './content-generation.js';
interface AuthorizedRequest { jobId:string; requestId:string; generation:string; chatId:number; turnVersion:number; correctionIds:string[]; botGeneration:unknown; format:ContentFormat; snapshot:ContentSnapshot; snapshotSha256:string }
const serial=(value:unknown)=>JSON.stringify(value);
/** Explicit command admission, never infer a financial or export mandate from model text. */
export function parseContentRequest(message:string):{format:ContentFormat;query:CanonicalReadQuery}|undefined {
 if(!/^\/export(?:\s|$)/.test(message))return;
 const words=message.split(/\s+--\s+/,1)[0]!.trim().split(/\s+/);const format=words[1] as ContentFormat;
 if(message.length>512||!['pdf','png','csv','xlsx'].includes(format))throw Error('Use /export pdf|png|csv|xlsx [section=...] [channel=...] [start=UTC end=UTC limit=1..100]');
 const query:CanonicalReadQuery={limit:50};const used=new Set<string>();
 for(const token of words.slice(2)){
  const match=/^(section|kind|source|target|channel|start|end|limit)=([^=]+)$/.exec(token);if(!match||used.has(match[1]!))throw Error('Unsupported or duplicate export scope');
  const key=match[1]!,value=match[2]!;used.add(key);
  if(key==='section'){if(!['observations','corridor_events','manual_events','policy_events','coverage','decisions','operations','evaluations','evaluationWindows','claims','holds'].includes(value))throw Error('Unsupported export section');if(value!=='observations')query.section=value;}
  else if(key==='kind'){if(!['forward','payment','payment_attempt','native_htlc','native_policy','events','decisions','operations','evaluations','evaluation_windows','claims','channel_holds','channel','graph','transaction','invoice'].includes(value))throw Error('Unsupported export kind');query.kind=value;}
  else if(key==='limit'){if(!/^[1-9]\d{0,2}$/.test(value)||Number(value)>100)throw Error('Bounded export limit required');query.limit=Number(value);}
  else if(key==='start'||key==='end'){if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,19)!==value.slice(0,19))throw Error('UTC export interval required');query[key]=new Date(value).toISOString();}
  else query[key as 'source'|'target'|'channel']=channelScid(value);
 }
 if(query.start&&query.end&&query.start>query.end)throw Error('Inverted export interval');
 if(query.section==='coverage'&&(query.source||query.target||query.channel||query.kind))throw Error('Coverage export requires its own unfiltered lineage scope');
 return {format,query};
}
function owner(store:Store,jobId:string){
 const turn=store.get<Turn>('telegramTurn:'+jobId),job=store.one('SELECT * FROM jobs WHERE id=?',jobId),binding=store.get('telegramBinding');
 if(store.get('contentArtifactsEnabled')!==true||store.get('telegramTokenTransition')===true||!turn||turn.closed||!['queued','running'].includes(turn.state)||!job||!['queued','running'].includes(job.state)||!binding||binding.generation!==turn.generation||binding.chatId!==turn.chatId||!['read_only_chat','read_only_research'].includes(turn.capability)||store.get('jobCapability:'+jobId)!==turn.capability)throw Error('Content request authority unavailable');
 return {turn,job};
}
export function authorizeContentRequest(store:Store,jobId:string,format:ContentFormat,snapshot:ContentSnapshot):void {
 const {turn,job}=owner(store,jobId),frozen=validateContentSnapshot(format,snapshot);
 const request:AuthorizedRequest={jobId,requestId:job.request_id,generation:turn.generation,chatId:turn.chatId,turnVersion:turn.version,correctionIds:[...(turn.correctionOrder??[])],botGeneration:store.get('telegramBotGeneration')??null,format,snapshot:frozen,snapshotSha256:checksum(serial(frozen))};
 const old=store.get<AuthorizedRequest>('contentAuthorizedRequest:'+jobId);if(old){if(serial(old)!==serial(request))throw Error('Immutable content request conflict');return;}
 const capacity=store.one("SELECT count(*) n, COALESCE(sum(length(CAST(value AS BLOB))),0) bytes FROM meta WHERE key LIKE 'contentAuthorizedRequest:%'");if(capacity.n>=128||capacity.bytes+Buffer.byteLength(serial(request))>16*1024*1024)throw Error('Content request capacity reached');
 store.set('contentAuthorizedRequest:'+jobId,request);
}
export function authorizedContentRequest(store:Store,jobId:string):{format:ContentFormat;snapshot:ContentSnapshot}|undefined {
 const request=store.get<AuthorizedRequest>('contentAuthorizedRequest:'+jobId);if(!request)return;
 const {turn,job}=owner(store,jobId);
 if(request.jobId!==jobId||request.requestId!==job.request_id||request.generation!==turn.generation||request.chatId!==turn.chatId||request.turnVersion!==turn.version||serial(request.correctionIds)!==serial(turn.correctionOrder??[])||serial(request.botGeneration)!==serial(store.get('telegramBotGeneration')??null)||request.snapshotSha256!==checksum(serial(request.snapshot)))throw Error('Content request identity mismatch');
 return {format:request.format,snapshot:validateContentSnapshot(request.format,request.snapshot)};
}
