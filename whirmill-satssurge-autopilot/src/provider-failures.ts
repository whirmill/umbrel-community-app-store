/** Public policy contains closed classifications and native identifiers, never provider text. */
export type ProviderFailureKind='transient_stream'|'transient_network'|'authentication'|'quota'|'no_model'|'configuration_missing'|'availability_unknown'|'provider_unknown';
export type ProviderFailureCode='stream_ended_before_terminal_event'|'stream_ended_without_stop_reason'|'connection_error'|'request_timeout'|'http_401'|'http_403'|'http_429'|'invalid_api_key'|'token_expired'|'rate_limit_exceeded'|'insufficient_quota'|'subscription_sharing_usage_limit_exceeded'|'no_model'|'configuration_missing'|'unclassified';
export interface ProviderFailure {
 kind:ProviderFailureKind;code:ProviderFailureCode;source:'native_entry'|'native_submission'|'pre_submission'|'legacy_unknown';
 jobId:string;conversationId?:string;submissionId?:string;taskId?:string;entryId?:string;
 at:string;cooldownMs:number;until:string;httpStatus?:401|403|429;
}
export function classifyNativeProviderError(message:unknown):Pick<ProviderFailure,'kind'|'code'|'httpStatus'> {
 // Exact SDK-generated conditions: model output and arbitrary matching words cannot qualify auth/quota.
 if(typeof message!=='string'||message.length>8192)return {kind:'provider_unknown',code:'unclassified'};
 if(message==='OpenAI Responses stream ended before a terminal response event')return {kind:'transient_stream',code:'stream_ended_before_terminal_event'};
 if(message==='OpenAI Responses stream ended without a stop reason')return {kind:'transient_stream',code:'stream_ended_without_stop_reason'};
 if(message==='Connection error.'||message==='fetch failed')return {kind:'transient_network',code:'connection_error'};
 if(message==='Request timed out.')return {kind:'transient_network',code:'request_timeout'};
 // Pinned Pi AI normalizeProviderError composes this prefix from SDK numeric status, not body keywords.
 const http=/^OpenAI API error \((401|403|429)\): /.exec(message);
 if(http){const status=Number(http[1]) as 401|403|429;return {kind:status===429?'quota':'authentication',code:('http_'+status) as ProviderFailureCode,httpStatus:status};}
 // Pinned Responses parser composes these qualified prefixes from structured event.error.code.
 const code=/^(?:Error Code )?(invalid_api_key|token_expired|rate_limit_exceeded|insufficient_quota|subscription_sharing_usage_limit_exceeded): /.exec(message)?.[1] as ProviderFailureCode|undefined;
 if(code)return {kind:['invalid_api_key','token_expired'].includes(code)?'authentication':'quota',code};
 return {kind:'provider_unknown',code:'unclassified'};
}
export function failureCooldownMs(kind:ProviderFailureKind){return kind==='transient_stream'||kind==='transient_network'?60000:30*60000;}
export function availabilityBlocker(failure:unknown):string {
 const f=failure as Partial<ProviderFailure>|undefined;
 // Readback provenance is required before claiming authentication/quota. Legacy state stays unknown.
 const native=f?.source==='native_entry'&&!!f.jobId&&!!f.conversationId&&!!f.submissionId&&!!f.taskId&&!!f.entryId;
 if(native&&f.kind==='authentication'&&['http_401','http_403','invalid_api_key','token_expired'].includes(f.code??''))return 'Autenticazione agente rifiutata dal provider; verifica la connessione';
 if(native&&f.kind==='quota'&&['http_429','rate_limit_exceeded','insufficient_quota','subscription_sharing_usage_limit_exceeded'].includes(f.code??''))return 'Quota o limite richieste agente segnalato dal provider';
 if(native&&f.kind==='transient_stream')return 'Risposta del provider interrotta; attesa temporanea prima di nuove richieste';
 if(native&&f.kind==='transient_network')return 'Connessione al provider interrotta; attesa temporanea prima di nuove richieste';
 if(f?.kind==='no_model'||f?.kind==='configuration_missing')return 'Modello agente non configurato o non disponibile';
 return 'Servizio modello agente non disponibile; causa non qualificata';
}
