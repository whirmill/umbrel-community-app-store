# Limpidog on Umbrel

This package runs Limpidog as one Umbrel app with separate API, worker,
dashboard, site, migration, restore, and PostgreSQL services. The Umbrel app
proxy exposes only the dashboard on port `5234`.

For public ingress through Umbrel's official Nginx Proxy Manager app, use:

- `dashboard.limpidog.com` -> `http://umbrel.local:5234`
- `api.limpidog.com` -> `http://umbrel.local:5235`
- `limpidog.com` -> `http://umbrel.local:5236`

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

- `data/postgres`: PostgreSQL cluster
- `data/import/limpidog.dump`: optional PostgreSQL custom-format import
- `data/import/.restored-sha256`: checksum of the last successful import
- `data/limpidog.env`: optional private runtime integration settings

Application code stays in the immutable container image. Only data and private
runtime configuration are mounted from `${APP_DATA_DIR}`.

## Safe migration behavior

The import service restores `data/import/limpidog.dump` only when its SHA-256
differs from the last successful import, then the migration service applies
pending Ecto migrations. API, dashboard, site, and worker start only after both
steps succeed.

Background processing is disabled by default. To perform a final cutover, set
these values in the private `data/limpidog.env` and restart the app only after
the old worker has been stopped and the final database dump has been copied:

```dotenv
OPERATIONAL_WORKER_ENABLED=true
CALENDAR_IMPORT_WORKER_ENABLED=true
```

The private environment file must remain untracked and mode `0600`. It can
carry existing Phoenix/authentication, OpenRouter, WhatsApp, Google Calendar,
and Web Push settings. Database URLs and credentials are supplied by Umbrel and
must not be copied from the previous host.
