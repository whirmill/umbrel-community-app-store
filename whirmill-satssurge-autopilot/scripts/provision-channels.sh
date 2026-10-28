#!/bin/sh
# Run as umbrel on the Umbrel host, only with the owner's approval. Bakes a third,
# separate macaroon for owner-approved channel opens and cooperative closes.
# Existing read/write macaroons are not touched. Without this file the app runs
# unchanged and channel operations stay unavailable.
# Residual risk: macaroon URIs cannot restrict request fields. CloseChannel also
# permits force and delivery_address, and OpenChannelSync permits push_sat. The
# app never sets them (force:false, push_sat:0, no delivery address), but a
# compromised container holding this file could. Field-level enforcement would
# need LND RPC middleware.
set -eu
umask 077
APP_DIR=${1:?Supply installed app data path}
# GetNodeInfo and QueryRoutes are read-only: peer candidates and the cost of return routes.
URIS="uri:/lnrpc.Lightning/ConnectPeer uri:/lnrpc.Lightning/ListPeers uri:/lnrpc.Lightning/OpenChannelSync uri:/lnrpc.Lightning/CloseChannel uri:/lnrpc.Lightning/PendingChannels uri:/lnrpc.Lightning/ClosedChannels uri:/lnrpc.Lightning/EstimateFee uri:/lnrpc.Lightning/GetNodeInfo uri:/lnrpc.Lightning/QueryRoutes"
CRED="$APP_DIR/credentials/channel.macaroon"
mkdir -p "$APP_DIR/credentials"
# The permission set is recorded next to the credential: a different set (an older install) is baked again,
# and the new file replaces the old one only once complete. The old macaroon stays valid in LND until its
# root key is revoked.
if [ ! -s "$CRED" ] || [ "$(cat "$CRED.uris" 2>/dev/null)" != "$URIS" ]; then
  # shellcheck disable=SC2086 # one argument per URI
  docker exec lightning_lnd_1 lncli bakemacaroon --save_to=/tmp/satssurge-channel.macaroon $URIS >/dev/null
  docker cp lightning_lnd_1:/tmp/satssurge-channel.macaroon "$CRED.new"
  docker exec lightning_lnd_1 rm /tmp/satssurge-channel.macaroon
  chmod 600 "$CRED.new"
  mv "$CRED.new" "$CRED"
  printf '%s\n' "$URIS" > "$CRED.uris"
fi
chmod 600 "$CRED"
# The app reads the credential at startup; restart it (owner action) to enable channel proposals.
