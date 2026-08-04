# SimpleX SMP Relay for Umbrel

This package is a bounded proof of concept for `smp.satssurge.com`.

It runs only the SimpleX Messaging Protocol relay. File transfers continue to
use the XFTP relays configured in the SimpleX clients, and calls continue to use
their configured WebRTC/STUN/TURN infrastructure.

## Runtime layout

- `server`: upstream `simplexchat/smp-server:v7.0.1`, pinned to
  the verified multi-architecture OCI digest.
- `status`: local connection-details page, reachable through the
  authenticated Umbrel app proxy on port `5230`.
- SMP is published directly on Umbrel host TCP port `5223`.
- Configuration and certificates persist in `data/smp-config`; queue records,
  undelivered messages, and statistics persist in `data/smp-state`.
- Umbrel's generated app password protects creation of new queues. The local
  status page combines it with the generated certificate fingerprint without
  logging the resulting server address.

## PoC ingress

The relay container binds TCP `5223` directly on the Umbrel host. The router
forwards public TCP `5223` to TCP `5223` on the Umbrel host; no reverse proxy is
in the SMP data path.

The Cloudflare record `smp.satssurge.com` must be an `A` record pointing to the
current public IPv4 address with proxy status **DNS only**.

## Install

```sh
Install this package as `whirmill-simplex-smp` after importing the Whirmill
Community App Store. Do not install it while the legacy `simplex-smp` app is
still binding host TCP port `5223`.
```

Open `http://umbrel.local:5230` through Umbrel and copy the generated server
address into SimpleX Chat under Network & Servers.

## Verification

Do not treat a running container or an HTTP status page as relay proof. Check:

1. The `server` service is healthy and its fingerprint file exists.
2. Umbrel host TCP `5223` maps directly to the relay container.
3. An external TLS connection reaches the SimpleX certificate.
4. A SimpleX client validates the fingerprint and successfully creates a queue.
5. Restarting the Umbrel app preserves the fingerprint and server identity.

## Rollback

1. Remove the router forwarding rule for TCP `5223`.
2. Remove the temporary DNS record if it is no longer needed.
3. Uninstall `whirmill-simplex-smp` only if its persisted relay identity is no longer
   required.
