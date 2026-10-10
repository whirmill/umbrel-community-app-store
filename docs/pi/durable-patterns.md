# Pattern Pi Durable 1.1.0

Leggere prima il [README ufficiale](upstream/v1.1.0/packages/durable/README.md).
Questa guida evidenzia le scelte che incidono su SatsSurge.

## Harness, submission e recovery

`Harness.open(storage, options, context)` collega storage, modelli e registry.
Il registry appartiene al processo; al riavvio vanno reinstallate le definizioni
necessarie ai task pendenti. Le conversazioni conservano i nomi delle estensioni,
non il codice JavaScript. La selezione predefinita include tutte le estensioni
installate: per SatsSurge usare sempre selezioni e capability esplicite.

`root.submit({ type: "input", content, requestId }, context)` registra un input.
Lo stesso `requestId` nella stessa conversazione riottiene la submission
originale. La coda applicativa deve anche impedire che un retry crei una nuova
conversazione: l'idempotenza del framework è per conversazione, non globale.
Non confondere `submit` accettata con risposta completata.

Una conversazione occupata conserva gli input in `pi.inbox`. `whenBusy` distingue
follow-up, steer e reject; le scritture aggiungono voci senza interpellare il
modello. Se un run fallisce, gli input accodati non diventano automaticamente
nuove richieste indipendenti. `reset` e compaction cambiano il contesto visibile,
conservando lo storico; non sono strumenti per cancellare ricevute operative.

## Estensioni e tool

Il registry riceve `defineExtension({ name, tools, sections, hooks, wraps, tasks })`.
Non riceve la funzione `export default (pi: ExtensionAPI)` del Coding Agent.
Un tool usa uno schema TypeBox, `defineTool`, una politica di replay e la propria
funzione `execute`. Nella **1.1.0** il risultato usa `content`; non copiare le API
`output`/`structuredOutput` introdotte successivamente su upstream main.

Esempio minimo del contratto 1.1.0, da adattare al contesto applicativo:

```ts
import { createRegistry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";

const registry = createRegistry();
registry.install(defineExtension({
  name: "read-only-example",
  tools: [defineTool({
    name: "explain_state",
    parameters: Type.Object({}),
    description: "Read committed public state without external effects",
    replay: "safe",
    execute: async () => ({ content: [{ type: "text", text: "State unavailable" }] }),
  })],
}));
```

L'esempio non concede accesso a LND né modifica le estensioni di produzione.
La registry selection limita ciò che il modello vede; i controlli dentro il
tool restano necessari perché configurazioni e ownership possono cambiare.

## Replay ed effetti esterni

Il task del tool commette l'intento prima di chiamare `execute`.

| Tipo | Politica | Recupero |
|---|---|---|
| Lettura o trasformazione ripetibile | `replay: "safe"` con idempotenza dimostrata | Può essere richiamata dopo crash |
| Creazione di proposta con ID stabile e vincolo univoco | Safe soltanto se duplicazione e condizioni sono gestite | Riottenere la proposta originale, non estenderne implicitamente la validità |
| Pagamento/modifica esterna | Unsafe nel flusso finanziario attuale | Errore di interruzione e riconciliazione della ricevuta originale |
| Invio Telegram | Outbox applicativa, esito incerto distinto | Non dedurre una mancata consegna da un timeout |

`replay: "unsafe"` non rende atomico il pagamento rispetto al commit locale.
SatsSurge deve registrare operazione e payment hash prima dell'invio, e usare
`TrackPaymentV2` per gli esiti incerti. Non trasformare un risultato sconosciuto
in fallimento per consentire un nuovo invio. Il successo tecnico non certifica
profitto né completezza contabile.

## Storage e transazioni

L'adattatore SQLite upstream usa WAL con `synchronous=NORMAL`; protegge dal crash
del processo, ma gli ultimi commit possono essere persi in un guasto host o
alimentazione. SatsSurge imposta esplicitamente `synchronous=FULL` prima di
`SqliteStorage.open` per il database Durable; lo store operativo usa FULL.
Non eliminare questo override durante un refactor.

Uno storage ha un solo proprietario di processo; upstream non fornisce un lock
tra processi. Il container SatsSurge usa `flock --no-fork` sull'executor lock.
Non avviare un secondo host Pi o un bot standalone sugli stessi file.

Nel callback di una transazione SQLite upstream usare l'handle ricevuto, non
l'oggetto database esterno: quest'ultimo può restare in attesa della transazione
stessa. Le transazioni dello `Store` applicativo sono distinte e non vanno
annidate; usare helper espliciti in-transaction quando disponibili.

Un checkpoint consistente comprende tutti e tre i database con WAL, oltre a
owner secret e credenziali conservati separatamente. Verificare capture e
restore isolato. Non ripristinare ricevute vecchie sopra effetti successivi.

## Tool generici e ambienti

`@earendil-works/pi-durable/tools` offre read, write, edit, bash e `CodingTools`.
Operano tramite l'`ExecutionEnv` dell'harness, non per una sandbox implicita.
`NodeExecutionEnv` accede ai file e processi dell'ambiente Node autorizzato.
Senza environment i tool built-in restituiscono errore.

Per strumenti futuri definire cwd, filesystem, credenziali non accessibili,
programma/argomenti consentiti, rete, timeout e cancellazione. Preferire argv
quando non serve una shell. Una factory di tool non è un confine finanziario:
un comando con accesso al macaroon può eludere l'executor applicativo.

## Eventi, UI e lifecycle

`viewState`, `watch` e `watchEvents` osservano stato commesso. Gli eventi includono
snapshot, delta, task, inbox e usage; un consumer lento oltre il buffer di 100
frame/batch riceve lo stato aggiornato. Non usarli come outbox garantita e non
ricostruire pagamenti dai delta del modello. Dopo reconnect partire dallo
snapshot, applicare identificatori e versioni, evitando duplicazioni.

I partial/output sono commessi a intervalli: il default di 100 ms può lasciare
una finestra di testo non salvato in caso di crash. Le ricevute finanziarie
seguono i propri commit e non dipendono dal testo parziale. Proiettare solamente
risposte pubbliche e sintesi consentite, mai hidden thinking.

Chiudere watch e view con i metodi documentati (`stop`/`dispose`). Un abort di
task proprietario si propaga ai figli; task background possono sopravvivere al
parent e richiedono gestione esplicita. `waitForTask` e lo stato committed
distinguono pending/running/waiting/completing/terminal; il silenzio non prova
che un writer sia fermo.

Gli esempi ufficiali in `upstream/v1.1.0/packages/durable/test/examples/`
coprono recovery, stato di estensione, eventi, subagent, child task, plan mode e
reload. Leggerli insieme ai tipi locali in `installed/pi-durable-1.1.0/`.

## Turni applicativi e inbox (coordinatore Telegram)

Un turno non equivale a un singolo run Pi. SatsSurge conserva tutte le submission
steer ammesse prima della chiusura, incluse quelle che iniziano un run al confine
finale senza tool, e aspetta il rilascio del contesto prima di accettare il turno
successivo. Il ledger applicativo e la transazione di binding Pi sono distinti:
`app.conversation_binding` consente di ritrovare la conversazione dopo un crash
tra i due database. I futuri turni non vengono pre-inseriti in `pi.inbox`, così
un abort del turno corrente non li ritira.

Le ricevute Stop rimangono `stop_requested` durante la recovery waiting e sono
ridispatchate sul target originale. Gli osservatori proiettano soltanto entry
successive al baseline persistito del turno; non diventano outbox e non sono
usati per riconciliare effetti finanziari. Per la sessione riutilizzata, usage
cumulativo e delta per turno sono entrambi distinti dal budget del turno.

Telegram terminal closure is one operational-store transaction with the accepted-Stop check. It commits the outcome, selected public final-entry ID, and owned submission IDs before returning to the scheduler. A closed turn cannot reopen or increment its version on recovery. Recovery reconciles every admitted correction in durable admission order, including native successful submissions whose app receipt was already settled: the latest successful correction supplies the final answer, while any required original/correction failure remains terminal. A confirmed queued withdrawal is exempt; an abort without its application result receipt remains unresolved and fails closed. Stop permits native identity lookup/readback, never creation of a missing correction.

Committed Telegram terminal receipts include the bounded public scheduler result. Recovery projects that result before provider availability, native configuration, cumulative usage, or budget initialization; the scheduler also projects queued/waiting terminal receipts before its availability gate. Consequently cooldown/accounting failure cannot turn committed completion into failure or postpone a known interrupted outcome. Completion rereads the full durable admitted ledger at the final fence, including correction placement rejected before a native ID exists. Intentional late choices are not required submissions.

## Recovered Stop offline: application patch v1

Stock Pi Durable 1.1.0 `Conversation.abort()` and `waitForIdle()` enable the
whole scheduler. They therefore cannot qualify an offline recovered Stop that
must leave unrelated pending work, including existing abort marks, untouched.
SatsSurge applies **`satssurge-scoped-stop-v1`**, a separate, pinned application
patch. The npm package version, lockfile integrity, upstream snapshots and
built-in generation/tool definitions remain the upstream 1.1.0 contract.

`whirmill-satssurge-autopilot/scripts/pi-scoped-stop-patch.mjs` verifies the exact
1.1.0 version, original or already-patched SHA-256 of scheduler/harness, and six
unchanged native contract files before any write. Unsupported inputs fail the
build. `build`, `test` (through build), and `typecheck` invoke it explicitly, so
`npm ci --ignore-scripts` is supported. Docker copies both patch files before
building; the resulting patched dependency is carried into the final image.
Patch manifest SHA-256:
`283b864ad348dc0bf979de7c1b6095b0a67e3b0d4585b65b0d9489302b0974d2`;
script SHA-256:
`8fc51a4418e9e073b64dcadd90f0c64ec9b8d910888823253ff1e53f30e81be8`.

The additional `cancelConversationScoped` entry point requires an open paused
scheduler. One native transaction marks the exact ordinary ownership scope and
withdraws its queued inbox inputs before dispatch. Only that captured set of
abort-marked tasks can be reserved while global scheduling stays paused. Native
abort handlers run bottom-up, preserving their real task/submission outcomes;
no registry substitution, filtered storage or invented terminal state is used.
The scheduler's scoped idle wait does not call `resume`. Global resume is refused
while scoped cancellation is preparing or still has live target work.

Deferred provider cancellation is skipped in this offline lane. A bounded
`app.scoped_stop_remote_uncertainty` entry commits the task identity and unknown
remote status before native cancellation. The original generation abort handler
still commits its native local outcome; remote execution is **unknown**, never
reported stopped. This uncertainty survives a crash after native terminal state
and before the application terminal receipt. It requires provider-side
reconciliation when access returns; cancellation does not authorize replay.

Agent recovery runs before availability and before budget/normal run admission,
serialized across scheduler pump and immediate Telegram dispatch. It checks the
existing binding, generation, turn version, capability, original request and
submission/conversation IDs again after awaits. If app binding fields are absent,
it resolves only the persisted conversation intent, immutable native binding
entries and the original native request-ID receipt; exactly one matching proof
may bind the existing operational job under the same fence. An admitted correction
with no native receipt is withdrawn explicitly as `stop_before_native_submission`
after scoped idle. Recovery creates/configures/submits
nothing. Active runners retain their existing live path. Unknown bindings,
stale ownership, an unsupported scheduler state, or a two-second native wait
timeout leave Stop pending. Only genuine native scoped idle permits application
closure. Future application turns remain queued outside the native inbox.

Disposable native fixtures cover SIGKILL during an active correction, offline
reopen, original submit-before-app-bind recovery, unrelated financial/analyst generations and a preexisting abort mark,
stale versions, unknown bindings, a bounded application wait failure, deferred
uncertainty, and a second SIGKILL after native idle before app closure. Their
preservation baseline is taken after Harness.open recovery normalization. They
check native tasks/submissions/transcript/documents and operational financial
receipts, original IDs, queued future work, zero provider/effect calls and
idempotent terminal readback. The wait failure uses an injected unresponsive
scoped-wait boundary; it does not certify cancellation of an arbitrary hung
extension abort handler. No real provider or financial action is qualified by
these local tests.
