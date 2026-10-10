# Optional integrations — M5 preparation

Observed 2026-10-10. Local preparation only: core → M2.4 → M3 → M4 → M5
remains the release/activation order. Pi Durable 1.1.0, existing mandate,
financial maintenance claim and database schemas are unchanged. Local protected configuration, gate validation and a Settings component are also
implemented; root server/Store/Agent/App wiring remains a proposed, unapplied patch.
No new dependency, installed server route, installation or financial effect.

## Implemented contract

`src/optional-integrations.ts` exports `OptionalIntegrationReads`,
`OPTIONAL_INTEGRATIONS_DISABLED`, `parseOptionalIntegrationConfig`, typed
`ReadResult` and projected market types. Empty config disables all providers;
only own explicit boolean flags on plain or null-prototype config objects enable reads. Unknown config keys are rejected.
Secrets are excluded from this schema. No caller-supplied URLs, GraphQL text or
financial methods exist. `unsupported(provider)` returns an explicit failure for
unqualified capabilities; it must never be interpreted as an empty market.

All HTTP requests have a 10-second abort deadline through body consumption,
256-KiB decoded-stream bound, redirect rejection, no cookies, strict numeric/schema
validation and sanitized failure categories. Unknown response fields are discarded.
Invalid required-field schemas, GraphQL errors (even with partial data),
malformed/non-JSON bodies and unsupported assets fail closed. No exception/body/headers are logged. The default native fetch honors the
AbortSignal; an injected transport must honor it too. Body processing permits at
most4096 read iterations, retains no empty chunks, checks a monotonic deadline
before/after reads and projection, and yields to timers/I/O every64 chunks.
Excess fragmentation returns `too_large`; elapsed deadlines return `timeout`.
Synchronous trusted transport callbacks cannot be preempted; an elapsed deadline
is rejected after control returns. No native remote empty-chunk exploit is claimed. Response strings remain
bounded and numeric monetary strings do not round-trip through JavaScript numbers.

One long-lived client reserves a five-second minimum interval per provider before
any await; HTTP429 blocks that provider for 60 seconds. Do not create per-job
clients to circumvent this limiter. It is per-process/instance, not a distributed
IP budget. Other clients sharing an egress IP require central admission at root.
No automatic retry, scheduler or background polling is introduced.

## Provider qualifications and limits

### RoboSats

[Official REST reference](https://learn.robosats.org/docs/api/) describes beta
v0, currently rendered as REST0.8.6. This client only GETs public `/api/info/` and
`/api/book/?currency=0&type=2`, without robot authentication. The fixed mainnet
Temple clearnet origin comes from the
[official federation registry](https://github.com/RoboSats/robosats/blob/main/frontend/static/federation.json),
read on the observation date. The registry is mutable; requalify source/origin at
integration. This represents one coordinator, never the entire federation.
Clearnet changes privacy properties; Tor transport and other coordinators remain
unqualified. The old generic `unsafe.robosats.org` probe returned incompatible
content; no fallback is used.

Info projects mainnet, coordinator maker/taker fees, bond percentage, order-size
bounds and order counts. Book discards nick/hash/payment-method/location data,
retaining only numeric public quote fields and expiration. Book coverage is
always partial, including an empty book. It establishes no robot, order, settlement
or profit. Null/incompatible quote fields are failures, not invented zeros.
Rate quota is not established by the reference: five-second local throttling is
our conservative bound, not a provider guarantee.

[Official usage guide](https://learn.robosats.org/read/en/) explains token-based
robot recovery and bond/escrow HODL invoices. Bonds reserve liquidity and can be
forfeited for contract failures; seller escrow additionally locks inventory.
Fiat receipt and payout/routing status must be independently reconciled before
settlement. Never retry a take/make/payment/confirm after uncertainty. The
[dispute guide](https://learn.robosats.org/docs/disputes/) identifies coordinator
mediation; this module offers no dispute, chat, robot, trade or payment method.
Net margins need coordinator fees, swap/routing/onchain costs, bond risk, fiat
costs, reserves, inventory opportunity cost and realized settlement evidence.

### Amboss Space

[Official Space API introduction](https://old-docs.amboss.tech/docs/api-docs/intro)
documents `https://api.amboss.space/graphql`, Bearer authentication and the public
`getHello` query. Implemented availability discards the greeting and returns only
`reachable`, `analyticsQualified:false`, `authenticationQualified:false`.
Passing an existing key does not prove key validity because this query is public.
Node analytics/recommendations need a separately pinned current field/permission
contract and safe projection; they are explicitly unsupported by this client.
The old introduction says noncommercial API use is free, commercial use requires
provider agreement. Existing owner access does not establish commercial licensing.

[Rate-limit reference](https://old-docs.amboss.tech/docs/api-docs/rateLimiting)
describes complexity credits and `extensions.cost`, not a fixed request quota.
This adapter does not expose raw extensions or infer subscription tier/credits.
No paid plan, subscription, API-key creation/rotation or permission mutation is
performed. Protected-key callback stays private/server-side and is invoked only
for an explicit authenticated Space availability read, never for public calls.
The checked local process had no Amboss-named variables and the three known config
candidates were absent. This limited discovery does not establish that the owner's
key is absent elsewhere. No authenticated live read was performed.

### Magma

[Current reference](https://docs.amboss.tech/magma/api-reference) documents the
separate `https://magma.amboss.tech/graphql` endpoint and IP-wide 60requests/60s.
The implemented public queries read `market.liquidity.liquidity_per_usd` and
`market.offer.offers(page)`. Actual public schema rejected Int pagination variables;
Float variables with integer validation are required. The current fixed query
selects documented `min_amount` and `max_amount` through BTC `SizeValue.satoshi.sats`.
The parser projects exact decimal-integer strings as `minSats` and `maxSats`, rejects
invalid or inverted bounds, and returns `sizeBoundsQualified:true` for a successfully
validated page. Missing BTC wrappers or other-asset-only bounds return `unsupported`;
this is parser qualification, not live market or operational eligibility.
Pages retain explicit `offset`, `nextOffset`, `total`, always partial coverage and
observation time; `total` is the provider's matching count, not a completeness proof.
Default page0 requests25 rows, with no truncation if the provider exceeds the limit.
Newest-first offset pagination can shift during concurrent market updates;
`nextOffset:null` proves only the returned page boundary, never an immutable
complete market snapshot.

Historical evidence from earlier2026-10-10 probes reported rejected size fields and
92 rows for `limit:25`, resulting in `unsupported`. Those original proofs are
preserved and do not describe the current query's field selection. The
original single anonymous read using the reviewed client on2026-10-10,
page0/limit25, took993ms and returned sanitized `http`; exact status was unknown
in that original retained projection. Its proof remains unchanged.

Two subsequent, separately authorized diagnostics used the same reviewed client
and fixed query without retries: the second observed HTTP400 with a JSON header
class; the third observed HTTP400 and two finite `unknown-field` categories for
queried `min_amount` and `max_amount`. Three distinct qualification calls were
performed in total, with zero retries. The final error body was consumed within
the finite client bounds and projected only in memory; raw body/messages were not
saved or hashed. Current offers remain live HOLD: the documented BTC-bound fields
conflict with the actual anonymous public schema. No returned offer page or live
BTC bounds were qualified. Independent documentation review confirmed the official
endpoint and public query contract; this does not override the observed conflict
or justify endpoint/auth fallback, activation or financial eligibility.


[Orders/offers](https://docs.amboss.tech/magma/orders-and-offers) documents offered
capacity, locked capacity and minimum-block commitments. Fee descriptions are
ambiguous: the offer's `variable` is described as ppm while `SatoshiValue` wraps
`sats`, and migration describes order fees as amounts. Therefore offers expose
`variableFeeValue`, `ambossFeeValue` and `feeUnitsQualified:false`, not an economic
cost calculation. Eligibility conditions and routing fee caps are not projected:
no offer returned here is qualified for purchase or sale.

[Migration guide](https://docs.amboss.tech/magma/migrate-from-legacy-api) deprecates
legacy Magma operations, retains IDs, and documents lost fields. Settled buyer/seller
fees may remain zero before settlement; that is not zero earned revenue. No
legacy marketplace fallback, mutation or close-side inference is implemented.

[Integration guide](https://docs.amboss.tech/magma/integrate) describes HODL payment,
order tracking and non-idempotent purchase creation. Unknown creation/payment
outcomes require persisted IDs and reconciliation, never blind replay. A channel
opening is not final economic recovery; verify payment status, commitments,
onchain costs, reserve duration and actual net settlement independently.

[Authentication](https://docs.amboss.tech/magma/authentication) distinguishes
existing account API keys from session keys created by buy/subscription mutations.
No such session is created here. The public adapter exposes no authenticated Magma read, so its public projections
cannot disclose account email, Telegram, invoices or order payloads. The separate
local protected control implements only an owner-authorized fixed `user { id }`
credential probe, discarding identity and extras; root wiring and live acceptance
remain pending. API keys can permit mutations: fixed-query allowlists do not narrow
the key itself, and no model-visible authentication probe is exposed.
No fee/subscription charge is created by these fixed public queries. Transport,
infrastructure and commercial terms are separate costs; no profitability claim.

## Exact root integration hooks (after ordered gates and independent review)

1. Integrate the existing local `OptionalIntegrationControl` and gate validator
   through the reviewed proposal only after orchestrator-owned acceptance evidence.
   Do not add provider flags to the financial mandate or release the claim.
2. Share one backend-owned control/client singleton across UI and research tools.
   Its existing private record holds flags and the optional key; model-visible
   projections return no credential. Root routes and runtime injection are pending.
3. Register read-only tools only for explicitly selected research capabilities:
   `roboSatsInfo()`, `roboSatsBook()`, `magmaEstimate()`, `magmaOffers(offset,limit)`,
   `ambossSpaceAvailability()`. Return only `ReadResult`. This lane did not modify
   shared agent/server/store/Telegram files. No financial executor hook exists.
4. Persist already-projected results with original job/request provenance,
   provider/coordinator origin, observation date and explicit partial scope.
   Stale/failed/partial evidence cannot establish operational eligibility.
5. Qualify live credentials, analytics fields, schema drift, Tor privacy, shared
   egress budget and economic fee-unit ambiguity before any broader capability.
   Trading/leasing/channel/subscription enablement needs separate authority,
   durable intents, preservation/accounting and uncertainty recovery proofs.

Local tests use synthetic values and isolated local HTTP resources only. Public
qualification receipts and full-input fingerprints are private outside Git.
Independent review and installed acceptance belong to the orchestrator.

## Protected configuration and minimal existing-key owner action

The existing `Credentials` class only permits OpenAI OAuth and is not widened for
Amboss. Local `OptionalIntegrationControl` persists one version1 record containing
flags and an optional existing key at `${DATA_DIR}/optional-integrations/private.json`
(container `/data/optional-integrations/private.json`). The private directory is0700
and the regular file0600; bounded reads reject unsafe ownership/modes, symlinks,
extra links and nonregular files without permission repairs. Nonblocking open
rejects FIFO input without stalling core startup. Atomic replacement uses an
exclusive temp, fsync, rename and parent-directory fsync; encoded records are
bounded8192bytes including JSON escaping. Encryption/backup protection is a root
deployment responsibility. Earlier two-file paths were proposals superseded by
this local implementation, not files to create or migrate now.

The Settings component exists locally with flags initially OFF and a write-only
password field cleared on submit. Its owner-authenticated, same-origin, CSRF-fenced
config/probe routes and App registration remain **unapplied root wiring proposals**.
Safe readback exposes flags, key presence, storage/readiness state only. The local
protected query `user { id }` discards identity; it is excluded from model tools.
No existing key was read and no authenticated live acceptance was performed.

After ordered core→M2.4→M3→M4 gates and protected UI integration, the owner may
paste their **existing** key once in that protected field and select only approved
read flags. No chat/source/fixture/command argument, new subscription, key creation
or OAuth extension is needed. Credential acceptance would establish only that
fixed read, not read-only permissions, analytics, trading or financial authority.

## Verification and evidence scope

The minimal BTC-bounds delta passed build and42 targeted API/protected-control
tests. Its first correctly located full run passed389/390, with one pre-existing
fragmented-stream timer assertion failure; that assertion passed the targeted
rerun. The orchestrator subsequently reported independent read-only full390/390
PASS. Original failure logs remain preserved: the later PASS does not establish
absence of timing intermittency. Public probe and frozen-input receipts remain
private outside Git; no live offer/authentication, installation or activation PASS
is claimed. See `optional-integration-readiness.md` for the protected contract and
pending root integration obligations.
