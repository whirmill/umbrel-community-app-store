# ZapBot on Umbrel — restart-safe package

Package revision `0.1.31` also installs its reviewed scripts from the community
store during the Umbrel `pre-start` hook. This compensates for the legacy
updater whitelist, which otherwise refreshes Compose and hooks but leaves an
installed app's `scripts/` directory unchanged. The hook copies only from an
exactly matching store manifest, stages and compares every file, and publishes
a version sentinel last; the Compose bootstrap refuses a mixed script/package
revision.

Operator Posture uses a bounded, pool-safe collection path that preserves
completed evidence and reports unfinished sources explicitly. Historical
decision comparison remains available through its dedicated diagnostic RPC,
outside the interactive five-second posture budget.

Entry Burst coverage now proves that a capped command scan reaches beyond the
complete current cluster and expiry horizon. Older truncated history remains
auditable without degrading runtime posture, while incomplete current coverage
still fails closed.

Stable SQL now crosses a single instrumented query boundary with reusable,
versioned prepared-statement identities. Dynamic and control SQL stays
explicitly unnamed, while evidence coverage, causal comparison and feature
backfill use set-based plans that reduce repeated work across API, Hub,
background jobs, release checks and the frontend. Operator Posture also keeps
the last complete snapshot visible during bounded partial refreshes and uses a
summary dashboard that retains every queue and runtime-SLO gate without the
unneeded full-page enrichment fan-out. Shared operational cache misses are
coalesced per key, and the signals receipt runs after the summary has populated
their shared bounded diagnostics instead of duplicating cold database work.
Concurrent clients also share one short-lived, server-owned posture collection
instead of multiplying the entire eleven-source query fan-out. Waiters that
arrive during a slow leader consume that completed generation even when its
semantic TTL elapsed during computation; later callers still recompute.
Interactive and scheduled database workloads now share one pool-aware permit
budget. Per-key single-flight avoids unrelated serialization; dashboard and
posture leaves, alert checks, causal notification groups and independent
retention families can progress concurrently while same-key ordering, atomic
alert admission and bounded connection headroom remain enforced.

This package provides a restart-safe, live-capable ZapBot runtime plus four
individually fenced continuous Trusted V2 evidence producers and one isolated,
one-shot execution-economics acquisition profile. It enables the public LN
Markets market feed, internal consumers, complete event-driven deliberation,
and normal background operational queues. Execution and new-entry authority
remain separate persisted, audited operator-controlled settings. The
only intended Umbrel entry point is the app proxy on port `5237`; database and
application container ports remain private.

## Image admission

Every ZapBot service uses the public multi-architecture image built from the
reviewed source revision `ebe726d3a5963b5f4d0110b8b8b7c3248ba4f7c9` on native
amd64 and arm64 runners, and pinned to the immutable digest
`sha256:3c495de089138cbcd12bde000de717e012ffa577f62bfef0e30e57f23e43e01c`.
Do not substitute `latest` or an unreviewed tag.

Open-position plans carry the canonical continuous exposure reconstructed from
filled and pending venue state, in-flight commands and live reservations, plus
the requested per-lot exposure fraction. An unavailable canonical snapshot
clears the projected exposure and attaches a blocking portfolio-risk receipt;
these evidence fields are never forwarded in the LN Markets adapter payload.
Persisted execution-command envelopes are unwrapped before correlating their
client identifier and requested fraction with reconciled live trades. Direct
legacy payloads remain supported; missing or malformed evidence still blocks
new risk rather than inferring an exposure value.

Strict readiness consumes that same canonical continuous exposure instead of
using active-position count as an exposure proxy. An authoritative flat state
requires both fresh trade-cache and REST-reconcile diagnostics; query errors,
stale rows, missing heartbeats and incomplete exposure or risk evidence remain
blocking. The empty-sandbox shortcut used by legacy tests is explicitly bound
to a test-compiled build and cannot be activated in an Umbrel release by a
runtime-mode or application-setting override.

The runtime database-role receipt now validates the active RiskAuthority
producer by its exact least-privilege catalog contract rather than treating
`LOGIN`/`NOLOGIN` as the safety property. Trusted V2 technical lineage is
reported separately from the campaign-bound legacy statistical admission;
authenticated reports and preregistered sample thresholds remain mandatory
for either a terminal `GO` or `NO_GO` result.

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
- `env/execution-coverage-acquirer/config.env` — temporary isolated LN Markets
  read binding, removed only after the database producer acknowledges commit;
- `env/execution-economics-producer/config.env` — non-secret campaign,
  environment, boundary and cutoff binding for the one-shot producer;
- `handoff/execution-economics/` — two mode-`0600` FIFOs; no artifact file is
  ever persisted;
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
   trading mode. The web healthcheck verifies application readiness, live
   process state and non-observation mode without rewriting the persisted
   execution or entry-mode decision.

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
`/api/health` evidence that the runtime is ready, live and outside observation
mode. The web service starts the internal bus, reconciliation,
candle-persistence, complete event-driven deliberation and normal Oban
operational workers together with the public market stream. The DB-backed
`deliberation_execute_enabled` and `trading_entry_mode` gates remain separately
operator-controlled and survive application and host restarts.

The four producer containers are part of the default restart-safe project but
remain idle until their individual admission markers exist. They use distinct
least-privilege LOGIN roles and isolated configuration/secret mounts. The
markers are `producer-lnmarkets-candles-enabled`,
`producer-coinbase-candles-enabled`, and `producer-lnmarkets-funding-enabled`
and `producer-risk-authority-snapshot-enabled` inside `data/state/`. A marker
is not activation approval:
each producer also requires its own reviewed credentials, TLS, campaign,
boundary, exact baked revision, enable flag and product-level admission.
Execution-economics ingestion is absent from the default project and exists
only under the `execution-economics-ops` Compose profile. For the initial
Umbrel migration, the operator may temporarily copy the current LN Markets
read values into these exact keys in the acquirer file:

```text
ZAPBOT_EXECUTION_COVERAGE_API_KEY=
ZAPBOT_EXECUTION_COVERAGE_API_SECRET=
ZAPBOT_EXECUTION_COVERAGE_API_PASSPHRASE=
ZAPBOT_EXECUTION_COVERAGE_ACCOUNT_ID=
ZAPBOT_DEPLOYMENT_ENVIRONMENT_ID=
TRUSTED_V2_CAMPAIGN_ID=
TRUSTED_V2_FORWARD_BOUNDARY=
TRUSTED_V2_EXECUTION_ECONOMICS_CUTOFF_AT=
```

The producer file contains only the last four non-secret bindings. The
credential initializer generates a one-time raw Ed25519 keypair and a separate
32-byte HMAC key. The producer registers that key through its exact
owner-controlled `SECURITY DEFINER` RPC; it never receives table access or an
administrator credential. The registry remains owner-only and append-only. The acquirer has no database binding; the
producer has no venue credential. They exchange one bounded frame through a
FIFO. After a successful database commit, the producer writes a fixed
acknowledgement through the second FIFO; only then does the acquirer mark the
acquisition consumed and remove its copied LN Markets config, Ed25519 private
key and HMAC file. The public key and database evidence remain verifiable.

The profile uses `POOL_SIZE=1`, caps acquisition pagination at 64 pages per
endpoint, and limits the two temporary BEAM containers to 384 MiB and 512 MiB.
It adds no resident process after completion. Re-acquisition or correction is
an explicit new operation because consumed private material is never silently
regenerated.

Both FIFO participants have a 20-minute deadline. A failed attempt deliberately
keeps retry material and stale FIFOs so that no second run can overlap it. After
investigating the failed containers, recover only the transport with:

```sh
./scripts/recover-execution-economics-handoff.sh
```

The script first proves through Docker Compose labels that neither participant
is running, then removes only owner-`1000`, mode-`0600` FIFO paths. It refuses
regular files, wrong ownership, wrong modes, and any active participant.

## Restart contract

The default Compose project contains the one-shot bootstrap and migration
chain, PostgreSQL, web, app proxy, and four fenced producers. Execution
economics, sealing, attestation, and report writing are profile-only jobs and
never restart automatically. Producer
containers survive host restarts and wait without database access until their
marker exists. The runtime loader preserves the baked image revision, rejects
cross-role identities, and strips unrelated credentials from producers. The
web startup path enables the market stream, internal consumers, complete
event-driven deliberation and normal Oban operational queues:

- `ZAPBOT_OBSERVATION_ONLY=false` (normal Oban operational queues enabled);
- `ZAPBOT_START_DELIBERATION_RUNTIME=true`;
- `ZAPBOT_START_INTERNAL_CONSUMERS=true`; and
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
