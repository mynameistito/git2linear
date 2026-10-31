/* oxlint-disable anti-slop/no-runtime-typeof -- Diagnostic parser validates persisted boundary scalars. */
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

/** Durable continuation; a watchdog alarm is armed before external effects begin. */
export class RunCoordinator {
  readonly #store: RunStore;
  readonly #runner: StepRunner;
  readonly #now: () => number;
  #busy = false;

  /** Platform lifecycle contract. */
  constructor(store: RunStore, runner: StepRunner, now = Date.now) {
    this.#store = store;
    this.#runner = runner;
    this.#now = now;
  }

  /** Start or reuse a run.
   * @param dryRun - Whether mutations are forbidden.
   * @returns Persisted run.
   */
  async start(dryRun: boolean): Promise<RunRecord> {
    const now = this.#now();
    const requestedId = crypto.randomUUID();

    const record = await this.#store.start({
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
      (record.runId === requestedId || (await this.#store.getAlarm()) === null)
    ) {
      await this.#store.schedule(Math.max(now + 1000, record.retryAt ?? 0));
    }

    return record;
  }

  /** Platform lifecycle contract. */
  async advance(): Promise<void> {
    if (this.#busy) {
      return;
    }

    this.#busy = true;

    try {
      const record = await this.#store.get();

      if (!record || record.status !== "running") {
        return;
      }

      await this.#store.schedule(this.#now() + 120_000);

      try {
        const next = await this.#runner.step(record);
        await this.#store.put({
          ...record,
          checkpoint: next.checkpoint,
          failures: 0,
          retryAt: next.retryAt ?? 0,
          status: next.done ? "complete" : "running",
          summary: next.summary,
          updatedAt: this.#now(),
        });

        if (!next.done) {
          await this.#store.schedule(
            Math.max(this.#now() + 1000, next.retryAt ?? 0)
          );
        }
      } catch {
        // Never persist vendor exception text: it can contain tokens or payload URLs.
        const failures = record.failures + 1;
        await this.#store.put({
          ...record,
          failures,
          retryAt: this.#now() + Math.min(60_000, 1000 * 2 ** failures),
          status: failures >= 5 ? "failed" : "running",
          updatedAt: this.#now(),
        });

        if (failures < 5) {
          await this.#store.schedule(
            this.#now() + Math.min(60_000, 1000 * 2 ** failures)
          );
        }
      }
    } finally {
      this.#busy = false;
    }
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

/* oxlint-disable eslint/complexity, sonarjs/expression-complexity, anti-slop/no-unknown-parameters -- Boundary parser deliberately verifies each diagnostic scalar and discards everything else. */
/** Parse only operational diagnostics from a private checkpoint.
 * @param checkpoint - Persisted internal checkpoint, never echoed.
 * @returns Validated safe scalar diagnostic fields.
 */
export const checkpointDiagnostics = (
  checkpoint: unknown
): CheckpointDiagnostics => {
  const safe: CheckpointDiagnostics = {};

  if (typeof checkpoint !== "object" || checkpoint === null) {
    return safe;
  }

  if (
    "phase" in checkpoint &&
    (checkpoint.phase === "repositories" ||
      checkpoint.phase === "projects" ||
      checkpoint.phase === "reconcile")
  ) {
    safe.phase = checkpoint.phase;
  }

  if (
    "attempts" in checkpoint &&
    typeof checkpoint.attempts === "number" &&
    Number.isSafeInteger(checkpoint.attempts) &&
    checkpoint.attempts >= 0
  ) {
    safe.attempts = checkpoint.attempts;
  }

  if (
    !("providerFailure" in checkpoint) ||
    typeof checkpoint.providerFailure !== "object" ||
    checkpoint.providerFailure === null
  ) {
    return safe;
  }

  const failure = checkpoint.providerFailure;

  if (
    !("kind" in failure) ||
    (failure.kind !== "http" &&
      failure.kind !== "network" &&
      failure.kind !== "invalid-response")
  ) {
    return safe;
  }

  safe.providerFailure = { kind: failure.kind };

  if (
    "reason" in failure &&
    (failure.reason === "illegal-invocation" ||
      failure.reason === "timeout" ||
      failure.reason === "invalid-header" ||
      failure.reason === "other")
  ) {
    safe.providerFailure.reason = failure.reason;
  }

  if (
    "status" in failure &&
    typeof failure.status === "number" &&
    Number.isInteger(failure.status) &&
    failure.status >= 100 &&
    failure.status <= 599
  ) {
    safe.providerFailure.status = failure.status;
  }

  if (
    "retryAt" in failure &&
    typeof failure.retryAt === "number" &&
    Number.isSafeInteger(failure.retryAt) &&
    failure.retryAt >= 0
  ) {
    safe.providerFailure.retryAt = failure.retryAt;
  }

  return safe;
};

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
