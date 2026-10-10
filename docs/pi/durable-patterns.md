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
