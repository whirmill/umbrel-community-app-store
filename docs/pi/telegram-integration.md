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
aggiornamenti temporanei, mentre il testo finale usa eventi outbox univoci. La
composizione rich candidata 0.5.11 è descritta sotto; i segmenti legacy sono
limitati a 3500 unità UTF-16. HTML è escapato e supporta grassetto/code/
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

## Correzione trasporto M2.3 e prova client richiesta

La policy rich candidata è `rotating`: ogni invio effettivo, inclusa la refresh
invariata a 20 secondi, riserva un nuovo ID persistente. Il
[Bot API rich draft](https://core.telegram.org/bots/api#sendrichmessagedraft)
documenta sostituzione senza animazione per ID diversi; il contratto MTProto
più generale descrive invece più draft. La correzione dell'animazione sul client
Telegram macOS deve quindi essere verificata con una prova reale abbinata,
senza affermare che i test mock certifichino la resa del client.

Per il controllo, `POST /api/telegram/stream-policy` accetta soltanto
`{"richDraftPolicy":"stable"}` oppure `{"richDraftPolicy":"rotating"}` attraverso
la normale sessione owner, same-origin e CSRF. La policy corrente è nel readback
`/api/telegram/status`. Cambiare policy durante un turno attivo o una dispatch
restituisce 409. Non modifica token, binding, OAuth, input modello o mandato.
La policy si applica ai turni successivi. Il controllo mantiene lo stesso ID;
la candidata lo ruota. Thinking pubblico, Stop nativo e proiezione restano uguali.

Un solo turno in primo piano per chat invia preview. La coalescenza è un secondo
per peer, la refresh invariata resta a 20 secondi e `retry_after` è condiviso.
Le dispatch normali e draft sono serializzate; le notifiche normali precedono
la preview e ne invalidano la ricevuta locale anche quando la consegna è incerta.
Con un turno attivo viene tentato al massimo un elemento outbox per ciclo.
Ogni chiamata outbound è limitata a cinque secondi, incluso il body HTTP;
il long polling conserva il timeout precedente. Timeout di una consegna normale
resta incerto e non viene reinviato automaticamente. Una chiamata già partita
potrebbe comunque arrivare dopo timeout: la ricevuta non prova cancellazione remota.

Gli alias draft conservano job, generazione, versione, chat e generazione bot,
ID, lunghezza/hash, tempi e outcome, senza una seconda copia del corpo o segreti.
Sono registrati prima dell'invio, anche se l'esito sarà incerto. Il contatore
monotono persistente non riusa ID dopo riavvio o eliminazione; esaurimento ID o
100.000 alias blocca la preview con ricevuta `capacity_blocked`, non la risposta
finale. Alias conservati 24 ore e cinque minuti coprono il ritardo massimo
ordinario della coda update Telegram, oltre i 30 secondi della preview. Pruning
al massimo una volta al minuto; gli alias legacy esatti restano riconoscibili.
Stop su alias vecchio conserva la sua identità: turno chiuso/versione scaduta
ha risposta esplicita; alias sconosciuto o scaduto non seleziona il turno attuale.
Dopo ogni await si ricontrollano turno running, versione, Stop, chat e bot,
senza riscrivere uno stream obsoleto né riaprire un turno terminale.

Le viste nuove `manual_events`/`policy_events` qualificano `directional-v2` con `filterSemanticsVersion:2` in metadata e hash
della versione:
`source` e `target` sono uguaglianze direzionali combinate con AND; `channel`
indica coinvolgimento di un endpoint o `affectedChannels`. Una direzione mancante
rende la vista scoped non disponibile, mai zero inventato. I campi direzione
della ricevuta non certificano attribuzione per rotta MPP: gli endpoint aggiuntivi
restano in `affectedChannels` e gli importi dell'evento intero non sono ripartiti
implicitamente tra rotte (`perRouteAllocationQualified:false`). Nei diagnostici il
filtro canale usa identità canale qualificata o endpoint normalizzati, mai l'ID
osservazione. Le righe prive dei campi necessari restano esplicitamente unsupported.
Un cursore persistente precedente conserva immutabilmente righe e semantica della
sua acquisizione; l'assenza del contratto è esposta come `legacy_unknown` senza
mutare la ricevuta salvata. Riapertura esplicita produce una nuova vista con le nuove regole.

## Recupero esplicito degli ingressi storici

I messaggi acquisiti oltre cinque minuti dalla data Telegram restano ricevute
persistenti; chat read-only e comandi `/status`, `/help`, `/queue`, `/menu`
richiedono ora revisione, senza eseguire automaticamente lavoro storico. Lo scan
avanza di venti ricevute per ciclo, in ordine numerico di update ID. `/recover`
mostra fino a otto richieste con data, estratto pubblico e pulsanti **Riprendi** e
**Ignora**. I pulsanti scadono dopo cinque minuti; dopo l'ACK callback e dentro
la transazione si rivalidano chat, owner, bot, associazione, hash del corpo e
ricevuta originale. Ignora produce `dismissed / owner_dismissed`, mai completed.
I comandi con effetti, le proposte, Stop, pairing e callback scaduti restano
esclusi da questo recupero.

La vista di recupero conserva update/request originali, data, body hash,
associazione e bot; non modifica la riga ignored o l'archivio originale. Una
ripresa esplicita usa il request ID originale e riottiene job/conversation/
submission già commessi. Job esistenti vengono riconciliati dal scheduler senza
nuova ammissione; queued/running/waiting restano non terminali. Completed,
failed e cancelled sono esiti distinti; non sono dedotti dal testo simile di
un'altra richiesta. Una ripresa durante una risposta attiva conserva la scelta
Correggi/Nuova richiesta, senza inserire automaticamente uno steer.

Un ACK ordinario sent/uncertain/sending/failed non certifica risposta modello
completa e non viene ritentato per recuperare il lavoro. Vecchie viste `done`
restano immutate: quando un percorso modello non ha un job o una scelta
correlati, una vista separata `telegramIngressRecoveryReview` dichiara
`legacy_model_completion_unknown / review_required` e conserva l'hash della
vecchia ricevuta. I comandi diretti già risposti e le scelte/job correlati non
sono riproposti. Una consegna finale incerta mantiene la policy di non replay.

L'ammissione di una richiesta normale a chat libera non invia più un ACK
permanente generico. Il draft Thinking pubblico esistente mostra l'attività
mentre il job è running; un turno veloce può produrre soltanto la risposta
finale. Richieste accodate e scelte sulla risposta attiva conservano conferme
veritiere. Deduplicazione e recovery dipendono dalla ricevuta di ammissione,
non dalla presenza di un ACK. Alias draft, Stop e ricevute incerte già commessi
restano preservati.

I nuovi prompt consultivi diagnostici identificano la fonte chiusa collector,
LNDg o Lightning Mate anche nella riproduzione. Revisioni, artefatti e checksum
precedenti restano immutati; le evidenze distinte mantengono la correlazione
con la propria fonte.

Una scelta `choice_pending` scaduta o `late`, senza submission né ammissione
correlata, non prova completamento. La vista separata conserva anche l'hash della
correction originale: **Riprendi** crea soltanto la richiesta futura con request
ID originale, senza riutilizzare lo steer scaduto né cambiare la correction.
Una scelta attiva non scaduta conserva esclusivamente il suo flusso di scelta;
scelte consumed/admitted/placed/settled e submission native già presenti restano
proprietà del turno originale. Prima della scelta, dopo l'await callback e prima
dell'ammissione si ricontrolla che non siano comparsi job, submission o consumo
correlati: nessuna seconda ammissione per chiudere una race.

Le scelte legacy ancora `choice_pending` conservano un riferimento differito
alla ricevuta originale: dopo la scadenza vengono rivalutate in gruppi di massimo
venti per ciclo, anche dopo avanzamento del cursore e riavvio. Una scelta
consumata o associata a una submission non riapre il lavoro. La vista di recupero
non riscrive i byte della correzione originale. La scadenza callback usa il tempo
trascorso dall'inizio dell'intero batch, inclusi gli ACK precedenti e il recupero
ricorsivo; dopo l'ACK rimangono attivi i fence di binding e generazione bot.

Anche le recovery correnti che, dopo Riprendi, diventano `choice_pending`
conservano un anchor distinto con hash della ricevuta e della correzione. Dopo
expiry o un passaggio applicativo verificato a `late`, vengono rivalutate al
massimo venti per ciclo e tornano a una vista di revisione esplicita, senza
ammissione automatica. La nuova vista conserva origine, hash e vincolo di nuova
richiesta; le righe ignored, la ricevuta della scelta e i byte della correzione
restano intatti. Consumo, submission nativa, ammissione correlata, cambio di
associazione o bytes inattesi impediscono la riapertura. Un passaggio `late`
può aggiornare l'anchor soltanto attraverso il normale handler steer, se il
cambiamento è esattamente quello dello stato e i fence restano validi.

Se l'origine è già una vista di recovery, la maturazione crea una chiave distinta
legata all'hash di quella precisa origine; non riusa né sovrascrive la vista
precedente. Le verifiche percorrono tutti gli hash degli antenati, anche dopo
l'ACK, e rifiutano catene cicliche, mancanti, mutate o oltre 128 riferimenti.
La ripresa conserva il vincolo di nuova richiesta e il request ID originale:
catene ripetute non consumano la correzione né creano doppio lavoro.

## Stop generico e recupero dei prompt consultivi (0.5.9)

Un comando `/stop` può essere consegnato dopo la fine della risposta visibile
al momento dell'invio. La data Telegram indica l'accettazione sul server e non
prova il turno previsto prima di un ritardo nel client. Il comando generico non
interrompe immediatamente: spiega il limite e offre un callback con job,
generazione e versione esatti. La conferma interrompe soltanto quel turno; se
è già chiuso non seleziona un successore. Stop nativo e callback già mirati
restano immediati. I fence di ingresso per comandi scaduti restano attivi.

I prompt consultivi oltre 2000 caratteri usano un allegato `.txt`; la soglia
è condivisa fra ammissione e invio. `/prompt ISSUE_ID [REVISIONE]` permette al
proprietario associato di richiedere una copia di una revisione già registrata.
Il comando verifica identità, associazione, contenuto e checksum dell'artefatto
originale e crea una consegna distinta correlata all'update, con
`sourceRequestLink`. Non cambia revisione, evidenza o ricevuta precedente, né
ritenta una consegna incerta automaticamente. Un update duplicato conserva
la sua ricevuta. Il recupero non autorizza modifica del runtime o effetti
finanziari. La consegna e apertura nel client reale restano prove separate.

## Composizione 0.5.11 — checkpoint storico 2026-10-12

Il checkpoint reale 0.5.10 su Telegram Web conserva il testo finale completo,
ma mostra parole tagliate ai confini dei cinque messaggi e anteprime sovrapposte.
La precedente candidata rotating e la sua motivazione sul client nativo restano
evidenze storiche: non provano equivalenza di resa tra client. Il nuovo default
è stable soltanto quando manca una scelta esplicita; l'API di confronto conserva
stable/rotating e il rifiuto durante un turno o dispatch attivo. Job, associazione
o versione diversi richiedono sempre un alias nuovo. Stop su un alias vecchio
mantiene il target originale, mentre `/stop` generico offre soltanto conferma.

Un'anteprima lunga conserva un prefisso coerente entro 3500 unità UTF-16, con
marcatore **Anteprima parziale** e indicazione della consegna completa al termine.
Non sposta una finestra sul testo né promette che il prefisso sia tutta la risposta.
Coalescenza, refresh, Stop nativo e allowlist delle sintesi pubbliche restano uguali.

La [Bot API](https://core.telegram.org/bots/api#sendrichmessagedraft) descrive il
draft come anteprima temporanea di 30 secondi; la persistenza del contenuto usa
[sendRichMessage](https://core.telegram.org/bots/api#sendrichmessage).
[InputRichMessage](https://core.telegram.org/bots/api#inputrichmessage) richiede
esattamente un campo tra html, markdown e blocks. La candidata usa soltanto
`rich_message: { html: ... }`, prodotto dal renderer applicativo che esegue escape
del testo pubblico e aggiunge grassetto, code e intestazioni sicure. Nessun HTML
grezzo, file remoto, media, paid broadcast o capacità nuova proviene dal modello.

Un nuovo finale entra come un unico intento outbox se il testo è entro 32768
unità UTF-16 e l'HTML codificato entro 65536 byte UTF-8. Sono limiti applicativi. La documentazione ufficiale corrente descrive anche
limiti rich di caratteri, blocchi e profondità, verificati nella candidata 0.5.12
sotto; la precedente descrizione senza limiti rich documentati è superata. Oltre quei limiti si usa
la segmentazione legacy, preservando la concatenazione esatta del testo pubblico:
prima confini di paragrafo, poi spazi; i normali grafemi Unicode restano interi.
Un token o grafema eccezionale più grande di un intero segmento richiede uno split
limitato, senza perdita di code point. Il job e le ricevute conservano l'originale.
Capture non converte né riscrive finali preesistenti, anche multipart parzialmente
consegnati, `sending`, `sent` o `uncertain`; non aggiunge loro metadata rich.

Un rifiuto API esplicito 400/404 senza `retry_after`, con binding e bot ancora
validi, può registrare un fallback deterministico `.txt` per il successivo
tentativo limitato della stessa ricevuta. Nome sanitizzato, destinazione, checksum
e byte del testo pubblico restano vincolati; una risposta parziale resta parziale.
Non segue un invio alternativo nello stesso tentativo. 429 rispetta l'epoch globale
e ritenta lo stesso metodo. Timeout, crash dopo l'intento, ACK non verificabile
e 5xx sono incerti: nessun replay automatico né cambio di canale. Anche un codice
API assente, malformato o non provato resta incerto, indipendentemente dal numero
di tentativi precedenti. I soli rifiuti rich ritentabili sono 400/401/403/404/429;
un cambio di identità conserva uno stato e un errore di consegna incerta. La resa rich,
la scomparsa dell'anteprima e l'apertura del fallback sul client reale richiedono
qualificazione separata dopo review, pubblicazione e installazione.


## Layout rich e menu candidati 0.5.12 — 2026-10-12

La reale 0.5.11 conserva identità stable e contenuto canonico, ma il client
Telegram Web presenta il finale C in un solo paragrafo, senza intestazioni o
liste. Il nuovo renderer rich produce tag blocco documentati: `h1`–`h6`, `p`,
`br`, `ul`/`ol`/`li`, `pre`/`code`. Interpreta soltanto intestazioni Markdown,
liste piatte, paragrafi, code fence con tre backtick e bold/code inline. Le
righe interne al paragrafo usano `br`; gli ordinali espliciti restano numerici.
Il testo dentro code/pre è opaco e sempre escapato. HTML, link Markdown,
immagini e markup non riconosciuto del modello restano testo; non generano
attributi arbitrari, media, Mini App o capacità applicative. Questo formatter
limitato non è un parser Markdown completo. Il testo canonico esatto resta
nell'outbox/job e nell'eventuale documento, anche quando i marcatori Markdown
sono interpretati per la presentazione. La funzione inline legacy
`telegramHtml` e i percorsi `sendMessage`/`sendMessageDraft` non cambiano.

La [Bot API corrente](https://core.telegram.org/bots/api#rich-messages)
documenta 32768 caratteri UTF-8, 500 blocchi inclusi quelli annidati e gli
item di lista, e 16 livelli annidati. Le soglie applicative rimangono 32768
unità UTF-16 e 65536 byte di HTML UTF-8; ora si verificano anche blocchi e
profondità. Ogni lista conta contenitore, item e paragrafo annidato. La grammatica
esclusivamente generata ha al massimo quattro livelli. Un finale fuori soglia
usa segmenti legacy con concatenazione canonica esatta; una preview fuori soglia
locale seleziona il draft plain esistente prima di inviare rich. Il thinking
rimane un blocco non vuoto, limitato alle sintesi pubbliche allowlisted e ai
nomi degli strumenti, con escape e line break espliciti. I fence alias/job/
versione/generazione e la scelta stable/rotating rimangono quelli esistenti.

Ogni nuovo intento rich include `format: rich-blocks-v1`, conteggio blocchi,
profondità e numero di byte del renderer. Un intento 0.5.11 senza `format`
conserva validazione e serializzazione esatte tramite `telegramHtml`; nessun
metadata viene retrofittato. Un formato ignoto o un checksum/conteggio/destinazione
incoerente fallisce prima del dispatch. Le ricevute sent, uncertain e multipart
storiche rimangono immutate; il nuovo formato non autorizza replay. Il fallback
400/404 nel tentativo successivo conserva format/checksum/byte/destinazione;
timeout, rete, 5xx o codici non provati rimangono incerti anche al quinto
tentativo. Il rate gate 429 e i fence owner/bot restano autorevoli.

La [precedenza ufficiale dei comandi](https://core.telegram.org/bots/api#determining-list-of-commands)
privilegia lo scope chat senza lingua rispetto agli scope all-private/global.
L'osservazione 0.5.11 ha mostrato undici comandi global/Italian e trenta comandi
storici all-private, ma nessuno scope owner default. Il testo dei comandi
storici non prova un writer Pi o Hermes attivo: origine e ownership restano
non determinate. La migrazione scrive soltanto gli undici comandi nello scope
della chat owner default e Italian; non elimina né modifica scope global,
all-private o di altre chat/lingue. Il menu a pulsanti commands resta invariato.

Il marker durevole `ownerChatDefaultV1:<chatId>` dipende dalle generazioni owner
ed effettivo bot; i vecchi marker non saltano l'upgrade. Chiamate concorrenti
sono serializzate. Ogni ACK setter deve essere `true`, l'identità deve avere
uno username valido, e dopo ogni await vengono riletti owner/chat/bot/rate fence.
Solo tutti gli ACK validi ammettono il marker finale atomico. Revoke, rebound,
ACK mancante o cooldown interrompono il resto senza completare la migrazione;
una nuova chiamata ripete soltanto la registrazione idempotente autorizzata.

Queste sono prove di sorgente e trasporti finti. Layout, scomparsa dell'anteprima,
menu effettivo e apertura del fallback sul client reale richiedono review,
pubblicazione, qualificazione nativa, installazione e nuova accettazione UI.
