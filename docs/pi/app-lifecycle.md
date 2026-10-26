# Application lifecycle and database maintenance

Production startup (`npm start`, image CMD) runs `scripts/app_launcher.py` as
UID 1000. The image bundles Debian Bookworm's standard-library Python 3 runtime
and the existing SQLite checkpoint helper. Node remains the pinned Node 24
image. No Docker socket, elevated capability, sudo or hook success is required.
The historical import (`npm run import`) was removed in 0.8.0; the data it
imported on 8 October stays in `operational.sqlite`.

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

## Legacy cutover (done on 2026-10-11)

A dataset with databases but no `lifecycle.json` is rejected unless
`data/offline-cutover.json` qualifies it (`scripts/app_launcher.py`): protocol 1,
the new release as `destination`, fence `offline-exclusive-v1`, writers
`{"app": "stopped", "lm-backfill": "disabled"}`, and the exact schema
identities of a fresh capture. The node passed this once, on 2026-10-11, and
has had `lifecycle.json` ever since. The one-time capture and publication tools
used then were removed on 2026-10-25 (#137); they remain in Git history.
