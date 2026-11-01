import {
  CloudflareEnvironment,
  DurableObject,
  providers,
  Worker,
} from "@alchemy.run/cloudflare";
import { AdoptPolicy, localState, Stack } from "alchemy";
import { Effect } from "effect";

import { deploymentConfig } from "./alchemy/deployment";
import { workerIdentity } from "./src/platform/deployment.ts";

export default Stack(
  workerIdentity.name,
  { providers: providers(), state: localState() },
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
