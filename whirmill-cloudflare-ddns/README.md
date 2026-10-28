# Cloudflare DDNS: installer

The source is private (`whirmill/cloudflare-ddns`); this folder holds the Umbrel
manifest and compose file.

## Installation

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
Cloudflare zone and one fully qualified record per line, then save.
