# Limpidog on Umbrel

Since 2.0.0 this package runs Limpidog as one `server` container (Node, SQLite).
It serves three listeners; the Umbrel app proxy exposes only the dashboard on
port `5234`.

| Container port | Role | Host port / ingress |
|---|---|---|
| 4001 | operations dashboard | Umbrel app proxy `5234` |
| 4000 | API and WhatsApp webhook | `5235` |
| 4002 | public site | `5236` |

Public ingress goes through Umbrel's official Nginx Proxy Manager app, which
forwards by container name on `umbrel_main_network` to the names of the 1.0.x
containers:

- `api.limpidog.com` -> `http://whirmill-limpidog_api_1:4000`
- `dashboard.limpidog.com` -> `http://whirmill-limpidog_dashboard_1:4001`
- `limpidog.com` -> `http://whirmill-limpidog_site_1:4002`

Since 2.0.1 the `server` container carries those three names as network
aliases and listens on the same ports, so the proxy hosts need no change.
Removing the aliases breaks the public vhosts (502).

Nginx Proxy Manager publishes HTTP on host port `40080` and HTTPS on `40443`.
The router therefore needs external `80 -> Umbrel:40080` and external
`443 -> Umbrel:40443`. Cloudflare records remain DNS-only and are maintained
by the separate Whirmill Cloudflare DDNS app.

While ZapBot remains on OpenShip, preserve it through temporary Nginx Proxy
Manager hosts using HTTPS upstreams and the original Host header:

- `zapbot.satssurge.com` -> `https://192.168.0.209:443`
- `openship.satssurge.com` -> `https://192.168.0.209:443`

Stage the router transition to avoid a certificate gap: move TCP port 80 first,
issue and verify the Nginx Proxy Manager certificates, then move TCP port 443.
The immediate rollback is to restore external TCP ports 80 and 443 to
`192.168.0.209:80` and `192.168.0.209:443` respectively.

## Persistent data

Everything lives in `${APP_DATA_DIR}/data`, mounted at `/data`. The container
runs as UID 1000 (`umbrel`) on a read-only root filesystem and writes only its
own files:

- `operational.sqlite` (+ `-wal`, `-shm`): application records and the derived
  analyses, slot proposals and reports
- `durable.sqlite` (+ `-wal`, `-shm`): the agent chat state
- `lifecycle.json`: the launcher's record of the installed release and schema
- `checkpoints/`: database copies taken before a new release migrates them
  (the two newest are kept)
- `app.lock`: held while the server runs, so only one process writes the data
- `migration/`: the one-off PostgreSQL export used by the 2.0.0 cutover
- `limpidog.env`: optional private runtime settings, passed to the container
  as environment (`env_file`); it must remain untracked, owned by `umbrel` and
  mode `0600`. It carries the authentication keys (`SECRET_KEY_BASE`,
  `AUTH_TOKEN_SALT`, both defaulting to the Umbrel app seed) and the
  OpenRouter, WhatsApp, Google Calendar and Web Push settings.

Application code stays in the immutable container image.

## Cutover from 1.0.x

Version 2.0.0 replaces the PostgreSQL deployment. The data is exported from
PostgreSQL and imported into SQLite once, following the cutover runbook of the
`limpidog-crm` repository; the dashboard needs a new sign-in afterwards.
The folders of the previous deployment stay untouched and unused by 2.0.0:

- `data/postgres`: PostgreSQL cluster, retained for rollback to 1.0.3
- `data/import`, `data/backups`: previous dumps

Rolling back means pinning 1.0.3 again; writes made in 2.0.0 after the cutover
are not copied back to PostgreSQL. Deleting `data/postgres` is a separate,
manual decision once the rollback window has closed.

## Workers

Webhook processing runs by default. To accept deliveries without processing
them, set `OPERATIONAL_WORKER_ENABLED=false` in `data/limpidog.env`. The
Google Calendar import runs only with `CALENDAR_IMPORT_WORKER_ENABLED=true`.
