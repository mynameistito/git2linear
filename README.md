# git2linear

Reconciles GitHub repositories with Linear projects and native GitHub push hooks using a TypeScript Cloudflare Worker. Maintained by mynameistito.

It preserves stable identities and existing resources. Native issue sync and project routing still require manual integration configuration; project creation alone does not enable two-way sync.

## Development

Use Bun 1.4.4 and a Node version supported by Alchemy.

```text
bun install --frozen-lockfile
bun run test
bun run typecheck
bun run check
bun run knip
```

For a credential-free build in PowerShell:

```powershell
$env:LINEAR_TEAM_ID = '00000000-0000-4000-8000-000000000000'
bun run build
```

The UUID is a build fixture. Deployment defaults target an existing maintainer instance and require adaptation before reuse.

Read [setup and operations](docs/operations.md), [architecture](docs/architecture.md) and [contributing](CONTRIBUTING.md). Licensed under [MIT](LICENSE).
