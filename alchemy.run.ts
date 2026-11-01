import {
  CloudflareEnvironment,
  DurableObject,
  providers,
  Worker,
} from "@alchemy.run/cloudflare";
import { AdoptPolicy, localState, Stack } from "alchemy";
import { Effect } from "effect";

import { deploymentConfig } from "./alchemy/deployment";

export default Stack(
  "git2linear",
  { providers: providers(), state: localState() },
  Effect.gen(function* stack() {
    const config = yield* deploymentConfig;

    const account = yield* CloudflareEnvironment.current;

    if (account.accountId !== "402722ab1f598e783cd6dcdedc37e1d0") {
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
      compatibility: { date: "2026-10-31" },
      crons: ["0 * * * *"],
      env: {
        APPLY_ENABLED: String(config.applyEnabled),
        GITHUB_OWNER: "mynameistito",
        GITHUB_TOKEN: config.githubToken,
        LINEAR_API_KEY: config.linearApiKey,
        LINEAR_TEAM_ID: config.teamId,
        LINEAR_TEAM_KEY: "MY",
        MANUAL_TRIGGER_TOKEN: config.manualTriggerToken,
        RECONCILER: DurableObject("Reconciler", {
          storage: "sqlite",
        }),
        ...webhookBindings,
      },
      main: "./src/index.ts",
      name: "git2linear",
    }).pipe(AdoptPolicy.adopt(true));

    return { url: worker.url };
  })
);
