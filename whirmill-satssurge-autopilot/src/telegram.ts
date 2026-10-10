import {availabilityBlocker} from './provider-failures.js';
import { RuntimeImprovements, runtimeDetectorVersion, type RuntimeArtifact } from './runtime-improvements.js';
import { TelegramTurns } from './telegram-turns.js';
import { randomBytes } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync, chmodSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ApplicationControl, requestCapability } from './application-control.js';
import { Store } from './store.js';
import { hash, json, now, day, scrub } from './domain.js';
export interface TelegramTransport {
    call(method: string, body: unknown, signal?: AbortSignal): Promise<any>;
}
export function telegramText(text: string) { return telegramClean(text).slice(0, 3500); }
export function telegramClean(text: string) { return String(scrub(text)).replace(/\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/g, '[REDACTED]').replace(/\blnbc[a-z0-9]+\b/gi, '[REDACTED]'); }
export function telegramHtml(text: string) { return telegramClean(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/^#{1,6} (.+)$/gm, '<b>$1</b>'); }
export function telegramParts(text: string) { const parts: string[] = []; let part = ''; for (const ch of telegramClean(text)) {
    if (part.length + ch.length > 3500) {
        parts.push(part);
        part = '';
    }
    part += ch;
} if (part)
    parts.push(part); return parts.length ? parts : ['Richiesta completata.']; }
export function romeHour(at: string) { return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', hour: '2-digit', hourCycle: 'h23' }).format(new Date(at))); }
export class Telegram {
    readonly tokenPath: string;
    private transport?: TelegramTransport;
    private abort = new AbortController();
    private running = false;
    private outgoing?: Promise<void>;
    private incoming?: Promise<void>;
    private wake?: () => Promise<void>;
    private dispatchTail:Promise<void>=Promise.resolve();
    private dispatchPending=0;
    private async dispatch<T>(work:()=>Promise<T>):Promise<T>{
        const previous=this.dispatchTail;let release!:()=>void;
        this.dispatchTail=new Promise<void>(r=>release=r);this.dispatchPending++;
        await previous;
        try{return await work();}finally{this.dispatchPending--;release();}
    }
    private async outboundCall(method:string,body:unknown){
        const controller=new AbortController(),signal=AbortSignal.any([this.abort.signal,controller.signal]);
        let timer:ReturnType<typeof setTimeout>|undefined;
        try{return await Promise.race([this.client().call(method,body,signal),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(Error('Telegram outbound deadline; delivery may be uncertain'));},5000);})]);}
        finally{if(timer)clearTimeout(timer);}
    }
    private rejectedRetryAfter(error:unknown):number|undefined{
        const value=(error as any)?.retryAfter;
        return (error as any)?.rejected===true&&typeof value==='number'&&Number.isFinite(value)&&value>0?value:undefined;
    }
    private recordRateLimit(error:unknown,botGeneration:unknown):number|undefined{
        const retry=this.rejectedRetryAfter(error);
        if(retry===undefined||(this.store.get('telegramBotGeneration')??null)!==botGeneration)return undefined;
        const deadline=Math.min(8640000000000000,Date.now()+retry*1000),prior=this.store.get<number>('telegramRateLimitUntil');
        this.store.set('telegramRateLimitUntil',Math.max(deadline,typeof prior==='number'&&Number.isFinite(prior)?prior:0));
        return retry;
    }
    private richDraftPolicy(): 'stable'|'rotating'{return this.store.get('telegramRichDraftPolicy')==='stable'?'stable':'rotating';}
    streamPolicy(policy:unknown){
        if(policy!=='stable'&&policy!=='rotating')throw Object.assign(Error('Unknown rich draft policy'),{statusCode:400});
        if(this.dispatchPending||this.store.all("SELECT value FROM meta WHERE key LIKE 'telegramTurn:%'").some(r=>{const t=JSON.parse(r.value);return !t.closed&&(['running','stop_requested','waiting'].includes(t.state)||this.control.queue.get(t.jobId)?.state==='running');}))throw Object.assign(Error('Stream policy cannot change during an active turn or dispatch'),{statusCode:409});
        this.store.set('telegramRichDraftPolicy',policy);return this.status();
    }
    private draftAuthorized(turn:any,b:any,bot:unknown){
        const current=this.turns().get(turn.jobId);
        return !!current&&this.authorized(b.generation,b.chatId,bot)&&current.generation===turn.generation&&current.chatId===b.chatId&&current.version===turn.version&&!current.closed&&current.state==='running'&&this.control.queue.get(turn.jobId)?.state==='running';
    }
    private draftAlias(turn:any,b:any,bot:unknown,prior:any,text:string,at:string){
        return this.store.tx(()=>{
            let state=this.store.get<any>('telegramDraftAliasState');
            if(!state||Date.parse(at)-(state.prunedAt??0)>=60000){
                this.store.run("DELETE FROM meta WHERE key LIKE 'telegramDraft:%' AND json_extract(value,'$.expires')<=?",at);
                const existing=this.store.all("SELECT key FROM meta WHERE key LIKE 'telegramDraft:%'").map(r=>Number(r.key.slice(14))).filter(Number.isSafeInteger);
                state={next:existing.reduce((n,v)=>Math.max(n,v),state?.next??0),count:existing.length,prunedAt:Date.parse(at)};
            }
            const rotating=!prior.plainDraft&&this.richDraftPolicy()==='rotating';
            let candidate=rotating||!prior.draftId?state.next+1:prior.draftId;
            const previousAlias=this.store.get<any>('telegramDraft:'+candidate);
            if(previousAlias&&(previousAlias.jobId!==turn.jobId||previousAlias.generation!==turn.generation||previousAlias.version!==turn.version))candidate=state.next+1;
            if(!Number.isSafeInteger(candidate)||candidate<=0||candidate>2147483647)throw Error('Draft identifier capacity exhausted');
            const existing=this.store.get<any>('telegramDraft:'+candidate);
            if(existing&&(existing.jobId!==turn.jobId||existing.generation!==turn.generation||existing.version!==turn.version))throw Error('Draft identifier collision; dispatch refused');
            if(!existing&&state.count>=100000)throw Error('Draft alias capacity exhausted; dispatch refused');
            state.next=Math.max(state.next,candidate);if(!existing)state.count++;this.store.set('telegramDraftAliasState',state);
            const alias={jobId:turn.jobId,generation:turn.generation,version:turn.version,chatId:b.chatId,botGeneration:bot,at,expires:new Date(Date.parse(at)+86700000).toISOString(),length:text.length,sha:hash(text),outcome:'dispatching'};
            this.store.set('telegramDraft:'+candidate,alias);return {id:candidate,alias};
        });
    }
    private invalidateDrafts(generation:string,chatId:number){
        for(const row of this.store.all("SELECT value FROM meta WHERE key LIKE 'telegramTurn:%'")){
            const t=JSON.parse(row.value);if(t.generation!==generation||t.chatId!==chatId||t.closed)continue;
            const key='telegramStream:'+t.jobId,prior=this.store.get<any>(key);if(prior&&!prior.fallback)this.store.set(key,{...prior,invalidated:true});
        }
    }
    setWake(wake: () => Promise<void>) { this.wake = wake; }
    private turns() { return new TelegramTurns(this.store, this.control.queue); }
    private authorized(generation: string, chatId: number, botGeneration: unknown) { const b = this.store.get('telegramBinding'); return b?.generation === generation && b.chatId === chatId && (this.store.get('telegramBotGeneration') ?? null) === botGeneration; }
    private buttons(eventId: string, items: {
        text: string;
        value: any;
    }[], generation: string) { return { inline_keyboard: [items.map(i => ({ text: i.text, callback_data: this.callback(eventId + ':' + i.text, i.value, generation) }))] }; }
    private attachButtons(eventId: string, items: {
        text: string;
        value: any;
    }[], generation: string) { this.store.set('telegramButtons:' + eventId, this.buttons(eventId, items, generation)); }
    constructor(readonly store: Store, readonly control: ApplicationControl, directory: string, transport?: TelegramTransport) { this.tokenPath = join(directory, 'telegram.secret'); this.transport = transport; }
    configure(token: string) {
        if (typeof token !== 'string' || !/^\d{6,12}:[A-Za-z0-9_-]{20,}$/.test(token))
            throw Error('Invalid bot token');
        // Commit the authority fence before touching credentials. A crash at any
        // filesystem boundary restarts unpaired and cannot reuse the old bot.
        this.revoke();
        this.store.tx(() => {
            this.store.set('telegramBotGeneration', randomBytes(12).toString('hex'));
            this.store.set('telegramTokenTransition', true);
            this.store.set('telegramConfigured', false);
            this.store.set('telegramUsername', null);
            this.store.set('telegramCursor', 0);
            this.store.run('DELETE FROM telegram_updates');
        });
        const temporary = this.tokenPath + '.new';
        writeFileSync(temporary, token, { mode: 0o600 });
        chmodSync(temporary, 0o600);
        renameSync(temporary, this.tokenPath);
        this.store.tx(() => { this.store.set('telegramConfigured', true); this.store.set('telegramTokenTransition', false); });
    }
    private client(): TelegramTransport {
        if (this.transport)
            return this.transport;
        const token = readFileSync(this.tokenPath, 'utf8').trim();
        return { call: async (method, body, signal) => {
                try {
                    const multipart = body instanceof FormData;
                    const response = await fetch('https://api.telegram.org/bot' + token + '/' + method, { method: 'POST', headers: multipart ? undefined : { 'content-type': 'application/json' }, body: multipart ? body : json(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(35000)]) : AbortSignal.timeout(35000) });
                    const result = await response.json() as any;
                    if (!result.ok) {
                        const error = new Error('Telegram API rejected request') as any;
                        error.retryAfter = result.parameters?.retry_after;
                        error.rejected = true;
                        throw error;
                    }
                    return result.result;
                }
                catch (error) {
                    if ((error as any)?.rejected)
                        throw error;
                    throw Error('Telegram transport unavailable; delivery may be uncertain');
                }
            } };
    }
    status() { const binding = this.store.get('telegramBinding'); return { richDraftPolicy:this.richDraftPolicy(),username: this.store.get('telegramUsername') ?? null, configured: this.store.get('telegramTokenTransition') !== true && (this.store.get('telegramConfigured') === true || existsSync(this.tokenPath)), paired: !!binding, owner: binding ?? null, candidate: this.store.get('telegramCandidate') ?? null, pairingExpires: this.store.get('telegramPairing')?.expires ?? null, failures: this.store.all("SELECT event_id,status,attempts,error FROM telegram_outbox WHERE status IN ('failed','uncertain') ORDER BY created_at DESC LIMIT 20"), pending: this.store.one("SELECT count(*) n FROM telegram_outbox WHERE status='pending'").n, lastPoll: this.store.get('telegramLastPoll') ?? null, error: this.store.get('telegramError') ?? null, turns: this.store.all("SELECT value FROM meta WHERE key LIKE 'telegramTurn:%'").map(r => JSON.parse(r.value)).filter(t => t.generation === binding?.generation).slice(-20) }; }
    pairing(at = now()) {
        if (!this.status().configured)
            throw Error('Configure bot token first');
        const code = randomBytes(18).toString('base64url');
        this.store.tx(() => { this.store.set('telegramPairing', { digest: hash(code), expires: new Date(Date.parse(at) + 300000).toISOString(), attempts: 0 }); this.store.set('telegramCandidate', null); });
        return { code, expires: new Date(Date.parse(at) + 300000).toISOString() };
    }
    confirm(userId: number, at = now()) {
        return this.store.tx(() => {
            const candidate = this.store.get('telegramCandidate');
            if (!candidate || candidate.userId !== userId || candidate.expires <= at)
                throw Error('Pairing candidate mismatch or expired');
            this.store.run("UPDATE telegram_outbox SET status='cancelled' WHERE status='pending'");
            this.store.run("UPDATE owner_proposals SET status='revoked' WHERE status='pending' OR (status='executing' AND operation_id IS NULL)");
            this.store.run("DELETE FROM meta WHERE key LIKE 'resume:%' OR key LIKE 'telegramCallback:%'");
            this.store.set('telegramBinding', { userId, chatId: candidate.chatId, username: candidate.username, since: at, generation: randomBytes(16).toString('hex') });
            this.store.set('telegramPairing', null);
            this.store.set('telegramCandidate', null);
            return this.status();
        });
    }
    revoke() { this.store.tx(() => { this.store.set('telegramBinding', null); this.store.set('telegramPairing', null); this.store.set('telegramCandidate', null); this.store.run("DELETE FROM meta WHERE key LIKE 'resume:%' OR key LIKE 'telegramCallback:%'"); this.store.run("UPDATE owner_proposals SET status='revoked' WHERE status='pending' OR (status='executing' AND operation_id IS NULL)"); this.store.run("UPDATE telegram_outbox SET status='cancelled' WHERE status='pending'"); }); return this.status(); }
    removeToken() {
        this.revoke();
        if (existsSync(this.tokenPath))
            unlinkSync(this.tokenPath);
        this.store.set('telegramConfigured', false);
    }
    /** Every batch is committed before advertising the offset. No network effect in this transaction. */
    ingest(updates: any[]) {
        this.store.tx(() => {
            let cursor = this.store.get<number>('telegramCursor') ?? 0;
            for (const u of updates) {
                if (!Number.isSafeInteger(u.update_id) || u.update_id < 0)
                    continue;
                const stopped = u.stopped_message_generation;
                const m = u.message ?? u.edited_message ?? u.callback_query?.message ?? stopped, from = u.message?.from ?? u.edited_message?.from ?? u.callback_query?.from;
                const draft = stopped && this.store.get('telegramDraft:' + stopped.draft_id);
                let text = String(u.message?.text ?? '');
                const start = /^\/start\s+(\S+)\s*$/.exec(text);
                const safe = { botGeneration:this.store.get('telegramBotGeneration')??null,generation: this.store.get('telegramBinding')?.generation, update_id: u.update_id, chatId: m?.chat?.id, chatType: m?.chat?.type, userId: from?.id ?? (stopped&&m?.chat?.type==='private'&&m?.chat?.id===this.store.get('telegramBinding')?.chatId ? this.store.get('telegramBinding')?.userId : undefined), topic: m?.message_thread_id, edited: !!u.edited_message, stoppedDraft: stopped?.draft_id, callbackId: u.callback_query?.id, username: telegramText(String(from?.username ?? '')), text: start ? '/start' : telegramText(text), date: m?.date, codeDigest: start ? hash(start[1]!) : undefined, callback: String(u.callback_query?.data ?? '').slice(0, 64) };
                this.store.run('INSERT OR IGNORE INTO telegram_updates(update_id,body) VALUES(?,?)', u.update_id, json(safe));
                cursor = Math.max(cursor, u.update_id + 1);
            }
            this.store.set('telegramCursor', cursor);
        });
    }
    enqueue(eventId: string, text: string, kind = 'reply', proposalId?: string, at = now(), generation = this.store.get('telegramBinding')?.generation ?? null) { if (generation !== (this.store.get('telegramBinding')?.generation ?? null))
        return; const parts = telegramParts(text); for (let i = 0; i < parts.length; i++)
        { const partId = i ? eventId + ':part:' + i : eventId;
            const inserted = this.store.run("INSERT OR IGNORE INTO telegram_outbox(event_id,created_at,kind,text,proposal_id,generation) VALUES(?,?,?,?,?,?)", partId, at, kind, parts[i], proposalId ?? null, generation);
            if (inserted.changes === 1) this.store.set('telegramOutboxVersion:' + partId, runtimeDetectorVersion);
        } }
    private callback(eventId: string, value: {
        action: string;
        code?: string;
        id?: string;
        version?: number;
        expires?: string;
        bodyHash?: string;
    }, generation = this.store.get('telegramBinding')?.generation ?? null) { const navigation=value.action==='navigate'||value.action==='recover_resume'||value.action==='recover_dismiss';const botGeneration=this.store.get('telegramBotGeneration')??null;const key = hash(navigation?JSON.stringify([eventId,generation,botGeneration]):eventId).slice(0, 32); this.store.set('telegramCallback:' + key, { ...value, generation,...(navigation?{chatId:this.store.get('telegramBinding')?.chatId,botGeneration,eventId}: {}) }); return key; }
    private admitAction(updateId: number, event: string, requestId: string, binding: any, at: string, answer: string,
        prepare: () => { message: string; analysis?: boolean; link: { priorTurn: string; correction?: string }; consume?: () => void }) {
        const job = this.store.tx(() => {
            const original = this.store.one('SELECT * FROM jobs WHERE request_id=?', requestId);
            if (original && this.store.get('jobTelegramGeneration:' + original.id) !== binding.generation) throw Error('Original action authority expired');
            // Replay consults the committed action before consumed/expired choice checks.
            const spec = original ? undefined : prepare();
            const admitted = original ?? this.control.admitWithinTransaction(requestId, spec!.message, 'telegram', spec!.analysis);
            this.store.set('jobTelegramGeneration:' + admitted.id, binding.generation);
            this.turns().attach(admitted, binding.generation, binding.chatId);
            if (spec) { this.store.set('telegramLinkedRequest:' + admitted.id, spec.link); spec.consume?.(); }
            this.store.set('telegramAction:' + event, { jobId: admitted.id, requestId, generation: binding.generation });
            this.enqueue(event, answer, 'reply', undefined, at, binding.generation);
            this.store.run("UPDATE telegram_updates SET status='done',error=NULL WHERE update_id=?", updateId);
            return admitted;
        });
        void this.wake?.().catch(() => { }); return job;
    }
    private delayedReadOnly(u:any):boolean {
        if(u.callbackId||u.callback||u.stoppedDraft||u.codeDigest||u.edited||u.topic||typeof u.text!=='string')return false;
        if(['/status','/help','/queue','/menu'].includes(u.text))return true;
        return !!u.text.trim()&&!u.text.startsWith('/')&&requestCapability(u.text,'telegram')==='read_only_chat';
    }
    // Legacy bodies lack botGeneration: retained pairing generation is the proof.
    // configure() revokes that binding and deletes the old input namespace first.
    private currentIncoming(u:any,b:any,at:string):boolean {
        const bot=this.store.get('telegramBotGeneration')??null;
        return !!b&&u.chatType==='private'&&Number.isSafeInteger(u.userId)&&u.userId===u.chatId&&u.userId===b.userId&&u.chatId===b.chatId&&u.generation===b.generation&&(!('botGeneration' in u)||u.botGeneration===bot)&&Number.isSafeInteger(u.date)&&u.date>=Math.floor(Date.parse(b.since)/1000)&&u.date<=Date.parse(at)/1000+60;
    }
    /** Bounded additive recovery; original ignored rows and immutable receipts never change. */
    private delayedRecovery(at:string) {
        const b=this.store.get('telegramBinding'),bot=this.store.get('telegramBotGeneration')??null;if(!b)return [];
        this.store.tx(()=>{
            const previous=this.store.get<any>('telegramIngressRecoveryScan'),cursor=previous?.generation===b.generation&&previous.botGeneration===bot?previous.updateId:-1;
            const candidates=this.store.all("SELECT * FROM telegram_updates WHERE status='ignored' AND error='Stale incoming command' AND update_id>? ORDER BY update_id LIMIT 20",cursor);
            for(const row of candidates){
                let u:any;try{u=JSON.parse(row.body);}catch{continue;}
                if(!u||typeof u!=='object'||Array.isArray(u))continue;
                const key='telegramIngressRecovery:'+row.update_id;
                if(!this.store.get(key)&&this.delayedReadOnly(u)&&this.currentIncoming(u,b,at)){
                    const original={updateId:row.update_id,body:row.body,status:row.status,error:row.error};
                    if(!this.store.get('telegramIngressRecoveryOriginal:'+row.update_id))this.store.set('telegramIngressRecoveryOriginal:'+row.update_id,original);
                    this.store.set(key,{state:'review_required',updateId:row.update_id,date:u.date,generation:b.generation,botGeneration:bot,chatId:b.chatId,bodyHash:hash(row.body),requestId:'telegram:'+(bot??'initial')+':'+row.update_id,eventId:'update:'+row.update_id,at});
                }
            }
            if(candidates.length)this.store.set('telegramIngressRecoveryScan',{generation:b.generation,botGeneration:bot,updateId:candidates.at(-1).update_id});
        });
        // Legacy "done" recovery receipts are immutable. Only unanswered model
        // routes get a separate review view; direct command replies are final.
        const legacyCursor=this.store.get<any>('telegramIngressLegacyReviewScan');
        const legacyAfter=legacyCursor?.generation===b.generation&&legacyCursor.botGeneration===bot?legacyCursor.updateId:-1;
        const legacy=this.store.all("SELECT key,value FROM meta WHERE key LIKE 'telegramIngressRecovery:%' AND json_extract(value,'$.state')='done' AND CAST(substr(key,25) AS INTEGER)>? ORDER BY CAST(substr(key,25) AS INTEGER) LIMIT 20",legacyAfter);
        // An active unconsumed choice can mature after the forward cursor has
        // passed it. Persist only a reference; revisit at most twenty due choices.
        const deferred=this.store.all("SELECT key,value FROM meta WHERE key LIKE 'telegramIngressLegacyDeferred:%' AND json_extract(value,'$.generation')=? AND json_extract(value,'$.botGeneration') IS ? AND json_extract(value,'$.expires')<=? ORDER BY json_extract(value,'$.expires'),CAST(substr(key,31) AS INTEGER) LIMIT 20",b.generation,bot,at);
        const matured=deferred.flatMap(candidate=>{
            const value=JSON.parse(candidate.value),record=this.store.one('SELECT key,value FROM meta WHERE key=?',value.originalRecoveryKey);
            this.store.run('DELETE FROM meta WHERE key=?',candidate.key);
            return record&&hash(record.value)===value.originalRecoveryHash?[record]:[];
        });
        for(const record of [...legacy,...matured]){
            const r=JSON.parse(record.value),id=Number(record.key.slice(24)),key='telegramIngressRecoveryReview:'+id,row=this.store.one('SELECT * FROM telegram_updates WHERE update_id=?',id);
            let u:any;try{u=row&&JSON.parse(row.body);}catch{}
            if(this.store.get(key)||!u||!this.delayedReadOnly(u)||u.text.startsWith('/')||r.generation!==b.generation||r.botGeneration!==bot||hash(row.body)!==r.bodyHash||!this.currentIncoming(u,b,at))continue;
            const original=this.store.one('SELECT id FROM jobs WHERE request_id=?',r.requestId),choice=this.turns().correction(b.generation+':'+id),followup=this.store.one('SELECT id FROM jobs WHERE request_id=?','telegram-followup:'+b.generation+':'+id);
            const expiredChoice=choice&&!choice.submissionId&&(choice.state==='late'||choice.state==='choice_pending'&&choice.expires<=at);
            if(original||followup)continue;
            if(choice&&!expiredChoice){
                if(choice.state==='choice_pending'&&!choice.submissionId&&choice.expires>at)
                    this.store.set('telegramIngressLegacyDeferred:'+id,{generation:b.generation,botGeneration:bot,expires:choice.expires,originalRecoveryKey:record.key,originalRecoveryHash:hash(record.value)});
                continue;
            }
            const choiceRow=choice&&this.store.one('SELECT value FROM meta WHERE key=?','telegramCorrection:'+choice.id);
            this.store.set(key,{...r,updateId:id,date:u.date,state:'review_required',outcome:'legacy_model_completion_unknown',originalRecoveryKey:record.key,originalRecoveryHash:hash(record.value),...(expiredChoice?{forceFutureRequest:true,correctionId:choice.id,correctionHash:hash(choiceRow.value)}:{})});
        }
        if(legacy.length)this.store.set('telegramIngressLegacyReviewScan',{generation:b.generation,botGeneration:bot,updateId:Number(legacy.at(-1).key.slice(24))});
        // Current owner-resumed inputs can also be held by an active-turn choice.
        // A separate pinned anchor keeps their original receipt/correction intact.
        const currentChoices=this.store.all("SELECT d.key,d.value FROM meta d LEFT JOIN meta c ON c.key='telegramCorrection:'||json_extract(d.value,'$.correctionId') WHERE d.key LIKE 'telegramIngressCurrentDeferred:%' AND json_extract(d.value,'$.state')='pending' AND json_extract(d.value,'$.generation')=? AND json_extract(d.value,'$.botGeneration') IS ? AND (json_extract(d.value,'$.expires')<=? OR json_extract(c.value,'$.state')='late') ORDER BY json_extract(d.value,'$.expires'),json_extract(d.value,'$.updateId') LIMIT 20",b.generation,bot,at);
        for(const candidate of currentChoices)this.store.tx(()=>{
            const anchor=JSON.parse(candidate.value),record=this.store.one('SELECT value FROM meta WHERE key=?',anchor.originalRecoveryKey),r=record&&JSON.parse(record.value);
            const row=this.store.one('SELECT * FROM telegram_updates WHERE update_id=?',anchor.updateId),choiceRow=this.store.one('SELECT value FROM meta WHERE key=?','telegramCorrection:'+anchor.correctionId),choice=choiceRow&&JSON.parse(choiceRow.value);
            let u:any;try{u=row&&JSON.parse(row.body);}catch{}
            const canonicalReviewKey='telegramIngressRecoveryReview:'+anchor.updateId;
            // The origin can itself be the canonical review. A distinct additive
            // view preserves that receipt and pins this exact lineage on retry.
            const reviewKey=this.store.get(canonicalReviewKey)?canonicalReviewKey+':maturity:'+hash(json([anchor.originalRecoveryKey,anchor.originalRecoveryHash])):canonicalReviewKey;
            const valid=record&&hash(record.value)===anchor.originalRecoveryHash&&r.state==='choice_pending'&&this.recoveryOriginValid(r)&&r.generation===b.generation&&r.botGeneration===bot&&r.chatId===b.chatId&&row?.status==='ignored'&&row.error==='Stale incoming command'&&hash(row.body)===r.bodyHash&&u&&this.currentIncoming(u,b,at)&&this.delayedReadOnly(u)&&!u.text.startsWith('/')&&choiceRow&&hash(choiceRow.value)===anchor.correctionHash&&choice.id===anchor.correctionId&&choice.generation===b.generation&&!choice.submissionId&&(choice.state==='late'||choice.state==='choice_pending'&&choice.expires<=at)&&!this.store.one('SELECT id FROM jobs WHERE request_id IN (?,?)',r.requestId,'telegram-followup:'+b.generation+':'+anchor.updateId)&&!this.store.get(reviewKey);
            if(valid)this.store.set(reviewKey,{...r,state:'review_required',outcome:'current_unconsumed_choice_matured',originalRecoveryKey:anchor.originalRecoveryKey,originalRecoveryHash:anchor.originalRecoveryHash,forceFutureRequest:true,correctionId:choice.id,correctionHash:anchor.correctionHash});
            this.store.set(candidate.key,{...anchor,state:valid?'reviewed':'closed',outcome:valid?'explicit_review_required':'original_choice_or_authority_changed'});
        });
        const selected:any[]=[];
        for(const record of this.store.all("SELECT key,value FROM meta WHERE (key LIKE 'telegramIngressRecovery:%' OR key LIKE 'telegramIngressRecoveryReview:%') AND json_extract(value,'$.state') IN ('pending','review_required','admitted') ORDER BY CASE json_extract(value,'$.state') WHEN 'pending' THEN 0 WHEN 'review_required' THEN 1 ELSE 2 END,COALESCE(json_extract(value,'$.updateId'),CAST(substr(key,25) AS INTEGER)) LIMIT 100")) {
            const recovery=JSON.parse(record.value),id=recovery.updateId??Number(record.key.slice('telegramIngressRecovery:'.length));
            const row=this.store.one('SELECT * FROM telegram_updates WHERE update_id=?',id);
            let u:any;try{u=row&&JSON.parse(row.body);}catch{}
            if(!this.recoveryOriginValid(recovery)||!row||row.status!=='ignored'||row.error!=='Stale incoming command'||hash(row.body)!==recovery.bodyHash||!u||!this.currentIncoming(u,b,at)||!this.delayedReadOnly(u)||recovery.generation!==b.generation||recovery.botGeneration!==bot){
                this.store.set(record.key,{...recovery,state:'expired',outcome:'authority_or_original_receipt_changed'});continue;
            }
            const job=this.store.one('SELECT * FROM jobs WHERE request_id=?',recovery.requestId);
            if(job){
                if(this.store.get('jobTelegramGeneration:'+job.id)!==b.generation||this.store.get('jobCapability:'+job.id)!=='read_only_chat'){
                    this.store.set(record.key,{...recovery,state:'expired',outcome:'original_admission_authority_mismatch'});continue;
                }
                this.store.set(record.key,{...recovery,state:['completed','failed','cancelled'].includes(job.state)?'settled':'admitted',outcome:'original_job_'+job.state,jobId:job.id});
                // The scheduler owns reconciliation of the original native submission.
                continue;
            }
            if(!this.recoveryResumeAvailable(recovery,at)){this.store.set(record.key,{...recovery,state:'owned',outcome:'existing_choice_or_linked_admission_retained'});continue;}
            // Old pending receipts had no explicit owner decision. An ACK is not
            // job completion and its uncertain delivery must never be retried.
            if(recovery.state==='pending'&&!recovery.ownerDecision){this.store.set(record.key,{...recovery,state:'review_required',outcome:'owner_review_required'});continue;}
            if(recovery.state==='pending'&&selected.length<10)selected.push({...row,recoveryKey:record.key,recovery});
        }
        return selected;
    }
    private recoveryResumeAvailable(r:any,at:string){
        if(this.store.one('SELECT id FROM jobs WHERE request_id IN (?,?)',r.requestId,'telegram-followup:'+r.generation+':'+(r.updateId??r.eventId.slice(7))))return false;
        const id=r.correctionId??r.generation+':'+(r.updateId??r.eventId.slice(7)),row=this.store.one('SELECT value FROM meta WHERE key=?','telegramCorrection:'+id);
        if(!row)return !r.correctionId;
        const c=JSON.parse(row.value);return c.id===id&&c.generation===r.generation&&!!r.forceFutureRequest&&hash(row.value)===r.correctionHash&&!c.submissionId&&(c.state==='late'||c.state==='choice_pending'&&c.expires<=at);
    }
    private recoveryOriginValid(r:any){
        const visited=new Set<string>();
        while(r.originalRecoveryKey){
            if(typeof r.originalRecoveryKey!=='string'||visited.has(r.originalRecoveryKey)||visited.size>=128)return false;
            visited.add(r.originalRecoveryKey);
            const raw=this.store.one('SELECT value FROM meta WHERE key=?',r.originalRecoveryKey);
            if(!raw||hash(raw.value)!==r.originalRecoveryHash)return false;
            try{r=JSON.parse(raw.value);if(!r||typeof r!=='object'||Array.isArray(r))return false;}catch{return false;}
        }
        return true;
    }
    private recoveryBacklog(event:string,b:any,at:string) {
        const records=this.store.all("SELECT key,value FROM meta WHERE (key LIKE 'telegramIngressRecovery:%' OR key LIKE 'telegramIngressRecoveryReview:%') AND json_extract(value,'$.state')='review_required' ORDER BY COALESCE(json_extract(value,'$.updateId'),CAST(substr(key,25) AS INTEGER)) LIMIT 8");
        const items=records.map(r=>({key:r.key,value:JSON.parse(r.value)})).filter(r=>r.value.generation===b.generation&&r.value.botGeneration===(this.store.get('telegramBotGeneration')??null)&&r.value.chatId===b.chatId);
        this.store.set('telegramButtons:'+event,{inline_keyboard:items.map(({key,value})=>['recover_resume','recover_dismiss'].map(action=>({text:(action==='recover_resume'?'Riprendi ':'Ignora ')+String(value.updateId??key.slice(24)),callback_data:this.callback(event+':'+key+':'+action,{action,id:key,bodyHash:value.bodyHash,expires:new Date(Date.parse(at)+5*60000).toISOString()},b.generation)})))});
        return items.length?'Richieste precedenti da verificare (massimo 8 per pagina). Riprendi solo quelle ancora utili; Ignora registra la tua scelta senza dichiararle completate.\n'+items.map(({key,value})=>`${String(value.updateId??key.slice(24))} · ${new Date((value.date??JSON.parse(this.store.one('SELECT body FROM telegram_updates WHERE update_id=?',Number(String(value.updateId??key.slice(24)))).body).date)*1000).toISOString()} · ${telegramText(JSON.parse(this.store.one('SELECT body FROM telegram_updates WHERE update_id=?',Number(String(value.updateId??key.slice(24)))).body).text).slice(0,100)}`).join('\n'):'Nessuna richiesta precedente da recuperare.';
    }

    private finishIncoming(row:any,error:string|null=null) {
        if(row.recoveryKey){const current=this.store.get(row.recoveryKey);if(current?.state==='pending'){const job=this.store.one('SELECT id FROM jobs WHERE request_id=?',current.requestId);this.store.set(row.recoveryKey,{...current,state:error?'blocked':job?'admitted':JSON.parse(row.body).text.startsWith('/')?'answered':'choice_pending',outcome:error?'blocked':job?'original_job_admitted':JSON.parse(row.body).text.startsWith('/')?'read_only_command_answered':'explicit_active_turn_choice_pending',jobId:job?.id,error});
            if(!error&&!job&&!JSON.parse(row.body).text.startsWith('/')){
                const correctionId=current.generation+':'+row.update_id,correctionRow=this.store.one('SELECT value FROM meta WHERE key=?','telegramCorrection:'+correctionId),receipt=this.store.one('SELECT value FROM meta WHERE key=?',row.recoveryKey);
                if(correctionRow){const c=JSON.parse(correctionRow.value);this.store.set('telegramIngressCurrentDeferred:'+row.update_id,{state:'pending',updateId:row.update_id,generation:current.generation,botGeneration:current.botGeneration,expires:c.expires,originalRecoveryKey:row.recoveryKey,originalRecoveryHash:hash(receipt.value),correctionId,correctionHash:hash(correctionRow.value)});}
            }
        }}
        else this.store.run("UPDATE telegram_updates SET status='done',error=? WHERE update_id=?",error,row.update_id);
    }
    async process(at = now(), clock = { at, started: Date.now() }) {
        // Carry one elapsed baseline through every row and recursive recovery.
        const currentAt=()=>new Date(Date.parse(clock.at)+Math.max(0,Date.now()-clock.started)).toISOString();
        at=currentAt();
        const pending=this.store.all("SELECT * FROM telegram_updates WHERE status='pending' ORDER BY update_id LIMIT 50"),recovered=this.delayedRecovery(at);
        for (const row of [...pending,...recovered]) {
            at=currentAt();
            const u = JSON.parse(row.body), event = 'update:' + row.update_id;
            try {
                if(row.recoveryKey){
                    const b=this.store.get('telegramBinding'),bot=this.store.get('telegramBotGeneration')??null;
                    const current=this.store.get(row.recoveryKey),originalInput=this.store.one('SELECT * FROM telegram_updates WHERE update_id=?',row.update_id);
                    if(current?.state!=='pending')continue;
                    if(!this.recoveryOriginValid(row.recovery)||originalInput?.status!=='ignored'||originalInput.error!=='Stale incoming command'||hash(originalInput.body)!==row.recovery.bodyHash||row.recovery.generation!==b?.generation||row.recovery.botGeneration!==bot||!this.currentIncoming(u,b,at)||!this.delayedReadOnly(u)){
                        this.store.set(row.recoveryKey,{...row.recovery,state:'expired',outcome:'authority_or_original_receipt_changed'});continue;
                    }
                    const original=this.store.one('SELECT id FROM jobs WHERE request_id=?',row.recovery.requestId);
                    if(original&&(this.store.get('jobTelegramGeneration:'+original.id)!==b.generation||this.store.get('jobCapability:'+original.id)!=='read_only_chat')){this.store.set(row.recoveryKey,{...row.recovery,state:'expired',outcome:'original_admission_authority_mismatch'});continue;}
                }
                if (u.chatType !== 'private' || !Number.isSafeInteger(u.userId) || u.userId !== u.chatId) {
                    this.store.run("UPDATE telegram_updates SET status='ignored' WHERE update_id=?", row.update_id);
                    continue;
                }
                if (u.text === '/start' && u.codeDigest) {
                    this.store.tx(() => {
                        const p = this.store.get('telegramPairing');
                        if (!p || p.expires <= at || p.attempts >= 5)
                            return;
                        p.attempts++;
                        this.store.set('telegramPairing', p);
                        if (p.digest !== u.codeDigest)
                            return;
                        this.store.set('telegramCandidate', { userId: u.userId, chatId: u.chatId, username: u.username, expires: p.expires });
                        this.store.set('telegramPairing', null);
                    });
                    this.finishIncoming(row);
                    continue;
                }
                const binding = this.store.get('telegramBinding');
                if (!binding || binding.generation !== u.generation || binding.userId !== u.userId || binding.chatId !== u.chatId || ('botGeneration' in u&&u.botGeneration!==(this.store.get('telegramBotGeneration')??null))) {
                    this.store.run("UPDATE telegram_updates SET status='ignored' WHERE update_id=?", row.update_id);
                    continue;
                }
                if (!u.callbackId && u.date!==undefined && (!Number.isSafeInteger(u.date)||u.date < Math.floor(Date.parse(binding.since) / 1000) || (Date.parse(at) / 1000 - u.date > 300&&!row.recoveryKey) || u.date > Date.parse(at) / 1000 + 60)) {
                    this.store.run("UPDATE telegram_updates SET status='ignored',error='Stale incoming command' WHERE update_id=?", row.update_id);
                    continue;
                }
                const callbackBot = this.store.get('telegramBotGeneration') ?? null;
                if (u.callbackId) {
                    try {
                        await this.client().call('answerCallbackQuery', { callback_query_id: u.callbackId }, this.abort.signal);
                    }
                    catch { }
                    at=currentAt();
                    if (!this.authorized(binding.generation, binding.chatId, callbackBot))
                        continue;
                }
                // Menu navigation enters the same command handlers after the callback
                // spinner ACK. Its persisted correlation is fenced separately from
                // financial confirmation callbacks and expires after fifteen minutes.
                if(u.callback){
                    const navigation=this.store.get('telegramCallback:'+u.callback);
                    if(navigation?.action==='navigate'&&navigation.generation===binding.generation&&navigation.chatId===binding.chatId&&navigation.botGeneration===callbackBot&&navigation.expires>at&&['/status','/analyze','/proposals','/queue','/recover','/help'].includes(navigation.code)){
                        u.text=navigation.code;u.callback='';
                    }
                }
                let answer = '';
                if (u.topic || u.edited) {
                    answer = 'Modifiche e topic non sono supportati: invia una nuova richiesta nella chat privata.';
                }
                else if (u.stoppedDraft) {
                    const mapped = this.store.get('telegramDraft:' + u.stoppedDraft);
                    if (mapped?.generation === binding.generation&&(!mapped.expires||mapped.expires>at)&&(!mapped.chatId||mapped.chatId===binding.chatId)&&(!('botGeneration' in mapped)||mapped.botGeneration===callbackBot)) {
                        const receipt=await this.turns().stop(mapped.jobId, mapped.generation, mapped.version, event);
                        this.enqueue(event, receipt.state==='received'?'Stop ricevuto per questa risposta. Confermerò il rilascio del task.':this.turns().get(mapped.jobId)?.state==='stop_requested'&&this.turns().get(mapped.jobId)?.version===mapped.version?'Stop già richiesto per questa risposta; attendo conferma di rilascio.':'Questa risposta è già chiusa o la sua versione è scaduta.', 'reply', undefined, at, u.generation);
                        void this.turns().dispatchStop(event).then(() => { if (this.store.get('telegramStop:' + event)?.state === 'idle_confirmed')
                            this.enqueue(event + ':stopped', 'Risposta interrotta; task rilasciato.', 'reply', undefined, now(), u.generation); }).catch(() => { });
                    }else answer='Draft sconosciuto o scaduto: nessuna risposta attiva è stata interrotta.';
                }
                else if (u.callback) {
                    const value = this.store.get('telegramCallback:' + u.callback);
                    if (!value || value.generation !== binding.generation || value.action==='navigate')
                        answer = 'Pulsante scaduto o già utilizzato.';
                    else if(value.action==='recover_resume'||value.action==='recover_dismiss') {
                        let selected=false;
                        this.store.tx(()=>{
                            const r=this.store.get(value.id!),input=r&&this.store.one('SELECT * FROM telegram_updates WHERE update_id=?',r.updateId??Number(value.id!.slice(24)));
                            let body:any;try{body=input&&JSON.parse(input.body);}catch{}
                            const valid=this.authorized(binding.generation,binding.chatId,callbackBot)&&value.chatId===binding.chatId&&value.botGeneration===callbackBot&&value.expires>currentAt()&&r?.state==='review_required'&&this.recoveryOriginValid(r)&&this.recoveryResumeAvailable(r,currentAt())&&r.generation===binding.generation&&r.botGeneration===callbackBot&&r.chatId===binding.chatId&&r.bodyHash===value.bodyHash&&input?.status==='ignored'&&input.error==='Stale incoming command'&&hash(input.body)===r.bodyHash&&body&&this.currentIncoming(body,binding,at)&&this.delayedReadOnly(body);
                            if(!valid){answer='Richiesta o pulsante scaduto; nessuna ripresa.';return;}
                            selected=value.action==='recover_resume';
                            this.store.set(value.id!,{...r,state:selected?'pending':'dismissed',ownerDecision:{action:value.action,updateId:row.update_id,at},outcome:selected?'owner_resume_selected':'owner_dismissed'});
                            answer=selected?'Ripresa richiesta: conservo la ricevuta originale e le eventuali consegne incerte.':'Richiesta ignorata per tua scelta; non risulta completata.';
                        });
                        this.store.tx(()=>{this.enqueue(event,answer,'reply',undefined,at,u.generation);this.finishIncoming(row);});
                        if(selected)await this.process(currentAt(),clock);
                        continue;
                    }
                    else if (value.action === 'steer') {
                        const beforeChoice=this.store.one('SELECT value FROM meta WHERE key=?','telegramCorrection:'+value.id);
                        const state = await this.turns().steer(value.id!, at);
                        if(state==='late'&&beforeChoice&&this.authorized(binding.generation,binding.chatId,callbackBot))this.store.tx(()=>{
                            const c=JSON.parse(beforeChoice.value),anchorKey='telegramIngressCurrentDeferred:'+value.id!.slice(binding.generation.length+1),anchor=this.store.get(anchorKey),after=this.store.one('SELECT value FROM meta WHERE key=?','telegramCorrection:'+value.id);
                            // Only the actual application steer transition may repin a late
                            // choice; arbitrary changed correction bytes remain ineligible.
                            if(anchor?.state==='pending'&&anchor.correctionId===value.id&&anchor.correctionHash===hash(beforeChoice.value)&&c.state==='choice_pending'&&after?.value===json({...c,state:'late'}))this.store.set(anchorKey,{...anchor,correctionHash:hash(after.value)});
                        });
                        answer = state === 'late' ? 'Questa risposta è già chiusa. Puoi inviare il testo come nuova richiesta.' : state === 'failed' ? 'Correzione non inserita; ricevuta conservata per verifica.' : 'Correzione ammessa. Pi la applica al prossimo confine utile; la ricevuta non certifica che il modello abbia seguito il testo.';
                        if (['admitted', 'placed'].includes(state))
                            this.attachButtons(event, [{ text: 'Ritira correzione', value: { action: 'withdraw', id: value.id } }], binding.generation);
                        if (state === 'late')
                            this.attachButtons(event, [{ text: 'Nuova richiesta', value: { action: 'followup', id: value.id } }], binding.generation);
                    }
                    else if (value.action === 'withdraw') {
                        const result = await this.turns().withdraw(value.id!);
                        answer = result === 'aborted' ? 'Correzione ritirata; ricevuta conservata.' : result === 'already_placed' ? 'La correzione è già nel contesto del modello e non può essere ritirata. Puoi interrompere questa risposta.' : 'Correzione già conclusa o da riconciliare; nessun replay.';
                    }
                    else if (value.action === 'followup') {
                        answer = 'Nuova richiesta accodata; puoi annullarla con /queue.';
                        this.admitAction(row.update_id, event, 'telegram-followup:' + value.id, binding, at, answer, () => {
                            const c = this.turns().correction(value.id!);
                            if (!c || c.expires <= at || c.generation !== binding.generation || !['choice_pending', 'late'].includes(c.state)) throw Error('Choice expired');
                            return { message: c.body, link: { priorTurn: c.jobId, correction: c.id }, consume: () => { c.state = 'withdrawn'; this.turns().saveCorrection(c); } };
                        });
                    }
                    else if (value.action === 'stop') {
                        const r = await this.turns().stop(value.id!, binding.generation, value.version!, event);
                        answer = r.state === 'received' ? 'Stop ricevuto per questa risposta. Attendo il rilascio del task.' : 'Questa risposta è già chiusa; nessun altro turno è stato fermato.';
                        if (r.state === 'received')
                            void this.turns().dispatchStop(event).then(() => { if (this.store.get('telegramStop:' + event)?.state === 'idle_confirmed')
                                this.enqueue(event + ':stopped', 'Risposta interrotta; task rilasciato.', 'reply', undefined, now(), u.generation); }).catch(() => { });
                    }
                    else if (value.action === 'cancel') {
                        answer = this.turns().cancel(value.id!, binding.generation, value.version!) ? 'Richiesta futura annullata; ricevuta conservata.' : 'Richiesta già avviata o pulsante scaduto.';
                    }
                    else if (value.action === 'details' || value.action === 'deepen' || value.action === 'gaps') {
                        answer = 'Approfondimento accodato.';
                        this.admitAction(row.update_id, event, 'telegram-action:' + row.update_id, binding, at, answer, () => {
                            const prior = this.turns().get(value.id!);
                            if (!prior || prior.generation !== binding.generation) throw Error('Expired turn');
                            const body = value.action === 'details' ? 'Spiega lo stato corrente del nodo con dati freschi e budget.' : value.action === 'gaps' ? 'Completa le lacune della ricerca precedente, dichiarando ciò che resta non disponibile.' : 'Approfondisci la risposta precedente con dati freschi e fonti; non eseguire operazioni.';
                            const original = JSON.parse(this.control.queue.get(prior.jobId)?.payload ?? '{}').message ?? '';
                            return { message: body + ' Richiesta precedente: ' + telegramText(original), analysis: value.action !== 'details', link: { priorTurn: prior.jobId } };
                        });
                    }
                    else if (value.action === 'resume') {
                        this.finishIncoming(row);
                        this.control.resume(value.code, at);
                        answer = 'Autonomia ripresa.';
                    }
                    else if (value.action === 'approve') {
                        const result = await this.control.approve(value.id, at);
                        answer = result.consumed ? 'Proposta accettata; verifica la ricevuta operativa nella web app.' : 'Proposta già utilizzata; nessuna seconda esecuzione.';
                    }
                    else if (value.action === 'reject') {
                        this.control.reject(value.id);
                        answer = 'Proposta rifiutata.';
                    }
                }
                else if (u.text === '/stop') {
                    const active = this.turns().active(binding.generation);
                    if (active) {
                        await this.turns().stop(active.jobId, binding.generation, active.version, event);
                        answer = 'Stop ricevuto per la risposta attiva. Attendo il rilascio del task.';
                        void this.turns().dispatchStop(event).then(() => { if (this.store.get('telegramStop:' + event)?.state === 'idle_confirmed')
                            this.enqueue(event + ':stopped', 'Risposta interrotta; task rilasciato.', 'reply', undefined, now(), u.generation); }).catch(() => { });
                    }
                    else
                        answer = 'Nessuna risposta attiva da interrompere.';
                }
                else if (u.text === '/queue') {
                    const pending = this.store.all("SELECT id,state FROM jobs WHERE state IN ('queued','waiting')").map(j => this.turns().get(j.id)).filter(t => t && t.generation === binding.generation && !t.closed);
                    answer = pending.length ? `${pending.length} richieste future. Annulla una richiesta con i pulsanti.` : 'Nessuna richiesta futura.';
                    this.attachButtons(event, pending.slice(0, 8).map(t => ({ text: 'Annulla ' + t!.jobId.slice(0, 8), value: { action: 'cancel', id: t!.jobId, version: t!.version } })), binding.generation);
                }
                else if (u.text === '/recover') { answer=this.recoveryBacklog(event,binding,at); }
                else if (u.text === '/pause') {
                    this.store.tx(() => { this.control.pause(true); this.enqueue(event, 'Autonomia sospesa. Gli effetti esistenti continuano la riconciliazione.', 'reply', undefined, at, u.generation); this.finishIncoming(row); });
                    continue;
                }
                else if (u.text === '/resume') {
                    this.store.tx(() => { const summary = this.control.resumeSummary(at); this.callback(event, { action: 'resume', code: summary.code }); this.enqueue(event, summary.summary, 'reply', undefined, at, u.generation); this.finishIncoming(row); });
                    continue;
                }
                else if (u.text === '/status') {
                    answer = `Autonomia: ${this.store.get('enabled') ? 'attiva' : 'sospesa'}. Nodo: ${this.store.get('bootstrapReady') ? 'pronto' : 'bloccato'}. Richieste pendenti: ${this.control.queue.metrics(at).states.filter(r => ['queued', 'running', 'waiting'].includes(r.state)).reduce((n, r) => n + r.count, 0)}. Dettagli e budget: impostazioni web.`;
                }
                else if (u.text === '/proposals') {
                    const proposals = this.control.proposals().filter(p => p.status === 'pending');
                    answer = proposals.length ? `${proposals.length} proposte pendenti. Apri la web app per i dettagli.` : 'Nessuna proposta pendente.';
                    for (const p of proposals)
                        this.enqueue('proposal:' + p.id, this.summary(p), 'proposal', p.id, at, u.generation);
                }
                else if (u.text === '/help' || u.text === '/menu') {
                    if(u.text==='/menu')this.attachButtons(event,[['Stato','/status'],['Analizza','/analyze'],['Proposte','/proposals'],['Coda','/queue'],['Recupera','/recover'],['Aiuto','/help']].map(([text,code])=>({text:text!,value:{action:'navigate',code,expires:new Date(Date.parse(at)+15*60000).toISOString()}})),binding.generation);
                    answer = '/status /analyze /pause /resume /proposals /stop /queue /recover /menu /help. La chat consente analisi; chiedi esplicitamente una proposta da approvare. Mandato, permessi, token e collegamento si gestiscono nelle impostazioni web.';
                }
                else {
                    const message = u.text.startsWith('/analyze') ? u.text.slice(8).trim() || 'Analizza economia del nodo e blocchi attuali' : u.text;
                    if (!message.trim()) throw Error('Empty request');
                    let shouldWake = false;
                    this.store.tx(() => {
                        const requestId = 'telegram:' + (this.store.get('telegramBotGeneration') ?? 'initial') + ':' + row.update_id;
                        // Consult original admission before active-turn selection on replay.
                        const original = this.store.one('SELECT * FROM jobs WHERE request_id=?', requestId);
                        const active = original||row.recovery?.forceFutureRequest ? undefined : this.turns().active(binding.generation);
                        if (active) {
                            const c = this.turns().receive(binding.generation+':'+row.update_id, active, message, at);
                            this.attachButtons(event, [{ text: 'Correggi questa risposta', value: { action: 'steer', id: c.id } }, { text: 'Nuova richiesta', value: { action: 'followup', id: c.id } }], binding.generation);
                            answer = 'Vuoi correggere la risposta attiva oppure accodare una nuova richiesta? Il testo resta in attesa della tua scelta.';
                        } else {
                            const job = original ?? this.control.admitWithinTransaction(requestId, message, 'telegram', u.text.startsWith('/analyze'));
                            this.store.set('jobTelegramGeneration:' + job.id, binding.generation);
                            if(!['completed','failed','cancelled'].includes(job.state))this.turns().attach(job, binding.generation, binding.chatId);
                            shouldWake = !['completed','failed','cancelled'].includes(job.state); answer = this.store.all("SELECT id FROM jobs WHERE state IN ('queued','waiting','running') AND id!=?",job.id).some(j=>this.turns().get(j.id)?.generation===binding.generation)?'Richiesta accodata; puoi annullarla con /queue.':'';
                        }
                        if(answer)this.enqueue(event, answer, 'reply', undefined, at, u.generation);
                        this.finishIncoming(row);
                    });
                    if (shouldWake) void this.wake?.().catch(() => { });
                }
                this.store.tx(() => {
                    if (answer)
                        this.enqueue(event, (row.recoveryKey?'Richiesta precedente recuperata. ':'')+answer, 'reply', undefined, at, u.generation);
                    this.finishIncoming(row);
                });
            }
            catch {
                this.store.tx(() => { this.enqueue(event, 'Richiesta bloccata o scaduta. Verifica lo stato nella web app e crea una nuova richiesta.', 'reply', undefined, at, u.generation); this.finishIncoming(row,'Request blocked; inspect web receipt'); });
            }
        }
    }
    summary(p: any) { return `Proposta ${p.content.kind}: ${p.content.source || 'policy'} → ${p.content.target}. Importo ${p.content.amountSat} sat; costo massimo ${p.content.maxFeeMsat} msat${p.content.newPpm === undefined ? '' : `; nuova fee ${p.content.newPpm} ppm`}. Motivo: ${telegramText(p.content.whyAct)}. Valida per 5 minuti dalla consegna. Approva o rifiuta; restano attivi i controlli di sicurezza.`; }
    capture(at = now()) {
        this.turns().reconcile();
        if (!this.store.get('telegramBinding'))
            return;
        for (const j of this.store.all("SELECT j.* FROM jobs j JOIN job_events e ON e.job_id=j.id AND e.type='accepted' WHERE json_extract(e.details,'$.origin')='telegram' AND j.created_at>=? AND j.state IN ('completed','failed')", this.store.get('telegramBinding').since)) {
            if (this.store.get('jobTelegramGeneration:' + j.id) !== this.store.get('telegramBinding').generation)
                continue;
            const result = JSON.parse(j.result ?? '{}');
            const source=JSON.parse(j.payload??'{}').message??'';
            const greeting=/^(ciao|buongiorno|salve|hello|hi|grazie|ok)[!.,\s]*$/i.test(source.trim());
            const cta:{text:string;value:any}[]=greeting?[]:[{text:'Approfondisci',value:{action:'deepen',id:j.id}}];
            if((result.researchGaps?.length??0)>0||j.state==='failed'&&this.store.one("SELECT id FROM ui_events WHERE job_id=? AND type='text' LIMIT 1",j.id))cta.push({text:j.state==='failed'?'Completa risposta parziale':'Completa le lacune',value:{action:'gaps',id:j.id}});
            if(!greeting&&j.state==='completed')cta.push({text:'Dettagli stato',value:{action:'details',id:j.id}});
            if(cta.length)this.attachButtons('answer:'+j.id,cta,this.store.get('telegramBinding').generation);
            const partial=this.store.one("SELECT data FROM ui_events WHERE job_id=? AND type='text' ORDER BY id DESC LIMIT 1",j.id);
            const finalText=j.state==='completed'?telegramClean(result.answer??'Richiesta completata; dettagli nella web app.'):((partial?JSON.parse(partial.data).text+'\n\n':'')+'Risposta interrotta o non completata. Il testo è parziale; puoi chiedere un nuovo approfondimento.');
            this.enqueue('answer:'+j.id,finalText,'reply',undefined,at);
        }
        for (const o of this.store.all("SELECT id,state FROM operations WHERE at>=? AND state IN ('SUCCEEDED','FAILED','uncertain','in_flight')", this.store.get('telegramBinding').since))
            this.enqueue('operation:' + o.id + ':' + o.state, `Operation ${o.id}: ${o.state}. Dettagli nella web app.`, o.state === 'uncertain' ? 'critical' : 'ordinary', undefined, at);
        const blockers = [this.store.get('integrityBlocker'), this.store.get('agent')?.status === 'unavailable' ? availabilityBlocker(this.store.get('agent')?.failure) : null, this.store.one("SELECT id FROM operations WHERE state='uncertain'") ? 'Esito finanziario incerto; richiesta riconciliazione, nessun replay' : null, ...(this.store.get<any[]>('blockers') ?? [])].filter(Boolean).map(telegramText);
        this.store.tx(() => {
            const generation = this.store.get('telegramBinding').generation;
            const previous = this.store.get('telegramIncident');
            const previousActive = previous?.generation === generation && typeof previous.active === 'object' ? previous.active : {};
            const active: Record<string, string> = {};
            for (const blocker of blockers) {
                const digest = hash(blocker);
                active[digest] = previousActive[digest] ?? randomBytes(12).toString('hex');
            }
            if (blockers.length)
                this.enqueue('blockers:' + generation + ':' + hash(json(Object.entries(active).sort())), `Intervento richiesto: ${blockers.join('; ')}`, 'critical', undefined, at);
            this.store.set('telegramIncident', { generation, active });
        });
        for (const p of this.control.proposals().filter(p => p.status === 'pending')) {
            const key = 'proposal:' + p.id;
            if (!this.store.one('SELECT event_id FROM telegram_outbox WHERE event_id=?', key)) {
                this.store.run('UPDATE owner_proposals SET expires_at=NULL WHERE id=?', p.id);
                this.enqueue(key, this.summary(p), 'proposal', p.id, at);
            }
        }
        // Advisory failure cannot prevent ordinary capture/delivery. No recursive
        // observations of advisory outbox events and bounded scan/output budgets.
        try { this.captureImprovements(at); } catch { this.store.set('runtimeAdvisoryCaptureFailed', { at }); }
        const hour = romeHour(at), date = day(at);
        if (hour >= 9) {
            const key = 'digest:' + date;
            if (!this.store.one('SELECT event_id FROM telegram_outbox WHERE event_id=?', key))
                this.store.tx(() => {
                    const ordinary = this.store.all("SELECT * FROM telegram_outbox WHERE kind='ordinary' AND status='pending' AND created_at<=?", at);
                    const stats = this.store.stats();
                    this.enqueue(key, `Riepilogo ${date} (Europe/Rome): ${ordinary.length} risultati da riconciliare nella cronologia. Ricavi 30 giorni ${stats.pnl30.revenueMsat} msat; costi ${stats.pnl30.costMsat} msat; netto ${stats.pnl30.netMsat} msat. Copertura ${stats.partial ? 'parziale' : 'completa'}. Budget residuo ${stats.budget.remainingMsat} msat. Autonomia ${stats.enabled ? 'attiva' : 'sospesa'}. Blocchi ${blockers.length}. Dettagli nella web app.`, 'digest', undefined, at);
                    this.store.run("UPDATE telegram_outbox SET status='aggregated' WHERE kind='ordinary' AND status='pending' AND created_at<=?", at);
                });
        }
    }
    private captureImprovements(at: string) {
        const runtime = new RuntimeImprovements(this.store); runtime.scan(at);
        const binding = this.store.get('telegramBinding'); if (!binding) return;
        let admitted = 0;
        for (const issue of runtime.issues()) {
            const revision = issue.revisions.at(-1)!;
            if (issue.status !== 'open' || revision.delivery || ['upstream_transient','authentication'].includes(revision.observation.classification) || admitted >= 3) continue;
            const eventId = `advisory:${issue.id}:${revision.number}`;
            const content = telegramClean(revision.prompt), checksum = hash(content);
            const artifact: RuntimeArtifact = { issueId: issue.id, revision: revision.number, requestLink: eventId,
                filename: `satssurge-${issue.id}-r${revision.number}.txt`, content, checksum,
                generation: binding.generation, chatId: binding.chatId };
            // One immutable text artifact, one outbox intent; retries never regenerate.
            this.store.tx(() => {
                this.store.set('runtimeArtifact:' + eventId, artifact);
                revision.delivery = { eventId, generation: binding.generation, chatId: binding.chatId, checksum, status: 'pending' };
                const issues = runtime.issues(); const target = issues.find(i => i.id === issue.id)!;
                target.revisions[target.revisions.length - 1] = revision;
                this.store.set('runtimeImprovements', issues);
                const critical = revision.observation.classification === 'app_defect' && revision.observation.impact === 'runtime_blocked' && revision.observation.facts.includes('regression_confirmed');
                this.enqueue(eventId, content.length <= 3500 ? content : `Segnalazione consultiva ${issue.id}, revisione ${revision.number}. Prompt di sviluppo nel file di testo allegato; consegna non significa risoluzione.`, critical ? 'critical' : 'advisory', undefined, at, binding.generation);
            });
            admitted++;
        }
    }
    async deliver(at = now()) {return this.dispatch(()=>this.deliverUnlocked(at));}
    private async deliverUnlocked(at:string) {
        if(Date.parse(at)<(this.store.get<number>('telegramRateLimitUntil')??0))return;
        const binding = this.store.get('telegramBinding');
        if (!binding)
            return;
        const hour = romeHour(at);
        const botGeneration = this.store.get('telegramBotGeneration') ?? null;
        for (const r of this.store.all("SELECT * FROM telegram_outbox WHERE status='pending' AND kind<>'ordinary' AND generation=? AND (next_at IS NULL OR next_at<=?) ORDER BY CASE kind WHEN 'critical' THEN 0 WHEN 'reply' THEN 1 ELSE 2 END,created_at LIMIT 20", binding.generation, at)) {
            if ((hour >= 22 || hour < 8) && !['critical', 'reply'].includes(r.kind))
                continue;
            if (r.proposal_id) {
                const p = this.control.proposal(r.proposal_id);
                if (!p || p.status !== 'pending') {
                    this.store.run("UPDATE telegram_outbox SET status='cancelled' WHERE event_id=?", r.event_id);
                    continue;
                }
                try {
                    this.store.run('UPDATE owner_proposals SET expires_at=? WHERE id=?', new Date(Date.parse(at) + 300000).toISOString(), p.id);
                    this.control.validate(p.id, this.store.get('snapshot')!, at);
                }
                catch {
                    this.store.run("UPDATE owner_proposals SET status='invalidated' WHERE id=?", p.id);
                    this.store.run("UPDATE telegram_outbox SET status='cancelled' WHERE event_id=?", r.event_id);
                    continue;
                }
            }
            let buttons: any = this.store.get('telegramButtons:' + r.event_id);
            if (r.proposal_id) {
                buttons = { inline_keyboard: [[{ text: 'Approva', callback_data: this.callback(r.event_id + ':approve', { action: 'approve', id: r.proposal_id }) }, { text: 'Rifiuta', callback_data: this.callback(r.event_id + ':reject', { action: 'reject', id: r.proposal_id }) }]] };
            }
            else if (this.store.get('telegramCallback:' + hash(r.event_id).slice(0, 32))?.action === 'resume')
                buttons = { inline_keyboard: [[{ text: 'Riprendi con il mandato attuale', callback_data: hash(r.event_id).slice(0, 32) }]] };
            // Re-read at every dispatch boundary: an earlier await may have
            // revoked this batch or rotated the token. Never mix identities.
            const currentBinding = this.store.get('telegramBinding');
            const currentRow = this.store.one('SELECT status,generation FROM telegram_outbox WHERE event_id=?', r.event_id);
            if (Math.max(Date.parse(at),Date.now())<(this.store.get<number>('telegramRateLimitUntil')??0)||!currentBinding || currentBinding.generation !== binding.generation || currentBinding.chatId !== binding.chatId || (this.store.get('telegramBotGeneration') ?? null) !== botGeneration || currentRow?.status !== 'pending' || currentRow.generation !== binding.generation)
                break;
            const artifact = this.store.get<RuntimeArtifact>('runtimeArtifact:' + r.event_id);
            if (artifact && (artifact.generation !== binding.generation || artifact.chatId !== binding.chatId || hash(artifact.content) !== artifact.checksum || artifact.requestLink !== r.event_id)) {
                this.store.run("UPDATE telegram_outbox SET status='failed',error='Artifact integrity or destination mismatch' WHERE event_id=?", r.event_id);
                new RuntimeImprovements(this.store).delivery(r.event_id, 'failed'); continue;
            }
            // A crash after this receipt is uncertain, not silently retried after restart.
            this.store.run("UPDATE telegram_outbox SET status='sending',attempts=attempts+1 WHERE event_id=?", r.event_id);
            new RuntimeImprovements(this.store).delivery(r.event_id, 'sending');
            this.invalidateDrafts(binding.generation,binding.chatId);
            try {
                let method = 'sendMessage', body: unknown = { chat_id: binding.chatId, text: telegramHtml(r.text), parse_mode: 'HTML', reply_markup: buttons };
                if (artifact && artifact.content.length > 3500) {
                    const form = new FormData(); form.set('chat_id', String(binding.chatId)); form.set('caption', telegramClean(r.text));
                    form.set('document', new Blob([artifact.content], { type: 'text/plain;charset=utf-8' }), artifact.filename);
                    method = 'sendDocument'; body = form;
                }
                const message = await this.outboundCall(method,body);
                this.store.tx(() => {
                    this.store.run("UPDATE telegram_outbox SET status='sent',message_id=?,error=NULL WHERE event_id=?", message.message_id, r.event_id);
                    new RuntimeImprovements(this.store).delivery(r.event_id, 'sent', message.message_id);
                    this.invalidateDrafts(binding.generation,binding.chatId);
                    if (r.proposal_id && this.store.get('telegramBinding')?.generation === binding.generation)
                        this.store.run("UPDATE owner_proposals SET expires_at=? WHERE id=? AND status='pending'", new Date(Date.parse(now()) + 300000).toISOString(), r.proposal_id);
                });
            }
            catch (error) {
                if (r.proposal_id)
                    this.store.run('UPDATE owner_proposals SET expires_at=NULL WHERE id=?', r.proposal_id);
                const attempts = r.attempts + 1, retry = this.rejectedRetryAfter(error), rejected = (error as any).rejected === true;
                const changed = this.store.get('telegramBinding')?.generation !== binding.generation || (this.store.get('telegramBotGeneration') ?? null) !== botGeneration;
                const status = changed ? 'uncertain' : attempts >= 5 ? 'failed' : rejected ? 'pending' : 'uncertain';
                this.store.run('UPDATE telegram_outbox SET status=?,next_at=?,error=? WHERE event_id=?', status, new Date(Math.min(8640000000000000,Date.parse(at) + Math.max(retry ?? 0, 2 ** attempts) * 1000)).toISOString(), rejected ? 'API rejection; bounded retry' : 'Delivery uncertain; inspect Telegram before manual retry', r.event_id);
                new RuntimeImprovements(this.store).delivery(r.event_id, status);
                if (this.recordRateLimit(error,botGeneration)!==undefined) break;
            }
            if(this.store.all("SELECT value FROM meta WHERE key LIKE 'telegramTurn:%'").some(row=>{const t=JSON.parse(row.value);return !t.closed&&t.state==='running';}))break;
        }
    }
    recover() { this.store.run("UPDATE telegram_outbox SET status='uncertain',error='Interrupted send; delivery uncertain, no automatic replay' WHERE status='sending'"); this.control.recover(); for (const row of this.store.all("SELECT event_id,status FROM telegram_outbox WHERE event_id LIKE 'advisory:%'")) new RuntimeImprovements(this.store).delivery(row.event_id, row.status); }
    async loop() {
        if (this.running)
            return;
        this.running = true;
        this.recover();
        this.outgoing = this.outbound();
        this.incoming = this.processLoop();
        while (!this.abort.signal.aborted) {
            const botGeneration = this.store.get('telegramBotGeneration')??null;
            try {
                if(Date.now()<(this.store.get<number>('telegramRateLimitUntil')??0)){await this.wait(1000);continue;}
                if (this.status().configured && (this.store.get('telegramBinding') || this.store.get('telegramPairing'))) {
                    if (this.store.get('telegramLastPoll') && Date.now() - Date.parse(this.store.get<string>('telegramLastPoll') ?? '') > 7 * 86400000)
                        this.store.set('telegramCursor', 0);
                    const updates = await this.client().call('getUpdates', { offset: this.store.get('telegramCursor') ?? 0, timeout: 25, allowed_updates: ['message', 'edited_message', 'callback_query', 'stopped_message_generation'] }, this.abort.signal);
                    if (botGeneration !== (this.store.get('telegramBotGeneration')??null))
                        continue;
                    this.ingest(updates);
                    this.store.set('telegramLastPoll', now());
                    this.store.set('telegramError', null);

                }
                else
                    await this.wait(1000);
            }
            catch(error) {
                if (!this.abort.signal.aborted) {
                    const retry=this.recordRateLimit(error,botGeneration);
                    this.store.set('telegramError', 'Telegram non disponibile; web e scheduler autonomo continuano');
                    await this.wait(retry===undefined?5000:1000);
                }
            }
        }
        await this.outgoing;
        await this.incoming;
        this.running = false;
    }
    private async processLoop(){while(!this.abort.signal.aborted){try{await this.process();}catch{this.store.set('telegramError','Ingresso Telegram temporaneamente bloccato; aggiornamenti conservati');}await this.wait(100);}}
    private async outbound() { while (!this.abort.signal.aborted) {
        let botGeneration=this.store.get('telegramBotGeneration')??null;
        try {
            if (this.status().paired && Date.now() >= (this.store.get<number>('telegramRateLimitUntil') ?? 0)) {
                this.capture();
                await this.deliver();
                await this.streamDrafts();
                // Earlier awaits may have changed the bot; menu dispatch owns its actual originating generation.
                botGeneration=this.store.get('telegramBotGeneration')??null;
                await this.menu();
            }
        }
        catch (error) {
            this.recordRateLimit(error,botGeneration);
            this.store.set('telegramError', 'Uscita Telegram temporaneamente non disponibile; ricevute conservate');
        }
        await this.wait(500);
    } }
    async menu() {
        const b = this.store.get('telegramBinding');
        if (!b)
            return;
        const bot = this.store.get('telegramBotGeneration') ?? null, key = 'telegramMenu:' + b.generation + ':' + bot;
        if (this.store.get(key)&&this.store.get(key+':recoveryReviewV1'))
            return;
        const dispatchAuthorized=()=>this.authorized(b.generation,b.chatId,bot)&&Date.now()>=(this.store.get<number>('telegramRateLimitUntil')??0);
        const commands = [['status', 'Stato e budget'], ['analyze', 'Analizza il nodo'], ['proposals', 'Proposte da approvare'], ['pause', 'Sospendi autonomia'], ['resume', 'Riprendi con conferma'], ['stop', 'Interrompi risposta attiva'], ['queue', 'Richieste future'], ['recover', 'Richieste precedenti'], ['menu', 'Menu'], ['help', 'Aiuto']].map(([command, description]) => ({ command, description }));
        if (!dispatchAuthorized())
            return;
        await this.outboundCall('setMyCommands', { commands });
        if (!dispatchAuthorized())
            return;
        await this.outboundCall('setMyCommands', { commands, scope: { type: 'chat', chat_id: b.chatId }, language_code: 'it' });
        if (!dispatchAuthorized())
            return;
        await this.outboundCall('setChatMenuButton', { chat_id: b.chatId, menu_button: { type: 'commands' } });
        if (!dispatchAuthorized())
            return;
        const identity = await this.outboundCall('getMe', {});
        if (this.authorized(b.generation, b.chatId, bot)) {
            if (/^[a-zA-Z0-9_]{5,32}$/.test(identity?.username ?? ''))
                this.store.set('telegramUsername', identity.username);
            this.store.set(key, true);this.store.set(key+':recoveryReviewV1',true);
        }
    }
    async streamDrafts(at = now()) {return this.dispatch(()=>this.streamDraftsUnlocked(at));}
    private async streamDraftsUnlocked(at:string) {
        if(Math.max(Date.parse(at),Date.now())<(this.store.get<number>('telegramRateLimitUntil')??0))return;
        const b = this.store.get('telegramBinding');
        if (!b)
            return;
        const bot = this.store.get('telegramBotGeneration') ?? null;
        // One foreground draft per peer: Telegram clients do not consistently support simultaneous drafts.
        const foreground=this.store.all("SELECT value FROM meta WHERE key LIKE 'telegramTurn:%'").map(r=>JSON.parse(r.value)).filter(t=>t.generation===b.generation&&t.chatId===b.chatId&&!t.closed&&t.state==='running'&&this.control.queue.get(t.jobId)?.state==='running').sort((a,b)=>String(this.control.queue.get(a.jobId)?.created_at).localeCompare(String(this.control.queue.get(b.jobId)?.created_at))||a.jobId.localeCompare(b.jobId)).slice(0,1);
        for (const turn of foreground) {
            const key = 'telegramStream:' + turn.jobId;
            const prior = this.store.get(key) ?? { cursor: 0 };
            if (prior.status === 'uncertain')
                continue;
            if (prior.status === 'sending') {
                this.store.set(key, { ...prior, status: 'uncertain' });
                continue;
            }
            if (prior.nextAt && prior.nextAt > at)
                continue;
            const textRow = this.store.one("SELECT id,data FROM ui_events WHERE job_id=? AND type='text' ORDER BY id DESC LIMIT 1", turn.jobId);
            const summary = this.store.one("SELECT data FROM ui_events WHERE job_id=? AND type='reasoning_summary' AND json_extract(data,'$.provenance')='responses.summary_text' ORDER BY id DESC LIMIT 1", turn.jobId);
            const tool = this.store.one("SELECT data,type FROM ui_events WHERE job_id=? AND type IN ('tool_call','tool_result') ORDER BY id DESC LIMIT 1", turn.jobId);
            let text = textRow ? JSON.parse(textRow.data).text : '';
            if (!text) {
                text = 'Thinking…';
                if (summary) {
                    const publicSummary = JSON.parse(summary.data);
                    if (publicSummary.text)
                        text += '\n' + publicSummary.text;
                }
                if (tool)
                    text += '\n' + (tool.type === 'tool_call' ? 'Strumento in corso: ' : 'Strumento completato: ') + JSON.parse(tool.data).toolName;
            }
            const clean=telegramClean(text);
            if(clean.length>3500){
                const marker='… Risposta in corso (continuazione)\n';
                let tail='';
                // Count UTF-16 transport units but keep whole Unicode code points.
                for(const ch of [...clean].reverse()){if(marker.length+tail.length+ch.length>3500)break;tail=ch+tail;}
                text=marker+tail;
            }else text=clean;
            if (prior.at && Date.parse(at) - Date.parse(prior.at) < 1000)
                continue;
            if (!prior.invalidated && prior.text === text && prior.at && Date.parse(at) - Date.parse(prior.at) < 20000)
                continue;
            if (!this.draftAuthorized(turn,b,bot)||Math.max(Date.parse(at),Date.now())<(this.store.get<number>('telegramRateLimitUntil')??0))
                continue;
            let allocation:{id:number;alias:any}|undefined;
            try {
                if(!prior.fallback){
                    if(Date.parse(at)-(this.store.get<number>('telegramDraftLastDispatchAt')??0)<1000)continue;
                    allocation=this.draftAlias(turn,b,bot,prior,text,at);prior.draftId=allocation.id;
                    this.store.set('telegramDraftLastDispatchAt',Date.parse(at));
                }
                if (prior.fallback) {
                    if (prior.messageId)
                        await this.outboundCall('editMessageText', { chat_id: b.chatId, message_id: prior.messageId, text });
                    else {
                        this.store.set(key, { ...prior, status: 'sending' });
                        const result = await this.outboundCall('sendMessage', { chat_id: b.chatId, text, reply_markup: this.buttons(key, [{ text: 'Stop', value: { action: 'stop', id: turn.jobId, version: turn.version } }], b.generation) });
                        prior.messageId = result.message_id;
                    }
                }
                else if (!prior.plainDraft)
                    await this.outboundCall('sendRichMessageDraft', { chat_id: b.chatId, draft_id: prior.draftId, rich_message: { html: text.startsWith('Thinking…') ? '<tg-thinking>' + telegramHtml(text.slice('Thinking…'.length).trim() || 'Sto elaborando…') + '</tg-thinking>' : telegramHtml(text) }, can_stop: true, keep_on_stop: true });
                else
                    await this.outboundCall('sendMessageDraft', { chat_id: b.chatId, draft_id: prior.draftId, text,can_stop:true,keep_on_stop:true });
                if(allocation)this.store.set('telegramDraft:'+allocation.id,{...allocation.alias,outcome:'accepted',completedAt:now()});
                if(!this.draftAuthorized(turn,b,bot))continue;
                this.store.set(key, { ...prior, invalidated:false,status: 'active', text, at, cursor: textRow?.id ?? prior.cursor });
            }
            catch (error) {
                if(allocation)this.store.set('telegramDraft:'+allocation.id,{...allocation.alias,outcome:(error as any).rejected?'rejected':'uncertain',completedAt:now()});
                // Bot quota outlives the originating turn; obsolete bot responses have no authority over its replacement.
                const retry=this.recordRateLimit(error,bot);
                if(!this.draftAuthorized(turn,b,bot))continue;
                if(!allocation&&!prior.fallback){this.store.set(key,{...prior,status:'capacity_blocked',at,note:'Draft alias capacity unavailable; final delivery remains independent'});continue;}
                if (prior.fallback && !prior.messageId && (error as any).rejected !== true) {
                    this.store.set(key, { ...prior, status: 'uncertain' });
                    this.enqueue(key + ':uncertain', 'Consegna del messaggio di avanzamento incerta: nessun reinvio automatico. La risposta finale conserva la propria ricevuta.', 'reply', undefined, at, b.generation);
                    continue;
                }
                if (retry!==undefined) {
                    this.store.set(key, { ...prior, nextAt: new Date(Math.min(8640000000000000,Date.parse(at) + retry * 1000)).toISOString() });
                }
                else if ((error as any).rejected && !prior.plainDraft) {
                    this.store.set(key, { ...prior, plainDraft: true });
                }
                else if ((error as any).rejected && !prior.fallback) {
                    this.store.set(key, { ...prior, fallback: true });
                    this.enqueue(key + ':fallback', 'Streaming nativo non disponibile: uso un messaggio aggiornabile.', 'reply', undefined, at, b.generation);
                }
                else
                    this.store.set(key, { ...prior, nextAt: new Date(Date.parse(at) + 5000).toISOString() });
            }
        }
    }
    private wait(ms: number) {
        return new Promise<void>(resolve => {
            if (this.abort.signal.aborted)
                return resolve();
            const done = () => { clearTimeout(timer); this.abort.signal.removeEventListener('abort', done); resolve(); };
            const timer = setTimeout(done, ms);
            this.abort.signal.addEventListener('abort', done, { once: true });
        });
    }
    stop() { this.abort.abort(); }
}
