# Whirmill Community App Store

Store privato per i pacchetti Umbrel gestiti da Whirmill e assenti dallo store
ufficiale. La struttura segue il template ufficiale Umbrel: lo store usa il
prefisso `whirmill` e ogni directory coincide con l'ID completo dell'app.

## Applicazioni

| Nuovo ID | Versione | Stato prima della migrazione | Vecchio ID |
| --- | --- | --- | --- |
| `whirmill-byparr` | `2.1.0` | installata direttamente | `byparr` |
| `whirmill-tdarr` | `2.81.01` | installata direttamente | `tdarr` |
| `whirmill-simplex-smp` | `7.0.1` | installata direttamente | `simplex-smp` |
| `whirmill-simplex-xftp` | `7.0.1` | installata direttamente | `simplex-xftp` |
| `whirmill-simplex-turn` | `4.16.0-5` | installata direttamente | `simplex-turn` |
| `whirmill-cloudflare-ddns` | `1.1.2` | installata dal Community App Store | `cloudflare-ddns` |
| `whirmill-limpidog` | `1.0.2` | nuova migrazione da OpenShip | — |
| `whirmill-zapbot` | `0.1.40` | installata dal Community App Store | — |

La verifica del 4 agosto 2026 non ha trovato questi ID nello store ufficiale
`getumbrel/umbrel-apps`. `cloudflared` è un'app ufficiale diversa: fornisce un
Cloudflare Tunnel, non l'aggiornamento DDNS dei record A.

## Importazione futura

Lo store deve prima essere pubblicato in un repository GitHub raggiungibile.
In Umbrel aprire `App Store`, menu con i tre puntini, `Community App Stores` e
aggiungere l'URL HTTPS della radice del repository.

Le immagini personalizzate vengono pubblicate da sorgenti o artefatti ufficiali
verificati e le definizioni delle app usano sempre digest immutabili. La
pubblicazione dello store non autorizza da sola una migrazione live: prima di
rimuovere un'app esistente devono essere verificati il relativo snapshot dati
e il percorso di ripristino.

## Migrazione futura

I nuovi ID cambiano nomi container e directory `app-data`. Ogni nuova app usa
la stessa porta UI della corrispondente installazione legacy; le app SimpleX
condividono inoltre le stesse porte host native. Nessuna coppia vecchio/nuovo ID
può quindi essere installata e avviata contemporaneamente.

Prima della migrazione è stato predisposto un primo backup locale privato,
esterno a Git, in:

```text
/Volumes/BuildBox/whirmill/umbrel-community-app-backups/
  2026-08-04-pre-community-store-migration/
```

La mappa di ripristino è:

```text
byparr       -> whirmill-byparr
tdarr        -> whirmill-tdarr
simplex-smp  -> whirmill-simplex-smp
simplex-xftp -> whirmill-simplex-xftp
simplex-turn -> whirmill-simplex-turn
```

Il backup contiene chiavi private, identità SimpleX, code SMP, file XFTP e
configurazione Tdarr. Deve restare fuori da Git e accessibile soltanto al
proprietario. Poiché questa prima copia è stata eseguita a servizi attivi, non è
il punto di ripristino definitivo.

Sequenza prevista, da eseguire solo con una successiva autorizzazione:

1. fermare tutte e cinque le app legacy;
2. creare un nuovo backup datato con un ultimo delta a servizi fermi;
3. rigenerare e verificare checksum, conteggi e presenza delle chiavi private;
4. interrompere la migrazione se il backup quiescente non è integralmente
   verificato;
5. rimuovere una sola vecchia app senza cancellare i backup;
6. installare la corrispondente nuova app dallo store;
7. fermare la nuova app prima del ripristino;
8. ripristinare soltanto le directory runtime indicate nel README del backup;
9. normalizzare proprietario e permessi per l'app, senza replicare alla cieca i
   bit world-writable della sorgente;
10. riavviare e verificare identità, salute e funzionalità end-to-end;
11. aggiornare i riferimenti esterni ai nuovi nomi container;
12. procedere con l'app successiva soltanto dopo il superamento dei controlli.

In particolare, Prowlarr dovrà usare
`http://whirmill-byparr_server_1:8191`. Le password generate da Umbrel sono
associate all'installazione e potrebbero cambiare con il nuovo ID: dopo il
ripristino, ricopiare dagli status page gli indirizzi SMP/XFTP e le tre righe
ICE TURN nei client SimpleX. Certificati, fingerprint, code e file persistenti
devono invece provenire dal backup.

Tdarr viene distribuito con `startPaused=true` per evitare conversioni durante
il ripristino e la verifica delle librerie.

Prima della pubblicazione o migrazione live verificare inoltre che l'app proxy
Umbrel richieda autenticazione, che l'accesso diretto tra container non allarghi
il perimetro previsto e che Tdarr resti in pausa dopo il ripristino dello stato.
