import { Effect } from "effect";

import { PersistenceError } from "../application/persistence-error";

/** Atomic metadata operations needed for bounded report retention. */
export interface ReportRetentionStore {
  readonly cursor: () => Promise<string | undefined>;
  readonly keys: (
    after: string | undefined,
    limit: number
  ) => Promise<readonly string[]>;
  readonly remove: (keys: string[]) => Promise<void>;
  readonly saveCursor: (cursor: string | null) => Promise<void>;
}

const call = <T>(operation: string, run: () => Promise<T>) =>
  Effect.tryPromise({
    catch: () => new PersistenceError({ operation }),
    try: run,
  });

/** Prune at most 100 internal report records while retaining current and previous runs.
 * @param store - Operations in one durable storage transaction.
 * @param currentRunId - Current run protected from cleanup.
 * @param previousRunId - Previous run protected from cleanup.
 * @returns Whether another bounded maintenance batch remains.
 */
export const pruneEffect = (
  store: ReportRetentionStore,
  currentRunId: string,
  previousRunId: string | undefined
): Effect.Effect<boolean, PersistenceError> =>
  Effect.gen(function* pruneBatch() {
    const cursor = yield* call("retention-cursor", store.cursor);

    const keys = yield* call(
      "retention-keys",
      async () => await store.keys(cursor, 100)
    );

    const currentPrefix = `repository:${currentRunId}:`;

    const previousPrefix =
      previousRunId === undefined ? null : `repository:${previousRunId}:`;

    const expired = keys.filter(
      (key) =>
        key.startsWith("repository:") &&
        !key.startsWith(currentPrefix) &&
        (previousPrefix === null || !key.startsWith(previousPrefix))
    );

    if (expired.length > 0) {
      yield* call("retention-remove", async () => {
        await store.remove(expired);
      });
    }

    const more = keys.length === 100;
    yield* call("retention-save-cursor", async () => {
      await store.saveCursor(more ? (keys.at(-1) ?? null) : null);
    });

    return more;
  });

/** Run one bounded retention batch.
 * @param store - Operations in one durable storage transaction.
 * @param currentRunId - Current run protected from cleanup.
 * @param previousRunId - Previous run protected from cleanup.
 * @returns Whether another batch remains.
 */
export const pruneReportBatch = async (
  store: ReportRetentionStore,
  currentRunId: string,
  previousRunId: string | undefined
): Promise<boolean> =>
  await Effect.runPromise(pruneEffect(store, currentRunId, previousRunId));
