#!/bin/sh
# Run as umbrel on the Umbrel host, only with the owner's approval. Bakes a separate
# macaroon for SatsSurge's native Loop Out client (#258, no loopd): a receiver key in
# family 99 and the preimage by ECDH (DeriveNextKey, DeriveSharedKey), the sweep's
# address, fee estimate, signature and broadcast (NextAddr, EstimateFee, SignOutputRaw,
# PublishTransaction), the server HTLC's confirmation and spend notifications, the
# decode of the swap invoices, the node's height (GetInfo) and the L402 payment's
# preimage (TrackPaymentV2). Paying keeps using the write macaroon (SendPaymentV2).
# Without this file the app runs unchanged and Loop Out stays unavailable.
# Residual risk: macaroon URIs cannot restrict request fields; SignOutputRaw signs any
# input with any key LND holds, and PublishTransaction broadcasts any transaction. The
# app signs only the success leaf of its own Loop HTLC with its family-99 key and
# publishes only that sweep to its own wallet address.
set -eu
umask 077
APP_DIR=${1:?Supply installed app data path}
URIS="uri:/walletrpc.WalletKit/DeriveNextKey uri:/walletrpc.WalletKit/NextAddr uri:/walletrpc.WalletKit/EstimateFee uri:/walletrpc.WalletKit/PublishTransaction uri:/signrpc.Signer/SignOutputRaw uri:/signrpc.Signer/DeriveSharedKey uri:/chainrpc.ChainNotifier/RegisterConfirmationsNtfn uri:/chainrpc.ChainNotifier/RegisterSpendNtfn uri:/lnrpc.Lightning/DecodePayReq uri:/lnrpc.Lightning/GetInfo uri:/routerrpc.Router/TrackPaymentV2"
CRED="$APP_DIR/credentials/loop.macaroon"
mkdir -p "$APP_DIR/credentials"
# As for the other macaroons: the permission set is recorded next to the credential, a
# different set is baked again, and the new file replaces the old one only once complete.
if [ ! -s "$CRED" ] || [ "$(cat "$CRED.uris" 2>/dev/null)" != "$URIS" ]; then
  # shellcheck disable=SC2086 # one argument per URI
  docker exec lightning_lnd_1 lncli bakemacaroon --save_to=/tmp/satssurge-loop.macaroon $URIS >/dev/null
  docker cp lightning_lnd_1:/tmp/satssurge-loop.macaroon "$CRED.new"
  docker exec lightning_lnd_1 rm /tmp/satssurge-loop.macaroon
  chmod 600 "$CRED.new"
  mv "$CRED.new" "$CRED"
  printf '%s\n' "$URIS" > "$CRED.uris"
fi
chmod 600 "$CRED"
# The app reads the credential at startup; restart it (owner action) to enable Loop Out.
