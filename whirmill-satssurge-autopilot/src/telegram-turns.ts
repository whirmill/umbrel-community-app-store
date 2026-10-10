import { Store } from './store.js';
import { Queue, type Job } from './queue.js';
import { now, hash } from './domain.js';
export interface Turn {
    jobId: string;
    generation: string;
    chatId: number;
    version: number;
    state: 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'stop_requested' | 'interrupted';
    capability: string;
    conversationId?: string;
    submissions: string[];
    correctionOrder?: string[];
    closed: boolean;
}
export interface ScopedStopReceipt { patch:string;taskIds:number[];remoteCancellationUnknown:number[]; }
export interface Correction {
    id: string;
    jobId: string;
    generation: string;
    version: number;
    body: string;
    state: 'received' | 'choice_pending' | 'admitted' | 'placed' | 'late' | 'withdrawn' | 'settled' | 'failed';
    submissionId?: string;
    withdrawalRequested?:boolean;
    withdrawResult?:string;
    expires: string;
}
interface Runner {
    steer(receipt: Correction): Promise<void>;
    stop(): Promise<void>;
    withdraw?(receipt: Correction): Promise<string>;
}
const runners = new WeakMap<Store, Map<string, Runner>>();
/** App turns remain in Queue. Only explicit corrections enter the native inbox. */
export class TelegramTurns {
    constructor(readonly store: Store, readonly queue: Queue) { }
    get(jobId: string) { return this.store.get<Turn>('telegramTurn:' + jobId); }
    save(turn: Turn) { this.store.set('telegramTurn:' + turn.jobId, turn); }
    attach(job: Job, generation: string, chatId: number) { const old = this.get(job.id); if (old)
        return old; const turn: Turn = { jobId: job.id, generation, chatId, version: 1, state: 'queued', capability: this.store.get('jobCapability:' + job.id) ?? 'read_only_chat', submissions: [], closed: false }; this.save(turn); return turn; }
    active(generation: string) { return this.store.all("SELECT value FROM meta WHERE key LIKE 'telegramTurn:%'").map(r => JSON.parse(r.value) as Turn).find(t => t.generation === generation && !t.closed && (['running', 'stop_requested'].includes(t.state) || this.queue.get(t.jobId)?.state === 'running')); }
    choices(generation: string) { return this.store.all("SELECT value FROM meta WHERE key LIKE 'telegramCorrection:%'").map(r => JSON.parse(r.value) as Correction).filter(c => c.generation === generation && c.state === 'choice_pending'); }
    receive(id: string, turn: Turn, body: string, at = now()) { const key = 'telegramCorrection:' + id; if (this.choices(turn.generation).length >= 20 && !this.store.get(key))
        throw Error('Too many unanswered choices'); let c = this.store.get<Correction>(key); if (!c) {
        c = { id, jobId: turn.jobId, generation: turn.generation, version: turn.version, body, state: 'choice_pending', expires: new Date(Date.parse(at) + 300000).toISOString() };
        this.store.set(key, c);
    } return c; }
    correction(id: string) { return this.store.get<Correction>('telegramCorrection:' + id); }
    saveCorrection(c: Correction) { this.store.set('telegramCorrection:' + c.id, c); }
    authorized(t: Turn) { const b = this.store.get('telegramBinding'); return !!b && b.generation === t.generation && b.chatId === t.chatId && this.store.get('jobCapability:' + t.jobId) === t.capability; }
    bind(job: Job, runner: Runner) { const t = this.get(job.id); if (!t)
        return; if (t.closed) return; if (!this.authorized(t))
        throw Error('Telegram turn authority revoked'); const pendingStop = this.store.all("SELECT value FROM meta WHERE key LIKE 'telegramStop:%'").some(r => { const stop = JSON.parse(r.value); return stop.jobId === job.id && stop.state === 'received'; }); t.state = t.state === 'stop_requested' || pendingStop ? 'stop_requested' : 'running'; t.conversationId = job.conversation_id ?? undefined; this.save(t); let map = runners.get(this.store); if (!map) {
        map = new Map();
        runners.set(this.store, map);
    } map.set(job.id, runner); }
    submission(jobId: string, id: string) { const t = this.get(jobId); if (t && !t.submissions.includes(id)) {
        t.submissions.push(id);
        this.save(t);
    } }
    async steer(id: string, at = now()) { const c = this.correction(id); if (!c)
        return 'expired'; const t = this.get(c.jobId); if (c.state !== 'choice_pending')
        return c.state; if (c.expires <= at) {
        c.state = 'withdrawn';
        this.saveCorrection(c);
        return 'expired';
    } if (!t || !this.authorized(t) || t.closed || t.version !== c.version || !['running', 'queued'].includes(t.state) || this.queue.get(t.jobId)?.state !== 'running') {
        c.state = 'late';
        this.saveCorrection(c);
        return 'late';
    } const runner = runners.get(this.store)?.get(t.jobId); if (!runner) {
        c.state = 'admitted';
        this.admitCorrection(t,c);
        return 'admitted';
    } c.state = 'admitted'; this.admitCorrection(t,c); try {
        await runner.steer(c);
        return this.correction(id)!.state;
    }
    catch {
        c.state = 'failed';
        this.saveCorrection(c);
        return 'failed';
    } }
    admitCorrection(t:Turn,c:Correction) { this.store.tx(()=>{const current=this.get(t.jobId)!;current.correctionOrder??=[];if(!current.correctionOrder.includes(c.id))current.correctionOrder.push(c.id);this.save(current);this.saveCorrection(c);}); }
    orderedCorrections(jobId:string) { const t=this.get(jobId);return this.store.all("SELECT value FROM meta WHERE key LIKE 'telegramCorrection:%'").map(r=>JSON.parse(r.value) as Correction).filter(c=>c.jobId===jobId).sort((a,b)=>{const rank=(c:Correction)=>{const order=t?.correctionOrder?.indexOf(c.id)??-1;return order>=0?order:Number(c.submissionId??Number.MAX_SAFE_INTEGER);};return rank(a)-rank(b)||a.id.localeCompare(b.id);}); }
    finalize(jobId:string,state:Turn['state'],details:Record<string,unknown>={}) { return this.store.tx(()=>this.finalizeInTransaction(jobId,state,details)); }
    private finalizeInTransaction(jobId:string,state:Turn['state'],details:Record<string,unknown>={}) {
        const t=this.get(jobId);if(!t)return undefined;
        const existing=this.store.get('telegramTerminal:'+jobId);if(t.closed&&existing)return existing;
        const stopped=t.state==='stop_requested'||this.store.all("SELECT value FROM meta WHERE key LIKE 'telegramStop:%'").some(r=>{const stop=JSON.parse(r.value);return stop.jobId===jobId&&stop.generation===t.generation&&['received','idle_confirmed'].includes(stop.state);});
        const outcome={...details,state:t.closed?t.state:stopped?'interrupted':state,at:now()};
        this.store.set('telegramTerminal:'+jobId,outcome);
        if(!t.closed){t.state=outcome.state as Turn['state'];t.closed=true;t.version++;this.save(t);}
        runners.get(this.store)?.delete(jobId);return outcome;
    }
    /** Native scoped idle and every accepted receipt become visible in one operational commit. */
    finalizeScopedStop(expected:Turn,submissionIds:string[],native:ScopedStopReceipt) {
        return this.store.tx(()=>{
            const t=this.get(expected.jobId),job=this.queue.get(expected.jobId);
            if(!t||!job||t.closed||t.state!=='stop_requested'||t.generation!==expected.generation||t.version!==expected.version||t.conversationId!==expected.conversationId||job.conversation_id!==expected.conversationId||!this.authorized(t))return undefined;
            const stops=this.matchingStops(t.jobId,t.generation,t.version);
            if(!stops.some(r=>r.value.state==='received'))return undefined;
            const stopProof={jobId:t.jobId,generation:t.generation,version:t.version,conversationId:t.conversationId,submissionIds,nativeCancellation:native};
            const outcome=this.finalizeInTransaction(t.jobId,'interrupted',{reason:'owner_stop_native_idle',submissionIds,nativeCancellation:native,stopProof,remoteCancellation:native.remoteCancellationUnknown.length?'unknown':'not_required'});
            this.confirmScopedStops(stops,native);return outcome;
        });
    }
    private matchingStops(jobId:string,generation:string,version:number) {
        return this.store.all("SELECT key,value FROM meta WHERE key LIKE 'telegramStop:%'").map(row=>({key:row.key,value:JSON.parse(row.value)})).filter(r=>r.value.jobId===jobId&&r.value.generation===generation&&r.value.version===version&&['received','idle_confirmed'].includes(r.value.state));
    }
    private confirmScopedStops(stops:{key:string;value:any}[],native:ScopedStopReceipt) {
        for(const stop of stops)if(stop.value.state==='received')this.store.set(stop.key,{...stop.value,state:'idle_confirmed',confirmedAt:now(),native,remoteCancellation:native.remoteCancellationUnknown.length?'unknown':'not_required'});
    }
    /** Caller has read back original native terminal identities; no current session cancellation belongs here. */
    reconcileClosedScopedStop(expected:Turn,terminal:Record<string,any>,native:ScopedStopReceipt,original:{submissionId:string;requestId:string}) {
        return this.store.tx(()=>{
            const t=this.get(expected.jobId),job=this.queue.get(expected.jobId),current=this.store.get<any>('telegramTerminal:'+expected.jobId);
            if(!t||!job||!t.closed||t.state!=='interrupted'||t.generation!==expected.generation||t.version!==expected.version||t.conversationId!==expected.conversationId||t.capability!==expected.capability||job.conversation_id!==expected.conversationId||job.submission_id!==original.submissionId||job.request_id!==original.requestId||JSON.stringify([...new Set([job.submission_id,...t.submissions])].sort())!==JSON.stringify([...new Set(terminal.submissionIds)].sort())||this.store.get('jobCapability:'+t.jobId)!==t.capability||JSON.stringify(current)!==JSON.stringify(terminal))return false;
            const stops=this.matchingStops(t.jobId,t.generation,t.version-1);this.confirmScopedStops(stops,native);return stops.length>0;
        });
    }
    async withdraw(id: string) {
        const c = this.correction(id), t = c && this.get(c.jobId);
        if (!c || !t || !this.authorized(t))
            return 'expired';
        if (c.state === 'choice_pending') {
            c.state = 'withdrawn';
            this.saveCorrection(c);
            return 'aborted';
        }
        if (!['admitted', 'placed'].includes(c.state) || t.closed)
            return 'settled';
        const runner = runners.get(this.store)?.get(t.jobId);
        if (!runner?.withdraw)
            return 'requires_reconciliation';
        c.withdrawalRequested=true;this.saveCorrection(c);
        const result = await runner.withdraw(c);
        c.withdrawResult=result;
        if (result === 'aborted') {
            c.state = 'withdrawn';
            this.saveCorrection(c);
        }
        else if (result === 'already_placed') {
            c.state = 'placed';
            this.saveCorrection(c);
        }
        return result;
    }
    async stop(jobId: string, generation: string, version: number, receiptId: string) { return this.store.tx(() => { const old = this.store.get('telegramStop:' + receiptId); if (old)
        return old; const t = this.get(jobId); const valid = t && this.authorized(t) && t.generation === generation && t.version === version && !t.closed && (t.state === 'running' || (t.state === 'queued' && this.queue.get(t.jobId)?.state === 'running')); const receipt = { jobId, generation, version, state: valid ? 'received' : 'stale', at: now() }; this.store.set('telegramStop:' + receiptId, receipt); if (valid) {
        t.state = 'stop_requested';
        this.save(t);
    } return receipt; }); }
    async dispatchStop(receiptId: string) { const key = 'telegramStop:' + receiptId, r = this.store.get(key), t = r && this.get(r.jobId); if (!r || r.state !== 'received' || !t)
        return; if (t.closed) {
        // Closed turns need original native proof; Agent recovery performs that readback.
        return;
    } if (t.version !== r.version || !this.authorized(t))
        return; const runner = runners.get(this.store)?.get(t.jobId); if (!runner)
        return; await runner.stop(); this.store.set(key, { ...r, state: 'idle_confirmed', confirmedAt: now() }); }
    close(jobId: string, state: Turn['state']) { this.finalize(jobId,state); }
    cancel(jobId: string, generation: string, version: number) { const t = this.get(jobId); if (!t || t.generation !== generation || t.version !== version || !this.authorized(t))
        return false; if (!this.queue.cancel(jobId))
        return false; this.close(jobId, 'cancelled'); return true; }
    reconcile() { for (const row of this.store.all("SELECT value FROM meta WHERE key LIKE 'telegramTurn:%'")) {
        const t = JSON.parse(row.value) as Turn, j = this.queue.get(t.jobId);
        if (!j || t.closed)
            continue;
        if (['completed', 'failed', 'cancelled'].includes(j.state))
            this.close(j.id, j.state as Turn['state']);
        else if (j.state === 'waiting' && t.state !== 'stop_requested') {
            t.state = 'waiting';
            this.save(t);
        }
    } for (const row of this.store.all("SELECT value FROM meta WHERE key LIKE 'telegramCorrection:%'")) {
        const c = JSON.parse(row.value) as Correction;
        if (c.state === 'choice_pending' && c.expires <= now()) {
            c.state = 'withdrawn';
            this.saveCorrection(c);
        }
    } }
    sessionKey(t: Turn) { return 'telegramSession:' + hash(JSON.stringify([t.generation, t.chatId, t.capability])); }
}
