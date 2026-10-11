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
shared lock; `lm_backfill.py` acquires it before its existing writer lock and
before opening operational SQLite. The backfill installer copies the shared
module together with its consumers; `install-backfill.sh <app> --helpers-only`
updates helpers without creating, enabling or starting a unit. Checkpoint/migration takes maintenance
exclusively. Lock order is executor (application/checkpoint only), admission,
maintenance, backfill writer (backfill only). Deadlines are 15 seconds for lock
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

Umbrel hooks are optional bounded orchestration/diagnostics. A new release's
hooks cannot fence the first update's old pre-update path; the mandatory launcher
therefore remains authoritative. No checkpoint is attempted on every SIGTERM.
Local synthetic acceptance does not qualify a real host cutover, architecture
image or installed financial recovery.
