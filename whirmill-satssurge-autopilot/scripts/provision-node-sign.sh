#!/bin/sh
# Run as umbrel on the Umbrel host, only with the owner's approval. Bakes the narrow
# macaroon for SatsSurge's owner signing (#277): /sign on Telegram and `satssurge sign`
# on the console sign a text the owner sends with the node key (LND SignMessage, as
# `lncli signmessage`), to prove node ownership to a service.
# - node-sign.macaroon: SignMessage only. Kept apart from amboss-sign.macaroon so the
#   owner can revoke Amboss's signing and their own independently.
# Verification (/verify) is local and needs no credential; the signer's alias comes from
# GetNodeInfo under the existing channel credential.
# Without this file the app runs unchanged and /sign answers that the credential is
# missing; the app reads it again while absent, so no restart is needed. The switch is
# telegram.nodeSign in config/satssurge.json (1 by default).
# Residual risk: SignMessage signs any text with the node key; only the paired Telegram
# owner and the owner console reach it, never a model tool.
set -eu
umask 077
APP_DIR=${1:?Supply installed app data path}
URIS="uri:/lnrpc.Lightning/SignMessage"
CRED="$APP_DIR/credentials/node-sign.macaroon"
mkdir -p "$APP_DIR/credentials"
if [ ! -s "$CRED" ] || [ "$(cat "$CRED.uris" 2>/dev/null)" != "$URIS" ]; then
  # shellcheck disable=SC2086 # one argument per URI
  docker exec lightning_lnd_1 lncli bakemacaroon --save_to=/tmp/satssurge-node-sign.macaroon $URIS >/dev/null
  docker cp lightning_lnd_1:/tmp/satssurge-node-sign.macaroon "$CRED.new"
  docker exec lightning_lnd_1 rm /tmp/satssurge-node-sign.macaroon
  chmod 600 "$CRED.new"
  mv "$CRED.new" "$CRED"
  printf '%s\n' "$URIS" >"$CRED.uris"
fi
chmod 600 "$CRED"
