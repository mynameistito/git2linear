import {
  Context,
  Duration,
  Effect,
  flow,
  Layer,
  Option,
  Schedule,
  Schema,
} from "effect";

import { PersistenceError } from "../application/persistence-error";

/** Secret-free status counters accumulated by the application runner. */
export interface RunSummary {
  discovered: number;
  alreadyConfigured: number;
  created: number;
  repaired: number;
  skipped: number;
  failed: number;
  manualActionRequired: number;
}

/** One bounded unit; checkpoints contain no credentials or authenticated URLs. */
export interface StepInput {
  readonly checkpoint: unknown;
  readonly dryRun: boolean;
  readonly runId: string;
}

/** Platform lifecycle contract. */
export interface StepOutput {
  readonly checkpoint: unknown;
  readonly done: boolean;
  readonly summary: RunSummary;
  readonly retryAt?: number;
}

/** Platform lifecycle contract. */
export interface StepRunner {
  step: (input: StepInput) => Promise<StepOutput>;
}

/** Platform lifecycle contract. */
export interface RunRecord extends StepInput {
  readonly retryAt?: number;
  readonly status: "running" | "complete" | "failed";
  readonly summary: RunSummary;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly failures: number;
}

/** Create counters.
 * @returns Empty counters.
 */
export const emptySummary = (): RunSummary => ({
  alreadyConfigured: 0,
  created: 0,
  discovered: 0,
  failed: 0,
  manualActionRequired: 0,
  repaired: 0,
  skipped: 0,
});

/** Storage transaction serializes start decisions without holding a lock over network IO. */
export interface RunStore {
  getAlarm: () => Promise<number | null>;
  get: () => Promise<RunRecord | undefined>;
  put: (record: RunRecord) => Promise<void>;
  start: (record: RunRecord) => Promise<RunRecord>;
  schedule: (at: number) => Promise<void>;
}

export const RunRecordSchema = Schema.Struct({
  checkpoint: Schema.Unknown,
  dryRun: Schema.Boolean,
  failures: Schema.Number,
  retryAt: Schema.optionalKey(Schema.Number),
  runId: Schema.String,
  startedAt: Schema.Number,
  status: Schema.Literals(["running", "complete", "failed"]),
  summary: Schema.Struct({
    alreadyConfigured: Schema.Number,
    created: Schema.Number,
    discovered: Schema.Number,
    failed: Schema.Number,
    manualActionRequired: Schema.Number,
    repaired: Schema.Number,
    skipped: Schema.Number,
  }),
  updatedAt: Schema.Number,
});

/** Platform service boundary. */
export interface RunPersistence {
  get: () => Effect.Effect<RunRecord | undefined, PersistenceError>;
  getAlarm: () => Effect.Effect<number | null, PersistenceError>;
  put: (record: RunRecord) => Effect.Effect<void, PersistenceError>;
  start: (record: RunRecord) => Effect.Effect<RunRecord, PersistenceError>;
  schedule: (at: number) => Effect.Effect<void, PersistenceError>;
}

export const RunPersistenceService = Context.Service<RunPersistence>(
  "git2linear/RunPersistence"
);

const storageEffect = <T>(operation: string, run: () => Promise<T>) =>
  Effect.tryPromise({
    catch: () => new PersistenceError({ operation }),
    try: run,
  });

/** Decode a persisted record.
 * @param input - Untrusted persisted value.
 * @returns The decoded record or a persistence error.
 */
export const decodeRunRecord = flow(
  Schema.decodeUnknownEffect(RunRecordSchema),
  Effect.mapError(() => new PersistenceError({ operation: "decode-run" }))
);

/** Adapt Promise storage to Effect.
 * @param store - Promise-based run storage.
 * @returns The native persistence service.
 */
export const nativeRunPersistence = (store: RunStore): RunPersistence => ({
  get: () =>
    storageEffect("get-run", store.get).pipe(
      Effect.flatMap((value) =>
        value === undefined ? Effect.succeed(undefined) : decodeRunRecord(value)
      )
    ),
  getAlarm: () => storageEffect("get-alarm", store.getAlarm),
  put: (record) =>
    storageEffect("put-run", async () => {
      await store.put(record);
    }),
  schedule: (at) =>
    storageEffect("schedule", async () => {
      await store.schedule(at);
    }),
  start: (record) =>
    storageEffect("start-run", async () => await store.start(record)).pipe(
      Effect.flatMap(decodeRunRecord)
    ),
});

/** Create a persistence service layer.
 * @param store - Promise-based run storage.
 * @returns A layer providing run persistence.
 */
export const persistenceLayer = (store: RunStore) =>
  Layer.succeed(RunPersistenceService, nativeRunPersistence(store));

/** Platform service boundary. */
export interface NativeStepRunner {
  readonly stepEffect: (input: StepInput) => Effect.Effect<StepOutput, unknown>;
}

const retryDelay = Effect.fn("RunCoordinator.retryDelay")(function* retryDelay(
  failures: number,
  now: number
) {
  const step = yield* Schedule.toStep(Schedule.exponential("2 seconds"));
  let delay = 0;

  for (let attempt = 0; attempt < failures; attempt += 1) {
    const result = yield* Effect.result(step(now, undefined));

    if (result._tag === "Success") {
      delay = Duration.toMillis(result.success[0]);
    }
  }

  return Math.min(60_000, delay);
});

/** Durable continuation; the watchdog is armed before external effects. */
export class RunCoordinator {
  readonly #store: RunPersistence;
  readonly #runner: NativeStepRunner;
  readonly #now: () => number;
  #busy = false;

  /** Construct or invoke the coordinator. */
  constructor(store: RunStore, runner: StepRunner, now?: () => number);
  /** Construct or invoke the coordinator. */
  constructor(options: {
    store: RunPersistence;
    runner: NativeStepRunner;
    now?: () => number;
  });
  /** Construct or invoke the coordinator. */
  constructor(
    store:
      | RunStore
      | { store: RunPersistence; runner: NativeStepRunner; now?: () => number },
    runner?: StepRunner,
    now = Date.now
  ) {
    if ("store" in store) {
      this.#store = store.store;
      this.#runner = store.runner;
      this.#now = store.now ?? Date.now;
    } else {
      this.#store = nativeRunPersistence(store);

      if (!runner) {
        throw new Error("runner required");
      }

      this.#runner = {
        stepEffect: (input) =>
          Effect.tryPromise({
            catch: () => new PersistenceError({ operation: "legacy-step" }),
            try: async () => await runner.step(input),
          }),
      };
      this.#now = now;
    }
  }

  readonly startEffect = Effect.fn("RunCoordinator.start")(
    function* startEffect(this: RunCoordinator, dryRun: boolean) {
      const now = this.#now();
      const requestedId = crypto.randomUUID();

      const record = yield* this.#store.start({
        checkpoint: null,
        dryRun,
        failures: 0,
        runId: requestedId,
        startedAt: now,
        status: "running",
        summary: emptySummary(),
        updatedAt: now,
      });

      if (
        record.status === "running" &&
        (record.runId === requestedId ||
          (yield* this.#store.getAlarm()) === null)
      ) {
        yield* this.#store.schedule(Math.max(now + 1000, record.retryAt ?? 0));
      }

      return record;
    }.bind(this)
  );

  readonly advanceEffect = Effect.fn("RunCoordinator.advance")(
    function* advanceEffect(this: RunCoordinator) {
      if (this.#busy) {
        return;
      }

      this.#busy = true;
      yield* this.#advance().pipe(
        Effect.ensuring(
          Effect.sync(() => {
            this.#busy = false;
          })
        )
      );
    }.bind(this)
  );

  readonly #advance = Effect.fn("RunCoordinator.advanceWork")(
    function* advanceWork(this: RunCoordinator) {
      const record = yield* this.#store.get();

      if (!record || record.status !== "running") {
        return;
      }

      yield* this.#store.schedule(this.#now() + 120_000);
      const result = yield* Effect.result(this.#runner.stepEffect(record));

      if (result._tag === "Failure") {
        const failures = record.failures + 1;
        const now = this.#now();
        const retryAt = now + (yield* retryDelay(failures, now));
        yield* this.#store.put({
          ...record,
          failures,
          retryAt,
          status: failures >= 5 ? "failed" : "running",
          updatedAt: this.#now(),
        });

        if (failures < 5) {
          yield* this.#store.schedule(retryAt);
        }

        return;
      }

      const next = result.success;
      yield* this.#store.put({
        ...record,
        checkpoint: next.checkpoint,
        failures: 0,
        retryAt: next.retryAt ?? 0,
        status: next.done ? "complete" : "running",
        summary: next.summary,
        updatedAt: this.#now(),
      });

      if (!next.done) {
        yield* this.#store.schedule(
          Math.max(this.#now() + 1000, next.retryAt ?? 0)
        );
      }
    }.bind(this)
  );

  /** Start or resume a run.
   * @param dryRun - Whether changes should be simulated.
   * @returns The active run record.
   */
  async start(dryRun: boolean): Promise<RunRecord> {
    return await Effect.runPromise(this.startEffect(dryRun));
  }
  /** Construct or invoke the coordinator. */
  async advance(): Promise<void> {
    await Effect.runPromise(this.advanceEffect());
  }
}

/** Validated secret-free continuation fields. */
export interface CheckpointDiagnostics {
  phase?: string;
  attempts?: number;
  providerFailure?: {
    kind: string;
    status?: number;
    retryAt?: number;
    reason?: string;
  };
}

const DiagnosticFields = Schema.Struct({
  attempts: Schema.optionalKey(Schema.Unknown),
  phase: Schema.optionalKey(Schema.Unknown),
  providerFailure: Schema.optionalKey(Schema.Unknown),
});

const FailureFields = Schema.Struct({
  kind: Schema.optionalKey(Schema.Unknown),
  reason: Schema.optionalKey(Schema.Unknown),
  retryAt: Schema.optionalKey(Schema.Unknown),
  status: Schema.optionalKey(Schema.Unknown),
});

const Phase = Schema.Literals(["repositories", "projects", "reconcile"]);
const FailureKind = Schema.Literals(["http", "network", "invalid-response"]);

const FailureReason = Schema.Literals([
  "illegal-invocation",
  "timeout",
  "invalid-header",
  "other",
]);

const readNumber = Schema.decodeUnknownOption(Schema.Number);

/** Project only validated, secret-free checkpoint scalars.
 * @param input - Untrusted checkpoint value.
 * @returns Safe diagnostic fields.
 */
export const checkpointDiagnostics = flow(
  Schema.decodeUnknownOption(DiagnosticFields),
  (decoded): CheckpointDiagnostics => {
    const fields = Option.getOrUndefined(decoded);

    if (!fields) {
      return {};
    }

    const safe: CheckpointDiagnostics = {};

    const phase = Option.getOrUndefined(
      Schema.decodeUnknownOption(Phase)(fields.phase)
    );

    const attempts = Option.getOrUndefined(readNumber(fields.attempts));

    if (phase !== undefined) {
      safe.phase = phase;
    }

    if (
      attempts !== undefined &&
      Number.isSafeInteger(attempts) &&
      attempts >= 0
    ) {
      safe.attempts = attempts;
    }

    const failure = Option.getOrUndefined(
      Schema.decodeUnknownOption(FailureFields)(fields.providerFailure)
    );

    if (!failure) {
      return safe;
    }

    const kind = Option.getOrUndefined(
      Schema.decodeUnknownOption(FailureKind)(failure.kind)
    );

    if (!kind) {
      return safe;
    }

    const reason = Option.getOrUndefined(
      Schema.decodeUnknownOption(FailureReason)(failure.reason)
    );

    const status = Option.getOrUndefined(readNumber(failure.status));
    const retryAt = Option.getOrUndefined(readNumber(failure.retryAt));
    safe.providerFailure = { kind };

    if (reason !== undefined) {
      safe.providerFailure.reason = reason;
    }

    if (
      status !== undefined &&
      Number.isInteger(status) &&
      status >= 100 &&
      status <= 599
    ) {
      safe.providerFailure.status = status;
    }

    if (
      retryAt !== undefined &&
      Number.isSafeInteger(retryAt) &&
      retryAt >= 0
    ) {
      safe.providerFailure.retryAt = retryAt;
    }

    return safe;
  }
);

/** Recover a stable repository identity from a run-scoped record key.
 * @param key - Persisted status record key.
 * @param prefix - Current run repository prefix.
 * @returns Positive safe repository ID, or null for a malformed key.
 */
export const repositoryIdFromRecordKey = (
  key: string,
  prefix: string
): number | null => {
  if (!key.startsWith(prefix)) {
    return null;
  }

  const suffix = key.slice(prefix.length);

  if (!/^\d+$/u.test(suffix)) {
    return null;
  }

  const id = Number(suffix);

  return Number.isSafeInteger(id) && id > 0 ? id : null;
};
