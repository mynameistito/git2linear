# Repository knowledge

TypeScript and Effect Cloudflare Worker reconciling GitHub repositories with Linear.

## Where to look

- src/domain/reconciliation.ts: pure identity and webhook planning.
- src/application/runner.ts: reconciliation workflow.
- src/providers: paginated APIs and remote schemas.
- src/platform: authenticated triggers, durable runs and retention.
- alchemy: deployment validation and shared state policy.
- scripts: operator and provisioning entrypoints.
- tests: domain, provider and platform regressions.

## Conventions

Preserve stable IDs across renames and interruption. Validate remote responses and persisted records with Effect Schema. Keep Effect and Alchemy compatibility pins coordinated. Preserve unrelated hooks and existing signing secrets.

## Commands

Use package scripts test, typecheck, check and knip. Read README.md for the credential-free build fixture.

## Context pointers

For identity and continuation changes read docs/architecture.md and related tests. For deployment or recovery changes read docs/operations.md and alchemy/preflight.ts.

## Boundaries

Deployment defaults identify an existing instance. Local validation uses fixtures. Accepted triggers do not establish completed runs. Code rollback does not revert durable state or remote mutations.
