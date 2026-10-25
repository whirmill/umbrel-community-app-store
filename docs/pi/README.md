# Pi e Pi Durable: indice per sviluppatori e agenti

Questa raccolta documenta **il contratto usato da SatsSurge**, non una versione
generica di Pi. Verificata il 2026-10-09: Pi Durable, Pi AI e Chord **1.1.0**;
applicazione Node **24.x** (candidate gRPC TLS; qualificazione locale su 24.21.0). La documentazione ufficiale è conservata
localmente al commit `abe508e1b89912adde45528136c3221eb69acdd7` del tag `v1.1.0`.
Non serve una connessione Internet per consultare gli snapshot.

## Percorso rapido

1. [Architettura e versioni](architecture.md): distinguere i componenti Pi e
   capire quali sono effettivamente incorporati nell'applicazione.
2. [Pattern Durable e recupero](durable-patterns.md): submission, replay,
   estensioni, storage, strumenti, osservazione e proprietà delle risorse.
3. [Telegram e confini applicativi](telegram-integration.md): ingresso,
   associazione, autorizzazione, proposte, esecuzione, outbox e riavvio.
4. [Aggiornamenti e verifica delle fonti](upgrades.md): confrontare contratti
   senza applicare per errore esempi di una versione diversa.
5. [Complementi nativi e qualificazione](native-complements.md): matrice
   KEEP/THIN ADAPTER/REPLACE/QUALIFY e prove isolate sulla versione 1.1.0.

6. [Lifecycle applicativo](app-lifecycle.md): gate di bootstrap, checkpoint,
   protocollo writer e primo cutover legacy.

## Documentazione ufficiale locale

| Argomento | Fonte fissata a v1.1.0 |
|---|---|
| Panoramica Pi | [README](upstream/v1.1.0/README.md) |
| Modelli, provider, autenticazione, streaming | [Pi AI](upstream/v1.1.0/packages/ai/README.md) |
| Harness, strumenti, recovery e storage | [Pi Durable](upstream/v1.1.0/packages/durable/README.md) |
| Cambiamenti della versione installata | [Durable changelog](upstream/v1.1.0/packages/durable/CHANGELOG.md) |
| Stato, transazioni e contesti | [Chord](upstream/v1.1.0/packages/chord/README.md) |
| Specifica Durable: approfondimento, confrontare con README e tipi | [Spec](upstream/v1.1.0/packages/durable/docs/spec.md) |

Sono incluse solo le guide dei pacchetti che l'app usa (Durable, AI, Chord), la
specifica e gli esempi ufficiali Durable. I tipi TypeScript sono quelli del
pacchetto installato: `whirmill-satssurge-autopilot/node_modules/@earendil-works/pi-durable/dist/`
dopo `npm ci`. Gli esempi sono **riferimenti**: copiarli o eseguirli non è
necessario per usare questa documentazione.

I documenti interni `pico-*` e `chord-delta-*` non sono il contratto pubblico
dell'harness e non vengono inclusi nella raccolta. Alcuni link relativi degli
snapshot upstream puntano a codice o immagini non inclusi: usare l'URL originale
registrato nel manifest per consultarli al medesimo commit.

## Provenienza e manutenzione

- [Manifest delle fonti](SOURCES.json): URL immutabile, commit/versione, data di
  acquisizione, dimensioni e SHA-256 per ogni file conservato.
- [Licenza upstream](upstream/v1.1.0/LICENSE): MIT; gli snapshot sono copiati
  senza modificarne il contenuto.
Le guide curate vanno rivalutate quando cambiano versione, codice applicativo o
confini di autorità. A un aggiornamento di Pi si sostituiscono gli snapshot con
quelli della nuova versione e si aggiorna il manifest (vedi [upgrades](upgrades.md)).
