# Architecture

`src/index.ts` exposes the Worker and SQLite Durable Object Reconciler. Pure identity and hook decisions live in `src/domain`; provider adapters and response schemas in `src/providers`; effect coordination in `src/application`; authentication, continuation and retention in `src/platform`.

A singleton per owner/team persists repository identities, operation intents, checkpoints and outcomes. Alarms advance bounded work and arm recovery before effects. Concurrent triggers return the active run. Repository failures permit other repositories to continue; persistent global failures terminate the run.

Archived and disabled repositories are skipped. Ambiguous projects and duplicate hooks need manual inspection. Only exact native endpoint matches are managed; unrelated hooks and existing signing secrets are preserved. Report cleanup retains current and previous run details while preserving identities and intents.

Effect and Alchemy versions are pinned for compatibility. Effect Schema validates remote and persisted records. Project inventory fails closed when nested team or external-link connections exceed ten entries; extend pagination instead of deleting remote configuration.
