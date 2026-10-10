import { randomBytes } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync, chmodSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ApplicationControl } from './application-control.js';
import { Store } from './store.js';
import { hash, json, now, day, scrub } from './domain.js';
export interface TelegramTransport {
    call(method: string, body: unknown, signal?: AbortSignal): Promise<any>;
}
export function telegramText(text: string) { return String(scrub(text)).replace(/\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/g, '[REDACTED]').replace(/\blnbc[a-z0-9]+\b/gi, '[REDACTED]').slice(0, 3500); }
export function romeHour(at: string) { return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', hour: '2-digit', hourCycle: 'h23' }).format(new Date(at))); }
export class Telegram {
    readonly tokenPath: string;
    private transport?: TelegramTransport;
    private abort = new AbortController();
    private running = false;
    constructor(readonly store: Store, readonly control: ApplicationControl, directory: string, transport?: TelegramTransport) { this.tokenPath = join(directory, 'telegram.secret'); this.transport = transport; }
    configure(token: string) {
        if (typeof token !== 'string' || !/^\d{6,12}:[A-Za-z0-9_-]{20,}$/.test(token))
            throw Error('Invalid bot token');
        // Commit the authority fence before touching credentials. A crash at any
        // filesystem boundary restarts unpaired and cannot reuse the old bot.
        this.revoke();
        this.store.tx(()=>{
            this.store.set('telegramBotGeneration',randomBytes(12).toString('hex'));
            this.store.set('telegramTokenTransition',true);
            this.store.set('telegramConfigured',false);
            this.store.set('telegramCursor',0);
            this.store.run('DELETE FROM telegram_updates');
        });
        const temporary=this.tokenPath+'.new';
        writeFileSync(temporary,token,{mode:0o600});
        chmodSync(temporary,0o600);
        renameSync(temporary,this.tokenPath);
        this.store.tx(()=>{this.store.set('telegramConfigured',true);this.store.set('telegramTokenTransition',false);});
    }
    private client(): TelegramTransport {
        if (this.transport)
            return this.transport;
        const token = readFileSync(this.tokenPath, 'utf8').trim();
        return { call: async (method, body, signal) => {
                try {
                    const response = await fetch('https://api.telegram.org/bot' + token + '/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: json(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(35000)]) : AbortSignal.timeout(35000) });
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
    status() { const binding = this.store.get('telegramBinding'); return { configured: this.store.get('telegramTokenTransition')!==true&&(this.store.get('telegramConfigured') === true || existsSync(this.tokenPath)), paired: !!binding, owner: binding ?? null, candidate: this.store.get('telegramCandidate') ?? null, pairingExpires: this.store.get('telegramPairing')?.expires ?? null, failures: this.store.all("SELECT event_id,status,attempts,error FROM telegram_outbox WHERE status IN ('failed','uncertain') ORDER BY created_at DESC LIMIT 20"), pending: this.store.one("SELECT count(*) n FROM telegram_outbox WHERE status='pending'").n, lastPoll: this.store.get('telegramLastPoll') ?? null, error: this.store.get('telegramError') ?? null }; }
    pairing(at = now()) {
        if (!this.status().configured)
            throw Error('Configure bot token first');
        const code = randomBytes(18).toString('base64url');
        this.store.tx(() => { this.store.set('telegramPairing', { digest: hash(code), expires: new Date(Date.parse(at) + 300000).toISOString(), attempts: 0 }); this.store.set('telegramCandidate', null); });
        return { code, expires: new Date(Date.parse(at) + 300000).toISOString() };
    }
    confirm(userId: number, at = now()) {
        return this.store.tx(() => { const candidate = this.store.get('telegramCandidate'); if (!candidate || candidate.userId !== userId || candidate.expires <= at)
            throw Error('Pairing candidate mismatch or expired'); this.store.run("UPDATE telegram_outbox SET status='cancelled' WHERE status='pending'"); this.store.run("UPDATE owner_proposals SET status='revoked' WHERE status='pending' OR (status='executing' AND operation_id IS NULL)");this.store.run("DELETE FROM meta WHERE key LIKE 'resume:%' OR key LIKE 'telegramCallback:%'"); this.store.set('telegramBinding', { userId, chatId: candidate.chatId, username: candidate.username, since: at, generation: randomBytes(16).toString('hex') }); this.store.set('telegramPairing', null); this.store.set('telegramCandidate', null); return this.status(); });
    }
    revoke() { this.store.tx(() => { this.store.set('telegramBinding', null); this.store.set('telegramPairing', null); this.store.set('telegramCandidate', null); this.store.run("DELETE FROM meta WHERE key LIKE 'resume:%' OR key LIKE 'telegramCallback:%'"); this.store.run("UPDATE owner_proposals SET status='revoked' WHERE status='pending' OR (status='executing' AND operation_id IS NULL)"); this.store.run("UPDATE telegram_outbox SET status='cancelled' WHERE status='pending'"); }); return this.status(); }
    removeToken() { this.revoke(); if (existsSync(this.tokenPath))
        unlinkSync(this.tokenPath); this.store.set('telegramConfigured', false); }
    /** Every batch is committed before advertising the offset. No network effect in this transaction. */
    ingest(updates: any[]) { this.store.tx(() => { let cursor = this.store.get<number>('telegramCursor') ?? 0; for (const u of updates) {
        if (!Number.isSafeInteger(u.update_id) || u.update_id < 0)
            continue;
        const m = u.message ?? u.callback_query?.message, from = u.message?.from ?? u.callback_query?.from;
        let text = String(u.message?.text ?? '');
        const start = /^\/start\s+(\S+)\s*$/.exec(text);
        const safe = { generation: this.store.get('telegramBinding')?.generation, update_id: u.update_id, chatId: m?.chat?.id, chatType: m?.chat?.type, userId: from?.id, username: telegramText(String(from?.username ?? '')), text: start ? '/start' : telegramText(text), date: m?.date, codeDigest: start ? hash(start[1]!) : undefined, callback: String(u.callback_query?.data ?? '').slice(0, 64) };
        this.store.run('INSERT OR IGNORE INTO telegram_updates(update_id,body) VALUES(?,?)', u.update_id, json(safe));
        cursor = Math.max(cursor, u.update_id + 1);
    } this.store.set('telegramCursor', cursor); }); }
    enqueue(eventId: string, text: string, kind = 'reply', proposalId?: string, at = now(),generation=this.store.get('telegramBinding')?.generation??null) { if(generation!==(this.store.get('telegramBinding')?.generation??null))return;this.store.run("INSERT OR IGNORE INTO telegram_outbox(event_id,created_at,kind,text,proposal_id,generation) VALUES(?,?,?,?,?,?)", eventId, at, kind, telegramText(text), proposalId ?? null, generation); }
    private callback(eventId: string, value: {action:string;code?:string;id?:string},generation=this.store.get('telegramBinding')?.generation??null) { const key = hash(eventId).slice(0, 32); this.store.set('telegramCallback:' + key, {...value,generation}); return key; }
    async process(at = now()) {
        for (const row of this.store.all("SELECT * FROM telegram_updates WHERE status='pending' ORDER BY update_id LIMIT 50")) {
            const u = JSON.parse(row.body), event = 'update:' + row.update_id;
            try {
                if (u.chatType !== 'private' || !Number.isSafeInteger(u.userId) || u.userId !== u.chatId) {
                    this.store.run("UPDATE telegram_updates SET status='ignored' WHERE update_id=?", row.update_id);
                    continue;
                }
                if (u.text === '/start' && u.codeDigest) {
                    this.store.tx(() => { const p = this.store.get('telegramPairing'); if (!p || p.expires <= at || p.attempts >= 5)
                        return; p.attempts++; this.store.set('telegramPairing', p); if (p.digest !== u.codeDigest)
                        return; this.store.set('telegramCandidate', { userId: u.userId, chatId: u.chatId, username: u.username, expires: p.expires }); this.store.set('telegramPairing', null); });
                    this.store.run("UPDATE telegram_updates SET status='done' WHERE update_id=?", row.update_id);
                    continue;
                }
                const binding = this.store.get('telegramBinding');
                if (!binding || binding.generation !== u.generation || binding.userId !== u.userId || binding.chatId !== u.chatId) {
                    this.store.run("UPDATE telegram_updates SET status='ignored' WHERE update_id=?", row.update_id);
                    continue;
                }
                if (u.date && (u.date < Math.floor(Date.parse(binding.since) / 1000) || Date.parse(at) / 1000 - u.date > 300 || u.date > Date.parse(at) / 1000 + 60)) {
                    this.store.run("UPDATE telegram_updates SET status='ignored',error='Stale incoming command' WHERE update_id=?", row.update_id);
                    continue;
                }
                let answer = '';
                if (u.callback) {
                    const value = this.store.get('telegramCallback:' + u.callback);
                    if (!value||value.generation!==binding.generation)
                        answer = 'Pulsante scaduto o già utilizzato.';
                    else if (value.action === 'resume') {
                        this.store.run("UPDATE telegram_updates SET status='done' WHERE update_id=?", row.update_id);
                        this.control.resume(value.code, at);
                        answer = 'Autonomia ripresa.';
                    }
                    else if (value.action === 'approve') {
                        const result = await this.control.approve(value.id, at);
                        answer = result.consumed ? 'Proposta accettata; verifica la ricevuta operativa nella web app.' : 'Proposta già utilizzata; nessuna seconda esecuzione.';
                    }
                    else {
                        this.control.reject(value.id);
                        answer = 'Proposta rifiutata.';
                    }
                }
                else if (u.text === '/pause') {
                    this.store.tx(() => { this.control.pause(true); this.enqueue(event, 'Autonomia sospesa. Gli effetti esistenti continuano la riconciliazione.', 'reply', undefined, at,u.generation); this.store.run("UPDATE telegram_updates SET status='done' WHERE update_id=?", row.update_id); });
                    continue;
                }
                else if (u.text === '/resume') {
                    this.store.tx(() => { const summary = this.control.resumeSummary(at); this.callback(event, { action: 'resume', code: summary.code }); this.enqueue(event, summary.summary, 'reply', undefined, at,u.generation); this.store.run("UPDATE telegram_updates SET status='done' WHERE update_id=?", row.update_id); });
                    continue;
                }
                else if (u.text === '/status') {
                    answer = `Autonomia: ${this.store.get('enabled') ? 'attiva' : 'sospesa'}. Nodo: ${this.store.get('bootstrapReady') ? 'pronto' : 'bloccato'}. Richieste pendenti: ${this.control.queue.metrics(at).states.filter(r => ['queued', 'running', 'waiting'].includes(r.state)).reduce((n, r) => n + r.count, 0)}. Dettagli e budget: impostazioni web.`;
                }
                else if (u.text === '/proposals') {
                    const proposals = this.control.proposals().filter(p => p.status === 'pending');
                    answer = proposals.length ? `${proposals.length} proposte pendenti. Apri la web app per i dettagli.` : 'Nessuna proposta pendente.';
                    for (const p of proposals)
                        this.enqueue('proposal:' + p.id, this.summary(p), 'proposal', p.id, at,u.generation);
                }
                else if (u.text === '/help') {
                    answer = '/status /analyze /pause /resume /proposals /help. La chat consente analisi; chiedi esplicitamente una proposta da approvare. Mandato, permessi, token e collegamento si gestiscono nelle impostazioni web.';
                }
                else {
                    const message = u.text.startsWith('/analyze') ? u.text.slice(8).trim() || 'Analizza economia del nodo e blocchi attuali' : u.text;
                    if (!message.trim())
                        throw Error('Empty request');
                    const job = this.control.admit('telegram:' + (this.store.get('telegramBotGeneration') ?? 'initial') + ':' + row.update_id, message, 'telegram', u.text.startsWith('/analyze'));
                    this.store.set('jobTelegramGeneration:' + job.id, binding.generation);
                    answer = `Richiesta registrata nella cronologia condivisa (${job.id}). Riceverai qui il risultato.`;
                }
                this.store.tx(() => { if (answer)
                    this.enqueue(event, answer, 'reply', undefined, at,u.generation); this.store.run("UPDATE telegram_updates SET status='done',error=NULL WHERE update_id=?", row.update_id); });
            }
            catch {
                this.store.tx(() => { this.enqueue(event, 'Richiesta bloccata o scaduta. Verifica lo stato nella web app e crea una nuova richiesta.', 'reply', undefined, at,u.generation); this.store.run("UPDATE telegram_updates SET status='done',error='Request blocked; inspect web receipt' WHERE update_id=?", row.update_id); });
            }
        }
    }
    summary(p: any) { return `Proposta ${p.content.kind}: ${p.content.source || 'policy'} → ${p.content.target}. Importo ${p.content.amountSat} sat; costo massimo ${p.content.maxFeeMsat} msat${p.content.newPpm === undefined ? '' : `; nuova fee ${p.content.newPpm} ppm`}. Motivo: ${telegramText(p.content.whyAct)}. Valida per 5 minuti dalla consegna. Approva o rifiuta; restano attivi i controlli di sicurezza.`; }
    capture(at = now()) {
        if (!this.store.get('telegramBinding'))
            return;
        for (const j of this.store.all("SELECT j.* FROM jobs j JOIN job_events e ON e.job_id=j.id AND e.type='accepted' WHERE json_extract(e.details,'$.origin')='telegram' AND j.created_at>=? AND j.state IN ('completed','failed')", this.store.get('telegramBinding').since)) {
            if (this.store.get('jobTelegramGeneration:' + j.id) !== this.store.get('telegramBinding').generation)
                continue;
            const result = JSON.parse(j.result ?? '{}');
            this.enqueue('answer:' + j.id, j.state === 'completed' ? telegramText(result.answer ?? 'Richiesta completata; dettagli nella web app.') : 'Richiesta non completata; verifica la cronologia condivisa nella web app.', 'reply', undefined, at);
        }
        for (const o of this.store.all("SELECT id,state FROM operations WHERE at>=? AND state IN ('SUCCEEDED','FAILED','uncertain','in_flight')", this.store.get('telegramBinding').since))
            this.enqueue('operation:' + o.id + ':' + o.state, `Operation ${o.id}: ${o.state}. Dettagli nella web app.`, o.state === 'uncertain' ? 'critical' : 'ordinary', undefined, at);
        const blockers = [this.store.get('integrityBlocker'), this.store.get('agent')?.status === 'unavailable' ? 'Autenticazione o quota agente richiede verifica' : null, this.store.one("SELECT id FROM operations WHERE state='uncertain'") ? 'Esito finanziario incerto; richiesta riconciliazione, nessun replay' : null, ...(this.store.get<any[]>('blockers') ?? [])].filter(Boolean).map(telegramText);
        this.store.tx(()=>{
            const generation=this.store.get('telegramBinding').generation;
            const previous=this.store.get('telegramIncident');
            const previousActive=previous?.generation===generation&&typeof previous.active==='object'?previous.active:{};
            const active:Record<string,string>={};
            for(const blocker of blockers){const digest=hash(blocker);active[digest]=previousActive[digest]??randomBytes(12).toString('hex');}
            if(blockers.length)this.enqueue('blockers:'+generation+':'+hash(json(Object.entries(active).sort())),`Intervento richiesto: ${blockers.join('; ')}`,'critical',undefined,at);
            this.store.set('telegramIncident',{generation,active});
        });
        for (const p of this.control.proposals().filter(p => p.status === 'pending')) {
            const key = 'proposal:' + p.id;
            if (!this.store.one('SELECT event_id FROM telegram_outbox WHERE event_id=?', key)) {
                this.store.run('UPDATE owner_proposals SET expires_at=NULL WHERE id=?', p.id);
                this.enqueue(key, this.summary(p), 'proposal', p.id, at);
            }
        }
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
    async deliver(at = now()) {
        const binding = this.store.get('telegramBinding');
        if (!binding)
            return;
        const hour = romeHour(at);
        const botGeneration=this.store.get('telegramBotGeneration')??null;
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
            let buttons: any;
            if (r.proposal_id) {
                buttons = { inline_keyboard: [[{ text: 'Approva', callback_data: this.callback(r.event_id + ':approve', { action: 'approve', id: r.proposal_id }) }, { text: 'Rifiuta', callback_data: this.callback(r.event_id + ':reject', { action: 'reject', id: r.proposal_id }) }]] };
            }
            else if (this.store.get('telegramCallback:' + hash(r.event_id).slice(0, 32))?.action === 'resume')
                buttons = { inline_keyboard: [[{ text: 'Riprendi con il mandato attuale', callback_data: hash(r.event_id).slice(0, 32) }]] };
            // Re-read at every dispatch boundary: an earlier await may have
            // revoked this batch or rotated the token. Never mix identities.
            const currentBinding=this.store.get('telegramBinding');
            const currentRow=this.store.one('SELECT status,generation FROM telegram_outbox WHERE event_id=?',r.event_id);
            if(!currentBinding||currentBinding.generation!==binding.generation||currentBinding.chatId!==binding.chatId||(this.store.get('telegramBotGeneration')??null)!==botGeneration||currentRow?.status!=='pending'||currentRow.generation!==binding.generation)break;
            // A crash after this receipt is uncertain, not silently retried after restart.
            this.store.run("UPDATE telegram_outbox SET status='sending',attempts=attempts+1 WHERE event_id=?", r.event_id);
            try {
                const message = await this.client().call('sendMessage', { chat_id: binding.chatId, text: r.text, reply_markup: buttons }, this.abort.signal);
                this.store.tx(() => { this.store.run("UPDATE telegram_outbox SET status='sent',message_id=?,error=NULL WHERE event_id=?", message.message_id, r.event_id); if (r.proposal_id && this.store.get('telegramBinding')?.generation === binding.generation)
                    this.store.run("UPDATE owner_proposals SET expires_at=? WHERE id=? AND status='pending'", new Date(Date.parse(now()) + 300000).toISOString(), r.proposal_id); });
            }
            catch (error) {
                if (r.proposal_id)
                    this.store.run('UPDATE owner_proposals SET expires_at=NULL WHERE id=?', r.proposal_id);
                const attempts = r.attempts + 1, retry = (error as any).retryAfter, rejected = (error as any).rejected === true;
                const changed=this.store.get('telegramBinding')?.generation!==binding.generation||(this.store.get('telegramBotGeneration')??null)!==botGeneration;
                const status = changed?'uncertain':attempts >= 5 ? 'failed' : rejected ? 'pending' : 'uncertain';
                this.store.run('UPDATE telegram_outbox SET status=?,next_at=?,error=? WHERE event_id=?', status, new Date(Date.parse(at) + Math.max(Number(retry) || 0, 2 ** attempts) * 1000).toISOString(), rejected ? 'API rejection; bounded retry' : 'Delivery uncertain; inspect Telegram before manual retry', r.event_id);
            }
        }
    }
    recover() { this.store.run("UPDATE telegram_outbox SET status='uncertain',error='Interrupted send; delivery uncertain, no automatic replay' WHERE status='sending'"); this.control.recover(); }
    async loop() { if (this.running)
        return; this.running = true; this.recover(); while (!this.abort.signal.aborted) {
        try {
            if (this.status().configured && (this.store.get('telegramBinding') || this.store.get('telegramPairing'))) {
                const botGeneration = this.store.get('telegramBotGeneration');
                if (this.store.get('telegramLastPoll') && Date.now() - Date.parse(this.store.get<string>('telegramLastPoll') ?? '') > 7 * 86400000)
                    this.store.set('telegramCursor', 0);
                const updates = await this.client().call('getUpdates', { offset: this.store.get('telegramCursor') ?? 0, timeout: 25, allowed_updates: ['message', 'callback_query'] }, this.abort.signal);
                if (botGeneration !== this.store.get('telegramBotGeneration'))
                    continue;
                this.ingest(updates);
                this.store.set('telegramLastPoll', now());
                this.store.set('telegramError', null);
                await this.process();
                this.capture();
                await this.deliver();
            }
            else
                await this.wait(1000);
        }
        catch {
            if (!this.abort.signal.aborted) {
                this.store.set('telegramError', 'Telegram non disponibile; web e scheduler autonomo continuano');
                await this.wait(5000);
            }
        }
    } this.running = false; }
    private wait(ms: number) { return new Promise<void>(resolve => { if (this.abort.signal.aborted)
        return resolve(); const done = () => { clearTimeout(timer); this.abort.signal.removeEventListener('abort', done); resolve(); }; const timer = setTimeout(done, ms); this.abort.signal.addEventListener('abort', done, { once: true }); }); }
    stop() { this.abort.abort(); }
}
