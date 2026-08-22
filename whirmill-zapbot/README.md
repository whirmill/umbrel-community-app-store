# ZapBot on Umbrel — fenced package

This is an infrastructure reengineering package, not a cutover. It does not
build, publish, install, expose PostgreSQL, or enable any trading producer.
The only intended Umbrel entry point is the app proxy on port `5237`; database
and application container ports remain private.

## Image admission

Every ZapBot service uses the public multi-architecture image built from the
reviewed OpenShip revision and pinned to the immutable digest
`sha256:15242fc640d901904f8eccd50670cc9411891a8fbbd463d4229c368cd6883213`.
Do not substitute `latest` or an unreviewed tag.

PostgreSQL is pinned to the verified PostgreSQL 18 / pgvector 0.8.2 image
digest `pgvector/pgvector:0.8.2-pg18-trixie@sha256:b7337db8fe39d12fe8ecb0003c72680f24479813a744b43154eee6f2eab5a5f3`.

## Persistent local state

All persistent state is under `${APP_DATA_DIR}/data`:

- `postgres/` — private PostgreSQL cluster;
- `tls/` — the private database CA and server material;
- `import/zapbot.dump` — optional PostgreSQL custom-format import;
- `import/.restored-sha256` — only written after a successful restore;
- `release-sql/` — exact reviewed `bootstrap_database_roles.sql` and
  `verify_database_roles.sql` exported from the immutable release image;
- `env/app/config.env` — optional private web configuration;
- `env/producer-*/config.env` — optional, producer-specific configuration;
- `secrets/` — generated per-role database and release secrets; and
- `state/` — explicit app and producer admission markers.

Keep every `config.env` untracked and mode `0600`. The web and each producer
mount only their own configuration directory and generated role-secret
directory; they cannot read another service's API or database credential. A
configuration file must never contain a copied database URL: each service
replaces it with its own least-privilege identity during startup. Only the
one-shot administrator bootstrap/verifier mounts all generated database-role
secrets.

## Bootstrap and migration sequence

PostgreSQL starts with TLS but no host port. The release-SQL exporter copies
only `/app/lib/api-*/priv/sql/bootstrap_database_roles.sql` and
`verify_database_roles.sql`; it fails if the release image does not contain
exactly one matching source directory. Optional restore, role bootstrap,
one-shot migration, then post-migration bootstrap/verifier run in that order.
All jobs fail closed and are safe to repeat:

1. A non-empty `data/import/zapbot.dump` is restored only when its SHA-256
   differs from `data/import/.restored-sha256`. A failed restore writes no new
   marker.
2. A one-shot credential initializer derives a distinct password per LOGIN
   role from the Umbrel app seed and writes only service-scoped `0600` files.
   The owner is `NOLOGIN`; the migrator is
   the sole non-admin member of it. PostgreSQL creates `vector`, `pgcrypto`,
   and `pg_stat_statements`, then executes the official bootstrap and verifier
   as the PostgreSQL administrator.
3. Migrations use only `zapbot_migrator` plus `SET ROLE zapbot_owner`; the web
   runtime never receives a migration URL.
4. The post-migration step reruns the official bootstrap and verifier as the
   PostgreSQL administrator. It does not alter `internal_settings` or force a
   trading mode. A restored database must already demonstrate `manage_only`
   and `new_entries_enabled=false` through the web healthcheck, otherwise the
   application remains unhealthy and cutover is blocked.

Do not put an import dump in place while another authoritative ZapBot stack is
still writing to it. This descriptor has no replication, dual-write, traffic
cutover, rollback, or order-management authority.

## Explicit application admission

After reviewing the migration and normalization receipts, create exactly this
local marker to let the web process start:

```sh
mkdir -p "${APP_DATA_DIR}/data/state"
touch "${APP_DATA_DIR}/data/state/app-enabled"
```

Without it, the web container stays idle and reports healthy only as a fenced,
not-ready process. Once enabled, the healthcheck requires both `/api/ready` and
`/api/health` evidence that the runtime remains `manage_only` and that
`new_entries_enabled` is false.

The four producer containers have `restart: "no"`. The three data producers
have distinct markers: `producer-lnmarkets-candles-enabled`,
`producer-coinbase-candles-enabled`, and `producer-lnmarkets-funding-enabled`
inside `data/state/`. A marker is not activation approval:
each producer also requires its own reviewed credentials, TLS, campaign,
boundary, exact revision and product-level admission. The descriptor supplies
none of them, and each producer's copied `TRUSTED_V2_CONTINUOUS_ENABLED` value
must remain `false` until that separate admission. The RiskAuthority identity
remains canonical `NOLOGIN` with a
null password; its fourth container is permanently hard-disabled and receives
no database credential.

## Cutover warnings

Treat a healthy database, successful migration, or a responding UI as evidence
only — never as permission to retire the existing deployment, move DNS, enable
new entries, enable producers, or connect real-account credentials. Those are
separate operator decisions with backup, rollback, trading-safety, and live
readiness evidence.
