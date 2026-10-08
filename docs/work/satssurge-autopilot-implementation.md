# SatsSurge Autopilot — implementation checkpoint

User authority: implement consolidated plan, M1 real-node POC fee/rebalance autonomy using Pi Durable/Codex subscription, no regtest. M3 channel/Magma and M4 Telegram remain deferred. Mandate 30k cumulative incl history,1500 daily,750 exploration subset,100 attempt,500k onchain protected.

App: `whirmill-satssurge-autopilot/`. Root owns implementation. Never stage unrelated untracked docs/scripts. No mainnet financial RPC has been performed by this implementation turn.

Implemented: separate FULL-WAL operational SQLite and Pi Durable store, private OAuth credential store, unsafe financial tool recovery, single async execution owner and process flock, reservations and aggregate fingerprint caps, observed-data forecasts, strategy suspension, manual holds, historical importer, collector/HTLC coverage, owner-authenticated UI+CSRF, TLS/URI-macaroon bootstrap and host live interlock, amd64/arm64 release workflow.

Verification: 14 mocked tests passing, actual Pi Durable storage/root initialization opened, Node24 ARM Docker image built; anonymous backend status401/health200 verified. Historical import actual local files:47 costentries,10705169msat knownexpenses,1958000msat grossRoboSats premium, no importerrors, coverageincomplete. No personalpaymentdetails imported into tool evidence. Independent security-auditor review completed, fixes consumed: async invoice/reconciliationrace, canonical corridor/evidence grouping, MPPterminalcostnotlost, strict gate timestamps, exact historical fee check, persistent integrityblocker, backend ownerauthentication.

Published: main e407fe65976bb1dcfc63880fa7244e9f1a5f158a, annotated tag satssurge-autopilot-v0.1.0, CI https://github.com/whirmill/umbrel-community-app-store/actions/runs/37833585463 succeeded. OCI index ghcr.io/whirmill/umbrel-satssurge-autopilot:0.1.0@sha256:23dd5f6d0df009b903c2ea28a0c469052919ceb6ba8f84e5fe29003190859f56 contains amd64/arm64 and permits anonymous pulls. Compose pins this immutable index.

Umbrel bootstrap: restricted URI macaroons, TLS CA and node binding provisioned privately under app-data/whirmill-satssurge-autopilot/credentials; historical expenses/reconciliation and selected narratives copied privately; host user interlock timer refreshes every 30 seconds and all operational automation flags were verified false. No financial RPC performed. Catalog initially reports App not found despite updated repository files; investigate selected community-store lookup before claiming installation.

Remaining: install app and verify readonly live collection/TLS/macaroon/interlock/network owner access; user OAuth login needed for agent decisions. Do not claim realnode autonomy/economics tested before it is. Fee experiment evaluation is noncausal M1 contribution; richer comparable price evaluation belongs M2. Credentials/private history must never enter Git/tool outputs.
