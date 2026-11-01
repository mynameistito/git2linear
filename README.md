# git2linear

A modular TypeScript Cloudflare Worker reconciles repositories owned by `mynameistito` with the Linear `MY` team. It provisions projects and native GitHub push hooks. It never proxies commits, imports historical issues, deletes resources, or creates teams.

## Deployment status

The Worker is deployed at https://git2linear.mynameistito.workers.dev with hourly cron `0 * * * *` and `APPLY_ENABLED=true`. Three core runtime secrets were provisioned successfully. Native commit-webhook credentials remain absent; no placeholder endpoint or exposed signing secret was provisioned.

The completed authenticated dry run preceded the first apply. That apply discovered 203 owned repositories, created one Linear project, repaired 121 repository-resource attachments, skipped 81 archived repositories, and recorded zero failures. All 122 eligible repositories still require manual native integration action. Reports identify repositories by stable GitHub ID.

Independent authenticated pagination verified 203 GitHub repositories and 203 Linear projects. Every eligible repository has exactly one matching MY project with its current name and GitHub resource link; all 202 original project UUIDs remain present. No ambiguous matches or missing links were found. The 81 archived repositories remain excluded. Native sync mappings, default issue repository, commit-webhook delivery and real push processing are not proved by this project verification.

The second apply completed with 203 discovered, 122 already configured, zero creations, zero repairs, 81 archived skips, zero failures, and 122 manual native integration actions. All 203 repository reports were retrieved. Deployed code `168000f` is version `3ee5520c-6c77-467c-8b64-812ea19e74ee`; the hourly schedule was verified through Cloudflare API. Bounded report cleanup completed with no remaining alarm. Native commit hooks remain unconfigured by this deployment because replacement credentials are unavailable; no native hook or real push success is claimed.

## Current integration limitation

A live verification on 2026-11-01 completed an authenticated dry run followed by manual apply using the same reconciliation workflow as cron. Each discovered 203 repositories, found 122 already configured, skipped 81 archived repositories, made zero changes, and recorded zero failures. All 203 apply reports were retrieved and the continuation alarm cleared. Independent pagination confirmed 203 Linear projects, all 202 original project IDs retained, and exactly one correctly named and linked MY project per eligible repository. A separate authenticated hook audit inspected all 203 repositories (100 private, 37 forks): zero native Linear hooks and three unrelated hooks, which were untouched. All 122 eligible repositories lack native commit hooks. The three core runtime secret bindings are present and functional; `LINEAR_WEBHOOK_URL` and `LINEAR_WEBHOOK_SECRET` are absent. No ping delivery or real push processing is claimed.

Investigation on 2026-11-01 observed 207 saved GitHub integration mappings, including multiple bidirectional mappings under MY. Existing mappings and the default issue repository are preserved. The connected OAuth credential previously rejected integration-settings mutations. A supported unattended API and sufficient permissions for changing native issue-sync configuration have not been established. Consequently, the Worker reports native two-way sync and project routing as manual actions. A project does not automatically receive synced issues. No competing custom issue sync is installed.

## Development

```powershell
bun install
bun run test
bunx tsrs --noEmit
bun run check
$env:LINEAR_TEAM_ID = '<discovered team UUID>'
bun run build
bun run deploy:check
```

`src/domain` contains pure identity and hook planning, `src/providers` implements paginated API adapters, `src/application` coordinates per-repository effects, and `src/platform` owns authentication, durable continuation, and Worker entrypoints. Existing tsrs and Ultracite tools remain in use. `bun run typecheck` invokes tsrs for TypeScript checking.

Effect 4.1.1 owns provider operations, reconciliation, durable orchestration, configuration and operator scripts. Services expose native effects and layers; Promise facades remain at SDK lifecycle and compatibility boundaries. Effect Schema validates remote responses and persisted records, typed failures omit credentials, and redacted configuration protects secret values. Pure reconciliation decisions remain pure. Vitest runs the regression suite, including deterministic Effect clock and cancellation tests. Lint suppressions and rule overrides are not required.

The Effect migration is reviewed in the PR and has not replaced the deployed release recorded above.

## Alchemy adoption configuration

`alchemy.run.ts` defines an adoption of the existing Worker using Alchemy and its Cloudflare provider pinned to `2.0.0-beta.84`, with Effect `4.1.1`. It retains the Worker name, `Reconciler` class and SQLite storage, hourly cron, existing handlers, owner and team key. The resolved provider account must be `402722ab1f598e783cd6dcdedc37e1d0`. [Alchemy documents](https://alchemy.run/cloudflare/compute/durable-objects/#adopt-a-worker-deployed-by-wrangler) that adopted namespaces keep their storage and that a missing exported class stops deployment. The exact current `LINEAR_TEAM_ID` must be supplied: changing it addresses a different singleton even if the namespace survives.

This configuration has only been checked offline; no Alchemy plan or adoption has been run. Continue using the existing `cf` commands until a plan and adoption are reviewed. Alchemy's upload does not establish preservation of omitted bindings. Before **each** plan or deploy, inspect the target Worker's complete binding metadata without exposing values, confirm the account, owner, exact team UUID, apply setting, cron and all other Worker settings. The declared user bindings must exactly match `APPLY_ENABLED`, `GITHUB_OWNER`, `LINEAR_TEAM_ID`, `LINEAR_TEAM_KEY`, `RECONCILER`, `GITHUB_TOKEN`, `LINEAR_API_KEY`, `MANUAL_TRIGGER_TOKEN`, and optionally both `LINEAR_WEBHOOK_URL` and `LINEAR_WEBHOOK_SECRET`. Alchemy also adds its own runtime bindings. If metadata contains additional bindings or settings that need preservation, update and review the configuration first. Set `ALCHEMY_CONFIRMED_BINDINGS=core` only after confirming that complete inventory, or `core+webhook` when both optional bindings are present. This is an operator attestation, not an automated metadata check. The config rejects missing or blank secrets and mismatched webhook pairs. Explicitly set `APPLY_ENABLED` to the current intended value; it defaults to false.

Inject the three required values and, when applicable, both webhook values securely at runtime using the existing 1Password references, as in the credentials section. Do not place values in source, arguments, logs or plaintext files. The stack uses `Config.Redacted`; Worker runtime does not access 1Password. Verify the plan includes adoption of the existing Worker and namespace, with no deletion, replacement, unintended binding removal or unrelated resource changes before any deploy. Follow the documented release verification afterward. No live credentials or binding metadata were accessed while preparing this configuration.

After that inventory check, use `bun run alchemy:plan` with the secure environment injection; use `bun run alchemy:deploy` only after reviewing the plan. These commands pin the `production` stage and invoke the local Alchemy CLI under a supported Node version. The current `cf` commands remain available as the fallback.

The stack uses [local state](https://alchemy.run/state-store/) and does not use `Cloudflare.state()`, which can bootstrap resources even during a plan. The ignored `.alchemy/` directory may contain sensitive resource inputs. Protect it with restricted access and encrypted, durable backups; securely transfer the same state to an authorized operator and serialize deployments. Keep stack name, stage, logical ID and state stable. Loss or divergence of state can cause unintended adoption or changes. Do not commit state or run destroy against the production Worker. Alchemy's exports-based adoption may prevent returning to older migrations-based tooling; verify fallback compatibility before adopting.

## Configuration and deployment

The `cloudflare.config.ts` deployment is named `git2linear`, in the Personal Cloudflare account. Confirm the account before reusing this project elsewhere. Set the discovered `LINEAR_TEAM_ID` in the build environment; the team key is MY. The hourly schedule is `0 * * * *` (UTC). A singleton Durable Object per owner/team stores identities, operation intents, checkpoints, repository outcomes and failures. Each alarm advances bounded work, arms a recovery alarm before external effects, and persists continuation. Running requests return the existing run rather than starting another.

Configuration loading rejects missing, empty, whitespace-only and malformed team UUIDs, including bootstrap builds. Supply the discovered UUID before build or deployment commands.

`APPLY_ENABLED` defaults to `false`. Deploy first in this mode, provision secrets, run a dry run, inspect its complete report, then deploy with `APPLY_ENABLED=true`. A successful persisted dry run is also required before an apply run. Keep the same owner/team configuration to retain durable identity state.

```powershell
$env:LINEAR_TEAM_ID = '<discovered team UUID>'
$env:APPLY_ENABLED = 'false'
bun run deploy:check
bun run deploy
```

For the first deployment only, set `$env:BOOTSTRAP_MODE = 'true'` and run `bun run deploy` to create the Worker without required secret declarations. Bootstrap rejects unauthenticated requests and skips scheduled work while core credentials are absent. Inject the three required secrets with the provisioning script below, run `Remove-Item Env:BOOTSTRAP_MODE`, then run `bun run deploy` again with `APPLY_ENABLED=false`. Obtain and review a completed remote dry run before enabling apply. Never use bootstrap mode for routine releases.

The deployment status above records the verified release; deployment alone does not prove a completed reconciliation. Verify the deployed version, cron and runtime status after every release. Cron changes can take time to propagate.

## Credentials

Use the single API Credential item **`mynameistito/git2linear`** in the existing `github-actions` vault. Its stable item ID is `7qcdyu375b6v2xep2xovcnnhjy`; use that ID in references because the display name contains a slash. Named concealed fields are `GITHUB_TOKEN`, `LINEAR_API_KEY`, `MANUAL_TRIGGER_TOKEN`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_LEGACY_PROVISIONING_TOKEN`, `LINEAR_WEBHOOK_URL` and `LINEAR_WEBHOOK_SECRET`. The legacy Cloudflare token is retained for recovery; current provisioning uses `CLOUDFLARE_API_TOKEN`. The webhook fields remain empty until valid replacement values are available. Original permissions, repository selection, account/workspace, expiry and purpose notes are retained. Inspect item metadata before editing and transfer values through secure stdin or clipboard, never arguments or plaintext files.

`.env.credentials.tpl` contains references only. `2password env run .env.credentials.tpl -- bun run varlock:operate status` securely injects them before Varlock validation; set `WORKER_ORIGIN` first. Likewise, use `bun run varlock:provision` or the scoped Alchemy commands after setting their required non-secret configuration. The Worker runtime receives Cloudflare secrets and never accesses the vault. Update the existing named fields when rotating credentials, verify the result without printing values, then re-provision runtime secrets securely.

### GitHub Actions verification

CI runs tests, type checking, lint and a build with a dummy team ID on pushes and pull requests without production credentials. The separate **Verify Worker** workflow is manual-only and runs only from this repository's default branch. It installs locked dependencies before loading the `MANUAL_TRIGGER_TOKEN` field with the pinned official 1Password action and CLI, then validates the operator configuration with Varlock. Its fixed destination is the deployed Worker above; the only operations are `status` and `dry-run`. A dry run starts remote planning and can return an existing running reconciliation; an accepted request does not prove completion. Run `status` later and review the result. Workflow logs contain the operator's sanitized response and run summary, so access to logs should be appropriate for that metadata. This workflow does not perform apply or deploy.

Bootstrap is still required: the repository currently has no Actions secrets. An existing 1Password service account must already have read access to the `github-actions` vault and the item above; its token grants whatever vault access that account already has, even though this workflow resolves only one field. An authorized user can add its existing token as the single repository Actions secret `OP_SERVICE_ACCOUNT_TOKEN` using GitHub's **Settings → Secrets and variables → Actions** secret UI, without sharing the value in chat. GitHub does not allow an existing secret value to be read back. This setup creates no service account or permissions. The manual workflow becomes available from the default branch after these changes are merged, and will fail to load the token until bootstrap is complete.

There is deliberately no CI deployment. Alchemy's ignored local `.alchemy/` state and the existing namespace require a separately reviewed adoption plan and secure, durable, shared state before any CI deployment is considered. A fresh runner must not assume it has the existing state.

Upstream context: [Alchemy's 1Password provider request](https://github.com/alchemy-run/alchemy/issues/1834) and [preserving externally written Worker secrets](https://github.com/alchemy-run/alchemy/issues/2757) are open; the maintainers [declined binding inheritance](https://github.com/alchemy-run/alchemy/issues/1024). The [Vite/Cloudflare plugin issue](https://github.com/alchemy-run/alchemy/issues/1997) also affects the Varlock integration's plugin path. [Distilled's 1Password Connect package](https://github.com/alchemy-run/distilled/issues/696) targets a self-hosted Connect server, not the service-account SDK.

The GitHub fine-grained token is owned by `mynameistito`, expires **2026-12-01**, and needs repository **Webhooks: read/write**, plus GitHub's mandatory Metadata read permission. Repository selection must cover the intended personal repositories, including private repositories and forks. Forks and repositories with GitHub Issues disabled remain eligible for projects and commit hooks; native issue sync may require manual repository settings. The Worker never enables GitHub Issues. Selected-repository tokens require selection updates when new repositories are created; hourly discovery cannot grant itself additional access. Do not add Contents, Issues or Administration permissions for this implementation. Create credentials in the signed-in browser only after validating these permissions; password/MFA verification requires the user.

Use a Linear API credential with project read/create/update rights and access to MY; verify permissions against current Linear documentation and workspace policy. Do not assume it can administer native integration settings. The manual token must be a securely generated random value with at least 256 bits of entropy (43 base64url characters). Treat the old screenshot-exposed webhook signing secret as compromised: obtain a replacement recognized by Linear before provisioning hooks. The native authenticated payload URL is also a secret.

Required runtime bindings are `GITHUB_TOKEN`, `LINEAR_API_KEY`, and `MANUAL_TRIGGER_TOKEN`. Native webhook credentials are optional as a pair: without a verified native endpoint and replacement signing secret, projects can reconcile but webhook provisioning is reported as a manual action. No placeholder endpoint is used. Available runtime secret bindings are `GITHUB_TOKEN`, `LINEAR_API_KEY`, `LINEAR_WEBHOOK_URL`, `LINEAR_WEBHOOK_SECRET`, and `MANUAL_TRIGGER_TOKEN`. Worker runtime never accesses 1Password.

`scripts/provision-secrets.ts` consumes credentials injected into its environment and writes them directly to Cloudflare's supported secrets REST API. It requires a Cloudflare API token scoped to Workers Scripts edit for the selected account, supplied through an existing appropriate `op://` reference. It does not extract browser cookies or private cf login storage. Outputs contain only binding names, HTTP status and success. Do not pass secrets in arguments, enable HTTP tracing, or print process environments.

```powershell
$env:CLOUDFLARE_ACCOUNT_ID = '<confirmed account ID>'
$env:CLOUDFLARE_WORKER_NAME = 'git2linear'
2password run --env 'CLOUDFLARE_API_TOKEN=op://github-actions/7qcdyu375b6v2xep2xovcnnhjy/CLOUDFLARE_API_TOKEN' --env 'GITHUB_TOKEN=op://github-actions/7qcdyu375b6v2xep2xovcnnhjy/GITHUB_TOKEN' --env 'LINEAR_API_KEY=op://github-actions/7qcdyu375b6v2xep2xovcnnhjy/LINEAR_API_KEY' --env 'MANUAL_TRIGGER_TOKEN=op://github-actions/7qcdyu375b6v2xep2xovcnnhjy/MANUAL_TRIGGER_TOKEN' -- bun scripts/provision-secrets.ts
```

Replace placeholders with verified saved references. Cloudflare API calls preserve unrelated bindings. If interrupted, inspect binding metadata and provision missing values; secret provisioning success does not prove external APIs accept the credentials.

This command provisions the three core runtime secrets without resolving optional webhook items. When the verified native endpoint and replacement signing secret are both available, add both `--env 'LINEAR_WEBHOOK_URL=op://github-actions/7qcdyu375b6v2xep2xovcnnhjy/LINEAR_WEBHOOK_URL'` and `--env 'LINEAR_WEBHOOK_SECRET=op://github-actions/7qcdyu375b6v2xep2xovcnnhjy/LINEAR_WEBHOOK_SECRET'` before `-- bun scripts/provision-secrets.ts`. A single optional value is rejected. The manual trigger token must contain at least 43 characters; generate it from 32 cryptographically random bytes.

## Manual operations

Both deployment configurations enable native Cloudflare invocation logs and traces at 100% sampling, persist them to Cloudflare, and redact URL query strings. Do not log credentials, request headers, payloads or native webhook URLs. The live Worker's observability settings were enabled and read back through the script-settings API on 2026-11-01 without replacing its code or bindings. The provisioning credential cannot query stored telemetry (HTTP 403); the existing Cloudflare CLI login successfully queried 100 recent events and 100 traces belonging to `git2linear`, with no errors in those sampled traces. Use that supported login for inspection; no credential permissions were expanded. Trace ingestion and successful reconciliation are separate checks.

Set `WORKER_ORIGIN` to the deployed HTTPS origin. The operator script injects the bearer credential through the environment, never an argument. Requests reject redirects and have a 30-second timeout.

```powershell
$env:WORKER_ORIGIN = 'https://<deployment>.workers.dev'
2password run --env 'MANUAL_TRIGGER_TOKEN=op://github-actions/7qcdyu375b6v2xep2xovcnnhjy/MANUAL_TRIGGER_TOKEN' -- bun scripts/operate.ts dry-run
2password run --env 'MANUAL_TRIGGER_TOKEN=op://github-actions/7qcdyu375b6v2xep2xovcnnhjy/MANUAL_TRIGGER_TOKEN' -- bun scripts/operate.ts status
# Only after reviewing completed dry-run and enabling APPLY_ENABLED:
2password run --env 'MANUAL_TRIGGER_TOKEN=op://github-actions/7qcdyu375b6v2xep2xovcnnhjy/MANUAL_TRIGGER_TOKEN' -- bun scripts/operate.ts apply
```

`POST /reconcile?dryRun=true` starts read-only planning (the default). `POST /reconcile?dryRun=false` starts apply when enabled. `GET /status` returns the latest run summary. All endpoints require the strong bearer credential over HTTPS. This deployment uses a dedicated Cloudflare Access application for the exact Worker hostname with a bypass policy, so machine requests reach the Worker's own 256-bit bearer authentication. The existing wildcard Access application and its shared policies remain unchanged. An unauthenticated request to the exact hostname was verified to return the Worker's JSON HTTP 401 response. A 202 response means accepted, not completed. Inspect status until complete, then verify repository outcomes. Counters distinguish discovered, already configured, created, repaired, skipped, failed and manual actions.

Existing hooks are inspected before creation and only exact configured native endpoint matches are managed. Repairs retain the signing secret. Push-only, JSON, active hooks with SSL verification enabled are required. GitHub ping acceptance and delivery are separate from real push processing; only a real linked commit plus observed Linear behavior can prove end-to-end commit linking. Never claim that a successful ping proves push processing.

If an existing wildcard Access application intercepts machine requests, first inspect the account's Access applications with the supported `cf` CLI. Create a separate application scoped only to the exact Worker hostname and attach an application-local bypass policy using the documented Cloudflare Access application and policy APIs. Preserve the wildcard application and shared policies. Verify that unauthenticated requests receive Worker HTTP 401 and authenticated dry-run requests receive HTTP 202. A bypass must never replace the Worker bearer check.

## Renewal and recovery

Renew the GitHub token before 2026-12-01 through GitHub's fine-grained token UI with the same owner, repository selection and permissions, setting an explicit new expiration. After checking item metadata, update the existing `GITHUB_TOKEN` field in `mynameistito/git2linear` securely, retaining its item history for recovery. Provision the replacement, verify an authenticated complete inventory and hook read, run a dry run, then revoke the superseded token after validation. Update its expiry notes. Rotate manual and Linear credentials in their existing fields similarly. Signing-secret rotation needs a coordinated Linear-supported change and explicit hook-secret migration; routine reconciliation deliberately does not reset existing hook secrets.

Provider outages and rate limits retain checkpoints and use bounded retry timing. Per-repository failures do not stop other repositories. A repeatedly failing global step enters failed state; fix credentials/configuration and start another dry run. Repository detail retention keeps the current and previous run. Existing alarms scan at most 100 internal report keys per maintenance batch with a durable cursor, pruning older report sets after interrupted work resumes. Stable repository identities and operation intents are retained. Provider retry deadlines remain unchanged during active runs. Preserve the Durable Object namespace when redeploying. Ambiguous projects or duplicate matching hooks require inspection, not automatic deletion. Archived/disabled repositories are reported and never unarchived. A repository invisible to the credential cannot be inferred from a successful partial inventory; compare selected-repository coverage when troubleshooting missing private repositories.

To disable mutations, redeploy with `APPLY_ENABLED=false`. To stop all scheduled work, remove the scheduled trigger and deploy the reviewed configuration. Rolling back code does not roll back project/hook changes or durable state. Do not delete the namespace as a recovery shortcut.

Project inventory currently reads at most 10 teams and 10 external links per project. If either nested connection has more pages, the inventory fails closed before reconciliation, including for unrelated projects. Inspect projects with more than 10 entries when a global inventory step repeatedly reports an invalid response. Preserve their configuration and extend the adapter with supported nested pagination before resuming; do not delete links or teams to work around this limit. Regression tests cover both overflow cases.

## References

- [Linear GitHub integration](https://linear.app/docs/github)
- [Linear API authentication](https://linear.app/developers/graphql)
- [GitHub repository webhooks REST API](https://docs.github.com/en/rest/repos/webhooks)
- [Cloudflare CLI project configuration](https://developers.cloudflare.com/cf/projects/cloudflare-config/)
- [Cloudflare Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/)

## Varlock validation and Cloudflare boundary

The checked-in `.env.schema` declares sensitive values and context tags. Install with `bun install`. Run `bun run varlock:codegen` to generate Varlock's TypeScript declarations locally; the generated file is a convenience for `varlock/env`, which this Worker does not import. Do not commit that generated file without reviewing its generated lint directives. Do not put credentials in `.env` files.

Inject values into the process through the existing 1Password workflow, then invoke `bun run varlock:provision`, `bun run varlock:operate status` (or `dry-run` / `apply`), or `bun run varlock:alchemy:plan` and, only after reviewing the plan, `bun run varlock:alchemy:deploy`. For example, replace the final `bun scripts/provision-secrets.ts` in the 2password example above with `bun run varlock:provision`; set the non-secret account ID in the process as described above. The operator command similarly replaces `bun scripts/operate.ts status` with `bun run varlock:operate status`. The deploy tag requires the complete Alchemy inventory, including `ALCHEMY_CONFIRMED_BINDINGS` and `LINEAR_TEAM_ID`. Varlock checks required fields and token length; the existing Effect adapters additionally enforce webhook pairing, the confirmed inventory, URL restrictions, and other operation-specific checks. Filtering strips other schema keys from the child process. Do not nest filtered Varlock runs.

Varlock's [Cloudflare integration](https://varlock.dev/integrations/cloudflare/) requires `varlock-wrangler`, `nodejs_compat` and a `__VARLOCK_ENV` secret. The official documentation states that `cf/config` is unsupported and a public API to construct the binding for non-Wrangler tools is not yet available. This repository therefore does **not** initialize Varlock in the Worker: the Worker continues reading its Cloudflare bindings via Effect, with its existing fail-closed authentication, secret handling and query-string redaction. Varlock runtime console redaction and response leak detection are not enabled. The supported Varlock flow here validates injected process values before the existing tools run; it does not read remote Cloudflare secrets. `cf deploy` retains the existing secret bindings and Alchemy remains unadopted until separately reviewed. Do not switch to `varlock-wrangler`: its deployment replaces secret and variable bindings, which could remove existing secrets.

Before any eventual deployment, independently inspect the remote binding inventory and namespace, inject the matching values securely, review the Alchemy adoption plan if using it, and verify identity, cron, observability and secrets afterward. No live deployment is implied by this integration.
