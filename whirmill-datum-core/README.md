# DATUM for Bitcoin Core

This package runs OCEAN's DATUM Gateway against Umbrel's generic `bitcoin`
dependency. It uses the same pinned DATUM image as the official package, but it
receives RPC settings from the official Bitcoin Core app instead of requiring
Bitcoin Knots.

## Bitcoin Core integration

DATUM supports Bitcoin Core through the standard `getblocktemplate`,
`submitblock`, and RPC notification interfaces. Before starting this app, add
the following custom options in Bitcoin Node → Settings → Advanced → Custom
`bitcoin.conf`:

```ini
blockmaxsize=3985000
blockmaxweight=3985000
blocknotify=node -e "fetch('http://whirmill-datum-core_datum_1:21000/NOTIFY').catch(()=>process.exit(0))"
```

The official Bitcoin Node app preserves custom `bitcoin.conf` options across
settings changes and app updates. The notification command uses the Node.js
runtime already present in that app's container, so no changes to the official
Bitcoin Core image are required.

## Migration from the official DATUM app

Do not run the official `datum` app and `whirmill-datum-core` simultaneously:
both expose miner port `23334`.

1. Stop the official DATUM app.
2. Back up its `data/settings/datum_gateway_config.json` without displaying the
   RPC password or admin password.
3. Install this app with Bitcoin Core selected as the `bitcoin` dependency.
4. Stop this app and transfer only user-owned DATUM settings, such as the mining
   payout address and pool preferences. Do not transfer the old Knots RPC
   values; the pre-start hook injects fresh Core credentials.
5. Start the app and validate `getblocktemplate`, the `/NOTIFY` path, and the
   Core `submitblock` RPC surface before reconnecting miners.

Keep the original app installed and stopped until the Core-backed package has
completed its observation window and the rollback has been verified.
