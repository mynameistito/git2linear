import {
  CloudflareEnvironment,
  DurableObject,
  providers,
  state,
  Worker,
} from "@alchemy.run/cloudflare";
import { AdoptPolicy, Stack } from "alchemy";
import { ConfigProvider, Effect, Layer } from "effect";

import { deploymentConfig } from "./alchemy/deployment";
import { stateContextLayer } from "./alchemy/state-policy";
import { workerIdentity } from "./src/platform/deployment.ts";

export default Stack(
  workerIdentity.name,
  {
    providers: providers(),
    // Missing or outdated shared stores must fail even for local plans.
    state: state().pipe(
      Layer.provide(stateContextLayer),
      Layer.provide(
        ConfigProvider.layerAdd(ConfigProvider.fromUnknown({ CI: "true" }), {
          asPrimary: true,
        })
      )
    ),
  },
  Effect.gen(function* stack() {
    const config = yield* deploymentConfig;

    const account = yield* CloudflareEnvironment.current;

    if (account.accountId !== workerIdentity.accountId) {
      return yield* Effect.die("Cloudflare account does not match git2linear");
    }

    const webhookBindings =
      config.webhook === undefined
        ? undefined
        : {
            LINEAR_WEBHOOK_SECRET: config.webhook.secret,
            LINEAR_WEBHOOK_URL: config.webhook.url,
          };

    const worker = yield* Worker("Worker", {
      compatibility: { date: workerIdentity.compatibilityDate },
      crons: [workerIdentity.cron],
      env: {
        APPLY_ENABLED: String(config.applyEnabled),
        GITHUB_OWNER: workerIdentity.owner,
        GITHUB_TOKEN: config.githubToken,
        LINEAR_API_KEY: config.linearApiKey,
        LINEAR_TEAM_ID: config.teamId,
        LINEAR_TEAM_KEY: workerIdentity.teamKey,
        MANUAL_TRIGGER_TOKEN: config.manualTriggerToken,
        RECONCILER: DurableObject("Reconciler", {
          storage: "sqlite",
        }),
        ...webhookBindings,
      },
      main: "./src/index.ts",
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
    }).pipe(AdoptPolicy.adopt(true));

    return { url: worker.url };
  })
);
