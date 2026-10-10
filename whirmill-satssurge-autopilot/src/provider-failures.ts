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

/** Consume only the closed receipt written after Agent's native Task/Entry proof.
 * Binding to the original job/conversation/submission prevents a stale provider
 * receipt from classifying another failure. Correction IDs require the caller's
 * explicit accepted-turn ledger proof, never arbitrary same-conversation IDs.
 * Provider/model text is never proof. */
export function matchedNativeProviderFailure(value:unknown,job:{id:string;conversation_id:string|null;submission_id:string|null},acceptedCorrectionSubmissionIds:readonly string[]=[]):ProviderFailure|undefined {
 if(!value||typeof value!=='object'||Array.isArray(value))return;
 const allowed=['kind','code','source','jobId','conversationId','submissionId','taskId','entryId','at','cooldownMs','until','httpStatus'];
 if(Object.keys(value).some(k=>!allowed.includes(k)))return;
 const f=value as Partial<ProviderFailure>;
 const nativeId=(v:unknown)=>typeof v==='string'&&/^[1-9]\d{0,15}$/.test(v)&&Number.isSafeInteger(Number(v));
 if(f.source!=='native_entry'||f.jobId!==job.id||!nativeId(job.conversation_id)||!nativeId(job.submission_id)||f.conversationId!==job.conversation_id||(typeof f.submissionId!=='string'||!nativeId(f.submissionId)||(f.submissionId!==job.submission_id&&!acceptedCorrectionSubmissionIds.includes(f.submissionId)))||!nativeId(f.taskId)||!nativeId(f.entryId))return;
 const codes:Partial<Record<ProviderFailureKind,ProviderFailureCode[]>>={
  transient_stream:['stream_ended_before_terminal_event','stream_ended_without_stop_reason'],
  transient_network:['connection_error','request_timeout'],
  authentication:['http_401','http_403','invalid_api_key','token_expired'],
  quota:['http_429','rate_limit_exceeded','insufficient_quota','subscription_sharing_usage_limit_exceeded'],
 };
 if(!f.kind||!f.code||!codes[f.kind]?.includes(f.code))return;
 const expectedStatus=f.code==='http_401'?401:f.code==='http_403'?403:f.code==='http_429'?429:undefined;
 if(f.httpStatus!==expectedStatus)return;
 if(typeof f.at!=='string'||typeof f.until!=='string'||!/^\d{4}-\d\d-\d\dT.*Z$/.test(f.at)||!/^\d{4}-\d\d-\d\dT.*Z$/.test(f.until)||!Number.isFinite(Date.parse(f.at))||!Number.isFinite(Date.parse(f.until))||f.cooldownMs!==failureCooldownMs(f.kind)||Date.parse(f.until)!==Date.parse(f.at)+f.cooldownMs)return;
 return f as ProviderFailure;
}
