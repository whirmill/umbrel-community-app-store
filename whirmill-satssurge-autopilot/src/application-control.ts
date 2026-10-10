import { runtimeDetectorVersion } from './runtime-improvements.js';
import {forecast} from './economics.js';
import { randomBytes } from 'node:crypto';
import { Store } from './store.js';
import { Queue } from './queue.js';
import { Executor } from './executor.js';
import { hash, json, now, scrub, type Proposal, type Snapshot } from './domain.js';
/** Snapshot timestamps are excluded; every material approved endpoint field is bound. */
export function approvalState(s: Snapshot, p: Proposal) {
    return hash(json({ identity: s.identity, synced: s.synced, confirmedSat: s.confirmedSat, channels: s.channels.filter(c => [p.source, p.target].includes(c.id)).sort((a, b) => a.id.localeCompare(b.id)) }));
}
export class ApplicationControl {
    constructor(readonly store: Store, readonly queue: Queue, readonly executor?: Executor) { }
    pause(withinTransaction = false): {
        paused: boolean;
        note: string;
    } { if (!withinTransaction)
        return this.store.tx(() => this.pause(true)); this.store.set('enabled', false); this.store.run("DELETE FROM meta WHERE key LIKE 'resume:%'"); return { paused: true, note: 'Existing effects continue reconciliation' }; }
    resumeSummary(at = now()) {
        const code = randomBytes(16).toString('hex');
        this.store.set('resume:' + hash(code), { expires: new Date(Date.parse(at) + 300000).toISOString(),generation:this.store.get('telegramBinding')?.generation??null });
        return { code, summary: 'Riprendi le decisioni automatiche su fee e rebalance nel mandato attuale, con budget, riserva e controlli aggiornati. Gli effetti incerti vengono riconciliati senza ripetere i pagamenti.' };
    }
    resume(code: string, at = now()) {
        return this.store.tx(() => {
            const key = 'resume:' + hash(code), receipt = this.store.get(key);
            if (!receipt || receipt.expires <= at || receipt.generation!==(this.store.get('telegramBinding')?.generation??null))
                throw Error('Resume confirmation expired');
            const was = this.store.get('enabled');
            this.store.set('enabled', true);
            try {
                this.store.assertDispatchReady(at);
                const snapshot = this.store.get<Snapshot>('snapshot');
                if (!snapshot?.synced || !Number.isFinite(Date.parse(snapshot.at)) || (this.store.get('expectedIdentity') && snapshot.identity !== this.store.get('expectedIdentity')) || Date.parse(snapshot.at) > Date.parse(at) || Date.parse(at) - Date.parse(snapshot.at) > 60000)
                    throw Error('Fresh synchronized snapshot required');
            }
            catch (error) {
                this.store.set('enabled', was);
                throw error;
            }
            this.store.run('DELETE FROM meta WHERE key=?', key);
            return { enabled: true };
        });
    }
    admit(requestId: string, message: string, source: 'owner' | 'telegram', analysis = false, purpose?: 'qualification' | 'economic' | 'general', scope = '') {
        return this.store.tx(() => this.admitWithinTransaction(requestId, message, source, analysis, purpose, scope));
    }
    /** Caller owns Store.tx, so transport intake commits with capability/turn receipts. */
    admitWithinTransaction(requestId: string, message: string, source: 'owner' | 'telegram', analysis = false, purpose?: 'qualification' | 'economic' | 'general', scope = '') {
        const review = /\b(approv|review|propos|propon|valut.*prima|conferm)/i.test(message);
        const existing = this.store.one('SELECT id FROM jobs WHERE request_id=?', requestId);
        const job = this.queue.enqueueWithinTransaction({ requestId, kind: analysis ? 'analysis' : 'chat', origin: purpose === 'qualification' ? 'qualification' : source, scope, purpose: purpose ?? (analysis ? 'economic' : 'general'), payload: { message } });
        if (!existing) this.store.set('jobRuntimeVersion:' + job.id, runtimeDetectorVersion);
        if (!existing) this.store.set('jobCapability:' + job.id, purpose === 'qualification' ? 'read_only_qualification' : analysis ? 'read_only_research' : review ? 'guarded_manual_proposal' : source === 'telegram' ? 'read_only_chat' : 'financial_guarded');
        return job;
    }

    createProposal(p: Proposal, jobId: string, at = now()) {
        if (this.store.get('jobCapability:' + jobId) !== 'guarded_manual_proposal')
            throw Error('Manual proposal capability required');
        if (!['fee_change', 'rebalance'].includes(p.kind))
            throw Error('Unsupported manual proposal');
        const snapshot = this.store.get<Snapshot>('snapshot');
        if (!snapshot)
            throw Error('Snapshot unavailable');
        const content = json(scrub(p)), digest = hash(content), key = hash(jobId + ':' + digest);
        const originGeneration=this.store.get('jobTelegramGeneration:'+jobId);
        if(originGeneration&&originGeneration!==this.store.get('telegramBinding')?.generation)throw Error('Proposal request authority revoked');
        this.store.tx(()=>{
            const inserted=this.store.run("INSERT OR IGNORE INTO owner_proposals VALUES(?,?,?,?,?,'pending',?,NULL,NULL,NULL,?)", key, at, content, digest, approvalState(snapshot, p), new Date(Date.parse(at) + 300000).toISOString(), jobId);
            if(inserted.changes===1)this.store.set('proposalAuthority:'+key,{generation:this.store.get('telegramBinding')?.generation??null});
        });
        return this.proposal(key);
    }
    proposal(key: string) { const r = this.store.one('SELECT * FROM owner_proposals WHERE id=?', key); return r ? { ...r, content: JSON.parse(r.content) } : undefined; }
    proposals() { return this.store.all('SELECT id FROM owner_proposals ORDER BY created_at DESC LIMIT 50').map(r => this.proposal(r.id)); }
    validate(key: string, s: Snapshot, at = now()) {
        const r = this.proposal(key);
        const authority=this.store.get('proposalAuthority:'+key);
        if(!authority||authority.generation!==(this.store.get('telegramBinding')?.generation??null))throw Error('Proposal authority revoked');
        if (!r || !['pending', 'executing'].includes(r.status) || r.content_digest !== hash(json(r.content)) || !r.expires_at || r.expires_at <= at || r.state_digest !== approvalState(s, r.content))
            throw Error('Proposal expired or conditions changed; create a fresh proposal');
        this.store.assertDispatchReady(at);
        if(!s.synced||!Number.isFinite(Date.parse(s.at))||Date.parse(s.at)>Date.parse(at)||Date.parse(at)-Date.parse(s.at)>60000)throw Error('Fresh synchronized snapshot required');
        this.store.reserve(r.content,forecast(this.store,r.content,s),s,at,undefined,true);
    }
    reject(key: string) { return this.store.run("UPDATE owner_proposals SET status='rejected' WHERE id=? AND status='pending'", key).changes === 1; }
    async approve(key: string, at = now()) {
        if (!this.executor)
            throw Error('Executor unavailable');
        const consumed = this.store.tx(() => {
            const r = this.proposal(key);
            if (!r || r.status !== 'pending')
                return false;
            try {
                this.validate(key, this.store.get<Snapshot>('snapshot')!, at);
            }
            catch (error) {
                this.store.run("UPDATE owner_proposals SET status='invalidated' WHERE id=?", key);
                return { error };
            }
            this.store.run("UPDATE owner_proposals SET status='executing',intent_at=? WHERE id=? AND status='pending'", at, key);
            return true;
        });
        if (typeof consumed === 'object')
            throw consumed.error;
        if (!consumed)
            return { consumed: false, proposal: this.proposal(key) };
        const p = this.proposal(key)!.content;
        try {
            const result = await this.executor.execute(p, { validate: s => this.validate(key, s), reserved: operation => this.store.run('UPDATE owner_proposals SET operation_id=? WHERE id=?', operation, key) });
            this.store.run("UPDATE owner_proposals SET status='executed',result=? WHERE id=?", json(result), key);
            return { consumed: true, result };
        }
        catch (error) {
            this.store.run("UPDATE owner_proposals SET status=CASE WHEN operation_id IS NULL THEN 'invalidated' ELSE 'reconcile_required' END,result=? WHERE id=?", json({ error: 'Execution blocked or requires reconciliation; inspect operation receipt' }), key);
            throw error;
        }
    }
    recover() { this.store.run("UPDATE owner_proposals SET status='reconcile_required' WHERE status='executing'"); }
}
