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
mkdir -p "$APP_DIR/credentials"
if [ ! -s "$APP_DIR/credentials/channel.macaroon" ]; then
  docker exec lightning_lnd_1 lncli bakemacaroon --save_to=/tmp/satssurge-channel.macaroon uri:/lnrpc.Lightning/ConnectPeer uri:/lnrpc.Lightning/ListPeers uri:/lnrpc.Lightning/OpenChannelSync uri:/lnrpc.Lightning/CloseChannel uri:/lnrpc.Lightning/PendingChannels uri:/lnrpc.Lightning/ClosedChannels uri:/lnrpc.Lightning/EstimateFee uri:/lnrpc.Lightning/GetNodeInfo >/dev/null
  docker cp lightning_lnd_1:/tmp/satssurge-channel.macaroon "$APP_DIR/credentials/channel.macaroon"
  docker exec lightning_lnd_1 rm /tmp/satssurge-channel.macaroon
fi
chmod 600 "$APP_DIR/credentials/channel.macaroon"
# The app reads the credential at startup; restart it (owner action) to enable channel proposals.
