# Complementi applicativi e primitive native Pi Durable 1.1.0

Confronto locale del 2026-10-10. Versioni npm/lockfile invariate: Durable, AI e
Chord **1.1.0**. Nessun cambiamento ai moduli di produzione, schema, mandato,
claim finanziario o installazione. Questa matrice distingue la qualificazione
di una primitiva dalla equivalenza di una migrazione applicativa.

## Fonti e differenze di versione

Letti gli articoli indicati dal proprietario:

- [Earendil: Pi Durable](https://earendil.com/posts/pi-durable/), fonte primaria:
  presenta conversazioni/task posseduti, documenti atomici con il transcript,
  compaction in background e osservazione dello stato. Gli esempi di pagamento
  dipendono dall'idempotenza del servizio esterno.
- [MindStudio: Pi Durable and long-running agents](https://www.mindstudio.ai/blog/pi-durable-long-running-agents),
  panoramica secondaria datata 2026-10-04: distingue admission e replay degli
  effetti, segnala i limiti dello storage e descrive compaction come un esempio.

Il contratto eseguibile resta il [README fissato](upstream/v1.1.0/packages/durable/README.md),
i [tipi installati](installed/pi-durable-1.1.0/) e il runtime locale npm.
La 1.1.0 ha compaction **built-in**, task persistenti e configurazione delle
soglie; la panoramica secondaria non è sufficiente per scegliere le API.
L'articolo Earendil mostra `defineDoc`, `defineTask`, `configure`, `api.commit`,
`Conversation.compact` e tool result `content`, presenti nel contratto fissato.
Non usare API nuove di `main` né `ExtensionAPI` del Coding Agent.

La fixture importa gli export ESM reali, inclusi `@earendil-works/chord/context`.
Il precedente script privato falliva prima di creare harness/DB perché usava
`createRequire(...).resolve` su un export disponibile in ESM. Script e log
precedenti sono conservati; non vengono corretti retroattivamente.

## Matrice di decisione

KEEP conserva autorità e persistenza applicative. THIN ADAPTER proietta una
primitiva nativa, mantenendo i controlli di dominio. REPLACE richiede equivalenza
misurata e migrazione qualificata. QUALIFY è un candidato ancora incompleto.

| Complemento | Decisione attuale | Primitiva nativa e prova | Confine che resta / condizione di sostituzione |
|---|---|---|---|
| Admission, coda globale, priorità, slot coordinator/analyst | KEEP | `requestId` deduplica nella singola conversazione; inbox ordina gli input busy | Limiti globali, capability, rate, fairness, budget, identità job e recovery tra DB restano nella coda applicativa. Una nuova conversazione con lo stesso requestId non è un duplicato nativo. |
| Piani di ricerca e checkpoint delle pagine | QUALIFY | `defineDoc` rewindable e `defineTask` commettono fase/documento nella stessa transazione; SIGKILL preserva la fase e non ripete la preparazione | `Research` conserva intervallo congelato, research/revision/job ID, parent receipt, query/cursor/version/offset, coverage e continuazioni cross-store. La fixture non migra questi dati né prova l'equivalenza dei consumer. |
| Stato JSON locale della conversazione | THIN ADAPTER | Documento tipizzato con versione, storico e fork; snapshot/reopen del documento qualificati | Buon candidato per stato conversazionale senza autorità di dominio. Nessuna sostituzione dello Store condiviso o della transazione finanziaria. Fork/schema upgrade/migrazione dei documenti applicativi restano da qualificare. |
| Task di continuazione | QUALIFY | Fase persistente e stato terminale del task nativo sono qualificati dopo crash/Stop | Occorrono migrazione degli ID originali, massimo numero segmenti, coalescenza, trigger, priorità, budget e reconciliation con job operativi. Un task nativo non rimpiazza la ricevuta job da solo. |
| Analyst posseduti da una chiamata/task | QUALIFY | Parent task → child conversation → child task conserva ownership/ID dopo SIGKILL; Stop lascia entrambi terminali prima del ritorno | Gli analyst attuali sono job globali ownerless con budget/capability e provenienza indipendenti. Il modello owned cambia semantica Stop/lifecycle. Servono parity di risultati, queue accounting, tool fencing e recovery dei job originali. |
| Compaction e contesto del modello | THIN ADAPTER | Usare compaction nativa già presente; default, soglie automatiche, placement manuale, crash/reopen e failure sono qualificati | Nessuna seconda summarizer pipeline. Storage storico e ricevute canoniche restano interrogabili; una summary è contesto del modello, non prova economica o autorizzazione. |
| Streaming e stato pubblico | THIN ADAPTER | `watchEvents` espone message/inbox/usage committed; snapshot/reopen e `stop` qualificati localmente | Journal UI/outbox, redazione, autorizzazione, baseline del turno, reconnect/cursore/dedup e consegna Telegram restano applicativi. Eventi nativi non sono un journal di consegna garantita. |
| Usage del modello e compaction | THIN ADAPTER | `pi.usage`/`Harness.usage` coincidono con tutte le risposte faux completate, incluse summary e tentativi falliti; reopen non richiama il provider | Conservare delta per turno, baseline persistita, budget e limiti globali. Non usare il totale cumulativo come usage del turno. Token/costi di una risposta interrotta prima del commit possono essere sconosciuti. |
| Collector, canonical history/provenienza, contabilità | KEEP | Le primitive native non forniscono la semantica LND/cursor/coverage | Nessun cambiamento a collector, lineage, riconciliazione, history e viste economiche. |
| Mandato, riserve, decisioni, ledger, executor | KEEP | Replay unsafe e requestId non danno exactly-once esterno | Intenzione/operation/payment hash, fence e riconciliazione deterministica restano autorevoli. Nessun effetto finanziario nelle prove. |
| Telegram binding, scadenze, rate, outbox e consegna incerta | KEEP | Inbox e eventi non garantiscono consegna esterna | Authorization fresh, callback ownership/expiry, ricevute Stop e outbox restano applicativi. Stop nativo ritira gli input futuri già nella inbox: mantenere i futuri turni nella mailbox operativa. |

Nessun REPLACE applicato in questa freeze: le prove consentono di evitare
un'ulteriore pipeline di compaction o usage, ma non dimostrano una migrazione
equivalente dei complementi di dominio. Non è misurato alcun risparmio di codice,
costo o affidabilità. La patch applicativa scoped Stop resta distinta da stock
1.1.0; vedere [durable-patterns](durable-patterns.md#recovered-stop-offline-application-patch-v1).

## Qualificazione nativa isolata

Sorgenti: `whirmill-satssurge-autopilot/src/test/pi-native-qualification.test.ts`
e `pi-native-qualification-fixture.ts`. Il provider faux non usa credenziali o
rete; database temporanei nuovi, `synchronous=FULL`, nessun regtest. I child
process sono fixture Node, non sessioni agent o processi sull'installazione.

1. **Default invariati:** enabled=true, reserveTokens=16384,
   keepRecentTokens=20000, backgroundTokens=32768. Con finestra faux 65536,
   soglia blocking=49152 e background=16384. Il runtime usa `>` e seleziona
   prima un prefisso riassumibile. Primo turno senza summary, successivi con
   compaction automatica in background. Tutte le entry precedenti rimangono
   identiche; il contesto attivo è più piccolo e inizia dalla summary.
2. **Reopen:** entry, document identities, submission/result/request IDs,
   context e usage invariati; duplicate requestId restituisce la submission
   originale, zero nuove chiamate provider.
3. **Failure di soglia:** task compaction fallito, nessuna summary aggiunta,
   storico preservato. Stock 1.1.0 usa `allSettled`: la generazione procede
   dopo il tentativo fallito e può completare. Non chiamarla failure della
   submission né presumere contesto ridotto. Il tentativo entra in usage.
4. **Failure dopo overflow:** il provider risponde `prompt is too long`, la
   summary fallisce e la submission originale termina `unanswered`; nessun
   ciclo o replay al reopen. Tentativi commessi inclusi nell'usage.
5. **Placement manuale:** summary prodotta mentre il turno è busy, submission
   write ancora queued; al confine finale viene collocata con lo stesso ID,
   status `done` (non un inesistente `written`), head reason `manual`.
6. **Steer/follow-up/Stop:** input busy e steer persistono in inbox e completano
   al confine successivo; eventi pubblici e usage sono osservati e watch chiusa.
   Stop ritira anche il futuro input nativo. La prova rilascia esplicitamente
   il faux bloccato: non certifica cancellazione di un provider arbitrario hung.
7. **SIGKILL checkpoint/documento:** fase `finish` e documento `prepared`
   conservati, Stop sul task originale, nessuna seconda preparazione o model
   call. Reopen conferma outcome `aborted` e documento invariato.
8. **SIGKILL owned analyst:** proprietà e identità parent/child conservate;
   Stop termina child e parent e conserva il documento del child. Questa è
   prova della primitiva, non conversione degli analyst applicativi.
9. **SIGKILL durante summary in background:** riapertura della fase
   `summarize` sul task originale, placement riuscito, entry vecchie preservate;
   delta usage commesso uguale alle risposte riprese, nessun replay terminale.

Le prove confrontano usage nativo con il provider faux deterministico: non
certificano fatturazione, cancellation remota o accuratezza della summary di un
provider reale. Una summary può includere il testo storico inviato al provider;
non esportarne contenuti raw, thinking o errori privati nei consumer pubblici.

Ogni fixture chiude harness/storage, termina e attende i child process e rimuove
SQLite/WAL/SHM temporanei. La prima prova tenta una query sul database chiuso e
verifica il rifiuto. Il pacchetto privato di continuazione conserva log, diff e
hash degli input; l'accettazione indipendente e qualsiasi pubblicazione restano
all'orchestratore. L'ordine core → M2.4 → M3 → M4 → M5 resta vincolante.
