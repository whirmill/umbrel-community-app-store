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

   Optional, with the owner's approval: `scripts/provision-channels.sh` (same
   argument) bakes a separate channel macaroon. Without it, channel open/close
   proposals stay unavailable and everything else works unchanged. With it,
   each open or cooperative close still runs only after the owner approves it.

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
