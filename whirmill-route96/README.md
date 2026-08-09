# Route96 Community for Umbrel

This package preserves the live Route96 override in a reproducible Community
App Store definition.

- Upstream source: `v0l/route96`
- Source commit: `3429578e0cd9746431a1cc925edcdd21405233d3`
- Image: `ghcr.io/whirmill/route96:v0.7.0-3429578`
- Pinned image index: `sha256:9ec562252745fedb0f40000fb120fa849865476c42c0b0179df1431b2c53eedb`
- Supported platforms: `linux/amd64`, `linux/arm64`

The OCI provenance attached to the image identifies the same source repository
and commit. The tag name is retained only for readability; the digest makes the
runtime image immutable.

## Migration from the official app

The official `route96` app and `whirmill-route96` both use port `8002`, so they
must not run concurrently. Stop the official app, copy its `data` directory to
the new app-data path, change only the database hostname in `config.yaml` from
`route96_db_1` to `whirmill-route96_db_1`, then install and verify the community
app before removing the migration snapshot.

Route96 protocol requests deliberately bypass Umbrel account authentication,
matching the official package and allowing Nostr clients to use Blossom and
NIP-96. Keep port `8002` restricted to the intended LAN or private VPN.
