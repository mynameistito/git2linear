import { DurableObject } from "cloudflare:workers";
import { Effect, Option, Schema } from "effect";

import { PersistenceError } from "../application/persistence-error";
import { createRunner } from "../application/runner";
import type { Env } from "./env";
import { pruneEffect } from "./retention";
import {
  RunCoordinator,
  checkpointDiagnostics,
  decodeRunRecord,
  repositoryIdFromRecordKey,
} from "./run";
import type { RunRecord, RunPersistence } from "./run";

const PublicRepositoryStatus = Schema.Struct({
  dryRun: Schema.optionalKey(Schema.Boolean),
  hookId: Schema.optionalKey(Schema.Number),
  manualActionRequired: Schema.Literal(true),
  outcome: Schema.Literals([
    "already-configured",
    "created",
    "repaired",
    "skipped",
    "failed",
  ]),
  ping: Schema.Literals(["not-requested", "accepted", "failed"]),
  pingDelivery: Schema.optionalKey(
    Schema.Literals(["verified", "failed", "pending"])
  ),
  plannedActions: Schema.optionalKey(
    Schema.Array(
      Schema.Literals([
        "project:create",
        "project:reuse",
        "project:rename",
        "project:attach-repository-url",
        "hook:create",
        "hook:reuse",
        "hook:repair",
        "hook:manual",
        "native-sync:manual",
      ])
    )
  ),
  pushProcessing: Schema.Literal("unverified"),
  reason: Schema.Literals([
    "foreign-owner",
    "archived",
    "disabled",
    "identity-conflict",
    "missing-mapped-project",
    "ambiguous-project",
    "archived-project",
    "duplicate-endpoint-hooks",
    "commit-webhook-credentials-unavailable",
    "provider-failure-or-retry-exhausted",
    "verification-or-retry-exhausted",
    "dry-run-plan",
    "native-sync-configuration-and-project-routing-require-supported-api",
  ]),
  supportedStateVerified: Schema.optionalKey(Schema.Boolean),
});

const RUN = "run";
const PREVIOUS = "previous-run-id";
const CURSOR = "report-retention-cursor";
const DRY_RUN = "dry-run-complete";
const REPOSITORY = "repository:";
const PAGE_SIZE = 100;

const storageEffect = <T>(operation: string, run: () => Promise<T>) =>
  Effect.tryPromise({
    catch: () => new PersistenceError({ operation }),
    try: run,
  });

const optionalRun = Schema.decodeUnknownEffect(
  Schema.UndefinedOr(Schema.Unknown)
);

const optionalString = Schema.decodeUnknownEffect(
  Schema.UndefinedOr(Schema.String)
);

const readRun = (read: Effect.Effect<unknown, PersistenceError>) =>
  read.pipe(
    Effect.flatMap(optionalRun),
    Effect.flatMap((value) =>
      value === undefined ? Effect.succeed(undefined) : decodeRunRecord(value)
    ),
    Effect.mapError(() => new PersistenceError({ operation: "decode-run" }))
  );

const startTransaction = (tx: DurableObjectTransaction, record: RunRecord) =>
  Effect.gen(function* runStartTransaction() {
    const current = yield* readRun(
      storageEffect("get-run", async () => await tx.get(RUN))
    );

    if (current?.status === "running") {
      return current;
    }

    if (current !== undefined) {
      yield* storageEffect("previous-run", async () => {
        await tx.put(PREVIOUS, current.runId);
      });
    }

    yield* storageEffect("clear-cursor", async () => await tx.delete(CURSOR));
    yield* storageEffect("put-run", async () => {
      await tx.put(RUN, record);
    });

    return record;
  });

const retentionStore = (tx: DurableObjectTransaction) => ({
  cursor: async () =>
    Schema.decodeUnknownSync(Schema.UndefinedOr(Schema.String))(
      await tx.get(CURSOR)
    ),
  keys: async (after: string | undefined, limit: number) => {
    const options: DurableObjectListOptions = { limit, prefix: REPOSITORY };

    if (after !== undefined) {
      options.startAfter = after;
    }

    const entries = await tx.list(options);

    return [...entries.keys()];
  },
  remove: async (keys: string[]) => {
    await tx.delete(keys);
  },
  saveCursor: async (cursor: string | null) => {
    await (cursor === null ? tx.delete(CURSOR) : tx.put(CURSOR, cursor));
  },
});

const maintenanceTransaction = (tx: DurableObjectTransaction) =>
  Effect.gen(function* runMaintenanceTransaction() {
    const current = yield* readRun(
      storageEffect("get-run", async () => await tx.get(RUN))
    );

    if (current === undefined) {
      return false;
    }

    const previous = yield* storageEffect(
      "get-previous",
      async () => await tx.get(PREVIOUS)
    ).pipe(
      Effect.flatMap(optionalString),
      Effect.mapError(
        () => new PersistenceError({ operation: "decode-previous" })
      )
    );

    return yield* pruneEffect(retentionStore(tx), current.runId, previous);
  });

const makeStorage = (storage: DurableObjectStorage) => {
  const get = (key: string) =>
    storageEffect("get-storage", async () => await storage.get(key));

  const getRun = () => readRun(get(RUN));

  const getAlarm = () =>
    storageEffect("get-alarm", async () => await storage.getAlarm());

  const schedule = (at: number) =>
    storageEffect("set-alarm", async () => {
      await storage.setAlarm(at);
    });

  const start = (record: RunRecord) =>
    storageEffect(
      "start-run",
      async () =>
        await storage.transaction(
          async (tx) => await Effect.runPromise(startTransaction(tx, record))
        )
    );

  const persistence: RunPersistence = {
    get: getRun,
    getAlarm,
    put: (record) =>
      storageEffect("put-run", async () => {
        await storage.put(RUN, record);
      }),
    schedule,
    start,
  };

  const list = (options: DurableObjectListOptions) =>
    storageEffect("list-repositories", async () => await storage.list(options));

  const markDryRun = () =>
    storageEffect("mark-dry-run", async () => {
      await storage.put(DRY_RUN, true);
    });

  const maintenance = () =>
    storageEffect(
      "maintenance",
      async () =>
        await storage.transaction(
          async (tx) => await Effect.runPromise(maintenanceTransaction(tx))
        )
    );

  return {
    get,
    getAlarm,
    list,
    maintenance,
    markDryRun,
    persistence,
    readRun: getRun,
    schedule,
  };
};

type Storage = ReturnType<typeof makeStorage>;

const summaryEffect = Effect.fn("Reconciler.summary")(function* summaryEffect(
  storage: Storage,
  record: RunRecord | undefined
) {
  const nextAlarm = yield* storage.getAlarm();

  return Response.json(
    record
      ? {
          continuation: {
            ...checkpointDiagnostics(record.checkpoint),
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
});

const detailsEffect = Effect.fn("Reconciler.details")(function* detailsEffect(
  storage: Storage,
  record: RunRecord,
  url: URL
) {
  const prefix = `${REPOSITORY + record.runId}:`;
  const after = url.searchParams.get("after");

  if (after !== null && !after.startsWith(prefix)) {
    return Response.json({ error: "invalid-cursor" }, { status: 400 });
  }

  const options: DurableObjectListOptions = { limit: PAGE_SIZE, prefix };

  if (after !== null) {
    options.startAfter = after;
  }

  const entries = yield* storage.list(options);
  const keys = [...entries.keys()];

  return Response.json({
    nextCursor: entries.size === PAGE_SIZE ? (keys.at(-1) ?? null) : null,
    repositories: [...entries].flatMap(([key, status]) => {
      const repositoryId = repositoryIdFromRecordKey(key, prefix);

      const safe = Option.getOrUndefined(
        Schema.decodeUnknownOption(PublicRepositoryStatus)(status)
      );

      return repositoryId === null || safe === undefined
        ? []
        : [{ ...safe, repositoryId, runId: record.runId }];
    }),
    runId: record.runId,
  });
});

const startEffect = Effect.fn("Reconciler.start")(function* startEffect(
  storage: Storage,
  coordinator: RunCoordinator,
  env: Env,
  url: URL
) {
  const dryRun = url.searchParams.get("dryRun") !== "false";

  if (!dryRun && env.APPLY_ENABLED !== "true") {
    return Response.json({ error: "apply-disabled" }, { status: 409 });
  }

  if (!dryRun) {
    const stored = yield* storage.get(DRY_RUN);

    if (stored !== undefined) {
      yield* Schema.decodeUnknownEffect(Schema.Boolean)(stored).pipe(
        Effect.mapError(
          () => new PersistenceError({ operation: "decode-dry-run" })
        )
      );
    }

    if (stored !== true) {
      return Response.json({ error: "dry-run-required" }, { status: 409 });
    }
  }

  const record = yield* coordinator.startEffect(dryRun);

  return Response.json(
    { dryRun: record.dryRun, runId: record.runId, status: record.status },
    { status: 202 }
  );
});

const fetchEffect = Effect.fn("Reconciler.fetch")(function* fetchEffect(
  storage: Storage,
  coordinator: RunCoordinator,
  env: Env,
  request: Request
) {
  const url = new URL(request.url);

  if (request.method !== "GET") {
    return yield* startEffect(storage, coordinator, env, url);
  }

  const record = yield* storage.readRun();

  if (record && url.searchParams.get("details") === "true") {
    return yield* detailsEffect(storage, record, url);
  }

  return yield* summaryEffect(storage, record);
});

const maintenanceEffect = Effect.fn("Reconciler.maintenance")(
  function* maintenanceEffect(storage: Storage) {
    const more = yield* storage.maintenance();
    const record = yield* storage.readRun();

    if (
      more &&
      record?.status !== "running" &&
      (yield* storage.getAlarm()) === null
    ) {
      yield* storage.schedule(Date.now() + 1000);
    }

    if (
      record?.dryRun === true &&
      record.status === "complete" &&
      record.summary.failed === 0
    ) {
      yield* storage.markDryRun();
    }
  }
);

const alarmEffect = Effect.fn("Reconciler.alarm")(function* alarmEffect(
  storage: Storage,
  coordinator: RunCoordinator
) {
  const record = yield* storage.readRun();
  const alarm = yield* storage.getAlarm();
  const now = Date.now();

  if (alarm !== null && alarm > now) {
    return;
  }

  if (
    record?.status === "running" &&
    record.retryAt !== undefined &&
    record.retryAt > now
  ) {
    yield* storage.schedule(record.retryAt);

    return;
  }

  yield* coordinator.advanceEffect();
  yield* maintenanceEffect(storage);
});

/** One coordinator per configured owner/workspace, never per repository. */
export class Reconciler extends DurableObject<Env> {
  readonly #coordinator: RunCoordinator;
  readonly #storage: Storage;
  /** Platform lifecycle contract. */
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.#storage = makeStorage(ctx.storage);
    this.#coordinator = new RunCoordinator({
      runner: createRunner(env, ctx.storage),
      store: this.#storage.persistence,
    });
  }
  /** Handle coordinator requests.
   * @param request - Internal request.
   * @returns Safe status.
   */
  override async fetch(request: Request): Promise<Response> {
    return await Effect.runPromise(
      fetchEffect(this.#storage, this.#coordinator, this.env, request)
    );
  }
  /** Platform lifecycle contract. */
  override async alarm(): Promise<void> {
    await Effect.runPromise(alarmEffect(this.#storage, this.#coordinator));
  }
}
