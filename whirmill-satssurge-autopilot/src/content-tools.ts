import { defineTool } from '@earendil-works/pi-durable';
import { Type } from '@earendil-works/pi-ai';
import { readFile } from 'node:fs/promises';
import { checksum, DLS_CSS_SHA256 } from './content-artifacts.js';
import { ContentGeneration } from './content-generation.js';
const output=(value:unknown)=>({content:[{type:'text' as const,text:JSON.stringify(value)}]});
/** Install in existing per-slot registry, never a second harness. Host resolves only
 * the current job's pre-admitted grant and applies its budget/Stop fence. */
export function contentTools(service:ContentGeneration,resolveGrant:(conversationId:string)=>string,label='') {
  return [
    defineTool({name:'content_snapshot'+label,description:'Read the current owner-request authorized public snapshot and fixed DLS before composing HTML. CSV/XLSX preserve the snapshot table directly. No code, permissions, runtime or financial authority.',parameters:Type.Object({},{additionalProperties:false}),replay:'safe',async execute(_a,api){
      const grant=resolveGrant(String(api.conversationId)),snapshot=service.snapshot(grant,String(api.conversationId));
      const css=await readFile(new URL('../content/dls/v1/style.css',import.meta.url),'utf8');
      const instructions=await readFile(new URL('../content/dls/v1/README.md',import.meta.url),'utf8');
      if(checksum(css)!==DLS_CSS_SHA256||instructions.length>32768)throw Error('Content DLS unavailable');
      // Revalidate original job after filesystem awaits; no raw store/tool body.
      service.snapshot(grant,String(api.conversationId));
      return output({...snapshot,dls:snapshot.dlsVersion?{instructions,css,cssSha256:DLS_CSS_SHA256}:null});
    }}),
    defineTool({name:'create_content_artifact'+label,description:'Commit exact agent-authored HTML for the authorized PDF/PNG request, or export the authorized table directly as CSV/XLSX. Omit HTML for table exports. Retries reuse the same revision and reject changed content; explicit regeneration must name revisionOf and is capped at four. Rendering may remain pending. Does not send messages.',parameters:Type.Object({html:Type.Optional(Type.String({minLength:1,maxLength:524288})),revisionOf:Type.Optional(Type.String({pattern:'^[a-f0-9]{64}$'}))},{additionalProperties:false}),replay:'safe',async execute(a,api){
      const grant=resolveGrant(String(api.conversationId));const r=await service.create(grant,String(api.conversationId),a.html,a.revisionOf??null);return output(service.describe(r.id));
    }}),
    defineTool({name:'content_artifact_status'+label,description:'Read verified artifact completion and correlated checksums. Pending means no output yet; do not regenerate as a delivery retry. Host outbox delivers the exact immutable artifact.',parameters:Type.Object({artifactId:Type.String({pattern:'^[a-f0-9]{64}$'})},{additionalProperties:false}),replay:'safe',async execute(a,api){
      const grant=resolveGrant(String(api.conversationId));service.snapshot(grant,String(api.conversationId));
      // Status validates conversation; also bind exact current grant on reused sessions.
      if(service.store.get<{grantId:string}>('contentReceipt:'+a.artifactId)?.grantId!==grant)throw Error('Content request mismatch');
      return output(await service.status(a.artifactId,String(api.conversationId)));
    }}),
  ];
}
