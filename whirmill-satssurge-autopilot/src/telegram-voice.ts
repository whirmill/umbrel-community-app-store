import { constants, openSync, closeSync, fstatSync, readFileSync, writeFileSync, fsyncSync, renameSync, unlinkSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { Store } from './store.js';
import { hash, json, now } from './domain.js';
import type { Turn } from './telegram-turns.js';

export const VOICE_PINS = { runtime: 'd1be6fde11ac6e0407606b4e42fe72d34add8037', model: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe', language: 'it', decoder: 'ffmpeg-7.1.1-ogg-opus-pcm16-v1', protocol: 1 } as const;
export const VOICE_BYTES = 10 * 1024 * 1024;
export interface VoiceInput { version: 1; messageId: number; fileId: string; uniqueId: string; duration: number; mime: string; bytes: number; }
export interface VoiceReceipt {
    version: 1; id: string; requestId: string; updateId: number; generation: string; botGeneration: unknown; chatId: number; userId: number;
    pins: typeof VOICE_PINS; bodyHash: string; acceptedAt: string; input: VoiceInput; target?: Turn; state: 'accepted'|'downloading'|'transcribing'|'transcript_ready'|'choice_pending'|'admitted'|'held'|'failed'|'cancelled';
    attempt?: string; audioHash?: string; requestHash?: string; transcript?: string; transcriptHash?: string; jobId?: string; correctionId?: string; code?: string; release?: 'confirmed'|'unknown';
}
export function sanitizeVoice(message: any): VoiceInput | undefined {
    if (!message?.voice) return undefined;
    const v = message.voice;
    return { version: 1, messageId: Number.isSafeInteger(message.message_id) ? message.message_id : -1, fileId: typeof v.file_id === 'string' ? v.file_id.slice(0, 512) : '', uniqueId: typeof v.file_unique_id === 'string' ? v.file_unique_id.slice(0, 256) : '', duration: Number.isSafeInteger(v.duration) ? v.duration : -1, mime: typeof v.mime_type === 'string' ? v.mime_type.slice(0, 100) : '', bytes: Number.isSafeInteger(v.file_size) ? v.file_size : -1 };
}
export function validVoice(v: VoiceInput): boolean {
    return v.version === 1 && Number.isSafeInteger(v.messageId) && v.messageId > 0 && /^[A-Za-z0-9_-]{1,512}$/.test(v.fileId) && /^[A-Za-z0-9_-]{1,256}$/.test(v.uniqueId) && Number.isSafeInteger(v.duration) && v.duration > 0 && v.duration <= 120 && (v.mime === 'audio/ogg' || v.mime === '') && Number.isSafeInteger(v.bytes) && v.bytes > 0 && v.bytes <= VOICE_BYTES;
}
export function voicePath(path: unknown): string {
    if (typeof path !== 'string' || !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.[A-Za-z0-9]+$/.test(path) || path.length > 512) throw Error('voice_file_path');
    return path;
}
function regular(path: string, cap: number): Buffer {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const s = fstatSync(fd); if (!s.isFile() || s.nlink !== 1 || s.uid !== process.getuid?.() || s.size > cap || (s.mode & 0o077)) throw Error('voice_file_invalid'); return readFileSync(fd); } finally { closeSync(fd); }
}
function atomic(directory: string, name: string, data: string | Buffer) {
    const temp = join(directory, name + '.tmp-' + randomBytes(8).toString('hex')), destination = join(directory, name);
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
    // Every destination is generated and attempt scoped, never an externally supplied path.
    renameSync(temp, destination); const dir = openSync(directory, constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(dir); } finally { closeSync(dir); }
}
export interface VoiceWorker {
    ready(): boolean;
    transcribe(receipt: VoiceReceipt, audio: Buffer | undefined, signal: AbortSignal, commit: (patch: Partial<VoiceReceipt>) => void): Promise<{ text: string; release: 'confirmed' }>;
    cancel(receipt: VoiceReceipt): Promise<boolean>;
}
export interface VoiceTransport { getFile(fileId: string, signal: AbortSignal): Promise<any>; download(path: string, signal: AbortSignal): Promise<Response>; }
export function telegramVoiceTransport(call: (body: unknown, signal: AbortSignal) => Promise<any>, token: () => string): VoiceTransport {
    return { getFile: (fileId, signal) => call({ file_id: fileId }, signal), download: async (path, signal) => {
        try { return await fetch('https://api.telegram.org/file/bot' + token() + '/' + voicePath(path), { signal, redirect: 'error' }); }
        catch { throw Error('voice_download_unavailable'); }
    } };
}
async function pause(signal?: AbortSignal) { await new Promise<void>(resolve => { if (signal?.aborted) return resolve(); const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }; const timer = setTimeout(done, 100); signal?.addEventListener('abort', done, { once: true }); }); }
export class FilesystemVoiceWorker implements VoiceWorker {
    constructor(readonly directory: string) { }
    private root() { const s = lstatSync(this.directory); if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid?.() || (s.mode & 0o077)) throw Error('voice_spool_invalid'); }
    ready() { try { this.root(); const r = JSON.parse(regular(join(this.directory, 'ready.json'), 4096).toString()); return r.protocol === 1 && r.runtime === VOICE_PINS.runtime && r.model === VOICE_PINS.model && r.language === 'it' && r.decoder === VOICE_PINS.decoder && Date.now() - r.at >= 0 && Date.now() - r.at < 5000 && r.state === 'ready'; } catch { return false; } }
    async transcribe(r: VoiceReceipt, audio: Buffer | undefined, signal: AbortSignal, commit: (patch: Partial<VoiceReceipt>) => void) {
        this.root(); let requestHash = r.requestHash;
        if (!requestHash) {
            if (!audio || !r.attempt || audio.length > VOICE_BYTES) throw Error('voice_input_invalid');
            const audioHash = createHash('sha256').update(audio).digest('hex');
            // Bound retained storage even if a failed consumer left old artifacts.
            let total = 0; for (const n of readdirSync(this.directory)) { const s = lstatSync(join(this.directory,n)); if (s.isFile()) total += s.size; }
            if (total + audio.length > 90 * 1024 * 1024) throw Error('voice_spool_capacity');
            atomic(this.directory, r.attempt + '.ogg', audio);
            const request = json({ ...VOICE_PINS, attempt: r.attempt, audioHash, bytes: audio.length, duration: r.input.duration }); requestHash = hash(request);
            // Persist intent before publishing. Restart reconciles output or cancels; never assumes an expired worker exited.
            commit({ audioHash, requestHash, state: 'transcribing', release: 'unknown' });
            atomic(this.directory, r.attempt + '.request.json', request);
        }
        const deadline = Date.now() + 145000;
        while (Date.now() < deadline && !signal.aborted) {
            const result = this.result(r.attempt!, requestHash);
            if (result) { if (result.status !== 'ok') throw Error(result.status === 'cancelled' ? 'voice_cancelled' : 'voice_transform_failed'); return { text: result.text as string, release: 'confirmed' as const }; }
            await pause(signal);
        }
        const closed = await this.cancel({ ...r, requestHash });
        throw Error(closed ? 'voice_timeout_closed' : 'voice_release_unknown');
    }
    private result(attempt: string, requestHash: string) {
        this.root();
        const path = join(this.directory, attempt + '.result.json');
        try {
            const r = JSON.parse(regular(path, 65536).toString());
            if (r.attempt !== attempt || r.requestHash !== requestHash || r.runtime !== VOICE_PINS.runtime || r.model !== VOICE_PINS.model || r.language !== 'it' || r.decoder !== VOICE_PINS.decoder || r.release !== 'confirmed' || !['ok','failed','cancelled'].includes(r.status) || (r.status === 'ok' && (typeof r.text !== 'string' || !r.text.trim() || r.text.length > 16000 || hash(r.text) !== r.transcriptHash))) throw Error('voice_result_invalid');
            return r;
        } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw Error('voice_result_invalid'); }
    }
    async cancel(r: VoiceReceipt) {
        if (!r.attempt || !r.requestHash) return true;
        try { this.root(); atomic(this.directory,r.attempt + '.cancel.json',json({attempt:r.attempt,requestHash:r.requestHash}));
            const until = Date.now() + 3000; do { if (this.result(r.attempt,r.requestHash)) return true; await pause(); } while (Date.now() < until);
        } catch { } return false;
    }
    cleanup(r: VoiceReceipt) {
        if (!r.attempt || r.release !== 'confirmed') return;
        for (const suffix of ['.ogg','.request.json','.result.json','.cancel.json']) try { unlinkSync(join(this.directory,r.attempt+suffix)); } catch { }
    }
}
export class TelegramVoice {
    private task?: Promise<void>;
    private controller?: AbortController;
    private closed = false;
    private activeId?: string;
    constructor(readonly store: Store, readonly transport: VoiceTransport, readonly worker: VoiceWorker,
        readonly authorized: (r: VoiceReceipt) => boolean, readonly admit: (r: VoiceReceipt) => void, readonly notice: (r: VoiceReceipt, code: string) => void) { }
    receipts(): VoiceReceipt[] { return this.store.all("SELECT value FROM meta WHERE key LIKE 'telegramVoice:%'").map(r => JSON.parse(r.value)); }
    private save(r: VoiceReceipt) { this.store.set('telegramVoice:' + r.id, r); }
    accept(u: any, body: string, target?: Turn): string | undefined {
        const id = hash(json([u.botGeneration,u.update_id])), old = this.store.get<VoiceReceipt>('telegramVoice:' + id);
        if (old) return undefined;
        if (!validVoice(u.voice) || !Number.isSafeInteger(u.date) || u.date <= 0) return 'voice_metadata_invalid';
        if (!this.worker.ready()) return 'voice_unavailable';
        if (this.receipts().filter(r => r.generation === u.generation && ['accepted','downloading','transcribing','transcript_ready'].includes(r.state)).length >= 8) return 'voice_capacity';
        const r: VoiceReceipt = { version:1,pins:VOICE_PINS,id,requestId:'telegram:' + (u.botGeneration ?? 'initial') + ':' + u.update_id,updateId:u.update_id,generation:u.generation,botGeneration:u.botGeneration,chatId:u.chatId,userId:u.userId,bodyHash:hash(body),acceptedAt:now(),input:u.voice,target:target ? structuredClone(target) : undefined,state:'accepted' };
        if (!this.authorized(r)) return 'voice_authority'; this.save(r); return undefined;
    }
    blocks(updateId: number) { return this.receipts().some(r => r.updateId < updateId && ['accepted','downloading','transcribing','transcript_ready'].includes(r.state)); }
    private earlierPendingText(r: VoiceReceipt) {
        // The ingress loop remains free to handle Stop/callbacks. Yield the
        // voice pump to earlier pending text instead of waiting inside it.
        return !!this.store.one(`SELECT update_id FROM telegram_updates
            WHERE status='pending' AND update_id<?
              AND json_extract(body,'$.generation')=?
              AND json_extract(body,'$.botGeneration') IS ?
              AND json_extract(body,'$.chatId')=?
              AND json_extract(body,'$.voice') IS NULL
              AND json_extract(body,'$.callbackId') IS NULL
              AND json_extract(body,'$.stoppedDraft') IS NULL
              AND length(json_extract(body,'$.text'))>0 LIMIT 1`, r.updateId,r.generation,r.botGeneration,r.chatId);
    }
    kick() { if (this.task || this.closed) return; this.task = this.pump().finally(() => { this.task = undefined; }); }
    async drain() { await this.task; return !this.receipts().some(r=>r.release==='unknown'); }
    private fence(r: VoiceReceipt) { if (this.closed || !this.authorized(r) || this.controller?.signal.aborted || this.store.get<VoiceReceipt>('telegramVoice:'+r.id)?.state==='cancelled') throw Error('voice_authority'); }
    private async pump() {
        for (const r of this.receipts().filter(r => ['accepted','downloading','transcribing','transcript_ready'].includes(r.state)).sort((a,b) => a.updateId-b.updateId)) {
            if(this.earlierPendingText(r))break;
            this.activeId = r.id; this.controller = new AbortController(); const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(180000)]);
            const commit = (patch: Partial<VoiceReceipt>) => { this.fence(r); Object.assign(r,patch); this.save(r); };
            try {
                this.fence(r);
                if (r.state !== 'transcript_ready') {
                    let audio: Buffer | undefined;
                    if (r.state === 'transcribing') {
                        // Reopen never starts a replacement for an unproven previous child.
                        const closed = await this.worker.cancel(r); this.fence(r);
                        if (!closed) throw Error('voice_release_unknown');
                    } else {
                        if (!this.worker.ready()) throw Error('voice_unavailable');
                        commit({state:'downloading',attempt:randomBytes(16).toString('hex')});
                        const downloadSignal=AbortSignal.any([signal,AbortSignal.timeout(30000)]);
                        const file = await this.transport.getFile(r.input.fileId, downloadSignal); this.fence(r);
                        if (file?.file_id !== r.input.fileId || file.file_unique_id !== r.input.uniqueId || file.file_size !== r.input.bytes) throw Error('voice_file_invalid');
                        const path = voicePath(file.file_path);
                        const response = await this.transport.download(path, downloadSignal); this.fence(r);
                        if (!response.ok || response.redirected || !response.body) throw Error('voice_download_invalid');
                        const length = response.headers.get('content-length'); if (length && (!/^\d+$/.test(length) || Number(length) !== r.input.bytes)) throw Error('voice_size_invalid');
                        const chunks: Uint8Array[] = []; let size = 0; const reader = response.body.getReader();
                        const stop = () => { void reader.cancel().catch(()=>{}); }; downloadSignal.addEventListener('abort',stop,{once:true});
                        try { while (true) { const part = await reader.read(); this.fence(r); if(downloadSignal.aborted)throw Error('voice_timeout_closed'); if (part.done) break; size += part.value.length; if (size > VOICE_BYTES || size > r.input.bytes) throw Error('voice_size_invalid'); chunks.push(part.value); } }
                        finally { downloadSignal.removeEventListener('abort',stop); await reader.cancel().catch(()=>{}); }
                        if (size !== r.input.bytes) throw Error('voice_size_invalid'); audio = Buffer.concat(chunks);
                    }
                    const result = await this.worker.transcribe(r,audio,signal,commit); this.fence(r);
                    const text = result.text.trim(); if (!text || text.length > 16000 || /\x00/.test(text)) throw Error('voice_transcript_invalid');
                    commit({state:'transcript_ready',transcript:text,transcriptHash:hash(text),release:result.release});
                }
                // New older ingress may have arrived during download/STT.
                // Keep the frozen transcript and target; never retranscribe it.
                if(this.earlierPendingText(r))break;
                this.fence(r); this.store.tx(() => { this.fence(r); this.admit(r); this.save(r); });
            } catch (error) {
                const closed = await this.worker.cancel(r);
                const code = (error as Error).message;
                r.release = closed ? 'confirmed' : 'unknown'; const withdrawn=this.store.get<VoiceReceipt>('telegramVoice:'+r.id)?.code==='voice_owner_cancel'; r.code = withdrawn ? (closed?'voice_cancelled':'voice_release_unknown') : /^voice_[a-z_]+$/.test(code) ? code : 'voice_failed';
                r.state = !this.authorized(r) || this.closed || this.store.get<VoiceReceipt>('telegramVoice:'+r.id)?.state==='cancelled' ? 'cancelled' : closed ? 'failed' : 'held';
                this.save(r); if (!this.closed && this.authorized(r)) this.notice(r,r.code);
            } finally {
                if (this.worker instanceof FilesystemVoiceWorker) this.worker.cleanup(r);
                this.controller = undefined; this.activeId = undefined;
            }
        }
    }
    withdraw(id: string, generation: string) {
        const r=this.store.get<VoiceReceipt>('telegramVoice:'+id);
        if(!r||r.generation!==generation||!this.authorized(r)||!['accepted','downloading','transcribing'].includes(r.state))return false;
        r.state='cancelled';r.code='voice_owner_cancel';r.release=r.attempt?'unknown':'confirmed';this.save(r);
        if(this.activeId===id)this.cancel();return true;
    }
    cancel() { this.controller?.abort(); }
    stop() { this.closed = true; this.cancel(); }
}
