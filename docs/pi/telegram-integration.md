# Telegram: integrazione con Pi Durable

## Componenti riutilizzabili e compatibilità

Verifica del 2026-10-09, codice upstream fissato ai commit indicati:

| Progetto | Commit | Compatibilità con SatsSurge |
|---|---|---|
| [badlogic/pi-telegram](https://github.com/badlogic/pi-telegram/tree/cb34008460b6c1ca036d92322f69d87f626be0fc) | `cb34008460b6c1ca036d92322f69d87f626be0fc` | ExtensionAPI Coding Agent; non caricabile direttamente da Durable |
| [earendil-works/pi-chat](https://github.com/earendil-works/pi-chat/tree/9adbd29b40ee27ff1decf0fc87cbe180b40924f5) | `9adbd29b40ee27ff1decf0fc87cbe180b40924f5` | ExtensionAPI Coding Agent; runtime Gondolin/QEMU/tmux distinto |
| [Mikan](https://github.com/geminixiang/mikan/tree/80c75473e8fc8141c4e5ef139340e6f50f1ff346) | `80c75473e8fc8141c4e5ef139340e6f50f1ff346` | Esempio applicativo con Durable 1.1.0; non un plugin installabile |

`pi-telegram` offre streaming, allegati e polling ma conserva le richieste
accodate in memoria e associa il primo utente DM. Questi comportamenti non
soddisfano l'associazione web e le ricevute persistenti richieste da SatsSurge.
`pi-chat` separa parte del trasporto, ma usa tipi e renderer del proprio host.
Le relative licenze sono rispettivamente MIT e Apache-2.0; verificare e mantenere
le notifiche di licenza se si adatta codice, non soltanto i nomi degli autori.

SatsSurge usa pertanto un adattatore Bot API applicativo, con strumenti
registrati nel **registry nativo Pi Durable esistente**. Nessun secondo agente,
sessione CLI, QEMU o bot standalone. Il tool `create_manual_proposal` è distinto
da `execute_decision`; soltanto le capability previste possono richiamarlo.

## Ingresso e identità

Il long polling `getUpdates` non richiede porte pubbliche. Telegram conserva gli
aggiornamenti non ricevuti per un massimo di 24 ore: una lunga disconnessione
non permette di promettere il recupero di tutti i messaggi mai acquisiti.
[Contratto Bot API](https://core.telegram.org/bots/api#getupdates).

1. Salvare il batch accettato e il cursore nella stessa transazione locale.
2. Autorizzare esclusivamente una chat privata con sender ID e chat ID numerici
   corrispondenti al proprietario associato.
3. Rifiutare comandi scaduti, identità errate e gruppi. Il codice di associazione
   è monouso, casuale, memorizzato come digest e valido cinque minuti.
4. Confermare l'identità sul web autenticato; username e nome sono etichette,
   non prove di autorità.
5. Correlare ogni richiesta con ID Telegram, generazione dell'associazione,
   request/job e submission. Il retry riottiene la ricevuta originale.

La generazione cambia dopo revoca, nuova associazione o sostituzione del bot.
Job, callback, ripresa e outbox conservano la generazione di origine. Prima di
un effetto verificare di nuovo la generazione corrente, anche dopo un await.
Non attribuire a un pulsante vecchio la generazione corrente solo perché il
messaggio è stato ricevuto dopo la nuova associazione.

## Proposte e operazioni

Le richieste naturali Telegram sono read-only o abilitate alla creazione di
proposte; non eseguono direttamente azioni finanziarie. Le analisi restano
possibili con autonomia in pausa, dichiarando i dati non disponibili.

Una proposta contiene il tipo fee/rebalance, endpoint, importi, costo massimo,
ragione, evidenze, digest del contenuto e condizioni osservate. Approvazione e
rifiuto sono condivisi con il web. L'approvazione scade dopo cinque minuti e
viene consumata una sola volta. Una consegna rinviata richiede rivalutazione
prima di mostrare un nuovo pulsante, non rinnovi indiscriminati di una ricevuta.

Dopo il fresh snapshot del nodo e prima della prenotazione rivalidare contenuto,
scadenza, condizioni e autorità. Registrare l'operation ID nella transazione che
crea la prenotazione, prima di qualsiasi RPC. Revoca durante lo snapshot blocca
la proposta; revoca dopo l'intento non elimina un effetto potenzialmente inviato.
La riconciliazione rimane proprietaria di quell'operazione.

Le operazioni autonome già consentite dal mandato restano autonome. Il bot non
modifica budget o permessi. La pausa blocca nuove esecuzioni, non i controlli di
tracking; la ripresa richiede un riepilogo, conferma esplicita e guard freschi.

## Uscita e notifiche

Le risposte pubbliche provengono dai job Telegram della stessa associazione.
Non inoltrare chat web, hidden thinking, segreti o dati di pagamenti personali.
Conservare il token in un file privato 0600, mai nel registry o nei tool result.
Gli errori del trasporto non devono contenere URL con il token.

L'outbox applicativa usa ID evento e generazione. Un tentativo registra l'intento
prima di `sendMessage`; timeout e crash possono lasciare una consegna incerta.
La transazione locale e Telegram non condividono atomicità. Mostrare lo stato
incerto, rispettare `retry_after`, limitare i retry e non ritentare operazioni
finanziarie per risolvere una notifica fallita.

Verificare binding e stato della riga **prima di ogni invio**, non solo all'inizio
del batch: la revoca può intervenire durante l'await dell'invio precedente.
Un invio già partito può arrivare dopo la revoca; nessun invio successivo deve
usare l'identità revocata o una nuova credenziale con la vecchia chat.

Risposte richieste sempre disponibili, quiete 22–08 per notifiche non critiche,
digest alle 09 Europe/Rome. Criticità identiche appartengono allo stesso episodio
finché attive; se si risolvono e ricompaiono, generare un nuovo episodio.
Telegram indisponibile non ferma l'autopilot entro mandato o la riconciliazione.

## Prove richieste

- Associazione normale, codice scaduto, limite tentativi, foreign ID e gruppi.
- Revoca e riassociazione durante snapshot, invio di un batch e gestione dei
  callback; nessun effetto autorizzato da una generazione vecchia.
- Doppia approvazione web/bot, contenuto/condizioni mutate, budget e manutenzione.
- Crash tra update receipt, job, submission, consumo e operation intent.
- Riavvio con pagamento/consegna incerti, senza replay dell'effetto.
- Ricorrenza delle criticità, quiete, digest senza attività, ora legale e rate limit.
- Migrazione/reopen che preservano ricevute, contabilità e credenziali.

Mock e fixture isolati verificano il comportamento locale; non certificano la
consegna a un bot reale né una migrazione installata sul nodo. Queste verifiche
richiedono configurazione e qualificazione separate.

## Coordinatore interattivo (2026-10-10)

Telegram è l'unico ingresso conversazionale del proprietario. La web app conserva
configurazione, associazione, modello, controlli finanziari e cronologia in sola
lettura. Nuove richieste HTTP `chat/analyze` rispondono 410; il recupero di un ID
preesistente continua a restituire la ricevuta originale. Nessuna cronologia o
submission precedente viene eliminata.

La chat libera sveglia immediatamente `Scheduler.dispatchTelegram`, senza
attendere il ciclo di manutenzione. Il coordinatore Telegram usa gli strumenti
read-only dello slot 2; il coordinatore finanziario e i due analisti restano
indipendenti. La mailbox applicativa conserva soltanto i turni futuri e ne
permette l'annullamento. Per una stessa generazione/chat, chat, analisi e bridge
verso proposta sono serializzati in ordine d'ammissione, anche se hanno lane
interne diverse. Le analisi automatiche non diventano turni Telegram.

Una sessione read-only può conservare il contesto di chat nella stessa
associazione/capability/slot; non viene promossa a capability finanziaria. Una
richiesta esplicita di proposta crea un job separato `guarded_manual_proposal`.
Le proposte sono ricevute commesse, approvate una sola volta con i controlli e la
scadenza esistenti. La conversazione non rinnova mandato o budget.

### Ricevute e confini

Le ricevute additive nello schema 6 sono `telegramTurn`, `telegramCorrection`,
`telegramStop`, `telegramBaseline`, `telegramUsageBaseline` e `telegramStream`.
Conservano job/request/conversation/submission originali. Pi commette creazione
conversazione e binding `app.conversation_binding` nella stessa transazione;
una ripartenza tra commit Pi e binding applicativo ritrova quella conversazione.
Il baseline pubblico è registrato prima della prima submission: snapshot e
recovery di una sessione riutilizzata non inoltrano testo/tool/sintesi di turni
precedenti. Usage della sessione è cumulativo; usage e deadline del turno restano
separati. Una correzione non azzera il budget del turno.

Un messaggio durante la risposta rimane `choice_pending` fino alla scelta
esplicita **Correggi questa risposta** oppure **Nuova richiesta**. Le scelte
scadono dopo cinque minuti e sono limitate a venti per associazione. Soltanto
una correzione ammessa entra in `pi.inbox` con `whenBusy: steer`; tutti i turni
futuri restano nello store applicativo. Pi può applicare uno steer dopo il round
di tool oppure avviare un run successivo al confine della risposta finale. Il
turno applicativo possiede tutte quelle submission fino al settlement. Sono
ammesse ulteriori correzioni durante il run corretto. `placed` prova l'ingresso
nel contesto, non che il modello abbia seguito il testo. **Ritira correzione**
usa `Submission.abort`: `already_placed` è dichiarato esplicitamente e non
cancella la risposta o un altro turno. Una correzione tardiva offre una nuova
richiesta collegata, senza eseguirla automaticamente.

Stop conserva target turn/generation/version e conferma prima la ricezione,
poi l'assenza di task ordinari con `Conversation.abort` e `waitForIdle`. La
ripartenza ridispatcha l'intento Stop conservato anche durante `waiting`. Stop
vecchi/duplicati non si applicano al turno successivo. L'evento nativo Telegram
`stopped_message_generation`, privo di sender, richiede la mappa durevole
`draft_id → turn/generation/version` e la stessa chat privata associata. Stop
non sospende l'autonomia e non interrompe la riconciliazione finanziaria.
Topic ed edited message ricevono un rifiuto esplicito; non mutano l'input già
ammesso.

### Streaming e trasporto

Polling e uscita hanno lifecycle indipendenti. Il proiettore riusa `UiEvents`,
con coalescing a un aggiornamento al secondo e rinnovo dei draft entro venti
secondi. `sendRichMessageDraft` mostra `<tg-thinking>` e offre Stop nativo;
`sendMessageDraft` e messaggio modificabile sono fallback espliciti. Soltanto
`reasoning_summary` con provenienza `responses.summary_text` è pubblico.
Thinking grezzo, blocchi nascosti, argomenti/tool result e segreti non vengono
inoltrati come attività. L'attività mostra soltanto il nome dello strumento.

L'invio iniziale di un messaggio fallback registra `sending`; timeout o crash
lo rendono `uncertain`, senza un nuovo invio automatico. I draft sono
aggiornamenti temporanei, mentre il testo finale usa eventi outbox univoci e
segmenti sotto 3500 unità UTF-16. HTML è escapato e supporta grassetto/code/
intestazioni sicure. `retry_after` sospende l'uscita e ogni dispatch rilegge i
fence dell'associazione e del bot. Le ricevute finali incerte mantengono la
politica di non replay.

Il catalogo comandi italiano sostituisce quello preesistente nel default e
nella chat proprietario; `setChatMenuButton` viene riconciliato una volta per
generazione. `getMe` conserva soltanto lo username pubblico per il link web.
`callback_query.id` è conservato e `answerCallbackQuery` precede il lavoro;
pulsanti di approfondimento, lacune, dettagli, cancellazione e proposta hanno
azioni reali e mantengono l'associazione di origine.

Fixture senza rete coprono entrambi i confini steer, due correzioni consecutive,
recovery del secondo turno nella sessione, Stop prima del bind e dopo ACK,
FIFO chat/analisi, dispatch immediato mentre il coordinatore finanziario è
occupato, timeout fallback, draft/429, menu, testo esteso e isolamento di una
operazione finanziaria incerta. Il risultato locale non certifica la resa di
un client Telegram reale o l'installazione sul nodo.

## Ricognizione plugin estesa (2026-10-10)

La valutazione include anche plugin distinti da `badlogic/pi-telegram`:

| Progetto fissato | Contratto osservato | Pattern utile / limite |
|---|---|---|
| [Qusic/pi-telegram](https://github.com/Qusic/pi-telegram/tree/4e197246f4ba2f623feed3db6e5bdf6f567c5798) | `src/index.ts` importa Coding Agent `ExtensionAPI` | `turn.ts` offre streaming/typing/abort/steer e `dispatch.ts` registra i comandi. `polling.ts` salva il cursore JSON prima del dispatch e mantiene pending/active in RAM: non sostituisce le ricevute crash-safe applicative. |
| [pi-telegram-plus](https://github.com/jalyfeng/pi-telegram-plus/tree/cd284c2d1bcfb1a4d3d267de2e856325e3872ca9) | Coding Agent `>=0.76 <0.82` nel README/source | Menu, callback, renderer, topic e polling condiviso; API host distinta da Durable 1.1.0. |
| [TelePi](https://github.com/benedict2310/TelePi/tree/02536f6ea24607c32b26edf3eeef8b660853f544) | Coding Agent SDK SessionManager 0.86.1 | Servizio, sessioni JSONL e handoff; non fornisce il ledger applicativo SatsSurge. |

Questi progetti sono riferimenti UX/trasporto, non plugin caricabili direttamente
nel registry Durable. Si conserva il lifecycle nativo Durable, l'outbox e la
policy SatsSurge; eventuale adattamento di codice richiede verifica e conservazione
delle rispettive licenze. Questa implementazione non incorpora codice esterno.
La ricognizione è stata eseguita dalla lane di ricerca in sola lettura; i commit
fissati rendono esplicita la versione valutata.

Entrambi i metodi draft della Bot API 10.3 supportano `can_stop` e `keep_on_stop`:
il fallback `sendMessageDraft` conserva quindi Stop nativo. Fonte:
[Bot API changelog 10.3](https://core.telegram.org/bots/api#recent-changes).

Una correzione già placed che termina per errore provider o Stop rende il turno
applicativo failed/interrupted anche se la submission originale aveva già una
risposta finale. Quel testo resta disponibile come risposta esplicitamente
parziale. Soltanto il ritiro confermato di una correzione ancora queued preserva
il completamento della risposta originale. Intento e risultato di ritiro sono
ricevute distinte, così `already_placed` non diventa un ritiro riuscito durante
una race. Un 429 di draft sospende anche l'outbox dello stesso ciclo: il gate
globale è controllato all'ingresso di deliver e prima di ciascun dispatch.
