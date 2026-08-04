# SimpleX XFTP Relay for Umbrel

This package runs the XFTP file relay for `xftp.satssurge.com`. It is separate
from the SMP messaging relay and handles encrypted file payloads, including
images, videos, documents, and voice messages.

## Runtime

- Official `simplexchat/xftp-server:v7.0.1` image pinned to its verified
  multi-architecture digest.
- Direct Umbrel host binding on TCP `443`.
- Persistent configuration, server state, and file storage.
- Global storage quota: `20gb`.
- Upload creation requires Umbrel's app-specific generated password.
- Local authenticated setup page on Umbrel port `5231`.

The Cloudflare `A` record `xftp.satssurge.com` must point to the current public
IPv4 address with proxy status **DNS only**. The router forwards public TCP
`443` to Umbrel TCP `443`.

## Client configuration

Open the app through Umbrel and copy the concealed XFTP address. Add it to the
SimpleX Chat file-server configuration. Keep the complete address private: it
contains the upload-creation password.

## Verification

1. The `server` service is healthy and has generated its fingerprint.
2. The server certificate and fingerprint persist across an Umbrel restart.
3. External TCP/TLS on `xftp.satssurge.com:443` reaches that exact certificate.
4. A SimpleX client can upload, download, and delete a test attachment.
5. A wrong password cannot create an upload and the quota remains bounded.

## Rollback

1. Remove router forwarding for TCP `443`.
2. Revert SimpleX clients to public XFTP servers.
3. Stop the app while retaining its data until outstanding downloads finish.
4. Remove the DNS record and uninstall only when stored transfers are no longer
   required.
