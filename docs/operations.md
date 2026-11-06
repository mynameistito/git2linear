# Setup and operations

Review deployment identity in `src/platform/deployment.ts`, both deployment configurations, credential templates and GitHub workflows before using another account. Replace account, owner, team key, Worker identity, origin and secret-manager references. Supply the real team UUID through `LINEAR_TEAM_ID`.

Required runtime secrets are `GITHUB_TOKEN`, `LINEAR_API_KEY` and `MANUAL_TRIGGER_TOKEN`. Generate the manual credential securely with at least 43 characters. GitHub access must cover intended repositories and webhook operations; Linear access must permit project mutations. Native hooks require the complete `LINEAR_WEBHOOK_URL` and `LINEAR_WEBHOOK_SECRET` pair from Linear. Keep values in a secret manager and inject process environments; never commit credential files.

Production uses Alchemy with shared state. Preserve stack, stage, namespace and owner/team identity. Before each plan or deployment inspect remote settings and the full binding inventory. Set `ALCHEMY_CONFIRMED_BINDINGS` to `core` or `core+webhook` matching the supplied inventory. With deploy inputs injected, run `bun run varlock:alchemy:preflight` and `bun run varlock:alchemy:plan`. Review deletion, replacement and omitted-binding risks before explicitly deploying. Shared state compatibility failures require operator review. The cf fallback requires compatibility review; bootstrap mode is only for initial creation and must be removed after provisioning.

Alchemy beta.85 changes the shared Cloudflare state store. Its [upgrade notes](https://alchemy.run/blog/2026-11-01-beta-85/) say the upgrade removes the old management stack and older Alchemy versions can risk the encryption key afterward. Coordinate every machine and CI job using the store before upgrading; do not treat a code rollback as a state-store rollback. The current pins and state policy intentionally prevent an automatic store upgrade during an ordinary deployment.

Start with `APPLY_ENABLED=false`, provision credentials and complete a remote dry run before enabling mutations. Inject `WORKER_ORIGIN` as an HTTPS origin and the manual token, then use `bun scripts/operate.ts dry-run` and `bun scripts/operate.ts status`. Apply uses `bun scripts/operate.ts apply` and requires a successful persisted dry run plus enabled mutations.

All endpoints require bearer authentication: POST `/reconcile?dryRun=true` plans, POST `/reconcile?dryRun=false` applies, GET `/status` reports progress. HTTP 202 means accepted, not completed. Inspect complete repository outcomes and credential repository coverage. Verify version, namespace, bindings, UTC hourly schedule and unauthenticated HTTP 401 after releases. A webhook ping does not prove real push processing; verify actual linked commits and Linear behavior.

Disable mutations with a reviewed deployment setting `APPLY_ENABLED=false`. Removing the schedule stops scheduled work. Code rollback does not undo remote mutations or durable state; preserve the namespace. Rotate credentials before expiry, validate replacements with inventory and dry runs, then revoke old tokens. Signing-secret rotation requires coordinated migration because reconciliation preserves existing hook secrets.

Varlock validates injected process inputs; the Worker uses Effect bindings without Varlock runtime leak detection. Do not treat a successful plan as deployment evidence.
