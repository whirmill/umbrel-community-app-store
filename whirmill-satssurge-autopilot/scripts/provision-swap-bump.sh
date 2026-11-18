#!/bin/sh
# Run as umbrel on the Umbrel host, only with the owner's approval. Bakes the narrow
# macaroon for SatsSurge's fee bump of a stuck incoming swap payment (#253 S6): when the
# payment to our swap address stays unconfirmed, the app proposes a child-pays-for-parent
# (CPFP) of our own output of it, and runs it only after the owner's Approva on Telegram.
# - swap-bump.macaroon: WalletKit BumpFee only. LND's sweeper spends an output of our own
#   wallet back to our wallet, with a higher fee and never more than the call's budget in
#   fees. No SendCoins, no address, key or other wallet call.
# The app accepts the file only when swap-bump.macaroon.uris beside it holds exactly this
# one URI; without it, or with any other list, swap.stuckBump in config/satssurge.json
# (0 by default) proposes nothing and a stuck payment is only told to the owner.
# Residual risk: macaroon URIs cannot restrict request fields; BumpFee permits a bump of
# any output the wallet owns, with any budget, so a leaked file can spend wallet funds in
# miner fees (never to another address). The app bumps only a swap's own output, within
# swap.bumpMaxSat and the month's swap budget, and only after Approva.
set -eu
umask 077
APP_DIR=${1:?Supply installed app data path}
URIS="uri:/walletrpc.WalletKit/BumpFee"
CRED="$APP_DIR/credentials/swap-bump.macaroon"
mkdir -p "$APP_DIR/credentials"
# As for the other macaroons: the permission set is recorded next to the credential, a
# different set is baked again, and the new file replaces the old one only once complete.
if [ ! -s "$CRED" ] || [ "$(cat "$CRED.uris" 2>/dev/null)" != "$URIS" ]; then
  # shellcheck disable=SC2086 # one argument per URI
  docker exec lightning_lnd_1 lncli bakemacaroon --save_to=/tmp/satssurge-swap-bump.macaroon $URIS >/dev/null
  docker cp lightning_lnd_1:/tmp/satssurge-swap-bump.macaroon "$CRED.new"
  docker exec lightning_lnd_1 rm /tmp/satssurge-swap-bump.macaroon
  chmod 600 "$CRED.new"
  mv "$CRED.new" "$CRED"
  printf '%s\n' "$URIS" >"$CRED.uris"
fi
chmod 600 "$CRED"
# The app reads the credential when the swap actuator starts; restart it (owner action).
