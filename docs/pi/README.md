# Pi e Pi Durable: indice per sviluppatori e agenti

Questa raccolta documenta **il contratto usato da SatsSurge**, non una versione
generica di Pi. Verificata il 2026-10-09: Pi Durable, Pi AI e Chord **1.1.0**;
applicazione Node **24 o superiore**. La documentazione ufficiale è conservata
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

## Documentazione ufficiale locale

| Argomento | Fonte fissata a v1.1.0 |
|---|---|
| Panoramica Pi | [README](upstream/v1.1.0/README.md) |
| Modelli, provider, autenticazione, streaming | [Pi AI](upstream/v1.1.0/packages/ai/README.md) |
| Loop e strumenti dell'agente in memoria | [Pi Agent Core](upstream/v1.1.0/packages/agent/README.md) |
| CLI e host Coding Agent | [Coding Agent](upstream/v1.1.0/packages/coding-agent/README.md) |
| SDK Coding Agent | [SDK](upstream/v1.1.0/packages/coding-agent/docs/sdk.md) |
| Estensioni Coding Agent, API distinta da Durable | [Extensions](upstream/v1.1.0/packages/coding-agent/docs/extensions.md) |
| Harness, strumenti, recovery e storage | [Pi Durable](upstream/v1.1.0/packages/durable/README.md) |
| Cambiamenti della versione installata | [Durable changelog](upstream/v1.1.0/packages/durable/CHANGELOG.md) |
| Stato, transazioni e contesti | [Chord](upstream/v1.1.0/packages/chord/README.md) |
| Indice completo dei documenti Coding Agent | [Docs index](upstream/v1.1.0/packages/coding-agent/docs/index.md) |
| Sicurezza dell'host Coding Agent | [Security](upstream/v1.1.0/packages/coding-agent/docs/security.md) |
| MCP, specifico del Coding Agent | [MCP](upstream/v1.1.0/packages/coding-agent/docs/mcp.md) |
| Specifica Durable: approfondimento, confrontare con README e tipi | [Spec](upstream/v1.1.0/packages/durable/docs/spec.md) |

Sono inclusi tutti i documenti Markdown di `packages/coding-agent/docs`, le
guide dei componenti principali, gli esempi ufficiali Durable e i tipi TypeScript
del pacchetto Durable realmente installato. Gli esempi sono **riferimenti**:
copiarli o eseguirli non è necessario per usare questa documentazione.

I documenti interni `pico-*` e `chord-delta-*` non sono il contratto pubblico
dell'harness e non vengono inclusi nella raccolta. Alcuni link relativi degli
snapshot upstream puntano a codice o immagini non inclusi: usare l'URL originale
registrato nel manifest per consultarli al medesimo commit.

## Provenienza e manutenzione

- [Manifest delle fonti](SOURCES.json): URL immutabile, commit/versione, data di
  acquisizione, dimensioni e SHA-256 per ogni file conservato.
- [Licenza upstream](upstream/v1.1.0/LICENSE): MIT; gli snapshot sono copiati
  senza modificarne il contenuto.
- `installed/pi-durable-1.1.0/`: dichiarazioni `.d.ts` del pacchetto npm locale;
  provenienza e integrità del lockfile nel manifest, nessuna dipendenza nuova.
- `upgrade-watch/`: changelog di un commit successivo, **non compatibilità
  garantita con l'applicazione corrente**.
- Verifica offline: `python3 docs/pi/scripts/snapshot.py --verify`.
- Riacquisizione esplicita della stessa versione:
  `python3 docs/pi/scripts/snapshot.py --refresh` dalla radice del repository.

Il manifest viene rigenerato dallo script; le guide curate devono essere
rivalutate quando cambiano versione, codice applicativo o confini di autorità.
La verifica degli hash prova la consistenza locale, non la correttezza di ogni
affermazione contenuta nella documentazione.
