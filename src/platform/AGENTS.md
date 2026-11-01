# Platform persistence

Durable Object hosting lives in durable.ts; run.ts advances persisted work and retention.ts performs bounded cleanup. auth.ts gates requests and env.ts validates bindings.

Arm recovery alarms before effects. Preserve operation intents and checkpoints across interruptions; concurrent triggers return the active run. Cleanup retains identities, intents and active provider retry deadlines. Use bounded batches and durable cursors.

Validate changes with platform run and retention tests using deterministic clocks and fixtures.
