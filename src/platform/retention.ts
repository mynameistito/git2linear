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

/** Prune at most 100 internal report records while retaining current and previous runs.
 * @param store - Operations in one durable storage transaction.
 * @param currentRunId - Current run protected from cleanup.
 * @param previousRunId - Previous run protected from cleanup.
 * @returns Whether another bounded maintenance batch remains.
 */
export const pruneReportBatch = async (
  store: ReportRetentionStore,
  currentRunId: string,
  previousRunId: string | undefined
): Promise<boolean> => {
  const cursor = await store.cursor();
  const keys = await store.keys(cursor, 100);
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
    await store.remove(expired);
  }

  const more = keys.length === 100;
  await store.saveCursor(more ? (keys.at(-1) ?? null) : null);

  return more;
};
