import { DurableObject } from "cloudflare:workers";

import { createRunner } from "../application/runner";
import type { Env } from "./env";
import { RunCoordinator } from "./run";
import type { RunRecord, RunStore } from "./run";

/** One coordinator per configured owner/workspace, never per repository. */
export class Reconciler extends DurableObject<Env> {
  readonly #coordinator: RunCoordinator;

  /** Platform lifecycle contract. */
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    const store: RunStore = {
      get: async () => await ctx.storage.get<RunRecord>("run"),
      put: async (record) => {
        await ctx.storage.put("run", record);
      },
      schedule: async (at) => {
        await ctx.storage.setAlarm(at);
      },
      start: async (record) =>
        await ctx.storage.transaction(async (transaction) => {
          const current = await transaction.get<RunRecord>("run");

          if (current?.status === "running") {
            return current;
          }

          await transaction.put("run", record);

          return record;
        }),
    };

    this.#coordinator = new RunCoordinator(
      store,
      createRunner(env, ctx.storage)
    );
  }

  /** Handle coordinator requests.
   * @param request - Internal request.
   * @returns Safe status.
   */
  override async fetch(request: Request): Promise<Response> {
    if (request.method === "GET") {
      const record = await this.ctx.storage.get<RunRecord>("run");
      const url = new URL(request.url);

      if (record && url.searchParams.get("details") === "true") {
        const prefix = `repository:${record.runId}:`;
        const after = url.searchParams.get("after");

        if (after !== null && !after.startsWith(prefix)) {
          return Response.json({ error: "invalid-cursor" }, { status: 400 });
        }

        const options: DurableObjectListOptions = {
          limit: 100,
          prefix,
        };

        if (after !== null) {
          options.startAfter = after;
        }

        const entries = await this.ctx.storage.list(options);

        const keys = [...entries.keys()];

        return Response.json({
          nextCursor: entries.size === 100 ? (keys.at(-1) ?? null) : null,
          repositories: [...entries.values()],
          runId: record.runId,
        });
      }

      return Response.json(
        record
          ? {
              dryRun: record.dryRun,
              runId: record.runId,
              startedAt: record.startedAt,
              status: record.status,
              summary: record.summary,
              updatedAt: record.updatedAt,
            }
          : { status: "idle" }
      );
    }

    const dryRun = new URL(request.url).searchParams.get("dryRun") !== "false";

    if (!dryRun && this.env.APPLY_ENABLED !== "true") {
      return Response.json({ error: "apply-disabled" }, { status: 409 });
    }

    if (
      !dryRun &&
      (await this.ctx.storage.get<boolean>("dry-run-complete")) !== true
    ) {
      return Response.json({ error: "dry-run-required" }, { status: 409 });
    }

    const record = await this.#coordinator.start(dryRun);

    return Response.json(
      { dryRun: record.dryRun, runId: record.runId, status: record.status },
      { status: 202 }
    );
  }

  /** Platform lifecycle contract. */
  override async alarm(): Promise<void> {
    await this.#coordinator.advance();
    const record = await this.ctx.storage.get<RunRecord>("run");

    if (
      record?.dryRun === true &&
      record.status === "complete" &&
      record.summary.failed === 0
    ) {
      await this.ctx.storage.put("dry-run-complete", true);
    }
  }
}
