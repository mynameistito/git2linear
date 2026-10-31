import { authorized } from "./platform/auth";
import type { Env } from "./platform/env";

export { Reconciler } from "./platform/durable";

const coordinator = (env: Env): DurableObjectStub =>
  env.RECONCILER.getByName(`${env.GITHUB_OWNER}:${env.LINEAR_TEAM_ID}`);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!(await authorized(request, env.MANUAL_TRIGGER_TOKEN))) {
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
    const dryRun = env.APPLY_ENABLED !== "true";
    await coordinator(env).fetch(
      new Request(`https://internal/reconcile?dryRun=${dryRun}`, {
        method: "POST",
      })
    );
  },
} satisfies ExportedHandler<Env>;
