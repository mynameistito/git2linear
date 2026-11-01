import { bindings, defineConfig, exports, triggers } from "cf/config";
import { Config, Effect } from "effect";

import { teamIdConfig } from "./src/platform/deployment";

const deployment = Effect.runSync(
  Config.all({
    applyEnabled: Config.Boolean("APPLY_ENABLED").pipe(
      Config.withDefault(false)
    ),
    bootstrap: Config.Boolean("BOOTSTRAP_MODE").pipe(Config.withDefault(false)),
    teamId: teamIdConfig,
  })
);

const secretBindings: Record<string, ReturnType<typeof bindings.secret>> = {};

if (!deployment.bootstrap) {
  secretBindings.GITHUB_TOKEN = bindings.secret();
  secretBindings.LINEAR_API_KEY = bindings.secret();
  secretBindings.MANUAL_TRIGGER_TOKEN = bindings.secret();
}

export default defineConfig({
  accountId: "402722ab1f598e783cd6dcdedc37e1d0",
  worker: {
    compatibilityDate: "2026-10-31",
    entrypoint: "src/index.ts",
    env: {
      APPLY_ENABLED: bindings.text(String(deployment.applyEnabled)),
      GITHUB_OWNER: bindings.text("mynameistito"),
      LINEAR_TEAM_ID: bindings.text(deployment.teamId),
      LINEAR_TEAM_KEY: bindings.text("MY"),
      RECONCILER: bindings.durableObject({
        exportName: "Reconciler",
        worker: "git2linear",
      }),
      ...secretBindings,
    },
    exports: { Reconciler: exports.durableObject({ storage: "sqlite" }) },
    name: "git2linear",
    triggers: [triggers.scheduled({ schedule: "0 * * * *" })],
  },
});
