# SatsSurge Autopilot: installer

A Lightning routing agent for an Umbrel LND node, driven from Telegram. The
application source is private (`whirmill/satssurge-autopilot`); this folder
holds the Umbrel manifest, the compose file and the one-time provisioning
scripts that run on the node.

## Installation

1. **Install** the app from this community app store.
2. **Provision LND credentials once**, as `umbrel` on the host. Do not rerun
   this for certificate renewals.

   ```sh
   sh scripts/provision.sh /home/umbrel/umbrel/app-data/whirmill-satssurge-autopilot
   ```

   Both scripts record each macaroon's permission set beside it (`*.uris`) and
   bake it again when a release changes that set; restart the app afterwards.

   Optional, with the owner's approval: `scripts/provision-channels.sh` (same
   argument) bakes a separate channel macaroon. Without it, channel open/close
   proposals stay unavailable and everything else works unchanged. With it,
   each open or cooperative close still runs only after the owner approves it.

   Optional, with the owner's approval and after the channel macaroon:
   `scripts/provision-swap.sh` (same argument) bakes a separate swap macaroon
   (`NewAddress`, `DecodePayReq`) for RoboSats swap-outs. Without it, swaps hold
   and everything else works unchanged. It moves no funds: payments keep using
   the write macaroon, and swaps stay off until the owner enables them.

   Optional, with the owner's approval, each with the same argument and each a
   separate macaroon; without one, its feature stays unavailable and everything
   else works unchanged. None moves funds by itself; every feature stays off
   until the owner enables it in `config/satssurge.json`.
   - `scripts/provision-amboss.sh`: `SignMessage` only (Amboss health check) and
     channel-backup export only (encrypted backups pushed to Amboss).
   - `scripts/provision-loop.sh`: the native Loop Out client (keys, signature and
     broadcast of its own sweep, chain notifications).
   - `scripts/provision-sale.sh`: hold invoices for the liquidity SatsSurge sells
     (Magma leases, LSPS1 orders).
   - `scripts/provision-lsp.sh`: the LSPS1 peer messages (needs the sale macaroon).

3. **Nothing else runs on the host.** The automation check and the fee
   competition capture run inside the app; the compose mounts the Lightning
   app's `tls.cert` read-only. Nodes installed before 0.9.28 can disable and
   remove the old `satssurge-autopilot-*` user timers.

4. **Sign in** to the web UI from the Umbrel dashboard with the password in
   `data/owner.secret`. Complete the ChatGPT OAuth login there and pick a model.
   Never paste credentials into the chat.
5. **Connect Telegram.** In the web settings, enter the bot token and generate a
   pairing code, then send `/start <code>` to the bot within five minutes. Only
   the paired owner can talk to it.

## Updates

Use the supported Umbrel update after stopping the app and copying
`app-data/whirmill-satssurge-autopilot`. The exact steps and the rollback
procedure are on the status page in the private repository.
