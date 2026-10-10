import { matchedNativeProviderFailure } from './provider-failures.js';
import { readFileSync } from 'node:fs';
import { Store } from './store.js';
import { hash, json, now } from './domain.js';

export const runtimeDetectorVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version as string;
const version = runtimeDetectorVersion;
const facts = {
    job_failed: 'Una richiesta ha una ricevuta terminale failed; la risposta non è completa.',
    turn_interrupted: 'Il turno conversazionale risulta interrotto nella ricevuta persistente.',
    delivery_failed: 'La consegna ha esaurito i tentativi consentiti.',
    delivery_uncertain: 'La consegna è incerta: non è consentito un replay automatico.',
    collector_failed: 'Il collector dichiara ok=false; nuovi dati non sono confermati.',
    source_incompatible: 'La proiezione diagnostica dichiara uno schema o una versione incompatibile.',
    coverage_gap: 'Una fonte qualificata dichiara copertura o acquisizione incompleta; ignoto non significa zero.',
    regression_confirmed: 'Una verifica esplicita del runtime ha confermato una regressione applicativa.',
} as const;
type Fact = keyof typeof facts;
export type RuntimeEvidenceSource = 'job' | 'outbox' | 'collector' | 'lndg' | 'lightningMate';
type Classification = 'app_defect' | 'upstream_transient' | 'authentication' | 'unknown' | 'data_gap';
export interface RuntimeObservation {
    component: 'telegram' | 'agent' | 'collector' | 'diagnostics';
    classification: Classification;
    facts: Fact[];
    impact: 'partial_response' | 'notification_unavailable' | 'data_unavailable' | 'runtime_blocked';
    // Opaque receipt identity only. No payloads, free text, logs or credentials.
    receipt: string;
    observedAt?: string;
    runtimeVersion?: string;
    timeBasis?: 'source' | 'detection';
    affectedVersion?: string;
    admissionVersion?: string;
    /** Trusted source occurrence identity, separate from material evidence and UI samples. */
    occurrenceId?: string;
    snapshotSource?: 'collector' | 'lndg' | 'lightningMate';
}
export interface RuntimeRevision {
    number: number; previous: number | null; fingerprint: string; observation: RuntimeObservation;
    firstAt: string; lastAt: string; observations: number; receipts: string[]; prompt: string;
    delivery?: { eventId: string; generation: string; chatId: number; checksum: string; status: string; messageId?: number };
}
export interface RuntimeIssue { id: string; status: 'open' | 'resolved'; revisions: RuntimeRevision[]; resolvedBy?: string; }
export interface RuntimeArtifact { issueId: string; revision: number; requestLink: string; filename: string; content: string; checksum: string; generation: string; chatId: number; }
const classes = ['app_defect', 'upstream_transient', 'authentication', 'unknown', 'data_gap'];
const components = ['telegram', 'agent', 'collector', 'diagnostics'];
const impacts = ['partial_response', 'notification_unavailable', 'data_unavailable', 'runtime_blocked'];
function validate(o: RuntimeObservation) {
    if (!o || Object.keys(o).some(k => !['component','classification','facts','impact','receipt','observedAt','runtimeVersion','timeBasis','affectedVersion','occurrenceId','snapshotSource','admissionVersion'].includes(k)) ||
        !components.includes(o.component) || !classes.includes(o.classification) || !impacts.includes(o.impact) ||
        !Array.isArray(o.facts) || !o.facts.length || o.facts.length > 8 || o.facts.some(f => !Object.hasOwn(facts, f)) ||
        typeof o.receipt !== 'string' || !/^(?:[a-f0-9-]{16,64}|row:\d{1,16})$/.test(o.receipt))
        throw Error('Only classified allowlisted observations and opaque receipts are accepted');
    if (o.admissionVersion !== undefined && o.admissionVersion !== 'unknown' && !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]{1,30})?$/.test(o.admissionVersion)) throw Error('Admission version must be semver or unknown');
    if (o.snapshotSource !== undefined && !['collector','lndg','lightningMate'].includes(o.snapshotSource)) throw Error('Invalid closed snapshot source');
    if (o.occurrenceId !== undefined && !/^[a-f0-9]{64}$/.test(o.occurrenceId)) throw Error('Occurrence identity must be an opaque SHA-256 digest');
    if (o.affectedVersion !== undefined && o.affectedVersion !== 'unknown' && !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]{1,30})?$/.test(o.affectedVersion)) throw Error('Affected version must be verified semver or unknown');
    if (o.timeBasis !== undefined && !['source','detection'].includes(o.timeBasis)) throw Error('Invalid timestamp provenance');
    if (o.observedAt !== undefined && (!/^\d{4}-\d\d-\d\dT.*Z$/.test(o.observedAt) || !Number.isFinite(Date.parse(o.observedAt)))) throw Error('UTC observation timestamp required');
    if (o.runtimeVersion !== undefined && !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]{1,30})?$/.test(o.runtimeVersion)) throw Error('Runtime version must be semver');
    if (o.classification === 'app_defect' && !o.facts.includes('regression_confirmed'))
        throw Error('App defect requires explicit regression evidence');
}
export function classifyRuntimeFailure(error: unknown): Classification {
    // Inspect bounded text locally, retain only the classification, never the error.
    const text = typeof error === 'string' ? error.slice(0, 1000) : '';
    if (/401|403|unauthorized|authentication|api.key|quota|credit/i.test(text)) return 'authentication';
    if (/429|503|502|timeout|timed.out|ECONN|ENOTFOUND|provider|network|rate.limit/i.test(text)) return 'upstream_transient';
    return 'unknown';
}
function prompt(o: RuntimeObservation, id: string, revision: number) {
    const scope = o.classification === 'app_defect' ? 'Indagare la regressione confermata e proporre una modifica minima dopo aver riprodotto il difetto.' :
        o.classification === 'data_gap' ? 'Valutare la raccolta e la rappresentazione delle lacune, senza inventare dati storici mancanti.' :
        o.classification === 'authentication' ? 'Verificare configurazione, autorizzazione e quota con il proprietario; nessuna modifica al codice è giustificata da sola.' :
        o.classification === 'upstream_transient' ? 'Verificare lo stato del provider/rete e il recupero. Un errore upstream transitorio da solo non giustifica una correzione dell’app.' :
        'Raccogliere una riproduzione isolata prima di attribuire il problema al codice applicativo.';
    const steps = o.facts.map(f => ({
        job_failed: 'Recuperare il job tramite ID dalla cronologia read-only. Confrontare la ricevuta terminale con il testo pubblico; simulare job failed con risposta parziale in una fixture.',
        turn_interrupted: 'Confrontare la ricevuta del turno con le submission correlate. Riavviare la fixture dopo interrupted: conservare il testo parziale, senza promuoverlo a completed.',
        delivery_failed: 'Leggere il conteggio tentativi nella diagnostica Telegram. Simulare cinque rifiuti API e verificare failed, senza un sesto invio.',
        delivery_uncertain: 'Verificare la chat destinataria e la ricevuta outbox. Simulare send accettato seguito da timeout/riavvio: uncertain persistente e zero replay.',
        collector_failed: 'Confrontare timestamp collector e ultimo snapshot valido. Simulare errore di raccolta e recupero: dati obsoleti dichiarati, nessuna nuova azione AI finché non validi.',
        source_incompatible: 'Leggere status/version della fonte in diagnostics. Simulare schema incompatibile: la fonte resta unavailable/incompatible e i consumer non trasformano la lacuna in zero.',
        coverage_gap: 'Confrontare coverage.complete e captureComplete della fonte. Fixture con paginazione parziale: conservare i conteggi disponibili e dichiarare la copertura incompleta.',
        regression_confirmed: 'Recuperare la verifica esplicita della regressione. Riprodurre prima della modifica e ripetere la stessa verifica dopo, conservando entrambe le ricevute.',
    }[f])).join('\n');
    const lookup = o.component === 'agent' ? `Cronologia job ID ${o.receipt}` : o.component === 'telegram' ? `Outbox Telegram ricevuta ${o.receipt}; lookup locale read-only: SELECT event_id,status,attempts FROM telegram_outbox WHERE rowid=${o.receipt.startsWith('row:') ? o.receipt.slice(4) : '0'} (nessun payload).` : `Diagnostica web / meta ${o.component === 'collector' ? 'collector' : 'diagnostics'}, timestamp ${o.observedAt}.`;
    return `Prompt di sviluppo consultivo — ${id}, revisione ${revision}\nVersione SatsSurge del rilevatore: ${o.runtimeVersion ?? version}. Versione interessata dal problema: ${o.affectedVersion && o.affectedVersion !== 'unknown' ? o.affectedVersion : 'non verificata nella ricevuta; non assumere la versione attuale per un guasto storico'}; componente: ${o.component}. Versione di ammissione della richiesta/evento: ${o.admissionVersion ?? 'unknown'} (non prova della versione di esecuzione o del guasto).\n\nFatti osservati (timestamp ${o.observedAt}, ${o.timeBasis === 'source' ? 'della ricevuta fonte' : 'di rilevazione; timestamp della fonte non disponibile'}) (${lookup}):\n${o.facts.map(f => '- ' + facts[f]).join('\n')}\nImpatto osservato: ${o.impact}.\nClassificazione: ${o.classification}. Cause sospette: non dimostrate; separare dipendenze esterne da difetti app/bot.\n\nRiproduzione disponibile e test mirati:\n${steps}\nUsare esclusivamente store temporaneo e trasporti mock; non ripetere effetti finanziari.\nComportamento atteso: stato veritiero, risposta parziale esplicita, ricevute originali preservate e recupero entro i fence di autorizzazione. Una consegna incerta resta incerta senza replay.\nAmbito proposto: ${scope}\n\nVincoli: questa segnalazione non modifica codice, file, dipendenze, permessi o runtime; nessuna PR, installazione o distribuzione automatica. Il proprietario decide ed esegue il lavoro in una sessione di sviluppo separata. Preservare mandato, budget, capability, identificativi originali, reconciliation e unico executor finanziario. Non acquisire credenziali, log grezzi o payload di pagamenti personali.\n\nAccettazione e test concreti:\n- Fixture isolata con il fatto osservato: verificare stato pubblico corretto e ricevuta immutata dopo riavvio.\n- Simulare provider indisponibile e successivo recupero: distinguere errore esterno da regressione; non richiedere una modifica app senza evidenza.\n- Simulare consegna accettata seguita da timeout: persistere uncertain, zero nuovi invii automatici e zero effetti finanziari.\n- Revocare associazione o ruotare token durante un await: nessun invio successivo con vecchia autorità.\n- Verificare quiete, rate limit e massimo cinque tentativi; una notifica consegnata non risolve il problema.\n- Eseguire npm test, npm run typecheck e python3 -m unittest discover -s scripts/tests in ambiente isolato.\n\nEvidenza mancante: causa radice, riproduzione completa, versione delle dipendenze coinvolte, durata/recupero del guasto e prova dal runtime modificato. Non inventare percorsi sorgente o una correzione già provata. Per chiudere occorre una nuova verifica esplicita del runtime corretto.\n`;
}
/** Fixed exact retention: at most 2048 hashed occurrence/material identities (about
 * 140 KiB serialized), 100 issues, eight immutable revisions each and 50 display
 * receipt samples per revision, plus three fixed source-time snapshot watermarks.
 * Unchanged open snapshot captures advance those watermarks without new ledger
 * identities. Other identities are never evicted or approximated:
 * after capacity, unknown observations are explicitly blocked rather than
 * mislabeled as duplicates. Existing exact replays remain recognizable. */
export const MAX_RUNTIME_OCCURRENCES = 2048;
/** Persists advisory receipts only. No executor, shell, filesystem write or agent tools. */
export class RuntimeImprovements {
    constructor(readonly store: Store) {}
    issues(): RuntimeIssue[] { return this.store.get<RuntimeIssue[]>('runtimeImprovements') ?? []; }
    observe(input: RuntimeObservation, at = now()) {
        validate(input);
        const observation: RuntimeObservation = { component: input.component, classification: input.classification,
            facts: [...new Set(input.facts)].sort(), impact: input.impact, receipt: input.receipt,
            observedAt: input.observedAt ?? at, runtimeVersion: input.runtimeVersion ?? version, timeBasis: input.timeBasis ?? (input.observedAt ? 'source' : 'detection'), affectedVersion: input.affectedVersion ?? 'unknown', occurrenceId: input.occurrenceId ?? hash(input.receipt), snapshotSource: input.snapshotSource, admissionVersion: input.admissionVersion ?? 'unknown' };
        const family = observation.component === 'telegram' ? (observation.facts.includes('delivery_uncertain') ? 'delivery_uncertain' : 'delivery_failed') :
            observation.component === 'diagnostics' ? observation.receipt : 'runtime';
        const id = hash(json([observation.component, family])).slice(0, 16);
        // Receipt identity is attribution, not material evidence: repeated occurrences aggregate.
        const fingerprint = hash(json([observation.component, observation.classification, observation.facts, observation.impact, observation.affectedVersion]));
        const occurrence = hash(json([id, observation.occurrenceId, fingerprint]));
        return this.store.tx(() => {
            const occurrences = this.store.get<string[]>('runtimeImprovementOccurrences') ?? [];
            const issues = this.issues(); let issue = issues.find(i => i.id === id);
            // Exact replay is checked before resolution/reopening. UI receipt samples
            // may rotate; they never determine whether an occurrence is new.
            if (occurrences.includes(occurrence) && issue) {
                const historical = issue.revisions.find(r => r.fingerprint === fingerprint);
                return { issue, revision: historical ?? issue.revisions.at(-1)! };
            }
            const blocked = (reason: 'occurrence_limit' | 'issue_limit' | 'revision_limit' | 'stale_source_snapshot') => {
                const diagnostic = { status: 'blocked', reason, at, issueId: id,
                    reported: false, occurrenceRecorded: false, retainedOccurrences: occurrences.length,
                    retainedIssues: issues.length, retainedRevisions: issue?.revisions.length ?? 0 };
                this.store.set('runtimeAdvisoryAdmission', diagnostic);
                if (reason !== 'stale_source_snapshot') this.store.set('runtimeAdvisoryCapacity', diagnostic);
                return undefined;
            };
            // Only these three authoritative overwritten snapshot sources use a
            // monotonic source-time watermark. Never use detection time as recurrence.
            // Unchanged open snapshots advance without growing the exact ledger.
            const snapshots = this.store.get<Record<string, { at: string; fingerprint: string }>>('runtimeSnapshotWatermarks') ?? {};
            const source = observation.snapshotSource && observation.timeBasis === 'source' ? observation.snapshotSource : undefined;
            const previous = source ? snapshots[source] : undefined;
            if (previous && Date.parse(observation.observedAt!) < Date.parse(previous.at)) return blocked('stale_source_snapshot');
            if (previous && Date.parse(observation.observedAt!) === Date.parse(previous.at) && fingerprint === previous.fingerprint && issue)
                return { issue, revision: issue.revisions.find(r => r.fingerprint === fingerprint) ?? issue.revisions.at(-1)! };
            if (source && previous && issue?.status === 'open' && issue.revisions.at(-1)?.fingerprint === fingerprint) {
                const current = issue.revisions.at(-1)!; current.lastAt = at; current.observations++;
                snapshots[source] = { at: observation.observedAt!, fingerprint };
                this.store.set('runtimeSnapshotWatermarks', snapshots); this.store.set('runtimeImprovements', issues);
                return { issue, revision: current };
            }
            if (occurrences.length >= MAX_RUNTIME_OCCURRENCES) return blocked('occurrence_limit');
            if (!issue) { if (issues.length >= 100) return blocked('issue_limit'); issue = { id, status: 'open', revisions: [] }; issues.push(issue); }
            let revision = issue.revisions.at(-1)!;
            if (issue.status === 'resolved' || revision?.fingerprint !== fingerprint) {
                if (issue.revisions.length >= 8) return blocked('revision_limit');
                const number = (revision?.number ?? 0) + 1;
                revision = { number, previous: revision?.number ?? null, fingerprint, observation, firstAt: at, lastAt: at, observations: 1, receipts: [observation.receipt], prompt: prompt(observation, id, number) };
                issue.revisions.push(revision); issue.status = 'open'; delete issue.resolvedBy;
            } else { revision.lastAt = at; revision.observations++; if (!revision.receipts.includes(observation.receipt)) revision.receipts = [...revision.receipts, observation.receipt].slice(-50); }
            if (source) { snapshots[source] = { at: observation.observedAt!, fingerprint }; this.store.set('runtimeSnapshotWatermarks', snapshots); }
            this.store.set('runtimeImprovementOccurrences', [...occurrences, occurrence]);
            this.store.set('runtimeImprovements', issues); return { issue, revision };
        });
    }
    resolve(id: string, verifiedRuntimeReceipt: string) {
        if (!/^[a-f0-9-]{16,64}$/.test(verifiedRuntimeReceipt)) throw Error('Explicit runtime verification receipt required');
        const issues = this.issues(), issue = issues.find(i => i.id === id); if (!issue) return;
        issue.status = 'resolved'; issue.resolvedBy = verifiedRuntimeReceipt; this.store.set('runtimeImprovements', issues);
    }
    candidates(): { source: RuntimeEvidenceSource; reference: string; state: string }[] {
        const rows: { source: RuntimeEvidenceSource; reference: string; state: string }[] = [];
        for (const j of this.store.all("SELECT id FROM jobs WHERE state='failed' ORDER BY updated_at DESC LIMIT 20")) rows.push({ source: 'job', reference: j.id, state: 'failed' });
        for (const r of this.store.all("SELECT rowid receipt_row,status FROM telegram_outbox WHERE status IN ('failed','uncertain') AND event_id NOT LIKE 'advisory:%' ORDER BY created_at DESC LIMIT 20")) rows.push({ source: 'outbox', reference: 'row:' + r.receipt_row, state: r.status });
        if (this.store.get('collector')?.ok === false) rows.push({ source: 'collector', reference: 'collector', state: 'failed' });
        for (const source of ['lndg','lightningMate'] as const) {
            const d = this.store.get('diagnostics')?.[source];
            if (d?.status === 'incompatible' || d?.status === 'qualified' && (d.captureComplete === false || d.coverage?.complete === false)) rows.push({ source, reference: source, state: d.status === 'incompatible' ? 'incompatible' : 'partial' });
        }
        return rows;
    }
    /** Native model entry point: facts/classification/version derive from current receipts,
     * never from model declarations. No raw error, payload or personal payment fields. */
    reportEvidence(source: RuntimeEvidenceSource, reference: string, at = now()) {
        if (typeof reference !== 'string' || reference.length > 64 || !this.candidates().some(c => c.source === source && c.reference === reference)) throw Error('No bounded current persisted evidence matches this reference');
        let observation: RuntimeObservation;
        if (source === 'job') {
            const j = this.store.one("SELECT id,error,updated_at,conversation_id,submission_id FROM jobs WHERE id=? AND state='failed'", reference);
            const turn = this.store.get('telegramTurn:' + j.id);
            // A placed correction may own the failed native submission while the
            // job retains its immutable initial submission ID. Accept only IDs in
            // this original turn's committed order, with matching generation,
            // conversation and admission version (closure increments it once).
            const acceptedCorrections: string[] = [];
            const turnBound = turn?.jobId === j.id && turn.conversationId === j.conversation_id &&
                typeof turn.generation === 'string' && turn.generation.length > 0 &&
                typeof turn.closed === 'boolean' && turn.capability === this.store.get('jobCapability:' + j.id) &&
                turn.generation === this.store.get('jobTelegramGeneration:' + j.id) &&
                Array.isArray(turn.submissions) && turn.submissions.includes(j.submission_id) &&
                Number.isSafeInteger(turn.version) && turn.version >= 1 && Array.isArray(turn.correctionOrder);
            if (turnBound && turn.correctionOrder.length <= 100) for (const id of turn.correctionOrder) {
                if (typeof id !== 'string' || id.length > 160) continue;
                const correction = this.store.get('telegramCorrection:' + id);
                if (correction?.id === id && correction.jobId === j.id && correction.generation === turn.generation &&
                    correction.version === turn.version - (turn.closed ? 1 : 0) &&
                    ['placed','failed'].includes(correction.state) && correction.withdrawalRequested !== true &&
                    correction.withdrawResult === undefined && typeof correction.submissionId === 'string' &&
                    correction.submissionId !== j.submission_id && turn.submissions.includes(correction.submissionId))
                    acceptedCorrections.push(correction.submissionId);
            }
            const provider = matchedNativeProviderFailure(this.store.get('providerFailure:' + j.id), j, acceptedCorrections);
            // Generic terminal text can describe many failures. Only a matched native
            // receipt qualifies a provider/auth diagnosis; missing proof stays unknown.
            const classification: Classification = provider?.kind === 'transient_stream' || provider?.kind === 'transient_network' ? 'upstream_transient' :
                provider?.kind === 'authentication' || provider?.kind === 'quota' ? 'authentication' : 'unknown';
            observation = { component: 'agent', classification, facts: turn?.state === 'interrupted' ? ['job_failed','turn_interrupted'] : ['job_failed'], impact: 'partial_response', receipt: j.id, observedAt: j.updated_at, admissionVersion: this.store.get('jobRuntimeVersion:' + j.id) ?? 'unknown', affectedVersion: 'unknown' };
        } else if (source === 'outbox') {
            const r = this.store.one('SELECT event_id,status,created_at FROM telegram_outbox WHERE rowid=?', Number(reference.slice(4)));
            observation = { component: 'telegram', classification: 'unknown', facts: [r.status === 'failed' ? 'delivery_failed' : 'delivery_uncertain'], impact: 'notification_unavailable', receipt: reference, observedAt: r.created_at, admissionVersion: this.store.get('telegramOutboxVersion:' + r.event_id) ?? 'unknown', affectedVersion: 'unknown' };
        } else if (source === 'collector') {
            observation = { component: 'collector', classification: 'unknown', facts: ['collector_failed'], impact: 'data_unavailable', receipt: hash('collector'), observedAt: this.store.get('collector').at };
        } else {
            const diagnostics = this.store.get('diagnostics'), d = diagnostics[source];
            observation = { component: 'diagnostics', classification: 'data_gap', facts: [d.status === 'incompatible' ? 'source_incompatible' : 'coverage_gap'], impact: 'data_unavailable', receipt: hash(source), observedAt: diagnostics.at };
        }
        // Legacy evidence with no trustworthy timestamp remains explicitly unknown in
        // the prompt; detection time is supplied separately, never invented as source time.
        const snapshotSource = ['collector','lndg','lightningMate'].includes(source);
        if (snapshotSource) observation.snapshotSource = source as 'collector' | 'lndg' | 'lightningMate';
        observation.occurrenceId = hash(json(snapshotSource ? [source, reference, observation.observedAt ?? null] : [source, reference]));
        if (!observation.observedAt) { observation.observedAt = at; observation.timeBasis = 'detection'; }
        const outcome = this.observe({ ...observation, runtimeVersion: version }, at);
        return outcome ? { issueId: outcome.issue.id, revision: outcome.revision.number, status: outcome.issue.status, delivery: outcome.revision.delivery?.status ?? 'pending_capture', prompt: outcome.revision.prompt, advisoryOnly: true, financialExecution: false } : { boundedCapacityReached: this.store.get('runtimeAdvisoryAdmission')?.reason !== 'stale_source_snapshot', status: 'blocked', reported: false, reason: this.store.get('runtimeAdvisoryAdmission')?.reason ?? 'admission_unknown', advisoryOnly: true, financialExecution: false };
    }
    scan(at = now()) {
        for (const c of this.candidates()) this.reportEvidence(c.source, c.reference, at);
        // Revocation/cancellation is a delivery disposition, never issue resolution.
        for (const issue of this.issues()) for (const revision of issue.revisions) if (revision.delivery) {
            const row = this.store.one('SELECT status FROM telegram_outbox WHERE event_id=?', revision.delivery.eventId);
            if (row && row.status !== revision.delivery.status) this.delivery(revision.delivery.eventId, row.status);
        }
    }
    delivery(eventId: string, status: string, messageId?: number) {
        const issues = this.issues(); for (const issue of issues) for (const r of issue.revisions) if (r.delivery?.eventId === eventId) { r.delivery.status = status; if (messageId !== undefined) r.delivery.messageId = messageId; }
        this.store.set('runtimeImprovements', issues);
    }
}
