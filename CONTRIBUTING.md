# Contributing

Install with `bun install --frozen-lockfile`. Run `bun run test`, `bun run typecheck`, `bun run check`, `bun run knip` and the README build fixture before opening a PR. CI also validates workflows with actionlint.

Keep planning pure and effects in adapters or orchestration. Add meaningful regressions for behavior changes, especially retries, persistence and mutation safety. Use fixtures instead of production credentials. Explain behavior and validation in the PR; keep personal deployment evidence out of public documentation.
