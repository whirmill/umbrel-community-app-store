# Cloudflare DDNS for Umbrel

This local Umbrel app keeps an explicit allowlist of existing Cloudflare `A`
records across one or more zones aligned with the connection's public IPv4
address. Its default scope is the three native SimpleX endpoints:

- `smp.satssurge.com`
- `xftp.satssurge.com`
- `turn.satssurge.com`

It does not create or delete DNS records. Before saving a configuration, it
verifies the API token, resolves every exact active zone, and requires every
configured `A` record to exist uniquely in its most specific configured zone.
Every update preserves the record TTL, changes only its IPv4 content when
needed, and forces `proxied: false` because
Cloudflare's HTTP proxy cannot carry the native SMP, XFTP, STUN, or TURN data
paths used here.

## Why this package does not use `oznu/cloudflare-ddns`

The `oznu/docker-cloudflare-ddns` project is archived and no longer maintained.
This package instead uses a small dependency-free service with a local Umbrel
setup page, HTTPS-only public-IP detection, exact-record validation, and a
pinned Python runtime image. It also avoids putting the Cloudflare token in the
Compose file, process environment, or browser request.

## Cloudflare token

Create a dedicated API token in Cloudflare with only:

- `Zone` / `Zone` / `Read`
- `Zone` / `DNS` / `Edit`

Restrict its zone resources to `Include` / `Specific zone` and select every
zone managed by this app. A token covering all zones in the account also works,
but grants broader access than necessary. Do not use the Global API Key.

Because the local Umbrel route is HTTP, the token is never accepted by the web
UI. Install it interactively over SSH as `data/api-token`; the service requires
that it be a regular file with mode `0600`. It is never returned by the status
API. This is still a plaintext secret at rest inside the app's persistent data,
so access to the Umbrel host and its backups must be protected accordingly.

## Runtime layout

- `server`: dependency-free Python service and authenticated Umbrel UI.
- Local UI: `http://umbrel.local:5233` through Umbrel's app proxy.
- Default interval: 300 seconds; accepted range is 60–86400 seconds.
- Public IPv4: detected from Cloudflare trace endpoints over HTTPS; private,
  non-IPv4, unexpected-host, and WARP responses are rejected.
- Persistent settings: `${APP_DATA_DIR}/data/config.json`; restricted token:
  `${APP_DATA_DIR}/data/api-token`.
- No host port is published and no inbound router rule is required for DDNS.

The three SimpleX service records must remain **DNS only**. Router forwarding
for their native service ports remains independent from this app.

## Local installation

```sh
Install this package as `whirmill-cloudflare-ddns` after importing the Whirmill
Community App Store.
```

After installation, connect to Umbrel via SSH and enter the token without
placing it in shell history:

```sh
umask 077
read -rsp 'Cloudflare API token: ' cloudflare_token; echo
printf '%s' "$cloudflare_token" > \
  /home/umbrel/umbrel/app-data/whirmill-cloudflare-ddns/data/api-token
chmod 600 /home/umbrel/umbrel/app-data/whirmill-cloudflare-ddns/data/api-token
unset cloudflare_token
```

Open `http://umbrel.local:5233`, confirm that the token is detected, enter one
Cloudflare zone and one fully qualified record per line, then save. The service
validates the token, every zone, and every record before saving the non-secret
settings; the first update is requested immediately. Records in delegated
sub-zones are assigned to the longest matching configured zone.

Configurations created by version 1.0 with a single `zone` field are accepted
and migrated in memory to the new `zones` list. Saving from version 1.1 writes
the new schema without changing or deleting any Cloudflare record.

## Verification

Do not treat a running container as DDNS proof. Check all of the following:

1. The app reports a successful update and the detected public IPv4.
2. Cloudflare shows each configured `A` record with that IPv4 and proxy status
   `DNS only`.
3. The status response contains no token:

   ```sh
   curl -fsS http://127.0.0.1:5233/api/status
   ```

4. After restarting the app, the configuration remains present and a new
   update succeeds.
5. Changing only the public IPv4 in a controlled test updates the allowlisted
   records and leaves unrelated DNS records untouched.

## Removal and rollback

The UI's **Remove configuration** action waits for any in-flight update and
then deletes the saved token and settings, but does not alter or delete
Cloudflare records. Uninstalling the Umbrel app
also stops future updates; the last DNS values remain in Cloudflare.

To roll back after an unwanted update, disable or uninstall the app, restore
the intended `A` record values manually in Cloudflare, and rotate the dedicated
API token if its confidentiality is in doubt.
