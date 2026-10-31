/* oxlint-disable sonarjs/no-duplicate-string -- Fixed internal metadata keys identify the same durable records across lifecycle operations. */
/* oxlint-disable anti-slop/no-runtime-typeof -- Private persisted checkpoint safe diagnostic projection. */
import { DurableObject } from "cloudflare:workers";

import type { RepositoryStatus } from "../application/runner";
import { createRunner } from "../application/runner";
import type { Env } from "./env";
import { pruneReportBatch } from "./retention";
import {
  RunCoordinator,
  checkpointDiagnostics,
  repositoryIdFromRecordKey,
} from "./run";
import type { RunRecord, RunStore } from "./run";

/** One coordinator per configured owner/workspace, never per repository. */
export class Reconciler extends DurableObject<Env> {
  readonly #coordinator: RunCoordinator;

  /** Platform lifecycle contract. */
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    const store: RunStore = {
      get: async () => await ctx.storage.get<RunRecord>("run"),
      getAlarm: async () => await ctx.storage.getAlarm(),
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

          if (current !== undefined) {
            await transaction.put("previous-run-id", current.runId);
          }

          await transaction.delete("report-retention-cursor");
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
  // oxlint-disable-next-line sonarjs/cognitive-complexity -- Authenticated operational projection and bounded pagination remain together.
  override async fetch(request: Request): Promise<Response> {
    if (request.method === "GET") {
      const record = await this.ctx.storage.get<RunRecord>("run");
      const nextAlarm = await this.ctx.storage.getAlarm();
      const diagnostics = checkpointDiagnostics(record?.checkpoint);

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

        const entries = await this.ctx.storage.list<RepositoryStatus>(options);

        const keys = [...entries.keys()];

        return Response.json({
          nextCursor: entries.size === 100 ? (keys.at(-1) ?? null) : null,
          repositories: [...entries].flatMap(([key, status]) => {
            const repositoryId = repositoryIdFromRecordKey(key, prefix);

            return repositoryId === null ? [] : [{ ...status, repositoryId }];
          }),
          runId: record.runId,
        });
      }

      return Response.json(
        record
          ? {
              continuation: {
                ...diagnostics,
                failures: record.failures,
                nextAlarm,
              },
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

    const moreReports = await this.ctx.storage.transaction(
      async (transaction) => {
        const current = await transaction.get<RunRecord>("run");

        if (current === undefined) {
          return false;
        }

        const previous = await transaction.get<string>("previous-run-id");

        return await pruneReportBatch(
          {
            cursor: async () =>
              await transaction.get<string>("report-retention-cursor"),
            keys: async (after, limit) => {
              const options: DurableObjectListOptions = {
                limit,
                prefix: "repository:",
              };

              if (after !== undefined) {
                options.startAfter = after;
              }

              const entries = await transaction.list(options);

              return [...entries.keys()];
            },
            remove: async (keys) => {
              await transaction.delete(keys);
            },
            saveCursor: async (cursor) => {
              await (cursor === null
                ? transaction.delete("report-retention-cursor")
                : transaction.put("report-retention-cursor", cursor));
            },
          },
          current.runId,
          previous
        );
      }
    );

    const record = await this.ctx.storage.get<RunRecord>("run");

    if (moreReports && record?.status !== "running") {
      await this.ctx.storage.setAlarm(Date.now() + 1000);
    }

    if (
      record?.dryRun === true &&
      record.status === "complete" &&
      record.summary.failed === 0
    ) {
      await this.ctx.storage.put("dry-run-complete", true);
    }
  }
}
