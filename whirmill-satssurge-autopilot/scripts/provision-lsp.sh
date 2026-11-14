#!/bin/sh
# Run as umbrel on the Umbrel host, only with the owner's approval. Bakes a separate
# macaroon for SatsSurge as an LSPS1 service (#261): the peer messages that carry the
# LSPS0/LSPS1 requests and answers (SendCustomMessage, SubscribeCustomMessages). The
# paid order's hold invoice uses the sale macaroon (provision-sale.sh). Without this
# file the app runs unchanged and LSPS1 stays unavailable.
# Residual risk: macaroon URIs cannot restrict request fields; SendCustomMessage can
# send any message type to a connected peer and the subscription sees every custom
# message. The app sends and reads only LSPS message type 37913.
set -eu
umask 077
APP_DIR=${1:?Supply installed app data path}
URIS="uri:/lnrpc.Lightning/SendCustomMessage uri:/lnrpc.Lightning/SubscribeCustomMessages"
CRED="$APP_DIR/credentials/lsp.macaroon"
mkdir -p "$APP_DIR/credentials"
# As for the other macaroons: the permission set is recorded next to the credential, a
# different set is baked again, and the new file replaces the old one only once complete.
if [ ! -s "$CRED" ] || [ "$(cat "$CRED.uris" 2>/dev/null)" != "$URIS" ]; then
  # shellcheck disable=SC2086 # one argument per URI
  docker exec lightning_lnd_1 lncli bakemacaroon --save_to=/tmp/satssurge-lsp.macaroon $URIS >/dev/null
  docker cp lightning_lnd_1:/tmp/satssurge-lsp.macaroon "$CRED.new"
  docker exec lightning_lnd_1 rm /tmp/satssurge-lsp.macaroon
  chmod 600 "$CRED.new"
  mv "$CRED.new" "$CRED"
  printf '%s\n' "$URIS" > "$CRED.uris"
fi
chmod 600 "$CRED"
# The app reads the credential at startup; restart it (owner action) to enable LSPS1.
