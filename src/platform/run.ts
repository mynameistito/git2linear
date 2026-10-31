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

    const record = await this.#store.start({
      checkpoint: null,
      dryRun,
      failures: 0,
      runId: crypto.randomUUID(),
      startedAt: now,
      status: "running",
      summary: emptySummary(),
      updatedAt: now,
    });

    if (record.status === "running") {
      await this.#store.schedule(now + 1000);
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
