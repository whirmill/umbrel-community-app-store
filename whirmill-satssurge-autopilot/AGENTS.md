# SatsSurge development

Start at [docs/pi/README.md](../docs/pi/README.md). For harness/tool changes read
[Durable patterns](../docs/pi/durable-patterns.md); for transport or approval
changes read [Telegram integration](../docs/pi/telegram-integration.md).

- The installed contract is `@earendil-works/pi-durable@1.1.0`, not Pi Coding
  Agent's `ExtensionAPI`. Verify package/lockfile versions before adopting an
  upstream example. `main` contains unreleased incompatible APIs.
- Keep Pi Durable and its committed submissions. Preserve original request,
  job, conversation, submission, decision, operation and payment identifiers.
- Financial effects pass through the existing executor and current mandate.
  Neither a prompt, research draft, Telegram message, extension nor approval
  grants broader authority. Unknown evidence remains unknown.
- Model-visible tools receive no credentials. Do not expose bot tokens,
  macaroons, OAuth state, owner secrets, hidden reasoning or personal payment
  payloads in logs, UI, tool output, documentation or fixtures.
- Keep `execute_decision` replay-unsafe and reconcile uncertain effects. Safe
  tool replay requires an actual idempotency argument and regression coverage.
  Never infer exactly-once external execution from Pi Durable alone.
- Use the documented per-job capability selection. Generic Bash/file tools
  require an explicitly designed execution environment and permissions; do not
  add `CodingTools` wholesale to financial or read-only conversations.
- Local acceptance uses Node 24+, `npm test`, `npm run typecheck`, and
  `python3 -m unittest discover -s scripts/tests`. Relevant browser fixtures
  use isolated temporary data and mock transports, never production secrets.
  Do not use regtest or execute real payments as an incidental test.
- Keep additive migrations, current receipts, the executor lock and consistent
  three-database checkpoints. A schema bump requires preservation/reopen tests.
  An older binary must refuse newer schemas.

The Telegram-first release preserves the current fee/rebalance mandate. Native
LND diagnostics, channel lifecycle, HTLC policies, discovery and optional
RoboSats/Amboss/Magma integrations are separate future work.
