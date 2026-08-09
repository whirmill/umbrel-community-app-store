# Nostr VPN Community for Umbrel

This package tracks the current Nostr VPN release while the official Umbrel app
is still pinned to v4.0.67.

- Upstream release: `v4.1.6`
- Source commit: `4320001ec84eeec7a32d54419569f63012c81c8d`
- Image repository: `ghcr.io/whirmill/nostr-vpn-umbrel`
- Pinned image index: `sha256:ceffbb7bb08cd2f06a989130fe075d5b670233a2e2ae3efa12fac48006375d4a`
- Supported platforms: `linux/amd64`, `linux/arm64`

The image reuses the verified per-architecture root filesystems bundled in the
official v4.1.6 StartOS release packages. Those packages build the same
`umbrel/Dockerfile` used by the upstream Umbrel integration and include both
`nvpn` and `nvpn-web`. The final app compose references the resulting
multi-platform image by immutable digest.

## Migration from the official app

The official `nostr-vpn` app and `whirmill-nostr-vpn` both use port `38180` and
host networking for the daemon, so they must not run concurrently. Stop the
official app, copy its persistent `data` directory to the new app-data path,
then install the community package and verify the existing network roster
before deleting the migration snapshot.
