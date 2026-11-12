#!/bin/sh
# Run as umbrel on the Umbrel host, only with the owner's approval. Bakes a fourth,
# separate macaroon for RoboSats swap-outs (#139): a fresh on-chain address for each
# order (NewAddress) and the decode of a coordinator's hold invoice (DecodePayReq),
# checked before any payment. Paying uses the existing write macaroon (SendPaymentV2)
# and reading the wallet's transactions the channel macaroon (GetTransactions, from
# provision-channels.sh); neither changes here. Without this file the app runs
# unchanged and swaps hold.
# Residual risk: macaroon URIs cannot restrict request fields; NewAddress permits any
# address type and account. The app asks only for a new P2WPKH address of the default
# account. Neither call moves funds or reads balances.
set -eu
umask 077
APP_DIR=${1:?Supply installed app data path}
URIS="uri:/lnrpc.Lightning/NewAddress uri:/lnrpc.Lightning/DecodePayReq"
CRED="$APP_DIR/credentials/swap.macaroon"
mkdir -p "$APP_DIR/credentials"
# As for the other macaroons: the permission set is recorded next to the credential, a
# different set is baked again, and the new file replaces the old one only once complete.
if [ ! -s "$CRED" ] || [ "$(cat "$CRED.uris" 2>/dev/null)" != "$URIS" ]; then
  # shellcheck disable=SC2086 # one argument per URI
  docker exec lightning_lnd_1 lncli bakemacaroon --save_to=/tmp/satssurge-swap.macaroon $URIS >/dev/null
  docker cp lightning_lnd_1:/tmp/satssurge-swap.macaroon "$CRED.new"
  docker exec lightning_lnd_1 rm /tmp/satssurge-swap.macaroon
  chmod 600 "$CRED.new"
  mv "$CRED.new" "$CRED"
  printf '%s\n' "$URIS" > "$CRED.uris"
fi
chmod 600 "$CRED"
# The app reads the credential at startup; restart it (owner action) to enable swaps.
