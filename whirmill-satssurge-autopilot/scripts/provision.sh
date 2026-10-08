#!/bin/sh
# Run as umbrel on the Umbrel host. No admin macaroon is exposed to the app.
set -eu
umask 077
APP_DIR=${1:?Supply installed app data path}
mkdir -p "$APP_DIR/data" "$APP_DIR/credentials" "$APP_DIR/history" "$APP_DIR/interlock"
if [ ! -s "$APP_DIR/credentials/read.macaroon" ]; then
  docker exec lightning_lnd_1 lncli bakemacaroon --save_to=/tmp/satssurge-read.macaroon uri:/lnrpc.Lightning/GetInfo uri:/lnrpc.Lightning/WalletBalance uri:/lnrpc.Lightning/ListChannels uri:/lnrpc.Lightning/GetChanInfo uri:/lnrpc.Lightning/ForwardingHistory uri:/lnrpc.Lightning/ListPayments uri:/routerrpc.Router/TrackPaymentV2 uri:/routerrpc.Router/SubscribeHtlcEvents >/dev/null
  docker cp lightning_lnd_1:/tmp/satssurge-read.macaroon "$APP_DIR/credentials/read.macaroon"
  docker exec lightning_lnd_1 rm /tmp/satssurge-read.macaroon
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
