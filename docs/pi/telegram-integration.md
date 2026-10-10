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
