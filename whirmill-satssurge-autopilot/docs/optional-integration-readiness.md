# M5 protected configuration and wiring proposal

Prepared and reconciled2026-10-10 against the root's0.5.7 wiring base, read-only.
Local protected modules and the minimal BTC-bounds adapter delta received independent
review PASS. This documents local preparation; server/Store/Agent/App routes and
runtime registration remain an unapplied proposal requiring root integration
and acceptance after the ordered gates. No root/shared path,
Git ref, installation, host configuration or live credential has been modified.

## Protected contract

`OptionalIntegrationControl` owns one long-lived read client and a shared-instance
five-second admission interval across all optional calls. Root must share this singleton for UI and tools;
other processes behind the same IP remain outside this local budget. Config replacement does
not reset the interval. It blocks probes unless every backend roadmap gate is
true; request/config fields cannot seed those gates. Unknown/mutation operation
names fail closed. Owner callbacks are checked before admission and after awaits;
config version changes also discard stale results. Optional storage failure
blocks this lane without throwing out of the constructor or disabling the core.
Nonblocking private-file open rejects FIFOs before regular-file validation; startup
and existing-file configuration are covered by finite-watchdog/reaped-child tests.

Owner endpoint proposal (within existing bearer session, same-origin and CSRF
fences): POST `/api/optional-integrations/config`, exact schema
`{flags:{robosats:boolean,ambossSpace:boolean,magma:boolean},ambossKey?:string,
clearAmbossKey?:true}`. Unknown fields, inherited flags, accessors, invalid keys
and simultaneous set/clear are rejected. Response returns only safe status:
flags, key presence, storage availability, runtime readiness; no raw credential,
identity, token fingerprint, subscription, model reasoning or financial payload.
Malformed optional endpoint JSON and exceptions have fixed safe error messages.

Private file: `${DATA_DIR}/optional-integrations/private.json`, schema version1,
flags and optional existing key in one atomic record. Directory0700/file0600,
exclusive random temp, fsync, atomic rename and parent-directory fsync. Existing
files/directories are checked for symlinks, unsafe modes, ownership and regular
file/link/size bounds; none are repaired by chmod. Owned parent directories may
be0755 if not group/other writable, because the private child protects contents.
Encoded configuration is validated against the8192byte file cap before writing,
including JSON escaping overhead. Protected reads are bounded8192bytes and reject malformed UTF-8/JSON. No new DB,
OAuth provider or operational schema exists. OS/application backups must protect
this private record like other credentials; encryption at rest is a deployment
responsibility, not provided by file permissions. Atomic replacement can have an
uncertain persistence acknowledgement if directory fsync fails; storage then
blocks the lane until restart/readback instead of claiming a committed update.

Unapplied owner route proposal: POST `/api/optional-integrations/probe`, body `{probe:<fixed operation name>}`.
The local, unregistered Settings component offers a write-only password field for the existing key, immediately clears
it on submit and renders only safe result categories. Public probes expose only
already-reviewed numeric projections. Owner-only `magma-account-auth` uses the
fixed official query `user { id }`; the identity and all extra fields are discarded.
Successful response means that endpoint accepted the credential for this read,
not a read-only key scope, Space analytics qualification or financial authority.
No auth acceptance is persisted in public status. Auth probes cannot be selected
by the model-visible tool, whose enum contains only five public operations.

The new authenticated reader retains the same10s monotonic deadline,256KiB cap,
4096-read bound, empty-chunk discard and periodic timer/I/O yield. Injected fetch
must honor AbortSignal. Custom synchronous callbacks remain trusted code.

## Gate and scoped tool proposal

The Store patch only reads `optionalIntegrationGateReceipts` from existing meta;
it seeds nothing and stores no credential. Proposed value: version1 with core,
m24,m3,m4 acceptance references, each own `accepted:true`, SHA256 evidence hash,
UTC timestamp in roadmap order. Strict UTC round-trip validation rejects normalized
invalid dates while retaining zero-to-three fractional digits. Missing, malformed,
inherited, future or reversed references fail closed. Hash syntax is not proof verification: the orchestrator
must validate actual acceptance evidence before controlled seeding; no HTTP/tool
path may set these records. This is an explicit root integration obligation.

Agent patch adds `optional_integration_read` to existing registries, with fixed
public enum and immutable `read_only_research` job capability. Existing invocation
budget/ownership checks run first; callbacks revalidate job run token, conversation,
capability, active run and Telegram authorization after awaits. Auth/config methods
are never model tools. The patch injects the service as a new optional final Agent
constructor parameter, preserving existing constructors and fixtures.

## Official capability/cost/recovery matrix

Sources rechecked2026-10-10; documented support is distinct from current live
qualification. The original2026-10-10 bounded public qualification used one reviewed-client
anonymous Magma offers query, page0/limit25,993ms: sanitized `http`, exact status
unknown in that preserved original proof. Two subsequent separately authorized
diagnostics used the same fixed query: HTTP400 with a JSON header class, then
HTTP400 with two finite `unknown-field` categories for `min_amount` and `max_amount`.
Three distinct qualification calls total, zero retries. The final body was bounded,
consumed and projected in memory only, without raw-body/message persistence or
hashing. The documented fields conflict with the current anonymous schema; offers
remain live HOLD without endpoint/auth workaround or activation.

| Capability | Endpoint/auth | Cost/rate/economic and recovery boundary | Status |
|---|---|---|---|
| RoboSats public info/book | Temple mainnet, GET, no robot/key | Coordinator fee/bond fields only; rate quota unverified; one coordinator and partial book. No settlement/profit inference. | Reviewed adapter; prior public proof only |
| Space availability | `api.amboss.space/graphql`, public `getHello` | Free noncommercial use per old documentation; commercial permission and current credit/tier terms unverified. Greeting cannot prove auth. | Supported availability only |
| Magma estimate | `magma.amboss.tech/graphql`, public fixed pricing query | Estimate described as free; endpoint quota60/IP/60s. No executable quote or earned return. | Reviewed adapter; prior public proof only |
| Magma offers | Fixed public query including BTC min/max amounts | Exact integer-string bounds validate locally; `sizeBoundsQualified:true` on valid pages. Missing BTC wrappers unsupported; inverted/invalid bounds fail. Coverage always partial, total matching count not completeness, oversized page unsupported; fee units remain ambiguous. Historical92-row/schema proofs preserved. | Independent parser review PASS; latest finite HTTP400: unknown-field min_amount/max_amount;3 distinct calls,0 retries; current docs/schema conflict, no live bounds/page qualification |
| Magma credential acceptance | Same endpoint, existing Bearer key, only `user { id }` | No new key/session/subscription; bounded read, identity discarded. Broad key permissions are not narrowed by the query. | Implemented mocks; missing existing key/live auth blocked |
| Space node analytics; Magma order/account-history reads | Authenticated field contracts beyond minimal probe | Sensitive bodies and economic field provenance require separate allowlists/qualification. | Not exposed |
| Trades/swaps/bonds; buy/sell/offer/lease/channel/subscription mutations | Any provider | Explicit obligations, capital reserves and uncertain effects; separate authority, durable intents and reconciliation required. | No API/method/tool exposed |

[Space introduction](https://old-docs.amboss.tech/docs/api-docs/intro) supports its
endpoint, Bearer header, public greeting and commercial-use restriction.
[Space rate limits](https://old-docs.amboss.tech/docs/api-docs/rateLimiting) describe
complexity credits rather than a fixed request count.
[Current Magma reference](https://docs.amboss.tech/magma/api-reference) distinguishes
public and authenticated roots and the IP-wide quota.
[Authentication](https://docs.amboss.tech/magma/authentication) supplies the account
`user { id email }` example; this probe selects only id. Session keys require a
buy/subscription mutation, so none is requested here.
[Integration](https://docs.amboss.tech/magma/integrate) documents free estimates,
HODL settlement and non-idempotent order creation: uncertain creation/payment
requires reconciliation of original IDs, never blind replay.
[Migration](https://docs.amboss.tech/magma/migrate-from-legacy-api) deprecates old
Magma operations and identifies missing fields/settled-fee semantics; zero
pre-settlement amounts do not establish realized revenue.
[RoboSats API](https://learn.robosats.org/docs/api/) and
[usage](https://learn.robosats.org/read/en/) underpin the retained beta public
contract and bond/escrow recovery boundaries. The web extractor returned only the
API page shell on this refresh; the prior reviewed contract remains the source,
not a new full schema qualification. Official coordinator reference:
[federation registry](https://github.com/RoboSats/robosats/blob/main/frontend/static/federation.json).

Net economics still require realized settlement, routing/onchain/fiat costs,
bond forfeiture risk, liquidity reserves, channel commitments and inventory
opportunity cost. Neither a buyer order nor API-key acceptance is profit.

## Integration and minimal owner action

Apply `optional-integration-wiring-proposal.patch` only after independent review
and exact base-hash checks. It proposes server/store/App/Agent edits without
applying them; new source modules/component must be included separately. No new
schema migration or gate seed accompanies it. Patched-source TypeScript checking
in a disposable private copy is compile qualification only, not live endpoint,
browser, model-tool or installed acceptance.

After core→M2.4→M3→M4 gates and protected UI integration, the owner pastes the
already-owned key once in **Chiave API Amboss già esistente**, selects only an
approved read flag and runs **Verifica chiave esistente (Magma)**. No key in chat,
command, source, fixture or new subscription is needed. The real key remains
absent from this lane; no authenticated live PASS is asserted. Root must also
qualify protected backup handling, actual owner auth/CSRF routes and safe UI
failure behavior before publication/activation.

## Current verification and retained history

The BTC parser delta passed build and42 API/protected-control tests. A full run
from the package directory passed389/390 with an existing fragmented-stream timer
assertion failure; targeted rerun passed that assertion. The orchestrator reported
a subsequent independent read-only390/390 full PASS. All original logs are retained;
the later PASS does not eliminate observed timing intermittency. A separate first
attempt from the repository directory had package-relative fixture failures and
was stopped/replaced; it is preserved as an execution-location error, not code proof.

Local control, strict gate validator, tests and Settings component are implemented;
private record protection is active when that module is instantiated in isolation.
Root owner routes, Store gate projection, Agent tools, App registration, installation,
credential qualification and activation are pending. No current live endpoint result
justifies auth/endpoint fallback, readiness bypass or financial eligibility.
