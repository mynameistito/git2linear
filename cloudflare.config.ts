import { bindings, defineConfig, exports, triggers } from "cf/config";
import { Config, Effect } from "effect";

import { teamIdConfig, workerIdentity } from "./src/platform/deployment.ts";

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
  accountId: workerIdentity.accountId,
  worker: {
    compatibilityDate: workerIdentity.compatibilityDate,
    entrypoint: "src/index.ts",
    env: {
      APPLY_ENABLED: bindings.text(String(deployment.applyEnabled)),
      GITHUB_OWNER: bindings.text(workerIdentity.owner),
      LINEAR_TEAM_ID: bindings.text(deployment.teamId),
      LINEAR_TEAM_KEY: bindings.text(workerIdentity.teamKey),
      RECONCILER: bindings.durableObject({
        exportName: "Reconciler",
        worker: workerIdentity.name,
      }),
      ...secretBindings,
    },
    exports: { Reconciler: exports.durableObject({ storage: "sqlite" }) },
    name: workerIdentity.name,
    observability: {
      enabled: true,
      headSamplingRate: 1,
      logs: {
        enabled: true,
        headSamplingRate: 1,
        invocationLogs: true,
        persist: true,
      },
      redactQueryString: true,
      traces: { enabled: true, headSamplingRate: 1, persist: true },
    },
    triggers: [triggers.scheduled({ schedule: workerIdentity.cron })],
  },
});
