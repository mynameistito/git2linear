import { Effect, Schema } from "effect";

import {
  IdentitySchema,
  ProjectSchema,
  RepositorySchema,
} from "../domain/reconciliation";
import type { GitHubClient } from "../providers/github";
import { ProviderFailureSchema } from "../providers/http";
import type { ProviderError, ProviderResult } from "../providers/http";
import type { LinearOperations } from "../providers/linear";
import { PersistenceError } from "./persistence-error";
import type {
  ReconciliationStore,
  RepositoryStatus,
  RunnerOptions,
} from "./runner";

export { ReconciliationError } from "./reconciliation-error";

const SummarySchema = Schema.Struct({
  alreadyConfigured: Schema.Number,
  created: Schema.Number,
  discovered: Schema.Number,
  failed: Schema.Number,
  manualActionRequired: Schema.Number,
  repaired: Schema.Number,
  skipped: Schema.Number,
});

export const CheckpointSchema = Schema.Struct({
  attempts: Schema.Number,
  change: Schema.Literals(["none", "created", "repaired"]),
  cursor: Schema.NullOr(Schema.String),
  index: Schema.Number,
  inventoryAttempts: Schema.optionalKey(Schema.Number),
  page: Schema.Number,
  phase: Schema.Literals(["repositories", "projects", "reconcile"]),
  projects: Schema.Array(ProjectSchema).pipe(Schema.mutable),
  providerFailure: Schema.optionalKey(ProviderFailureSchema),
  repositories: Schema.Array(RepositorySchema).pipe(Schema.mutable),
  summary: SummarySchema,
});

const StatusSchema = Schema.Struct({
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
  plannedActions: Schema.optionalKey(Schema.Array(Schema.String)),
  pushProcessing: Schema.Literal("unverified"),
  reason: Schema.String,
  runId: Schema.optionalKey(Schema.String),
  supportedStateVerified: Schema.optionalKey(Schema.Boolean),
});

type EffectPort<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => Promise<infer R>
    ? (...args: A) => Effect.Effect<R, PersistenceError>
    : never;
};

/** Durable persistence operations. */
export type NativeStore = EffectPort<ReconciliationStore>;

type ProviderPort<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => Promise<infer R>
    ? (...args: A) => Effect.Effect<R, PersistenceError>
    : never;
};

/** Native runner dependencies. */
export interface NativeOptions {
  github: ProviderPort<RunnerOptions["github"]>;
  linear: ProviderPort<RunnerOptions["linear"]>;
  store: NativeStore;
  owner: string;
  teamId: string;
  teamKey: string;
  endpoint?: string;
}

const promise = <T>(operation: string, run: () => Promise<T>) =>
  Effect.tryPromise({
    catch: () => new PersistenceError({ operation }),
    try: run,
  });

/** Adapt fixture persistence.
 * @param store - Promise based store.
 * @returns Native store.
 */
const legacyStore = (store: ReconciliationStore): NativeStore => ({
  identities: () => promise("identities", store.identities),
  intent: (id, kind) =>
    promise("intent", async () => await store.intent(id, kind)),
  record: (id, status) =>
    promise("record", async () => {
      await store.record(id, status);
    }),
  saveIdentity: (identity) =>
    promise("save-identity", async () => {
      await store.saveIdentity(identity);
    }),
});

/** Adapt fixture provider ports.
 * @param options - Promise based ports.
 * @returns Native dependencies.
 */
export const adaptLegacy = (options: RunnerOptions): NativeOptions => ({
  ...options,
  github: {
    createHook: (repo) =>
      promise(
        "github-create",
        async () => await options.github.createHook(repo)
      ),
    deliveries: (repo, id) =>
      promise(
        "github-deliveries",
        async () => await options.github.deliveries(repo, id)
      ),
    listHooks: (repo) =>
      promise("github-hooks", async () => await options.github.listHooks(repo)),
    listRepositoryPage: (page) =>
      promise(
        "github-page",
        async () => await options.github.listRepositoryPage(page)
      ),
    pingHook: (repo, id) =>
      promise(
        "github-ping",
        async () => await options.github.pingHook(repo, id)
      ),
    repairHook: (repo, id) =>
      promise(
        "github-repair",
        async () => await options.github.repairHook(repo, id)
      ),
  },
  linear: {
    attach: (input) =>
      promise("linear-attach", async () => await options.linear.attach(input)),
    create: (input) =>
      promise("linear-create", async () => await options.linear.create(input)),
    page: (cursor) =>
      promise("linear-page", async () => await options.linear.page(cursor)),
    rename: (id, name) =>
      promise(
        "linear-rename",
        async () => await options.linear.rename(id, name)
      ),
    verifyTeam: (id, key) =>
      promise(
        "linear-team",
        async () => await options.linear.verifyTeam(id, key)
      ),
  },
  store: legacyStore(options.store),
});

const result = <T>(
  effect: Effect.Effect<T, ProviderError>
): Effect.Effect<ProviderResult<T>> =>
  effect.pipe(
    Effect.match({
      onFailure: (error): ProviderResult<T> => ({ error, ok: false }),
      onSuccess: (value): ProviderResult<T> => ({ ok: true, value }),
    })
  );

/** Wire native provider ports.
 * @param github - GitHub operations.
 * @param linear - Linear operations.
 * @param store - Persistence operations.
 * @param owner - GitHub owner.
 * @param teamId - Linear team.
 * @param teamKey - Expected Linear team key.
 * @param endpoint - Native webhook endpoint.
 * @returns Native dependencies.
 */
export const nativeOptions = (
  github: GitHubClient["effects"],
  linear: LinearOperations,
  store: NativeStore,
  owner: string,
  teamId: string,
  teamKey: string,
  endpoint?: string
): NativeOptions => ({
  endpoint,
  github: {
    createHook: (repo) => result(github.createHook(repo)),
    deliveries: (repo, id) => result(github.deliveries(repo, id)),
    listHooks: (repo) => result(github.listHooks(repo)),
    listRepositoryPage: (page) => result(github.listRepositoryPage(page)),
    pingHook: (repo, id) => result(github.pingHook(repo, id)),
    repairHook: (repo, id) => result(github.repairHook(repo, id)),
  },
  linear: {
    attach: (input) => result(linear.attach(input)),
    create: (input) => result(linear.create(input)),
    page: (cursor) => result(linear.page(cursor)),
    rename: (id, name) => result(linear.rename(id, name)),
    verifyTeam: (id, key) => result(linear.verifyTeam(id, key)),
  },
  owner,
  store,
  teamId,
  teamKey,
});

/** Adapt durable storage.
 * @param storage - Durable storage.
 * @returns Persistence operations.
 */
export const nativePersistenceService = (
  storage: DurableObjectStorage
): NativeStore => ({
  identities: Effect.fn("Persistence.identities")(function* identities() {
    const values = yield* promise(
      "identities",
      async () => await storage.list({ prefix: "identity:" })
    );

    const decoded: (typeof IdentitySchema.Type)[] = [];

    for (const value of values.values()) {
      decoded.push(
        yield* Schema.decodeUnknownEffect(IdentitySchema)(value).pipe(
          Effect.mapError(
            () => new PersistenceError({ operation: "decode-identity" })
          )
        )
      );
    }

    return decoded;
  }),
  intent: Effect.fn("Persistence.intent")(function* intent(id, kind) {
    const key = `intent:${id}:${kind}`;
    const found = yield* promise("intent", async () => await storage.get(key));

    if (found !== undefined) {
      return yield* Schema.decodeUnknownEffect(Schema.String)(found).pipe(
        Effect.mapError(
          () => new PersistenceError({ operation: "decode-intent" })
        )
      );
    }

    const value = crypto.randomUUID();
    yield* promise("intent", async () => {
      await storage.put(key, value);
    });

    return value;
  }),
  record: Effect.fn("Persistence.record")(function* record(
    id,
    status: RepositoryStatus
  ) {
    const value = yield* Schema.decodeUnknownEffect(StatusSchema)(status).pipe(
      Effect.mapError(
        () => new PersistenceError({ operation: "decode-status" })
      )
    );

    yield* promise("record", async () => {
      await storage.put(`repository:${value.runId}:${id}`, value);
    });
  }),
  saveIdentity: Effect.fn("Persistence.saveIdentity")(
    function* saveIdentity(identity) {
      const value = yield* Schema.decodeUnknownEffect(IdentitySchema)(
        identity
      ).pipe(
        Effect.mapError(
          () => new PersistenceError({ operation: "decode-identity" })
        )
      );

      yield* promise("save-identity", async () => {
        await storage.put(`identity:${value.repositoryId}`, value);
      });
    }
  ),
});
