import { bindings, defineConfig, exports, triggers } from "cf/config";

const secretBindings: Record<string, ReturnType<typeof bindings.secret>> = {};

if (process.env.BOOTSTRAP_MODE !== "true") {
  secretBindings.GITHUB_TOKEN = bindings.secret();
  secretBindings.LINEAR_API_KEY = bindings.secret();
  secretBindings.MANUAL_TRIGGER_TOKEN = bindings.secret();
}

export default defineConfig({
  accountId: "402722ab1f598e783cd6dcdedc37e1d0",
  worker: {
    compatibilityDate: "2026-11-01",
    entrypoint: "src/index.ts",
    env: {
      APPLY_ENABLED: bindings.text(process.env.APPLY_ENABLED ?? "false"),
      GITHUB_OWNER: bindings.text("mynameistito"),
      LINEAR_TEAM_ID: bindings.text(process.env.LINEAR_TEAM_ID ?? ""),
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
