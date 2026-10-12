# Isolated HTML renderer and application integration

M4 is implemented in source and defaults to disabled. Publication, deployment,
M3 closure and real Telegram acceptance belong to the release owner. This directory
supersedes the historical WeasyPrint candidate; it carries no historical live credit.
The catalogue Compose remains pinned to immutable 0.5.13. The integrated
application source candidate is 0.5.14; its renderer and installed acceptance
remain pending. The original arm64 qualification used the preserved source
candidate before the reviewed visible-text filter correction.

An explicit paired-owner `/export pdf|png|csv|xlsx [section=...] [kind=...]
[source=...] [target=...] [channel=...] [start=UTC end=UTC] [limit=1..100]
[-- description]` freezes a bounded canonical public snapshot at ingress. The
optional description guides the agent's composition without changing data scope.
Unknown intent, source semantics, evidence direction, completeness, accounting
and financial qualification remain explicit. Source observation timestamps,
lineage digests, high-water marks and partial cursors are retained; raw originals,
private SQL, credentials and payment payloads are excluded by the public projector.

The existing Pi Durable 1.1.0 registry installs three guarded tools only when
`contentArtifactsEnabled` was enabled before application startup: read the frozen
snapshot/DLS, create an exact revision, and inspect completion. It preserves
subscription Sol/high, the original financial capability, job ownership, Stop,
queue and application lifecycle. Tools cannot change flags, invoke shell/RPC,
reserve capital or broaden the mandate. The app's run budget remains; a distinct
content budget adds 12 calls/120 seconds, four linked revisions, bounded retained
requests/receipts, 512 KiB input and direct output, and a 90-second pending deadline.
Feature activation remains an operator action after ordered acceptance, never a
model tool or implicit approval from a chat request.

For PDF/PNG the agent authors HTML under [DLS 1.0.0](../content/dls/v1/README.md).
Puppeteer only renders it. Semantic tags, fixed DLS classes, a small positive CSS
language and bounded SVG shapes/labels replace unrestricted HTML/CSS. No scripts,
events, links, URLs, imports, images, forms, file paths, frames, arbitrary assets
or agent font-face rules are allowed. CSP disables active content; JavaScript is
disabled and request interception admits only the three hash-verified bundled static font
data URLs. All source timestamps, exact coverage and evidence refs must be visible.
PDF embedding must contain only qualified CID TrueType subsets, rejecting the Type3 variable-font failure observed in native visual QA. Actual DOM layout checks text size/contrast, horizontal overflow, oversized
unbreakable rows/cards, SVG boundaries and label overlaps before rendering.
`puppeteer-visible-v1` is the output policy version. It does not certify that every
authorized fact was included or that an agent narrative is economically correct.

Puppeteer renders A4 PDF with DLS margins, repeated table headers and page counters.
PNG rasterizes page 1 of that same PDF at 993×1404 and retains total page count in
the receipt/caption, so it is explicitly a preview. CSV/XLSX bypass the renderer:
CSV is deterministic UTF-8 BOM with formula-like strings escaped, XLSX has only
inline text cells and no formulas/macros/external relationships. Other arbitrary
file extensions are not currently admitted by `/export`.

Every immutable receipt binds original job/request/conversation, owner generation,
turn version/corrections, bot generation, frozen snapshot digest and source refs,
DLS/profile, HTML/direct-file digest, exact output SHA/bytes/pages, revision lineage
and outbox event. A retry reuses the same bytes. Changed input under the same
revision conflicts; regeneration needs a linked revision and cannot replace an
artifact already admitted to delivery. Transport rejection retries through the
existing serialized outbox; accepted timeout/restart remains uncertain without
automatic replay. Authority/token/destination/rate-limit/Stop are reread after I/O
and synchronously before sending intent. No financial reconciliation path changes.

## Deployment candidate

Build from the application directory with `docker build -f renderer/Dockerfile .`.
[compose.candidate.yml](compose.candidate.yml) is a development override, with
`docker compose -f docker-compose.yml -f renderer/compose.candidate.yml
--profile content-artifacts`, not a published Umbrel image pin. The release owner
must publish and verify immutable native amd64/arm64 images and wire that image
into the official catalogue after ordered gates. The app and worker share only a
dedicated `/content-jobs` directory, deliberately provisioned UID/GID 1000 and mode
0700. Neither process chmods/chowns an existing host mount. Docker Desktop bind
mounts can expose virtual UID 0; qualification used a dedicated named volume,
not an ownership-check bypass. The deployed Linux host directory needs real UID
1000 ownership. Never mount app data, OAuth, bot credentials, host files or Docker
socket into the renderer.

The worker refuses extra host mounts, privileges/capabilities, usable non-loopback
interfaces/routes, writable root or unbounded cgroups. The only known inert DOWN
kernel fallback tunnels are admitted if they have no address/route; unknown DOWN
interfaces are rejected. The read-only Docker init binary is a named mount exception.
Compose uses network none, no-new-privileges, no capabilities, read-only root,
192 MiB scratch, 768 MiB memory, one CPU, 256 PIDs and an init process. Chromium
runs with `--no-sandbox` under this container boundary; this is **not** a Chromium
sandbox claim. TLS validation is never disabled.

One exclusive worker lock owns IPC. Each request uses one subprocess group with
35-second deadline. Cancellation, worker SIGTERM and deadline kill/reap the entire
owned group. The Linux subreaper also kills/reaps Puppeteer's detached Chromium
descendants within a two-second bound before scratch cleanup; scratch is removed after every completion/failure and at exclusive
startup. A renderer intent after crash yields a closed failure, preserving partial
output instead of replaying or creating a new revision. Stop/revocation cancels
pending content during bounded host capture; a 90-second app deadline also commits
cancellation and rejection. App Stop never changes financial receipts. Renderer
container shutdown is separately supervised; with the app offline, already
admitted work is still bounded by the 35-second renderer deadline. Normal delivery
can resume using verified recorded bytes, while failed generation needs explicit
linked revision. Retention is bounded and fails closed, with no automatic deletion
of historical receipts or owned output.

## Dependency sources and verification

Pinned Node 24 bookworm image is the existing application base; renderer lock pins
`puppeteer-core` 25.12.0, parse5 8.0.0 and pdf-lib 1.17.1. Debian Chromium is pinned
to `154.0.8037.92-1~deb12u1` for native amd64/arm64. These are candidate dependency
choices, not native dual-platform qualification; the worker/consumer require exact
Chromium/Puppeteer versions in receipts. A missing apt version fails the build.

Primary documentation checked 2026-10-12:

- [Puppeteer installation](https://pptr.dev/guides/installation): core manages a supplied browser without implicit download.
- [System requirements](https://pptr.dev/guides/system-requirements): Node compatibility.
- [Supported browsers](https://pptr.dev/supported-browsers): Puppeteer 25.12 and Chrome 154 mapping; Debian Chromium compatibility needs actual execution.
- [Request interception](https://pptr.dev/api/puppeteer.page.setrequestinterception) and [PDF options](https://pptr.dev/api/puppeteer.pdfoptions): explicit blocked requests and bounded PDF settings.
- [Debian Chromium](https://packages.debian.org/bookworm/chromium): architecture/package availability.
- [Docker guidance](https://pptr.dev/guides/docker): init and Chromium sandbox requirements; this candidate does not grant SYS_ADMIN.

Application verification uses exact local Node 24.21.0 with full tests/typechecks
and Python script regression checks. Renderer policy tests run with `npm --prefix
renderer test` and `python3 -m unittest discover -s renderer/tests`. Native synthetic
Linux arm64 Docker checks cover short PDF/PNG, nine-page DLS, bundled font receipts,
hidden/offscreen/overlapping negative cases, independent exact-byte consumer readback
and selected-page visual inspection. This does not qualify amd64, installed runtime,
real Telegram clients, arbitrary generated layouts or complete financial data.

Static font instances preserve the OFL sources and licenses. Regenerate offline
with fontTools 4.63.0 using `derive-fonts.py`; `static-manifest.json` binds every
instance to original source SHA, complete pinned axes and generated SHA. This is
a build-only dependency. [Primary instancer API](https://fonttools.readthedocs.io/en/latest/varLib/instancer.html)
documents full-axis instancing. The original variable-font attempt is preserved:
text extraction retained a KPI while Poppler visual output lost leading digits
and emitted Type3 bounding-box warnings. Final native visual QA must use static
instances and independently confirm the complete numeric text.
