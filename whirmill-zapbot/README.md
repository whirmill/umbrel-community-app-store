# ZapBot on Umbrel — fenced package

This is an infrastructure reengineering package, not a cutover. It does not
build, publish, install, expose PostgreSQL, or enable any trading producer.
The only intended Umbrel entry point is the app proxy on port `5237`; database
and application container ports remain private.

## Image admission

Every ZapBot service uses the public multi-architecture image built from the
reviewed restart-safe revision `9bab5939` and pinned to the immutable digest
`sha256:6d5a6c9a5f6aad64fe7e915f7b12e80f5fed2df2b8896ce49195fe49e26aa72c`.
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
exactly one matching source directory. Optional restore, restored-object
ownership normalization, role bootstrap, one-shot migration, then
post-migration bootstrap/verifier run in that order. All jobs fail closed and
are safe to repeat:

1. A non-empty `data/import/zapbot.dump` is restored only when its SHA-256
   differs from `data/import/.restored-sha256`. A failed restore writes no new
   marker.
2. A pre-bootstrap normalization step accepts only the exact reviewed
   non-extension `SECURITY DEFINER` inventory, assigns restored application
   objects to the `zapbot_owner` role required by the official contract, and
   removes default PUBLIC execution from those functions. This reconciles the
   administrator ownership produced by `pg_restore --no-owner`; it does not
   bypass the subsequent body, ACL, role, and protected-table verifier.
3. A one-shot credential initializer derives a distinct password per LOGIN
   role from the Umbrel app seed and writes only service-scoped `0600` files.
   The owner is `NOLOGIN`; the migrator is
   the sole non-admin member of it. PostgreSQL creates `vector`, `pgcrypto`,
   and `pg_stat_statements`, then executes the official bootstrap and verifier
   as the PostgreSQL administrator.
4. Migrations use only `zapbot_migrator` plus `SET ROLE zapbot_owner`; the web
   runtime never receives a migration URL.
5. The post-migration step reruns the official bootstrap and verifier as the
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
`new_entries_enabled` is false. During the rehearsal, the web service also
forces the deliberation runtime, the internal consumers, the LN Markets stream,
and Trusted V2 continuous collection off even if an imported environment file
contains older enabled values.

The four producer containers are assigned to the explicit
`zapbot-producers` Compose profile and have `restart: "no"`. A normal Umbrel
start or restart does not create them. The three data producers
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

## Restart contract

The default Compose project contains only the one-shot bootstrap and migration
chain, PostgreSQL, the web runtime, and Umbrel's app proxy. Producer services
appear only when the `zapbot-producers` profile is explicitly selected. The web
runtime receives all three supervision fences as container environment values,
and its startup path reasserts them after loading private settings while
discarding any historical `RELEASE_SYS_CONFIG` override:

- `ZAPBOT_START_DELIBERATION_RUNTIME=false`;
- `ZAPBOT_START_INTERNAL_CONSUMERS=false`; and
- `ZAPBOT_START_MARKET_STREAM=false`.

The admitted ZapBot release must map these values into both the API and Hub
runtime configuration. Its release SQL must also include
`research_forward_holdout_successor_audits` in both the bootstrap protected
matrix and the administrative verifier, granting the runtime role only
`SELECT, INSERT`. Only an immutable image satisfying this contract may replace
the pinned release image above and be used to enable Umbrel autostart.

## Cutover warnings

Treat a healthy database, successful migration, or a responding UI as evidence
only — never as permission to retire the existing deployment, move DNS, enable
new entries, enable producers, or connect real-account credentials. Those are
separate operator decisions with backup, rollback, trading-safety, and live
readiness evidence.
