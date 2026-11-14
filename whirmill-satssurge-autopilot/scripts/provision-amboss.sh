#!/bin/sh
# Run as umbrel on the Umbrel host, only with the owner's approval. Bakes two separate,
# narrow macaroons for SatsSurge's Amboss features (#265), replacing ThunderHub's:
# - amboss-sign.macaroon: SignMessage only, for the Amboss health check (the app signs a
#   code-fixed timestamp payload; no model tool reaches it);
# - amboss-backup.macaroon: ExportAllChannelBackups and SubscribeChannelBackups, to push
#   LND's static channel backup to Amboss. That blob is encrypted by LND with a key
#   derived from the seed; the app never decrypts it.
# Each credential holds one capability class. Without these files the app runs unchanged
# and the Amboss features hold with a reason (they are also off by default:
# amboss.healthCheck and amboss.channelBackups in config/satssurge.json).
# Residual risk: SignMessage signs any text with the node key; only the app's own code
# can call it, with its fixed payload.
set -eu
umask 077
APP_DIR=${1:?Supply installed app data path}
mkdir -p "$APP_DIR/credentials"
bake() { # name, URIs
  cred="$APP_DIR/credentials/$1.macaroon"
  if [ ! -s "$cred" ] || [ "$(cat "$cred.uris" 2>/dev/null)" != "$2" ]; then
    # shellcheck disable=SC2086 # one argument per URI
    docker exec lightning_lnd_1 lncli bakemacaroon --save_to="/tmp/satssurge-$1.macaroon" $2 >/dev/null
    docker cp "lightning_lnd_1:/tmp/satssurge-$1.macaroon" "$cred.new"
    docker exec lightning_lnd_1 rm "/tmp/satssurge-$1.macaroon"
    chmod 600 "$cred.new"
    mv "$cred.new" "$cred"
    printf '%s\n' "$2" >"$cred.uris"
  fi
  chmod 600 "$cred"
}
bake amboss-sign "uri:/lnrpc.Lightning/SignMessage"
bake amboss-backup "uri:/lnrpc.Lightning/ExportAllChannelBackups uri:/lnrpc.Lightning/SubscribeChannelBackups"
# The app reads the credentials at startup; restart it (owner action) to enable them.
