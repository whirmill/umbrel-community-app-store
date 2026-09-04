# SimpleX XFTP Relay for Umbrel

This package runs the XFTP file relay for `xftp.satssurge.com:7443`. It is separate
from the SMP messaging relay and handles encrypted file payloads, including
images, videos, documents, and voice messages.

## Runtime

- Official `simplexchat/xftp-server:v7.0.1` image pinned to its verified
  multi-architecture digest.
- Umbrel host binding on TCP `7443` to container TCP `443`.
- Persistent configuration, server state, and file storage.
- Global storage quota: `20gb`.
- Upload creation requires Umbrel's app-specific generated password.
- Local authenticated setup page on Umbrel port `5231`.

The Cloudflare `A` record `xftp.satssurge.com` must point to the current public
IPv4 address with proxy status **DNS only**. The router forwards public TCP
`7443` to Umbrel TCP `7443`.

Umbrel 2 uses host TCP `443` for its own HTTPS ingress. XFTP uses a separate
public port: Nginx Proxy Manager keeps public TCP `443` forwarded to Umbrel
TCP `40443`, and public TCP `80` forwarded to Umbrel TCP `40080`.

## Upgrading the host port for Umbrel 2

Back up the installed compose and manifest before changing the package. Preserve
all XFTP configuration, identity, state, and file-storage directories.

1. Change the XFTP host binding from `443:443` to `7443:443` and restart only XFTP.
2. Verify local TCP `7443` serves the existing XFTP certificate and fingerprint.
3. Change only the router's XFTP rule from public `7443` → Umbrel `443` to
   public `7443` → Umbrel `7443`. Leave both Nginx Proxy Manager rules unchanged.
4. Verify a file transfer from a client outside the LAN.

The public endpoint stays `xftp.satssurge.com:7443`; existing clients already
using that port need no change. The setup page must include `:7443` in copied
addresses. Do not regenerate the relay identity.

## Client configuration

Open the app through Umbrel and copy the concealed XFTP address. Add it to the
SimpleX Chat file-server configuration. Keep the complete address private: it
contains the upload-creation password.

## Verification

1. The `server` service is healthy and has generated its fingerprint.
2. The server certificate and fingerprint persist across an Umbrel restart.
3. External TCP/TLS on `xftp.satssurge.com:7443` reaches that exact certificate.
4. A SimpleX client can upload, download, and delete a test attachment.
5. A wrong password cannot create an upload and the quota remains bounded.

## Rollback

1. Disable only router forwarding for XFTP TCP `7443`. Do not point it back to
   Umbrel TCP `443`, which now serves Umbrel's HTTPS ingress.
2. Revert SimpleX clients to public XFTP servers.
3. Stop the app while retaining its data until outstanding downloads finish.
4. Remove the DNS record and uninstall only when stored transfers are no longer
   required.
