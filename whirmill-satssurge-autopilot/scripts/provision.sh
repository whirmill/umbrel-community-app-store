#!/bin/sh
# Run as umbrel on the Umbrel host. No admin macaroon is exposed to the app.
set -eu
umask 077
APP_DIR=${1:?Supply installed app data path}
mkdir -p "$APP_DIR/data" "$APP_DIR/credentials" "$APP_DIR/config"
# ListInvoices is read-only: payments received on the node's own invoices (0.9.44 notices); preimages and
# payment requests never leave the app's LND client.
# QueryMissionControl is read-only: LND's pair history of payment successes and failures, an input of the kernel's
# route-reliability (0.9.64, owner approval 5 Nov 2026).
READ_URIS="uri:/lnrpc.Lightning/GetInfo uri:/lnrpc.Lightning/WalletBalance uri:/lnrpc.Lightning/ListChannels uri:/lnrpc.Lightning/GetChanInfo uri:/lnrpc.Lightning/ForwardingHistory uri:/lnrpc.Lightning/ListPayments uri:/lnrpc.Lightning/SubscribeChannelGraph uri:/lnrpc.Lightning/SubscribeChannelEvents uri:/routerrpc.Router/TrackPaymentV2 uri:/routerrpc.Router/SubscribeHtlcEvents uri:/lnrpc.Lightning/ListInvoices uri:/routerrpc.Router/QueryMissionControl"
READ="$APP_DIR/credentials/read.macaroon"
# As for the channel macaroon: the permission set is recorded next to the credential, a different set (an older
# install) is baked again, and the new file replaces the old one only once complete.
if [ ! -s "$READ" ] || [ "$(cat "$READ.uris" 2>/dev/null)" != "$READ_URIS" ]; then
  # shellcheck disable=SC2086 # one argument per URI
  docker exec lightning_lnd_1 lncli bakemacaroon --save_to=/tmp/satssurge-read.macaroon $READ_URIS >/dev/null
  docker cp lightning_lnd_1:/tmp/satssurge-read.macaroon "$READ.new"
  docker exec lightning_lnd_1 rm /tmp/satssurge-read.macaroon
  chmod 600 "$READ.new"
  mv "$READ.new" "$READ"
  printf '%s\n' "$READ_URIS" > "$READ.uris"
fi
if [ ! -s "$APP_DIR/credentials/write.macaroon" ]; then
  docker exec lightning_lnd_1 lncli bakemacaroon --save_to=/tmp/satssurge-write.macaroon uri:/lnrpc.Lightning/AddInvoice uri:/routerrpc.Router/SendPaymentV2 uri:/lnrpc.Lightning/UpdateChannelPolicy >/dev/null
  docker cp lightning_lnd_1:/tmp/satssurge-write.macaroon "$APP_DIR/credentials/write.macaroon"
  docker exec lightning_lnd_1 rm /tmp/satssurge-write.macaroon
fi
cp /home/umbrel/umbrel/app-data/lightning/data/lnd/tls.cert "$APP_DIR/credentials/tls.cert"
chmod 600 "$APP_DIR/credentials/"*
# No root keys, admin macaroon, wallet database or seed is mounted.

docker exec lightning_lnd_1 lncli getinfo | python3 -c 'import json,sys; print(json.load(sys.stdin)["identity_pubkey"])' > "$APP_DIR/credentials/node-pubkey"
chmod 600 "$APP_DIR/credentials/node-pubkey"
