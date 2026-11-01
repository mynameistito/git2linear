import { Effect, Redacted } from "effect";

import { authorizedEffect, scheduledReady } from "./platform/auth";
import type { Env } from "./platform/env";
import { runtimeConfigLayer, RuntimeConfigService } from "./platform/env";

export { Reconciler } from "./platform/durable";

const coordinator = (env: Env): DurableObjectStub =>
  env.RECONCILER.getByName(`${env.GITHUB_OWNER}:${env.LINEAR_TEAM_ID}`);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const authenticated = await Effect.runPromise(
      Effect.gen(function* authenticate() {
        const config = yield* RuntimeConfigService;

        return yield* authorizedEffect(
          request,
          Redacted.value(config.manualTriggerToken)
        );
      }).pipe(
        Effect.provide(runtimeConfigLayer(env)),
        Effect.catch(() => Effect.succeed(false))
      )
    );

    if (!authenticated) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    const url = new URL(request.url);

    if (
      !(
        (request.method === "POST" && url.pathname === "/reconcile") ||
        (request.method === "GET" && url.pathname === "/status")
      )
    ) {
      return Response.json({ error: "not-found" }, { status: 404 });
    }

    const response = await coordinator(env).fetch(request);
    const headers = new Headers(response.headers);
    headers.set("Cache-Control", "no-store");

    return new Response(response.body, { headers, status: response.status });
  },
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const ready = await Effect.runPromise(
      Effect.gen(function* scheduledConfig() {
        const config = yield* RuntimeConfigService;

        return {
          applyEnabled: config.applyEnabled,
          ready: scheduledReady({
            GITHUB_TOKEN: Redacted.value(config.githubToken),
            LINEAR_API_KEY: Redacted.value(config.linearApiKey),
            MANUAL_TRIGGER_TOKEN: Redacted.value(config.manualTriggerToken),
          }),
        };
      }).pipe(
        Effect.provide(runtimeConfigLayer(env)),
        Effect.catch(() => Effect.succeed({ applyEnabled: "", ready: false }))
      )
    );

    if (!ready.ready) {
      return;
    }

    const dryRun = ready.applyEnabled !== "true";
    await coordinator(env).fetch(
      new Request(`https://internal/reconcile?dryRun=${dryRun}`, {
        method: "POST",
      })
    );
  },
} satisfies ExportedHandler<Env>;
