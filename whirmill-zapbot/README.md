# ZapBot on Umbrel — restart-safe package

This package provides a restart-safe, manage-only ZapBot runtime plus four
individually fenced Trusted V2 evidence producers. It enables the public LN
Markets market feed, but not deliberation or execution consumers. The
only intended Umbrel entry point is the app proxy on port `5237`; database and
application container ports remain private.

## Image admission

Every ZapBot service uses the public multi-architecture image built from the
reviewed Trusted V2 producer revision `cfa7e824` and pinned to the immutable digest
`sha256:0b39d7ecc56752f0212985e5cd378d962a49f788e799e1f5daf83a9a77246b64`.
Do not substitute `latest` or an unreviewed tag.

PostgreSQL is pinned to the verified PostgreSQL 18 / pgvector 0.8.2 image
digest `pgvector/pgvector:0.8.2-pg18-trixie@sha256:b7337db8fe39d12fe8ecb0003c72680f24479813a744b43154eee6f2eab5a5f3`.

## Persistent local state

All persistent state is under `${APP_DATA_DIR}/data`:

- `postgres/` — private PostgreSQL cluster;
- `tls/` — separated client CA, server material, and init-only CA signing key;
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
   role from a validated non-empty Umbrel app seed and writes only
   service-scoped `0600` files.
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
`new_entries_enabled` is false. The web service forces internal execution
consumers and live deliberation off while retaining the public market stream,
even if an imported environment file contains older enabled values. The
DB-backed `deliberation_execute_enabled` gate remains separately
operator-controlled and must stay false during evidence collection.

The four producer containers are part of the default restart-safe project but
remain idle until their individual admission markers exist. They use distinct
least-privilege LOGIN roles and isolated configuration/secret mounts. The
markers are `producer-lnmarkets-candles-enabled`,
`producer-coinbase-candles-enabled`, and `producer-lnmarkets-funding-enabled`
and `producer-risk-authority-snapshot-enabled` inside `data/state/`. A marker
is not activation approval:
each producer also requires its own reviewed credentials, TLS, campaign,
boundary, exact baked revision, enable flag and product-level admission.
Execution-economics ingestion remains intentionally absent because it requires
an independently provisioned read-only LN Markets acquisition credential and
an isolated framed handoff.

## Restart contract

The default Compose project contains the one-shot bootstrap and migration
chain, PostgreSQL, web, app proxy, and four fenced producers. Producer
containers survive host restarts and wait without database access until their
marker exists. The runtime loader preserves the baked image revision, rejects
cross-role identities, and strips unrelated credentials from producers. The
web startup path keeps only the public market stream enabled:

- `ZAPBOT_OBSERVATION_ONLY=true` (Oban queues and plugins disabled);
- `ZAPBOT_START_DELIBERATION_RUNTIME=false`;
- `ZAPBOT_START_INTERNAL_CONSUMERS=false`; and
- `ZAPBOT_START_MARKET_STREAM=true`.

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
