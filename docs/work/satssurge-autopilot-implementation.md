# SatsSurge Autopilot — implementation checkpoint

User authority: implement consolidated plan, M1 real-node POC fee/rebalance autonomy using Pi Durable/Codex subscription, no regtest. M3 channel/Magma and M4 Telegram remain deferred. Mandate 30k cumulative incl history,1500 daily,750 exploration subset,100 attempt,500k onchain protected.

App: `whirmill-satssurge-autopilot/`. Root owns implementation. Never stage unrelated untracked docs/scripts. No mainnet financial RPC has been performed by this implementation turn.

Implemented: separate FULL-WAL operational SQLite and Pi Durable store, private OAuth credential store, unsafe financial tool recovery, single async execution owner and process flock, reservations and aggregate fingerprint caps, observed-data forecasts, strategy suspension, manual holds, historical importer, collector/HTLC coverage, owner-authenticated UI+CSRF, TLS/URI-macaroon bootstrap and host live interlock, amd64/arm64 release workflow.

Verification: 14 mocked tests passing, actual Pi Durable storage/root initialization opened, Node24 ARM Docker image built; anonymous backend status401/health200 verified. Historical import actual local files:47 costentries,10705169msat knownexpenses,1958000msat grossRoboSats premium, no importerrors, coverageincomplete. No personalpaymentdetails imported into tool evidence. Independent security-auditor review completed, fixes consumed: async invoice/reconciliationrace, canonical corridor/evidence grouping, MPPterminalcostnotlost, strict gate timestamps, exact historical fee check, persistent integrityblocker, backend ownerauthentication.

Remaining: publish image/tag through release lane, pin OCI indexdigest, install/provision onUmbrel and verify readonlylivecollection/TLS/macaroon/interlock/networkowneraccess; user OAuth login needed for agent decisions. Do not claim realnode autonomy/economics tested before it is. Fee experiment evaluation is noncausal M1 contribution; richer comparable price evaluation belongs M2. Credentials/private history must never enterGit/tooloutputs.
