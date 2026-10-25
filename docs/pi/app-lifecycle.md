# Application lifecycle and database maintenance

Production startup (`npm start`, image CMD) runs `scripts/app_launcher.py` as
UID 1000. The image bundles Debian Bookworm's standard-library Python 3 runtime
and the existing SQLite checkpoint helper. Node remains the pinned Node 24
image. No Docker socket, elevated capability, sudo or hook success is required.
`npm run import -- <history>` uses the same launcher and fences while importing
into `operational.sqlite`; it is an offline operation and cannot run alongside
the application.

The launcher owns the executor lock for its entire application child lifetime.
All legitimate database writers acquire the stable admission inode exclusively,
then the stable `maintenance.lock` inode in shared mode. Runtime retains the
shared lock; offline maintenance scripts take the executor lock. Checkpoint/migration
takes maintenance exclusively. Lock order is executor, admission, maintenance.
The host Lightning Mate backfill (`lm_backfill.py`), which also took the shared
lock, was retired: masked on 2026-10-11, removed on 2026-10-25. Deadlines are 15 seconds for lock
acquisition and 60 seconds for isolated migration. These inodes must never be
unlinked, replaced or restored from a checkpoint.

Linux flock conversion from exclusive to shared has an unlock/relock gap. The
admission lock stays exclusive throughout conversion, qualifying that gap:
no legitimate writer or checkpoint can enter. Node inherits the executor and
maintenance open-file descriptions. Linux `/proc/self/fdinfo` and inode checks
qualify the required exclusive migration/shared runtime modes before application
storage imports. Killing only the Python wrapper does not release a child's
inherited fence. SIGTERM and SIGINT handlers are installed before migration/runtime spawn;
a signal during spawn registration is queued and delivered to the child. The
supervisor forwards it, retains the migration deadline, and reaps before closing
its descriptors. A migration receives up to 5 seconds to exit after termination;
runtime receives 35 seconds for the existing drain, then is killed and reaped. The existing 25-second
application drain is recovery guidance, not proof that HTTP/OAuth work is idle.
The fence covers the actual process lifetime, including remaining open handles.

Application shutdown is local to the app, not a general Umbreld coordination
service. The HTTP listener stops accepting connections; pending request handlers
are tracked through their actual settlement within the existing 25-second drain.
Owner login and writes recheck shutdown after request-body reads, and model
configuration rechecks after its asynchronous lookup. Work not yet dispatched
receives503 and can be retried with its original identity after restart. Already
dispatched effects keep their original receipts and reconciliation; a signal is
not cancellation of a payment or remote provider operation. A timed-out HTTP
handler records `httpDrained=false` / `restart_recovery_required`, never `drained`.
No checkpoint is required on every signal or ordinary same-release restart.

The public Node entrypoints reject direct startup before database creation.
`server-app.ts` contains the internal application function without top-level
initialization; the isolated HTTP test calls it explicitly as a fixture.
Calling internal modules directly, hostile root, or same-UID actors deliberately
ignoring the protocol are outside this cooperative protocol. They are not
supported production entrypoints or exempt legitimate writers.

## Transition receipt and checkpoint

The read-only image's package/lockfile, compiled JavaScript, installed Pi/Chord JavaScript and bundled Python
helper bytes determine the installed release fingerprint. Environment variables
cannot substitute a source SHA to authorize a transition. `lifecycle.json`
binds source/destination, phase, source/result schema identities and immutable
checkpoint file hashes. Schema identity includes `user_version`, DDL digest and
Durable's separate schema version. A same-release ordinary restart performs
recovery without another checkpoint. New releases capture all three databases
under the exclusive fence, verify their hashes/integrity, fsync copies and
checkpoint directory publication, then migrate in a separate Node process.
Migration opens storage only; it never opens Harness, dispatches jobs or contacts
providers. Live database/WAL files and their parent are fsynced before ready is
published. OAuth state and original receipts remain in place.

Every transition persists a unique ID before capture. Compatible release cycles
receive distinct checkpoint directories; retries retain the original transition
ID and baseline. The launcher passes the canonical absolute DATA_DIR to both
children, so import uses exactly the fenced database directory.

A crash after migration intent may retry additive migrations against the same
immutable baseline, never overwrite it with partially migrated files. A failure
during capture/publication is held for offline qualification. Disk-full, missing
files, corrupt baseline, schema mismatch or unsupported phase cannot bootstrap.
No path automatically restores an older database, OAuth state or receipts.

## First legacy cutover: HOLD until host qualification

This is a one-time, controlled legacy transition, not a mandatory permanent
Umbreld owner/catalogue/provider integration. Prefer the smallest independently
qualified host procedure that establishes the facts below. Do not patch global
Umbreld lifecycle operations merely to implement graceful app shutdown. The
known external SQLite writer was host `lm_backfill.py` (now removed); diagnostics/interlock/
competition write projections and the collector's separate history scope must
not be mislabeled as writers of all three databases. M3 retires LM/LNDg and
legacy helpers only after native collection and consumer semantic parity; a
planned retirement is not evidence that today's timer is already disabled.

An existing legacy dataset has no lifecycle marker and is rejected by default.
The app cannot certify host writer shutdown, service enablement, ownership or
future restart prevention; `/proc` scanning alone cannot do this. A host adapter
must establish an offline fence under its existing authorized UID, stop the
legacy app, disable the legacy backfill's service/timer/restart paths or install
and qualify its protocol enrollment, and prevent legacy restart through the
complete handoff. Read-only producers do not count as database writers. Unknown
participants or ownership remain HOLD. This repository does **not** supply a
qualified host adapter or claim a currently installed native receipt.

Only that adapter may publish private `data/offline-cutover.json`, after checking
current immutable source release and taking a verified three-database capture.
The current conservative receipt requires backfill **disabled** (an enabled but
inactive timer is insufficient). Contract:

```json
{
  "protocol": 1,
  "source": "qualified immutable source release identity",
  "destination": "actual new image content fingerprint",
  "fence": "offline-exclusive-v1",
  "writers": {"app": "stopped", "lm-backfill": "disabled"},
  "schemas": {"operational.sqlite": {}, "durable.sqlite": {}, "oauth.sqlite": {}},
  "files": {"operational.sqlite": {}, "durable.sqlite": {}, "oauth.sqlite": {}}
}
```

`schemas` must contain the exact schema identities returned by
`app_launcher.schemas`; `files` must be the exact verified checkpoint manifest
file entries. The launcher compares a new capture and fails on any mismatch.
The receipt is a trusted host adapter attestation, not a self-authenticating
claim from arbitrary JSON. Never create it merely to bypass HOLD. Host evidence,
source binary, known writer inventory, actual disabled paths and destination
image correlation must be independently reviewed before publication. The app
then serializes transition retries itself.

### Minimal target-runtime capture tool (capture only)

`docs/pi/scripts/legacy-target-capture.py` is an external, one-time operator
procedure, not an installed app helper or a host coordinator. It **does not**
publish `offline-cutover.json` or `lifecycle.json`, restore, migrate, start the
app, write database rows, contact providers, or certify that host writers are
disabled. Two isolated captures alone are not production/offline-host authority.
The original legacy binary/source identity and all host exclusion evidence must
be established independently; `--release-source` describes the **target image's**
reviewed source, not the old running binary.

Run the tool through stdin with the exact published platform image's `python3 -`
as **actual namespace PID 1**, UID and GID 1000. Do not use `--init`, a shell
entrypoint, `docker exec`, a background capture child, or a host Python capture.
The production entrypoint checks real Linux/PID/real and effective UID/GID before
any data/output modification. Supply the independently reviewed target source
SHA, expected product fingerprint and independently verified published platform
digest explicitly; neither runtime fingerprint self-discovery nor a mutable tag
is approval. The tool compares the expected fingerprint using the unchanged
`/app/scripts/app_launcher.py` implementation. A digest/source string inside the
container cannot independently prove Docker image provenance.

The same PID 1 acquires stable `executor.lock`, `maintenance-admission.lock`,
then `maintenance.lock`, all EX, and synchronously uses the image's unchanged
`checkpoint.capture`, `checkpoint.verify` and `app_launcher.schemas` for all
three databases. All fences remain held through both captures, verification,
source schema readback and summary/failure diagnostics. The two NEW private
subdirectories (`capture-1`, `capture-2`) must have identical `manifest.files`
and original schema identities. This comparison uses actual target-runtime
checkpoint bytes, not an invented host/target-runtime equality rule, and gives
the parent the exact file/schema entries required by the unchanged launcher's
repeated-capture comparison. The summary still says `hostQualification=HOLD`.

All three source files must already exist. Symlinked ancestors, nonregular or
hardlinked DB/WAL/SHM/lock files, either existing receipt (even a dangling
symlink), and existing/overlapping output paths are rejected. Use absolute paths
without traversal or SQLite URI metacharacters. The output must be outside the
data tree, under an operator-owned, non-publicly-writable existing parent; the
new output and checkpoint directories are mode 0700. Stable lock inodes and
existing DB/WAL/SHM are never explicitly unlinked, replaced or reset. Empty or
truncated existing SHM is rejected before SQLite access: admit only whole 32KiB
SQLite index blocks, then compare original inode/extent after every operation.
An unexpected inode/extent change is HOLD, not permission to reset or restore it.
Ordinary read-only SQLite may update SHM read marks (cache/locking bookkeeping,
not financial/OAuth rows); SHM bytes are not claimed immutable. The stdout summary
contains only bounded release identifiers, file hashes/sizes and schema identities,
never rows, DDL text, OAuth contents or tokens. The private database snapshots are
NOT sanitized: they necessarily contain original rows and OAuth state and require
confidential handling. Separate owner/bot credential files are not copied or read.
Partial capture directories/database copies and failed evidence remain for offline
review; the unchanged atomic helper may remove an unpublished manifest temporary.
Never reuse an existing output directory or delete it to mask a failed attempt.
The cooperative protocol does not defend against hostile root or same-UID actors
that deliberately ignore fences or replace paths.

Lock acquisition is at most 15 seconds per lock, within a cooperative total
operation budget (`--deadline-seconds`, default 120, maximum 300). SIGTERM,
SIGINT and the timer latch cancellation without raising or tearing down capture
failure diagnostics. Explicit checks reject a latch during/after summary output.
Successful production finalization occurs while all fences are still held: after
SQLite and reporting settle, TERM/INT/ALRM switch to Python's raising interrupt
handler, the timer stops, and a final check observes latches from the complete
switch. Delivered late signals then cause nonzero process exit, not an ignored
latch plus exit 0. An emitted summary alone is insufficient. These final raising
interrupts may terminate without an additional HOLD summary; no SQLite work
remains. Python delivery and capture checks are cooperative:
SQLite/C work, blocked output, filesystem calls or uninterruptible kernel I/O
can delay handling past the deadline. No timeout is proof of termination. There
is no foreign child to tear down: PID 1 owns both SQLite work and the fence;
SIGKILL ends that same process/fence together. Loss or death of the host Docker
client can instead leave the backend running **with the fence held**. Independently
inspect the fresh owned container's exact identity/state, stop it if needed and
prove its absence/removal before proceeding; caller death or timeout is never
release proof.

Native qualification recipe, **isolated synthetic data only**, for a separately
authorized operator (not production cutover): create a fresh private fixture
containing all three real SQLite databases with synthetic receipt/Durable IDs,
WAL state and schema versions, plus a separate empty private output parent,
owned by UID/GID 1000. Verify the platform digest, architecture, image provenance
and expected fingerprint independently first. A foreground invocation has this
shape (no shell wrapper, no `--init`, no Docker socket or credential mounts):

```sh
docker run --name "$FRESH_OWNED_NAME" --network none --read-only \
  --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges \
  --mount "type=bind,src=$ISOLATED_FIXTURE,dst=/data" \
  --mount "type=bind,src=$PRIVATE_OUTPUT_PARENT,dst=/capture" \
  --entrypoint python3 -i "$VERIFIED_IMAGE_AT_PLATFORM_DIGEST" - \
  --data /data --output /capture/new-attempt \
  --expected-fingerprint "$INDEPENDENT_EXPECTED_FINGERPRINT" \
  --release-source "$REVIEWED_TARGET_SOURCE_SHA" \
  --platform-digest "$VERIFIED_PLATFORM_DIGEST" --deadline-seconds 120 \
  < docs/pi/scripts/legacy-target-capture.py
```

Here `-i` is **Docker's stdin flag**, before the image; Python receives `-`.
Record actual client exit 0 **and** the independently inspected exact container
PID-1 command, UID/GID, image identity, architecture, container exit 0 and
`OOMKilled=false`. Retain manifests and verify original synthetic IDs/DDL,
identical repeated hashes, unchanged DB/WAL bytes and SHM inode/extent. Qualify
contention, deadline, SIGTERM/SIGINT (also after serialization), and transport
loss/owned stop/removal independently on the target. Preserve every failure and
partial output. Prove fresh owned container removal/absence before another step;
do not use `--rm` to discard inspectable exit/OOM evidence. Native success is
still not host qualification, receipt publication, installation or financial
activation. Production remains HOLD until persistent known-writer exclusion,
retirement/removal of original legacy container/restart paths, and an effective
supported catalogue/Compose target-image pin have separately been proved. The
parent owns trusted receipt publication under the qualified offline fence.

Umbrel hooks are optional bounded orchestration/diagnostics. A new release's
hooks cannot fence the first update's old pre-update path; the mandatory launcher
therefore remains authoritative. No checkpoint is attempted on every SIGTERM.
Local synthetic acceptance does not qualify a real host cutover, architecture
image or installed financial recovery.

### Separate admitted receipt publisher (one-time operator procedure)

`docs/pi/scripts/legacy-offline-publish.py` is separate from the unchanged
capture-only primitive. It never discovers/stops host writers, changes restart
policies, installs services, starts/migrates the app, replays or contacts providers.
Production remains HOLD until original host observations, persistent exclusion
through handoff, actual legacy image/source and supported target catalogue/Compose
pin have been independently reviewed. The review admits the **exact SHA-256 of
the evidence packet** as an explicit argument. Hashing unreviewed claims is not
admission. The private packet has this minimal shape (placeholders are not proof):

```json
{
  "protocol": 1,
  "legacy": {"source": "40 lowercase hex commit", "imageDigest": "sha256:64 lowercase hex"},
  "target": {"source": "reviewed target commit", "imageDigest": "verified target platform digest", "destination": "reviewed target fingerprint"},
  "observations": {
    "legacy-image": {"file": "image-provenance-live.json", "sha256": "exact artifact hash"},
    "target-image": {"file": "image-provenance-live.json", "sha256": "exact artifact hash"},
    "app-exclusion": {"file": "host-exclusion-readback.json", "sha256": "exact artifact hash"},
    "backfill-exclusion": {"file": "host-exclusion-readback.json", "sha256": "exact artifact hash"},
    "writer-inventory": {"file": "host-exclusion-readback.json", "sha256": "exact artifact hash"},
    "handoff-exclusion": {"file": "host-exclusion-readback.json", "sha256": "exact artifact hash"},
    "catalogue-pin": {"file": "legacy-pin-operation.stdout", "sha256": "exact artifact hash"}
  }
}
```

All seven roles require actual original host artifacts. One artifact may support
multiple roles, subject to independent review of its contents. The tool validates
bytes, hashes and binding, not the truth of host facts. Review resolves original
immutable legacy provenance, stopped/retired container and all restart paths,
disabled backfill service/timer paths, complete writer inventory, exclusion
through handoff and supported target pin. Do not include credentials or full
environment dumps. Packet and artifact siblings must be owned mode 0600,
single-link regular files in a private owned mode 0700 directory; artifact names
are local basenames with no symlinks, traversal or external references.

Use the same foreground read-only, network-none, no-init, UID/GID-1000 immutable
platform invocation as capture, now with publisher stdin. Mount the reviewed
unchanged capture script read-only at `/procedure/legacy-target-capture.py`, both
earlier captures under `/earlier` (private; writable for SQLite SHM read marks),
evidence read-only at `/evidence`, and a new private output parent at `/capture`.
Production fixes target helpers to `/app` and requires actual Linux PID 1; no
argument or environment overrides these. Publisher arguments:

```sh
--data /data --captures /earlier --evidence /evidence/packet.json \
--admitted-evidence-sha256 "$INDEPENDENTLY_ADMITTED_PACKET_SHA256" \
--output /capture/new-publish-attempt \
--expected-fingerprint "$REVIEWED_TARGET_FINGERPRINT" \
--release-source "$REVIEWED_TARGET_SOURCE_SHA" \
--platform-digest "$VERIFIED_TARGET_PLATFORM_DIGEST" --deadline-seconds 120
```

Data, earlier captures, evidence and output must be disjoint. The same PID 1
reacquires executor/admission/maintenance EX, verifies both earlier manifests,
files, schemas and target identities, then uses unchanged target helpers for a
fresh private capture/verify. Earlier and fresh entries/schemas must agree exactly.
Stable lock and existing SHM inode/extent guards remain; original DB/WAL inode,
extent and change timestamps must remain unchanged while fenced. Snapshot WAL
must be empty; readonly SQLite may create empty WAL/SHM bookkeeping files.
Evidence and earlier captures are reverified before publication.

The receipt contains protocol 1, actual legacy `git:<source>@sha256:<image>`,
target fingerprint, `offline-exclusive-v1`, externally admitted `app=stopped` /
`lm-backfill=disabled`, exact fresh schemas/files and the admitted evidence SHA.
A fsynced private staging file in data is atomically linked to
`offline-cutover.json` without clobbering any existing path, including dangling
symlinks. Successful publication removes only its own staging alias, fsyncs data
and reads back the receipt while all fences remain held. Cooperative deadline
and signal checks cover reporting and fenced finalization.

A nonzero exit, signal, transport loss or missing independent exit/OOM readback
means HOLD: a durable receipt or staging alias may exist. Retain all evidence and
reconcile offline; never automatically remove or retry. A `published` stdout
line alone is insufficient. Direct functions and tests authorize only synthetic
fixtures. Test-only `SATSSURGE_FIXTURE_APP_ROOT=/app` selects immutable helpers for
native fixtures and grants no production authority. Both target architectures
require separate native qualification, including actual PID-1/UID/GID and late
failure behavior, before production use.
