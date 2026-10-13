# Offline Telegram voice worker

The app downloads newly accepted owner voice notes from Telegram and exchanges
private immutable request/result manifests with this worker. This process has
no network, credential, app-database or job-admission access. Decoding and speech
recognition are offline; the resulting transcript is ordinary user text sent to
the existing configured chat model. Spoken slash commands are never transport
controls. Old discarded voice inputs cannot be recovered and are not replayed.

`Dockerfile` builds CPU whisper.cpp 1.9.5 and a restricted FFmpeg 7.1.1 decoder
from byte-verified source archives. It bakes the immutable multilingual base
model (147951465 bytes, SHA256 in `pins.json`) and verifies it again at startup.
There is no runtime download, cloud fallback, GPU, translation or retained prompt
context. MIT and LGPL notices/build configurations are included in the image.
The archive URLs are the commit-bound codeload URL and the official versioned
FFmpeg release URL in `fetch_asset.py`; model URL is bound to revision
5359861c739e955e79d9a303bcbc70fb988958b1. Build package versions are captured in
`/opt/voice/licenses/build-packages.txt`; package archives use the distribution
repository, so this is a pinned application-source build rather than a claim of
bit-for-bit reproducibility for the compiler image.

Bounds: one inference, eight pending notes, 10 MiB compressed per note, 120 seconds
actual decoded duration, 3840000 PCM sample bytes, decoder deadline 15 seconds,
inference deadline 120 seconds, 16k transcript characters. Ogg/Opus is checked
against decoded media; sender MIME/duration/size are declarations, not proof.
A silence-energy guard rejects silence; transcription quality and hallucinations
in noise still require actual model tests. Worker group closure and an inherited
process lock prevent an unproven timeout from becoming replacement authority.
An unknown release stays held. App shutdown cancels and awaits the pump.

Both images seed `/voice-spool` as a real private directory, owner 1000:1000,
mode 0700. The Compose fragment mounts one private named volume at this path,
so initialization needs no host root helper. Only this path is shared. Protocol files are mode 0600 with no-follow
regular-file checks, bounded reads, hashes, fsync and atomic renames. Successful
and confirmed terminal scratch is removed; unknown releases retain evidence and
count against the 90 MiB spool cap. Frozen transcripts/provenance live in normal
private operational receipts, never in diagnostic logs. Nothing modifies the
original `telegram_updates.body`.

`compose.candidate.yml` is **NOT READY FOR DEPLOYMENT** without a verified
published worker image digest and actual native amd64/arm64 qualification. Merge
it with the app Compose only after binding `SATSSURGE_VOICE_IMAGE` to an immutable
`ghcr.io/...@sha256:...` reference. The server keeps its existing 768m budget; the
worker adds a separate 768m/2 CPU/64 PID budget and 32 MiB bounded tmpfs. CI produces
a multiarch build receipt; QEMU compilation does not establish native instruction
compatibility, speech quality, timing, memory or actual Telegram delivery.

Local tests: `node --test dist/test/telegram-voice.test.js` after app build,
`python3 -m unittest discover -s voice/tests -v`. Fixtures use fake audio or
consented generated subprocess output; real private Telegram audio and actual
model inference are outside these local checks.
