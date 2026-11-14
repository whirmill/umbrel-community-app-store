#!/bin/sh
# Run as umbrel on the Umbrel host, only with the owner's approval. Bakes a separate
# macaroon for the liquidity SatsSurge sells (#260 Magma leases, #261 LSPS1 orders): a
# hold invoice for each order (AddHoldInvoice), settled once the channel is open
# (SettleInvoice) or cancelled when it is refused or fails (CancelInvoice), and read
# back (LookupInvoice). Without this file the app runs unchanged and sales hold.
# Residual risk: macaroon URIs cannot restrict request fields; SettleInvoice and
# CancelInvoice can act on any hold invoice of the node. The app settles only its own
# (it knows the preimage) and cancels only its own payment hashes.
set -eu
umask 077
APP_DIR=${1:?Supply installed app data path}
URIS="uri:/invoicesrpc.Invoices/AddHoldInvoice uri:/invoicesrpc.Invoices/SettleInvoice uri:/invoicesrpc.Invoices/CancelInvoice uri:/lnrpc.Lightning/LookupInvoice"
CRED="$APP_DIR/credentials/sale.macaroon"
mkdir -p "$APP_DIR/credentials"
# As for the other macaroons: the permission set is recorded next to the credential, a
# different set is baked again, and the new file replaces the old one only once complete.
if [ ! -s "$CRED" ] || [ "$(cat "$CRED.uris" 2>/dev/null)" != "$URIS" ]; then
  # shellcheck disable=SC2086 # one argument per URI
  docker exec lightning_lnd_1 lncli bakemacaroon --save_to=/tmp/satssurge-sale.macaroon $URIS >/dev/null
  docker cp lightning_lnd_1:/tmp/satssurge-sale.macaroon "$CRED.new"
  docker exec lightning_lnd_1 rm /tmp/satssurge-sale.macaroon
  chmod 600 "$CRED.new"
  mv "$CRED.new" "$CRED"
  printf '%s\n' "$URIS" > "$CRED.uris"
fi
chmod 600 "$CRED"
# The app reads the credential at startup; restart it (owner action) to enable sales.
