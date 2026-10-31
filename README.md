# git2linear

A modular TypeScript Cloudflare Worker reconciles repositories owned by `mynameistito` with the Linear `MY` team. It provisions projects and native GitHub push hooks. It never proxies commits, imports historical issues, deletes resources, or creates teams.

## Current integration limitation

Investigation on 2026-11-01 observed 207 saved GitHub integration mappings, including multiple bidirectional mappings under MY. Existing mappings and the default issue repository are preserved. The connected OAuth credential previously rejected integration-settings mutations. A supported unattended API and sufficient permissions for changing native issue-sync configuration have not been established. Consequently, the Worker reports native two-way sync and project routing as manual actions. A project does not automatically receive synced issues. No competing custom issue sync is installed.

## Development

```powershell
bun install
bun test
bunx tsrs --noEmit
bun run check
bun run build
bun run deploy:check
```

`src/domain` contains pure identity and hook planning, `src/providers` implements paginated API adapters, `src/application` coordinates per-repository effects, and `src/platform` owns authentication, durable continuation, and Worker entrypoints. Existing tsrs and Ultracite tools remain in use. `bun run typecheck` invokes tsrs for TypeScript checking.

## Configuration and deployment

The `cloudflare.config.ts` deployment is named `git2linear`, in the Personal Cloudflare account. Confirm the account before reusing this project elsewhere. Set the discovered `LINEAR_TEAM_ID` in the build environment; the team key is MY. The hourly schedule is `0 * * * *` (UTC). A singleton Durable Object per owner/team stores identities, operation intents, checkpoints, repository outcomes and failures. Each alarm advances bounded work, arms a recovery alarm before external effects, and persists continuation. Running requests return the existing run rather than starting another.

`APPLY_ENABLED` defaults to `false`. Deploy first in this mode, provision secrets, run a dry run, inspect its complete report, then deploy with `APPLY_ENABLED=true`. A successful persisted dry run is also required before an apply run. Keep the same owner/team configuration to retain durable identity state.

```powershell
$env:LINEAR_TEAM_ID = '<discovered team UUID>'
$env:APPLY_ENABLED = 'false'
bun run deploy:check
bun run deploy
```

No deployment success is implied by this document. Verify the deployed version, cron and runtime status after deployment. Cron changes can take time to propagate.

## Credentials

Use the existing `github-actions` vault. Inspect metadata with `2password find` before creation; never overwrite an item without checking deployment ownership. Save each value with `2password create api-credential --vault github-actions --clipboard` or `--stdin`, and require its `verified:true` result. Use separate clearly named items for the GitHub token, Linear credential, native commit endpoint, signing secret, and manual trigger token. Keep purpose, account/workspace, permissions, repository selection, expiry and deployment name in non-secret notes. Do not print values or use plaintext files.

The GitHub fine-grained token is owned by `mynameistito`, expires **2026-12-01**, and needs repository **Webhooks: read/write**, plus GitHub's mandatory Metadata read permission. Repository selection must cover the intended personal repositories, including private repositories and forks. Forks and repositories with GitHub Issues disabled remain eligible for projects and commit hooks; native issue sync may require manual repository settings. The Worker never enables GitHub Issues. Selected-repository tokens require selection updates when new repositories are created; hourly discovery cannot grant itself additional access. Do not add Contents, Issues or Administration permissions for this implementation. Create credentials in the signed-in browser only after validating these permissions; password/MFA verification requires the user.

Use a Linear API credential with project read/create/update rights and access to MY; verify permissions against current Linear documentation and workspace policy. Do not assume it can administer native integration settings. The manual token must be a securely generated random value with at least 256 bits of entropy (43 base64url characters). Treat the old screenshot-exposed webhook signing secret as compromised: obtain a replacement recognized by Linear before provisioning hooks. The native authenticated payload URL is also a secret.

Required runtime bindings are `GITHUB_TOKEN`, `LINEAR_API_KEY`, and `MANUAL_TRIGGER_TOKEN`. Native webhook credentials are optional as a pair: without a verified native endpoint and replacement signing secret, projects can reconcile but webhook provisioning is reported as a manual action. No placeholder endpoint is used. Available runtime secret bindings are `GITHUB_TOKEN`, `LINEAR_API_KEY`, `LINEAR_WEBHOOK_URL`, `LINEAR_WEBHOOK_SECRET`, and `MANUAL_TRIGGER_TOKEN`. Worker runtime never accesses 1Password.

`scripts/provision-secrets.ts` consumes credentials injected into its environment and writes them directly to Cloudflare's supported secrets REST API. It requires a Cloudflare API token scoped to Workers Scripts edit for the selected account, supplied through an existing appropriate `op://` reference. It does not extract browser cookies or private cf login storage. Outputs contain only binding names, HTTP status and success. Do not pass secrets in arguments, enable HTTP tracing, or print process environments.

```powershell
$env:CLOUDFLARE_ACCOUNT_ID = '<confirmed account ID>'
$env:CLOUDFLARE_WORKER_NAME = 'git2linear'
2password run --env 'CLOUDFLARE_API_TOKEN=op://github-actions/<Cloudflare item>/credential' --env 'GITHUB_TOKEN=op://github-actions/<GitHub item>/credential' --env 'LINEAR_API_KEY=op://github-actions/<Linear item>/credential' --env 'LINEAR_WEBHOOK_URL=op://github-actions/<Endpoint item>/credential' --env 'LINEAR_WEBHOOK_SECRET=op://github-actions/<Signing item>/credential' --env 'MANUAL_TRIGGER_TOKEN=op://github-actions/<Manual item>/credential' -- bun scripts/provision-secrets.ts
```

Replace placeholders with verified saved references. Cloudflare API calls preserve unrelated bindings. If interrupted, inspect binding metadata and provision missing values; secret provisioning success does not prove external APIs accept the credentials.

## Manual operations

Set `WORKER_ORIGIN` to the deployed HTTPS origin. The operator script injects the bearer credential through the environment, never an argument. Requests reject redirects and have a 30-second timeout.

```powershell
$env:WORKER_ORIGIN = 'https://<deployment>.workers.dev'
2password run --env 'MANUAL_TRIGGER_TOKEN=op://github-actions/<Manual item>/credential' -- bun scripts/operate.ts dry-run
2password run --env 'MANUAL_TRIGGER_TOKEN=op://github-actions/<Manual item>/credential' -- bun scripts/operate.ts status
# Only after reviewing completed dry-run and enabling APPLY_ENABLED:
2password run --env 'MANUAL_TRIGGER_TOKEN=op://github-actions/<Manual item>/credential' -- bun scripts/operate.ts apply
```

`POST /reconcile?dryRun=true` starts read-only planning (the default). `POST /reconcile?dryRun=false` starts apply when enabled. `GET /status` returns the latest run summary. All endpoints require the strong bearer credential over HTTPS. A 202 response means accepted, not completed. Inspect status until complete, then verify repository outcomes. Counters distinguish discovered, already configured, created, repaired, skipped, failed and manual actions.

Existing hooks are inspected before creation and only exact configured native endpoint matches are managed. Repairs retain the signing secret. Push-only, JSON, active hooks with SSL verification enabled are required. GitHub ping acceptance and delivery are separate from real push processing; only a real linked commit plus observed Linear behavior can prove end-to-end commit linking. Never claim that a successful ping proves push processing.

## Renewal and recovery

Renew the GitHub token before 2026-12-01 through GitHub's fine-grained token UI with the same owner, repository selection and permissions, setting an explicit new expiration. Save it as a clearly versioned credential after checking existing item metadata; provision the replacement securely, verify an authenticated complete inventory and hook read, run a dry run, then revoke the superseded credential after validation. Update its expiry notes. Rotate manual and Linear credentials similarly. Signing-secret rotation needs a coordinated Linear-supported change and explicit hook-secret migration; routine reconciliation deliberately does not reset existing hook secrets.

Provider outages and rate limits retain checkpoints and use bounded retry timing. Per-repository failures do not stop other repositories. A repeatedly failing global step enters failed state; fix credentials/configuration and start another dry run. Preserve the Durable Object namespace when redeploying. Ambiguous projects or duplicate matching hooks require inspection, not automatic deletion. Archived/disabled repositories are reported and never unarchived. A repository invisible to the credential cannot be inferred from a successful partial inventory; compare selected-repository coverage when troubleshooting missing private repositories.

To disable mutations, redeploy with `APPLY_ENABLED=false`. To stop all scheduled work, remove the scheduled trigger and deploy the reviewed configuration. Rolling back code does not roll back project/hook changes or durable state. Do not delete the namespace as a recovery shortcut.

## References

- [Linear GitHub integration](https://linear.app/docs/github)
- [Linear API authentication](https://linear.app/developers/graphql)
- [GitHub repository webhooks REST API](https://docs.github.com/en/rest/repos/webhooks)
- [Cloudflare CLI project configuration](https://developers.cloudflare.com/cf/projects/cloudflare-config/)
- [Cloudflare Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
