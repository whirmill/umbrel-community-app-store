# ZapBot package 0.1.85 — due-work queue drain

This release targets unchanged schema243/latest `20261006020000`.
[Source PR635](https://github.com/whirmill/zapbot-exs/pull/635) merged
`b65c67bb17c57f571687b2ba9650e3659c6db2fb`, tree
`454ad3f268ae07ed05e471c4684982b46e74a90f`, after independent CLEAN review.
Oban queue-drain age and backlog now measure due work. Future scheduled jobs
retain their full state counts but add no negative age or due backlog; timestamps
or query results with insufficient evidence remain unknown. Observed due-work
breaches stay visible even when another required projection is unknown. Full state
and historical failure counts remain separate from due workload. Generic freshness,
cache TTL, deadlines, DefaultFlat, manage_only and H4OFF boundaries are unchanged.
No executable admission, transport, canary, activation or trading authority is added.

Exact source CI37462848175 and automatic37462827014 passed all three jobs:
45 CLI,16 core,2945 API and420 Hub tests with zero failures; API had13 skips
and90 excluded cases, Hub had7 excluded cases. Frontend checks passed500 Vitest
and32 browser tests. Full PG18 schema243 fresh/upgrade/ten-row ownerless/224
restore checks passed. Separate36 focused tests on disposable PG18 and a paired
1.2-million-row synthetic benchmark support the regression:54 old queries versus
2 batched queries. These are isolated measurements, not current production SLO
proof. OPS021 addresses the negative due-age regression; OPS009 timeout and
M1c/OPS020 remain open. Monitor SLO closure and canary authority are not claimed.

Native amd64/arm64 image run37464508847 passed all four jobs. Independent
registry bytes, native indices, configs, OCI/build SHA, SLSAv1 source/builder/
arguments and SPDX subjects match. All twelve pins, attestor digest and current
rollback image use:

`ghcr.io/whirmill/zapbot:umbrel-queue-drain-due-b65c67bb17c57f571687b2ba9650e3659c6db2fb@sha256:12d9501edd2189943a724986de85c8f0c5ed1f679b6a22024d930d2dde9022ba`

Package Linux qualification is **PENDING** on this exact new image. The unchanged
fixture and harness must prove ten whole rows through243 restart/ownerless
thirteen-helper NULL-ACL normalization,241→242nine→243ten upgrade and224 restore.
Keep the existing actual old0.1.81-on243 compatibility probe under its accurate
name; it does not claim old0.1.84 compatibility. Each of six projects must show
initial/final container, network and volume absence, successful teardown, absent
compatibility resources/cleaner and fixture removal before aggregate PASS.
All migration, export, predicate, posture and fixture inputs are unchanged.
The PG18 pin and historical0.1.46 tail remain preserved; that tail grants no
rollback approval. No backup, credential, flag or risk-setting change is included.
OPS-010 real fresh empty-PGDATA startup remains unqualified.

Previous package notes follow unchanged.

# ZapBot package 0.1.84 — canonical technical H4 policy

This release targets unchanged schema243/latest `20261006020000`.
[Source PR633](https://github.com/whirmill/zapbot-exs/pull/633) merged
`745b7c383667caf921ec55f06496aec63136c607`, tree
`2ca8a4be958c8f63a0cf3176c066a7ea9efb132b`, after independent CLEAN review.
Typed canonical H4 policy/plan state uses Donchian120/ATR20 and no take-profit.
DecisionCore integrates the technical state into its reducer and durable causal
cursor; the Engine rejects executor commands for this policy. DefaultFlat,
manage_only and H4OFF remain preserved. Positive executable atomic admission,
reservation and mandatory transport remain future work. No live qualification,
enrollment, activation or increased authority is added.

Corrected exact source CI37439997555 and automatic37439520028 passed all three
jobs:45 CLI,16 core,2938 API and420 Hub tests with zero failures; API had13
skips, including explicitly gated standalone cases. Independent24 pure core/codec tests,64 pure regressions and3 physical
nativePG17 persistence/concurrency tests remain distinct from full PG18 CI. Both initial735f CI attempts
failed three plan tests because another test module was unavailable. Their logs
remain preserved; compiled fixture support fixes that loading dependency.
Full PG18 schema243 fresh/upgrade/ten-row ownerless/224 restore checks passed.

Native amd64/arm64 image run37441564076 passed all four jobs. Independent
registry bytes, native indices, configs, OCI/build SHA, SLSAv1 source/builder/
arguments and SPDX subjects match. All twelve pins, attestor digest and current
rollback image use:

`ghcr.io/whirmill/zapbot:umbrel-h4-canonical-policy-745b7c383667caf921ec55f06496aec63136c607@sha256:26453c0b96511b26ea5087ccdb97933a7153f2f17f66e2a7722f517b5b8644c6`

Package Linux qualification is **PENDING** on this exact new image. The unchanged
fixture and harness must prove ten whole rows through243 restart/ownerless
thirteen-helper NULL-ACL normalization,241→242nine→243ten upgrade and224 restore.
Keep the existing actual old0.1.81-on243 compatibility probe under its accurate
name; it does not claim old0.1.83 compatibility. Each of six projects must show
initial/final container, network and volume absence, successful teardown, absent
compatibility resources/cleaner and fixture removal before aggregate PASS.
All migration, export, predicate, posture and fixture inputs are unchanged.
The PG18 pin and historical0.1.46 tail remain preserved; that tail grants no
rollback approval. No backup, credential, flag or risk-setting change is included.
OPS-010 real fresh empty-PGDATA startup remains unqualified.

Previous package notes follow unchanged.

# ZapBot on Umbrel — restart-safe package

Package revision **0.1.83** targets unchanged schema243/latest
`20261006020000`. [Source PR631](https://github.com/whirmill/zapbot-exs/pull/631)
merged `fe21e691c91c72db5d1d87ee097ab3fbdae9277b`, tree
`f375aa5307e1688fdc3197fa5bf0e5e1984419e4`, after corrected independent CLEAN review.
Dormant H4 guards reject generic positive command/reservation paths and
conflicting declarations before effects, including canonical claim/mirror replay
and Hub dispatch. H4 remains default OFF. Dedicated positive atomic policy
admission/reservation/VENUE consumption and mandatory transport are still future
work; no live authority, enrollment, provider transport or activation is granted.
Protective non-H4 behavior and historical evidence remain preserved.

Exact source CI37414479128 and automatic37414471629 passed all three jobs,
including PG18 schema243 fresh/upgrade/ten-row ownerless restore. Actual backend
results:45 CLI,16 core,2922 API and420 Hub tests with zero failures. API had10
skips, including nine explicitly gated standalone native cases; their corrected
nativePG17 nine-case proof is separate. Source also passed64 pure regressions
and three original-map ingress/guard audit cases. Original P2 findings and
reproduction receipts remain retained after correction.

Native amd64/arm64 image run37415478242 passed all four jobs; registry byte
hashes, native platform indices, runtime configs, OCI/build SHA, SLSAv1 source/
builder/arguments and SPDX subjects independently match. All twelve application
pins, attestor digest and current rollback image use:

`ghcr.io/whirmill/zapbot:umbrel-h4-policy-boundary-fe21e691c91c72db5d1d87ee097ab3fbdae9277b@sha256:34efaeb2e0c8c0151805d54650e5a6cb37ab0777249ad3a1aeab3b6878dd45ff`

Package Linux qualification is **PENDING** on this new exact image. Reuse the
unchanged ten-row fixture, thirteen-helper/four-contract ownerless checks,
241→242nine→243ten upgrades,224 restore, restart and runtime posture assertions;
retain the actual old0.1.81-on243 compatibility probe under its accurate name.
The previous0.1.82 package proof does not qualify this new image. Every six-project
container/network/volume inventory and named cleaner must be absent, with
fixture removal complete before final PASS. Existing migration, SQL predicates,
normalizer and fixtures are unchanged. The PG18 pin and legacy0.1.46 tail are
preserved; that historical tail is not approval to run a rollback. No backup,
production credential, flag or risk-setting change is included. OPS-010 real
fresh empty-PGDATA startup remains unqualified.

The following0.1.82 record is preserved verbatim as preceding-release history;
its pending/installed statements describe that earlier record.

Package revision **0.1.82** targets schema 243/latest `20261006020000`.
[Source PR629](https://github.com/whirmill/zapbot-exs/pull/629) merged
`fc3f22d0acc0e18a0ce2816c51dbc79c0d3ed297`, tree
`26f66a34419f886adfe41ad150ee32f0b3c441ae`, after independent CLEAN review.
The additive fourth VENUE table permanently records a single-use consumption;
physical COMMIT readback, original canonical bytes, identifiers and physical
clocks bind its receipt. It adds no live consumer, callback, HTTP consumption,
provider transport or current capability. Aggregate qualifications remain false.

Exact source CI37394735846 and separate automatic PR CI37394726216 passed
all three jobs. Actual PG18 checks retained nine original schema242 rows through
243 and ten complete rows across ownerless restore, including thirteen explicitly
named VENUE helpers and NULL ACL normalization. Native amd64/arm64 image run
37395651977 passed all four jobs. Registry bytes, OCI revision/build SHA,
SLSAv1 provenance and SPDX subjects independently match the runtime manifests.
All twelve application pins, attestor digest and current rollback image use:

`ghcr.io/whirmill/zapbot:umbrel-venue-consumption-fc3f22d0acc0e18a0ce2816c51dbc79c0d3ed297@sha256:fc167509facacd7423ad17c57181873c9b1aa0fd98108e4ace0dcd1ee7dfa4ab`

Package Linux qualification is **PENDING**. The isolated fixture must retain all
ten original rows through upgrade, restore and restart, boot the previous0.1.81
API/Repo against upgraded schema243 with dummy credentials/internal networking,
and report the new nested runtime contract boolean. Every owned project must
have independently empty container, network and volume inventories, the named
cleaner must be absent, and fixture removal must finish before final PASS.
Local pure/mock checks do not qualify installation or OPS-010 real Umbrel
fresh-PGDATA startup. No backups, destructive downgrade, live binding, key
provisioning or risk-setting change is part of this release. The legacy0.1.46
compatibility tail is retained history, not approval to run a rollback.

The following0.1.81 record is preserved verbatim as preceding-release history;
its pending/installed statements describe that earlier record.

Package revision **0.1.81** targets schema 242/latest `20261006010000`.
[Source PR627](https://github.com/whirmill/zapbot-exs/pull/627) merged as
`257a3783e9741bb68cfe86fbe1b570a988eb5e6d`, tree
`8e4da45ee72d9330985db54ca7c537f6cd0b084b`, after final independent CLEAN review.
[Exact source CI37374666540](https://github.com/whirmill/zapbot-exs/actions/runs/37374666540)
passed all three jobs: 45/16/2885/417 umbrella tests with zero failures,
one skipped and 97 excluded; 500 frontend unit tests, 32 browser tests and
19+3+10 routine/harness/wrapper tests. The first dispatched backend and automatic
PR frontend jobs failed hosted-runner acquisition before any steps; those
receipts remain retained. One authorized failed-job retry passed on the same
head. Actual PG18 checks passed fresh/restart schema242, 224-to-241-to-242,
retained six-row 241 graph, retained three-row VENUE graph, ownerless242 VENUE
slice and ownerless224 restore. Client18.6 and service-server18.4 are separate.

[Native image build37377964791](https://github.com/whirmill/zapbot-exs/actions/runs/37377964791)
passed all four jobs. All twelve app images, the attestor digest and current
rollback image pin
`ghcr.io/whirmill/zapbot:umbrel-venue-domain-storage-257a3783e9741bb68cfe86fbe1b570a988eb5e6d`
at index `sha256:4a8806a277dc9481ec7e09be7931f692ccb858bb8dec0ae97e44e1ba7a53a9ed`.
The SHA alias matches. Native amd64 manifest
`sha256:70b8b1a159795fe638e0cd11d9ab0f1988bac7176f2033f943809b72a386f53a`
and arm64 manifest
`sha256:1fd87da3a1aa2b1e5dc5c971719f92282c9e52f9933b0ca72faeb4c610a013b0`
were independently verified with config/OCI/build SHA, SLSAv1 source, build
arguments, builder and subjects, and SPDX subjects. PG18 and legacy0.1.46
rollback pins are unchanged. The installed0.1.80/ca692ab6 image remains a
separate actual application-boot compatibility fixture; legacy tail/sleep
processes do not qualify that boot.

The increment stores separate immutable `lnm_prepared_intent_venue_pins`,
`lnm_prepared_intent_venue_profiles` and `lnm_prepared_intent_venue_bindings`.
Its exact predicate covers owner-only table/column/function ACLs (including
NULL function ACL), helper bodies, columns, constraints, indexes and nine
ALWAYS trigger bindings. Stored identity includes original canonical/signed
bytes and physical registration clocks. The package mirror verifies copied
source fixture hashes and historical profile/parent/wire signatures at the
original12:00Z clock; current validity and consumption remain false, authority
none. It never turns historical verification into fresh capability.

This candidate is **uninstalled**. Exact-image Linux qualification and final
package review remain required before publication or an existing-data update.
The schema241 route retains all original six consumption rows through the
additive migration, adds three VENUE rows, then verifies restart retention.
The schema224 restore route advances to242, seeds nine rows and verifies
restart. Current ownerless242 restore retains all nine whole rows. It separately boots the installed0.1.80 API/Repo against the upgraded
nonempty schema with dummy runtime credentials and an internal-only network,
no internal consumers or background jobs, then proves exact resource cleanup.
New-image boot must report the nested runtime contract boolean true. These
Linux templates remain **NOT RUN**; static/mock tests and source CI do not
qualify application installation. No consumer, callback, HTTP consumption,
provider action, enrollment, real key, risk-setting change or backup is added.
Aggregate qualifications remain false. Fresh empty-PGDATA remains **BLOCKED**
by OPS-010.

The following0.1.80 evidence is retained verbatim as preceding-release history;
its pending/installed statements describe that earlier record.

Package revision **0.1.80** targets schema 241/latest `20261005020000`,
including eleven exact consumption-contract helpers. Source PR622 merged
`ca692ab6e81951a1d7875b41220cc4bde3808275` (tree
`e5e6e8f088b294a123259169b8af5a6dc060cd87`) after corrected CLEAN review.
[Source CI37273039224](https://github.com/whirmill/zapbot-exs/actions/runs/37273039224)
passed all three jobs: 3287 backend tests, one skipped and 97 excluded;
500 frontend unit tests, 32 browser tests and 19 coordination checks. Actual
PostgreSQL18 fresh schema241, upgrade224 and ownerless restore224 passed.

[Image build37273797921](https://github.com/whirmill/zapbot-exs/actions/runs/37273797921)
passed all four jobs. All twelve app images, the attestor digest and rollback
current image now pin `ghcr.io/whirmill/zapbot:umbrel-precall-consumption-ca692ab6e81951a1d7875b41220cc4bde3808275`
at index `sha256:17ff13fb9ee14eb06f825d98f15d99e3cb3144c1c2f10b8d1a551664addbeed3`.
The native amd64 manifest is `sha256:aaec85d147ffddd5b1346bac9e4c9ac94c57ebbc9f6fbf17520461734e1de19d`;
arm64 is `sha256:224294badfb29caf7aaf5f9105286adfec3d3c664127be2fe10631987c329432`.
Both OCI/build revisions and SLSAv1 provenance match the exact source and
workflow. The first read-only verifier assumed obsolete SLSAv0.2 (session10328);
corrected v1 verification passed (session59884), without rebuilding. The legacy
0.1.46 rollback runtime pin remains unchanged.

This release is uninstalled. Exact-image Linux populated six-table ownerless
restore/repeat/rollback, historical signature verification, retained single-use
checks, restore224 and final package review remain required before publication.
The native PostgreSQL17 six-row cryptographic retention proof is separate from
those pending Linux gates. Dormant owner-only immutable consumption storage and
the default-OFF create_order guard confer no producer LOGIN or live authority. Current `.invalid` fixtures do not qualify provider execution.
Fresh empty-PGDATA remains **BLOCKED** by OPS-010. First source CI37271930151 and
preceding-package attestor CI37253476560 failures retain their original evidence.

The disposable Linux lifecycle mounts the exact copied SQL/public JSON/Elixir
checker assets into a fresh exact-image release eval. To honor their explicit
local-test guards, it temporarily renames only the owned, client-free lifecycle
database to `zapbot_test_package_consumption`, checks the same database OID and
restores its name on success or failure. It never terminates other clients.
The checker starts database/crypto dependencies without API, Hub, producers or
account credentials. An exclusive whole-row baseline is captured after seeding
and compared after actual ownerless restore, repeated initialization and software
rollback. Historical profile/parent/wire signature reverification is separate
from current expiry rejection; retained consumption is independently read back
and a second SQL claim must fail uniqueness. No current admission, provider
transport, live resend or production backup qualification is inferred. These
exact-image Linux checks are implemented templates and remain **NOT RUN**.
Verified source/image receipts now exist; Linux qualification and final package
review remain pending.

The following0.1.79 evidence is retained as preceding-release history:

Package revision **0.1.79** targets schema 240 through `20261005010000`
with the verified immutable precall-bindings source image. Source review/CI
and both native image architectures passed. Exact-image Linux package
lifecycle with restore-224 and final package review remain required before
publication, package merge or an existing-data update. No package lifecycle,
package merge or installation receipt is claimed here.

First package CI37253476560 rejected the attestor's stale preceding-image
`ZAPBOT_RELEASE_IMAGE_DIGEST` at the package image-pin guard before image pull
or any Docker lifecycle. Its job logs and artifact remain preserved. The
attestor now pins the same verified index as the twelve app images and rollback
current image. A new exact-image Linux lifecycle and review are still required.
Fresh empty-PGDATA installation remains **BLOCKED** by OPS-010.

Source [PR620](https://github.com/whirmill/zapbot-exs/pull/620) merged as
`4d84efb20d9c5f58859456078c288afb89bc353b`, tree
`9397249242bd7f98a1fe35a924beea9abdbb1e1f`, after CLEAN review of the final
19 source files. Exact source [CI37251509725](https://github.com/whirmill/zapbot-exs/actions/runs/37251509725)
passed all three jobs: 3261 backend tests passed, 1 skipped and 97 excluded;
500 frontend unit tests, 32 browser tests and 19 coordination checks passed.
PostgreSQL 18 fresh migration, schema-224 upgrade and ownerless schema-224
restore passed at schema 240/latest `20261005010000`. The earlier failed
CI37249667827 remains preserved as diagnostic evidence.

Native [image build37252166877](https://github.com/whirmill/zapbot-exs/actions/runs/37252166877)
passed all four jobs, including both native architectures and registry index
verification. The immutable tag
`umbrel-precall-bindings-4d84efb20d9c5f58859456078c288afb89bc353b`
and `sha-4d84efb20d9c5f58859456078c288afb89bc353b` alias resolve to index
`sha256:f3747d99ef5876e3470e2538b11ccb26114e174dc76683a9dc0d9e32b64f4c51`.
The linux/amd64 manifest is
`sha256:d41e50f0fd48f54cfcdd35f8e6ffa1ff1635a885c39780c8f282e03274178f67`;
the linux/arm64 manifest is
`sha256:95bda5dfe0794ef244b9c82aaa040422d9ed926c6cd0d25a6037b4d3f0e8858e`.
Raw index hashing, both platform OCI revision/version labels and
`ZAPBOT_BUILD_GIT_COMMIT_SHA` match the merged source. All twelve app image
pins and the rollback current-image pin use this same immutable index.

Separate native PostgreSQL 17.11 qualification restored one synthetic row in
each of all five prepared-intent tables through a selected-table ownerless,
privilege-free dump. Every column, original signed parent/profile bytes,
signatures, strict wire/entity bytes and binding remained identical; restored
cryptographic reverification and exact retry passed. It rejected 30 immutable
mutations under origin/replica modes and six runtime table/helper accesses.
The exact catalog was false before normalization and true after scoped
bootstrap/verifiers. This qualifies native synthetic nonempty retention only;
it does not qualify a production full-database backup or exact-image Linux
nonempty profile/receipt retention. No credentials, producer LOGIN, runtime
consumer, transport ordering or authority changed.

The increment adds dormant owner-only `lnm_prepared_intent_producer_pins`,
`lnm_prepared_intent_governance_profiles` and
`lnm_prepared_intent_precall_receipts`, with four SECURITY INVOKER helpers and
nine ALWAYS trigger bindings. The source store authenticates separate intent
and governance pins, verifies the original signed parent and strict wire bytes,
and acknowledges immutable profile/parent/wire/attempt bindings only after a
top-level database COMMIT. Exact identity retries retain the original binding.
This qualifies committed binding storage only. It provisions no production
producer LOGIN, private credential, runtime receipt consumer or mandatory
transport ordering; it proves no venue arrival, settlement or resend permission.
Authority remains none, admission false, liabilities unknown, capital null and
generated live actions 0. OPS020/M1c remains open.

The package lifecycle and rollback scripts embed the exact catalog predicate
from source `apps/api/priv/sql/lnm_prepared_intent_precall_contract.sql`, also
consumed by RuntimeDatabaseRole and the standalone verifier. It pins all three
tables' ownership, table/column ACLs, columns/defaults, validated/enforced
constraints, indexes, four function bodies/configurations/ACLs, and nine trigger
bindings, including PostgreSQL 18 NOT NULL constraint metadata. Existing schema
contracts remain required. Linux qualification must reject tampered contracts,
retain stored rows across repeat startup/ownerless restore/rollback, and verify
fresh startup, 229-to-240 upgrade and restore-224. Package SQL fixtures do not
prove Ed25519 verification or independent backend COMMIT; those are separate
source test evidence. The package fixture seeds one synthetic producer pin;
governance-profile and precall-receipt collections remain empty in this
package fixture, so exact-image Linux nonempty retention of those two stores
remains unqualified despite the separate native synthetic proof. Full
exact-image lifecycle remains pending.

The preceding 0.1.77 package fixed restricted-runtime settlement provenance
hashing without widening privileges; this image retains that correction.

The preceding `0.1.76` release added `execution.settlement_provenance.status@v1`, a
read-only RPC for 1–100 explicitly requested canonical command IDs. One
PostgreSQL statement observes command, outcome and transition rows under a
consistent MVCC snapshot; bounded row counts and truncation flags prevent a
partial history from masquerading as a complete one. Row hashes and the content
root identify the observed mutable snapshot, not immutable provider settlement.
Wrong-scope identifiers are suppressed. Missing rows, local statuses and
correlated outcomes do not prove provider settlement or global absence. Every
command remains unresolved; liabilities and available capital remain unknown,
with admission disabled. That increment added no policy, ACL, migration,
scheduler, acquisition, producer credential, trading authority or risk-setting
change.

The preceding `0.1.75` release adds the pure, fixture-only `ActiveLiabilityAssessment`.
It verifies the signed active-funding artifact before interpreting economic
components, reports exact per-trade and separate open/running subtotals, and
compares fixture commands with explicit trade/client identity and scope. Unknown
or conflicting evidence never releases a reservation. It retains
`authority=none`, `admission_eligible=false`, `funding_complete=false`,
`liabilities_status=unknown`, and no available-capital result. No scheduler,
acquisition, API/RPC, database contract or live admission is enabled. This
engineering increment does not qualify provider completeness or H4 activation.

The DNS correction from `0.1.74` is retained. The web runtime, three external
market-data producers (LN Markets candles/funding and Coinbase candles), and
the optional execution-coverage acquirer explicitly use
`dns: [9.9.9.9, 8.8.8.8]`. These were the two responsive existing host
upstreams during diagnosis; queries to the preceding first upstream did not
receive a response. Docker embedded DNS still resolves private service aliases.
The host DNS configuration, database, migrations and internal-only services
are unchanged. Schema 238 is retained with a new immutable source image.

Resolver and HTTP/connect deadlines remain unchanged. Increasing the libc
resolver timeout alone failed native BEAM lookup; additionally increasing
BEAM's startup resolver timeout allowed lookup but still exceeded the existing
Req connect deadline. This package instead avoids the observed unresponsive
upstream within the five external-consumer containers. If either selected
upstream later becomes unresponsive, failover may again exceed the original
request deadline; a total DNS outage still fails closed. This is not a general
DNS-outage or slow-failover guarantee. Sites requiring private/split-horizon
public-name resolution must review these explicit public resolvers before use.

After update, verify the five containers' effective DNS list, native public-name
resolution, private PostgreSQL resolution and application health. Configuration
changes require container recreation. To reverse this correction, restore the
reviewed `0.1.73` package through the normal package update path and recreate its
services; no image rollback or down migration is needed, but the original
inherited-upstream failure can return. Recheck health and persisted safety posture.

`python3 tests/zapbot-dns-selection.py` runs the deterministic local Docker
regression with the pinned image and disposable DNS/HTTP fixtures. It asserts
the five-service scope, reproduces the old silent-first-upstream failure,
checks native BEAM and Req against responsive selected upstreams, verifies
private aliases, and checks bounded outage failure and subsequent recovery.
Fixture DNS answers only `.invalid` names and never forwards. The test needs
Docker and Python 3, uses no production credentials or public DNS, and removes
its own containers and network on success, failure or interruption.

Schema 238 stores a signed, parent-bound active-funding acquisition in an
immutable table. Its validator binds the parent acquisition and canonical raw
evidence, verifies the database attestation, and keeps the producer's database
role narrow and NOLOGIN. The portable acquisition still requires an explicit,
unscheduled read with a dedicated credential. Venue pagination and integral-
satoshi fee behavior remain unqualified. The stored artifact has
`authority=none`, `admission_eligible=false`, `funding_complete=false`, and
`liabilities_status=unknown`; it provides no capital or H4 admission.

Schema 237 adds immutable `lnmarkets_global_current_reconciliation_receipts`.
For the flat default account, a receipt binds the signed account acquisition,
canonical raw evidence, identity observation, outstanding command and
reservation roots, and terminal execution-economics coverage. Missing or
conflicting evidence produces a blocked receipt. Every receipt has
`authority=none` and `admission_eligible=false`; no H4 admission, live trading
authority, scheduler, producer credential, or new exposure is enabled. The
source verifier pins the table shape, constraints, function bodies, ACLs, and
immutable triggers. The package normalizer checks the two SECURITY DEFINER
bodies before re-owning an ownerless restore.

The package retains the source-owned
`lnmarkets_account_active_snapshot_raw_evidence@v1` companion for the existing
signed account-snapshot parent. Canonical text and its roots are replayable;
JSONB values are non-authoritative projections. The companion is immutable and
parent-bound with `authority=none`, `admission_eligible=false`, and
`reconciliation_complete=false`. It adds no scheduler, RPC, live binding,
current-producer activation, or secret-key access. The existing account
reconciliation producer remains NOLOGIN, has no generated credential or runtime
grant, and receives only the source-verified narrow relation ACL.

Before an ownerless current-schema restore is re-owned, the package pins the
exact helper and trigger-function bodies:
`lnm_account_snapshot_raw_rows_valid(jsonb,text)`
(`9deb39db22dbab0b42fac685cbde0cd9a0c156cfaeebcdf4069310997e78dcf9`),
`reject_lnm_account_snapshot_raw_evidence_mutation()`
(`aa21e2fdce4fe3725b0b8b25ad88db2a647887d5e3f6904ec8d2ae4778a02a53`), and
`validate_lnm_account_snapshot_raw_evidence_insert()`
(`3a09d84b1625edd066c3b7fcb14ff9290bb9a2c3d6aecb88c9800b0dab812192`).

The existing migration added `h4_canary_economics_evidence_receipts` and
`materialize_h4_canary_economics_evidence(uuid)`. It can derive an internal,
append-only receipt from canonical execution-economics heartbeat, artifact and
producer-receipt lineage. Each row is constrained to `authority=none`,
`admission_eligible=false`, and `TERMINAL_REALIZED_ONLY`; it has no live
admission, execution, scheduling, producer, risk, entry-mode, exposure or
activation wiring. The materializer is expected to retain source hash
`0608e68275edf2b1faf82641f104a887ef0127b400f9bd15724a7f6434d7995e`.

The preceding 0.1.76 schema-238 package passed its exact-image Linux
restore-224 lifecycle, but its installed read-only provenance RPC failed under
the restricted runtime role. This 0.1.79 candidate requires a new exact-image Linux
restore-224 CI receipt before package merge; its local lifecycle is NOT RUN
because Docker Desktop's VM route is unavailable. That local tooling failure is
separate from the still-open OPS-010 fresh-install blocker. The release SQL
exporter remains authoritative for source bootstrap and verifier SQL; the
package does not copy or recreate those contracts.

Credential initialization completes before the release-SQL exporter runs. The
exporter then runs before every SQL consumer, exports the reviewed files from
the immutable image, and requires each consumer to verify their checksums. It
then permits the ordered migration and full post-migration verification
sequence.

Package revision `0.1.42` also installs its reviewed scripts from the community
store during the Umbrel `pre-start` hook. This compensates for the legacy
updater whitelist, which otherwise refreshes Compose and hooks but leaves an
installed app's `scripts/` directory unchanged. The hook copies only from an
exactly matching store manifest, stages and compares every file, and publishes
a version sentinel last; the Compose bootstrap refuses a mixed script/package
revision.

Version `0.1.42` also corrects the pre-migration bootstrap predicate introduced
in `0.1.41`. Existing functions are checked without an SQL NULL comparison when
the new causal-label function has not yet been created. After migrations, the
administrative verifier still requires the new function, its exact body and
the causal-attestation trigger. This covers upgrades from the preceding schema
as well as repeated startup after migration.

This revision stabilizes learning-label retries and causal availability,
protects normalization bases, validates every consumed aggregation window,
and corrects research monetary conversion, effective sample size and pipeline
degradation reporting. Its startup normalization allowlist includes the exact
new causal-label attestation function, preserving strict inventory checks on
later restarts.

Passive execution-evidence capture is present with both capability and enable
switches default-off. It observes existing execution attempts only when
separately activated; this package creates no additional orders or collection
admission. A local pre-dispatch quote is not physical venue arrival and order
acceptance is not a fill. Captures remain unassigned to development or holdout.
Use the read-only `mix zapbot.cli prod passive-evidence --json` diagnostic to
verify effective gates and bounded recorder status. Installing this package
does not implement or authorize the future horizon recommendation.

Operator Posture uses a bounded, pool-safe collection path that preserves
completed evidence and reports unfinished sources explicitly. Historical
decision comparison remains available through its dedicated diagnostic RPC,
outside the interactive five-second posture budget.

The clean-slate alpha foundation is present only as an unbound, default-off
contract. A future learned challenger may approve or veto the exact side and
template independently produced by a code-owned technical policy; it cannot
construct or modify a thesis, order plan, size, leverage, margin, stop, target,
exposure, executor or risk setting. Proposal identity binds causal features,
artifact, dataset, protocol, exact policy configuration and loaded BEAM code.
Missing, future, expired, OOD, low-quality or mismatched evidence resolves to
flat, never to a technical-analysis-only fallback. No live route is connected.

Operator diagnostics now use the Umbrel origin instead of the retired public
hostname, accept separate mode-`0600` token files for read and control access,
and expose the bounded `decision.engine.posture` receipt through the read-only
RPC catalog. The flat-cache provenance path retains its test-only fail-closed
semantics without emitting compiler warnings. No entry mode, execution path,
position sizing, exposure, leverage or risk-control setting changes.

Execution preflight now gives GraphRuntime's canonical continuous market and
direction exposure maps precedence over legacy concentration keys. The legacy
fallback remains available for older envelopes, while malformed or unavailable
canonical evidence still fails closed. Structured Trusted V2 provider failures
are classified before transaction entry and reported only with a fixed,
sanitized diagnostic code; retry, restart and checkpoint atomicity are unchanged.

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

Trusted V2 candle diagnostics now retain the preceding closed boundary through
the producer receipt-visibility window, then advance atomically to current time.
Fresh campaigns clamp that diagnostic cutoff just beyond their own holdout start,
while non-candle sources remain current and fail closed. The path uses the
existing runtime-authorized three-argument coverage function and does not alter
sealing, admission, readiness, execution, settings, risk or trading contracts.

This package provides a restart-safe, live-capable ZapBot runtime plus four
individually fenced continuous Trusted V2 evidence producers and one isolated,
one-shot execution-economics acquisition profile. It enables the public LN
Markets market feed, internal consumers, complete event-driven deliberation,
and normal background operational queues. Execution and new-entry authority
remain separate persisted, audited operator-controlled settings. The
only intended Umbrel entry point is the app proxy on port `5237`; database and
application container ports remain private.

## Prepared fixture restore and rollback

The existing generic restore normalizer reowns all six public nonextension
SECURITY INVOKER functions and both tables. They require no SECURITY DEFINER
allowlist extension. The ownerless schema 240 gate rejects a function promoted to an
unreviewed SECURITY DEFINER before reownership; the exported source verifier
then rejects altered invoker bodies, grants and other catalog tampering.

Rollback retains schema 240 and every original fixture/context row. The migration
`down` refuses destructive removal; software rollback uses the qualified current
SQL/bootstrap/verifier image while fencing the 0.1.46 long-lived services. An old
package unable to verify schema 240 is not a qualified database downgrade path.

Use the supported authenticated Umbrel updater after qualification. Installed
Umbrel exposes `umbreld client apps.update.mutate --appId whirmill-zapbot` and
`apps.state.query --appId whirmill-zapbot`; headless system authentication is
not established because the root-only CLI requires sudo authentication. Never
extract or alter the system credential. An available authenticated browser
updater session can supply the supported update path. Browser login is not
required for post-update agent CLI diagnostics: use the existing operator-owned
read-token file with `mix zapbot.cli prod check` and the scoped database-role
catalog RPC. Check the installed version sentinel, exact merged Compose/image,
all startup one-shots, schema 240/catalog contract, health, manage-only/entries
false, complete ledger and clear signals. These checks do not claim browser UAT.

## Image admission

Every current Compose reference, the Trusted V2 attestor digest, and the
rollback current image use source merge `cb39214d54290a787aad2f6e8a5681771f852580`
at immutable
`ghcr.io/whirmill/zapbot:umbrel-prepared-intent-store-cb39214d54290a787aad2f6e8a5681771f852580@sha256:cae6e3972976e75ea6083f2b57addd12eb1195392a4bbebe4e4ddadf151c58d8`.
The OCI index contains native `linux/amd64` manifest
`sha256:ab6236bacc44d05cdf78c80f13f0cc3b37eda6830eb211c5d38d435d8b1a72f4`
and `linux/arm64` manifest
`sha256:6465af683751cca131be70a2684d670f33a6445fda35b91f4286f4728ce338ea`.
Both platform OCI revision labels and build SHAs match the source merge, and the
immutable `sha-cb39214d54290a787aad2f6e8a5681771f852580` alias resolves to the
same index. All 12 Compose application image pins, the attestor digest and rollback
`current_image` agree: 13 full image references across Compose and rollback.
Do not substitute `latest`, a mutable tag or an unmatched digest. These image
receipts do not substitute for the pending exact-image Linux package lifecycle
and final review.

## Qualification scope

The lifecycle waits on exactly one container ID selected across all states.
This avoids Compose versions that omit already-exited one-shot services from
`compose wait`. Both Docker CLI failure and a nonzero container exit remain
failures; success also requires `exited:0`. Run
`sh tests/zapbot-one-shot-wait.sh` for the real-Docker regression covering fast
success, fast failure, invalid/ambiguous IDs and a missing-container CLI error.

The preceding 0.1.76 schema-238 package passed its full Linux lifecycle, but
the installed read-only RPC failed on restricted-role hashing. The 0.1.79
lifecycle must check fresh and repeat startup, ownerless current-schema restore,
schema-229-to-240 upgrade, function/ACL/trigger/constraint tampering, and the
fenced 0.1.46 compatibility overlay. Its exact-image full Linux restore-224 CI
receipt and final review are required before package merge. The local 0.1.79
lifecycle is NOT RUN because Docker Desktop's VM route is unavailable. An
existing-data Umbrel update requires the exact merged manifest and image
readback.

Fresh empty-PGDATA installation remains **BLOCKED** by OPS-010. Both local full
restore-224 observations include an initial temporary `pg_ctl` wrong-ownership
failure during PostgreSQL initialization before a later normal server start; they
do not prove the root cause or the safety of the UID 0/999 transition. The
PostgreSQL image and service configuration are unchanged in this package. Do not
treat a later healthy process, an existing-data update result, or the required
Linux CI result as fresh-install qualification.

## Compatibility rollback to 0.1.46

The package provides a compatibility overlay for the 0.1.46 long-lived web
runtime and four continuous producers. Once the new exact schema-240 release image is qualified and
verified, it keeps the current release-SQL export, migration, bootstrap and
verifier path at schema 240, preserving the immutable account snapshot, raw
evidence, active-funding observations, global reconciliation receipts, prepared-intent fixtures, producer pins, governance profiles and precall receipts. It
never drops data, runs a down migration, or changes a persisted authority setting.

Use it only after confirming `manage_only`, entry mode, H4 admission and every
producer marker are disabled. The rollback script refuses every enabled marker
and verifies the inline schema 240/prepared-fixture/trigger compatibility contract plus the
checksum-validated, exported current `verify_database_roles.sql` contract before
accepting the exact old runtime and current release image split. Start the fenced
qualified 0.1.79 package successfully first: its
release export, migration and normalizer/verifier one-shots must already have
completed. The script recreates only web and the four producers with
`--no-deps`; it never invokes `credential-init`, requires no `APP_SEED`, and
does not create a backup.

The command is resumable. For an existing-data update after the required Linux
restore-224 CI and final review, it accepts only the qualified pinned 0.1.79 or pinned
0.1.46 image for each of its five targets, completes a partial split, and
rejects any other image. A retry after all five are safely fenced is
verification-only. The rollback overlay runs the web as `tail` and producers as
`sleep`, with explicit health checks; these commands never read enable markers,
so a marker created after preflight cannot start application or producer
execution.

```sh
APP_DATA_DIR=/absolute/umbrel/app-data/whirmill-zapbot \
ZAPBOT_PACKAGE_COMPOSE=/absolute/umbrel/app-store/whirmill-zapbot/docker-compose.yml \
"$APP_DATA_DIR/scripts/rollback-0.1.46.sh" --dry-run
```

After the dry run, repeat the command without `--dry-run` only in the installed
Umbrel compose context, then verify the normalizer receipt and the fenced web
and producer state. The optional compose overlay is
`docker-compose.rollback-0.1.46.yml`; it pins only the prior long-lived
components. Do not apply it to the migration, release-SQL export, verifier, or
profile-only jobs.

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
- `release-sql/` — exact reviewed `provision_migration_roles.sql`,
  `bootstrap_database_roles.sql` and `verify_database_roles.sql` exported from
  the immutable release image, with SHA-256 checksums and a completion marker;
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
only `provision_migration_roles.sql`, `bootstrap_database_roles.sql` and
`verify_database_roles.sql` from `/app/lib/api-*/priv/sql`; it fails if the release
image does not contain exactly one matching source directory. Each SQL consumer
verifies the exported checksums before use. Optional restore, restored-object
ownership normalization, migration-role provisioning, one-shot migration, then
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
   The administrator creates `vector`, `pgcrypto` and `pg_stat_statements`,
   then runs the migration-only provisioner. It creates or hardens only the
   `NOLOGIN` owner and non-superuser migrator. It also pre-provisions the
   account-reconciliation role as `NOLOGIN` before owner migrations remove
   `CREATEROLE`; the full bootstrap later grants its narrow table ACL. Runtime,
   evaluator and other producer roles are created by the full bootstrap after
   migrations; a partially populated existing role inventory is rejected before
   provisioning. The account-reconciliation role receives no generated service
   secret or private signing-key mount.
4. Migrations use only `zapbot_migrator` plus `SET ROLE zapbot_owner`; the web
   runtime never receives a migration URL. Their connection uses
   `search_path=public,pg_temp` so historical unqualified DDL creates application
   objects in `public`, while PostgreSQL still searches the implicitly included
   catalog first. Persisted role defaults and runtime search paths remain
   unchanged. See the [PostgreSQL search-path contract](https://www.postgresql.org/docs/18/runtime-config-client.html#GUC-SEARCH-PATH).
5. The post-migration step runs the full official bootstrap and verifier as the
   PostgreSQL administrator. It does not alter `internal_settings` or force a
   trading mode. The web healthcheck verifies application readiness, live
   process state and non-observation mode without rewriting the persisted
   execution or entry-mode decision.

Do not put an import dump in place while another authoritative ZapBot stack is
still writing to it. This descriptor has no replication, dual-write, traffic
cutover, rollback, or order-management authority.

Package regression checks run from the Store repository root:

```sh
sh tests/zapbot-release-sql.sh
sh tests/zapbot-bootstrap-export-order.sh
```

They exercise the actual exporter and credential initializer in disposable
containers, including an absent data directory, repeat startup and corrupted or
incomplete exports. The `ZapBot package tests` workflow runs both on package PRs.
The source repository separately verifies fresh, existing-schema upgrade and
ownerless restore through the migration role and full administrative verifier;
its CI pins the reviewed Store normalizer used for that restore test.

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
- `ZAPBOT_START_MARKET_STREAM=true`; and
- `LNM_STARTUP_RECONCILE_ENABLED=true` only after `runtime-env` in this web
  command.

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
