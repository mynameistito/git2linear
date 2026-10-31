/* oxlint-disable sonarjs/no-duplicate-string, sonarjs/max-union-size -- Operational status variants remain explicit for exhaustive consumers. */
import type { Identity, Project, Repository } from "../domain/reconciliation";
import { planHook, planProject } from "../domain/reconciliation";
import type { Env } from "../platform/env";
import { emptySummary } from "../platform/run";
import type {
  RunSummary,
  StepInput,
  StepOutput,
  StepRunner,
} from "../platform/run";
import { GitHubClient } from "../providers/github";
import type { ProviderFailure } from "../providers/http";
import { LinearProjects } from "../providers/linear";

/** Storage survives runs; identity and intent writes precede provider mutation. */
export interface ReconciliationStore {
  readonly identities: () => Promise<readonly Identity[]>;
  readonly saveIdentity: (identity: Identity) => Promise<void>;
  readonly intent: (
    repositoryId: number,
    kind: "project" | "link"
  ) => Promise<string>;
  readonly record: (
    repositoryId: number,
    result: RepositoryStatus
  ) => Promise<void>;
}

/** Safe repository status never includes native endpoint or provider payloads. */
export interface RepositoryStatus {
  readonly outcome:
    | "already-configured"
    | "created"
    | "repaired"
    | "skipped"
    | "failed";
  readonly runId?: string;
  readonly dryRun?: boolean;
  readonly plannedActions?: readonly string[];
  readonly supportedStateVerified?: boolean;
  readonly manualActionRequired: true;
  readonly reason: string;
  readonly hookId?: number;
  readonly ping: "not-requested" | "accepted" | "failed";
  readonly pingDelivery?: "verified" | "failed" | "pending";
  readonly pushProcessing: "unverified";
}

interface Checkpoint {
  phase: "repositories" | "projects" | "reconcile";
  page: number;
  cursor: string | null;
  repositories: Repository[];
  projects: Project[];
  index: number;
  attempts: number;
  change: "none" | "created" | "repaired";
  summary: RunSummary;
}

/** Dependencies contain secrets only within provider adapters. */
export interface RunnerOptions {
  readonly github: Pick<
    GitHubClient,
    | "listRepositoryPage"
    | "listHooks"
    | "createHook"
    | "repairHook"
    | "pingHook"
    | "deliveries"
  >;
  readonly linear: Pick<
    LinearProjects,
    "page" | "create" | "rename" | "attach" | "verifyTeam"
  >;
  readonly store: ReconciliationStore;
  readonly owner: string;
  readonly teamId: string;
  readonly endpoint: string;
}

/** Each step handles one inventory page or one repository, with bounded durable retry. */
export class ReconciliationRunner implements StepRunner {
  readonly #options: RunnerOptions;
  #runId = "";
  #dryRun = true;
  /** Construct a runner from application-owned ports.
   * @param options - Provider and durable persistence dependencies.
   */
  constructor(options: RunnerOptions) {
    this.#options = options;
  }

  /** Advance a durable reconciliation by one bounded unit.
   * @param input - Durable internal checkpoint and dry-run mode.
   * @returns The next checkpoint and verified status counters.
   */
  async step(input: StepInput): Promise<StepOutput> {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: This private checkpoint is produced exclusively by this runner and stored by the trusted coordinator; callers cannot submit checkpoints over HTTP.
    const checkpoint = input.checkpoint as Checkpoint | null;
    this.#runId = input.runId;
    this.#dryRun = input.dryRun;

    const state: Checkpoint = checkpoint ?? {
      attempts: 0,
      change: "none",
      cursor: null,
      index: 0,
      page: 1,
      phase: "repositories",
      projects: [],
      repositories: [],
      summary: emptySummary(),
    };

    if (state.phase === "repositories") {
      const result = await this.#options.github.listRepositoryPage(state.page);

      if (!result.ok) {
        return await this.#retry(state, result.error);
      }

      const seen = new Set(state.repositories.map((repo) => repo.id));
      state.repositories.push(
        ...result.value.repositories.filter((repo) => !seen.has(repo.id))
      );
      state.summary.discovered = state.repositories.length;
      state.page += 1;
      state.attempts = 0;
      state.change = "none";

      if (!result.value.hasNextPage) {
        state.phase = "projects";
      }

      return ReconciliationRunner.#output(state);
    }

    if (state.phase === "projects") {
      const result = await this.#options.linear.page(state.cursor);

      if (!result.ok) {
        return await this.#retry(state, result.error);
      }

      state.projects.push(...result.value.projects);
      state.cursor = result.value.nextCursor;

      if (state.cursor === null) {
        state.phase = "reconcile";
      }

      return ReconciliationRunner.#output(state);
    }

    const repository = state.repositories[state.index];

    if (!repository) {
      return ReconciliationRunner.#output(state, true);
    }

    return await this.#repository(state, repository, input.dryRun);
  }

  static #output(state: Checkpoint, done = false): StepOutput {
    return { checkpoint: state, done, summary: state.summary };
  }

  async #record(repositoryId: number, result: RepositoryStatus): Promise<void> {
    await this.#options.store.record(repositoryId, {
      ...result,
      dryRun: this.#dryRun,
      runId: this.#runId,
    });
  }

  async #retry(
    state: Checkpoint,
    failure: ProviderFailure
  ): Promise<StepOutput> {
    state.attempts += 1;

    if (state.attempts >= 4 || failure.retryAt === undefined) {
      if (state.phase !== "reconcile") {
        throw new Error("inventory-unavailable");
      }

      state.summary.failed += 1;
      const repository = state.repositories[state.index];

      if (repository) {
        await this.#record(repository.id, {
          manualActionRequired: true,
          outcome: "failed",
          ping: "not-requested",
          pushProcessing: "unverified",
          reason: "provider-failure-or-retry-exhausted",
        });
      }

      state.summary.manualActionRequired += 1;
      state.index += 1;
      state.attempts = 0;
      state.change = "none";

      return ReconciliationRunner.#output(state);
    }

    return { ...ReconciliationRunner.#output(state), retryAt: failure.retryAt };
  }

  /* oxlint-disable eslint/complexity, sonarjs/cognitive-complexity -- Durable effect ordering is kept cohesive so each mutation is followed by verification before another mutation. */
  async #repository(
    state: Checkpoint,
    repository: Repository,
    dryRun: boolean
  ): Promise<StepOutput> {
    const { github, linear, store } = this.#options;

    if (state.attempts >= 4) {
      await this.#record(repository.id, {
        manualActionRequired: true,
        outcome: "failed",
        ping: "not-requested",
        pushProcessing: "unverified",
        reason: "verification-or-retry-exhausted",
      });
      state.summary.failed += 1;
      state.summary.manualActionRequired += 1;
      state.index += 1;
      state.attempts = 0;
      state.change = "none";
      state.attempts = 0;
      state.change = "none";

      return ReconciliationRunner.#output(state);
    }

    const plan = planProject({
      identities: await store.identities(),
      owner: this.#options.owner,
      projects: state.projects,
      repository,
      teamId: this.#options.teamId,
    });

    if (plan.kind === "skip" || plan.kind === "manual") {
      await this.#record(repository.id, {
        manualActionRequired: true,
        outcome: "skipped",
        ping: "not-requested",
        pushProcessing: "unverified",
        reason: plan.reason,
      });

      if (plan.kind === "skip") {
        state.summary.skipped += 1;
      } else {
        state.summary.manualActionRequired += 1;
      }

      state.index += 1;

      return ReconciliationRunner.#output(state);
    }

    const hooks = await github.listHooks(repository);

    if (!hooks.ok) {
      return await this.#retry(state, hooks.error);
    }

    const hookPlan = planHook(hooks.value, this.#options.endpoint);

    if (dryRun) {
      const plannedActions = [
        `project:${plan.kind}`,
        `hook:${hookPlan.kind}`,
        "native-sync:manual",
      ];

      await this.#record(repository.id, {
        manualActionRequired: true,
        outcome: "skipped",
        ping: "not-requested",
        plannedActions,
        pushProcessing: "unverified",
        reason: "dry-run-plan",
      });

      if (plan.kind === "create" || hookPlan.kind === "create") {
        state.summary.created += 1;
      } else if (
        plan.updateName !== null ||
        plan.attachUrl !== null ||
        hookPlan.kind === "repair"
      ) {
        state.summary.repaired += 1;
      } else {
        state.summary.alreadyConfigured += 1;
      }

      state.summary.manualActionRequired += 1;
      state.index += 1;
      state.attempts = 0;
      state.change = "none";

      return ReconciliationRunner.#output(state);
    }

    const team = await linear.verifyTeam(this.#options.teamId, "MY");

    if (!team.ok) {
      return await this.#retry(state, team.error);
    }

    if (!team.value) {
      return await this.#retry(state, { kind: "invalid-response" });
    }

    const projectId =
      plan.kind === "create"
        ? await store.intent(repository.id, "project")
        : plan.projectId;

    let changed = false;

    if (plan.kind === "create") {
      state.attempts += 1;

      const created = await linear.create({
        id: projectId,
        name: repository.name,
        repositoryUrl: repository.url,
        teamId: this.#options.teamId,
      });

      state.change = "created";

      if (!created.ok) {
        return ReconciliationRunner.#refresh(state, created.error);
      }

      changed = true;
    } else if (plan.updateName !== null) {
      state.attempts += 1;
      const renamed = await linear.rename(projectId, plan.updateName);

      if (state.change === "none") {
        state.change = "repaired";
      }

      if (!renamed.ok) {
        return ReconciliationRunner.#refresh(state, renamed.error);
      }

      changed = true;
    }

    // Re-read all project pages before counting any project mutation as successful.
    if (changed) {
      state.phase = "projects";
      state.projects = [];
      state.cursor = null;

      return ReconciliationRunner.#output(state);
    }

    if (plan.kind === "reuse" && plan.attachUrl !== null) {
      state.attempts += 1;

      const attached = await linear.attach({
        id: await store.intent(repository.id, "link"),
        projectId,
        url: repository.url,
      });

      if (state.change === "none") {
        state.change = "repaired";
      }

      if (!attached.ok) {
        return ReconciliationRunner.#refresh(state, attached.error);
      }

      state.phase = "projects";
      state.projects = [];
      state.cursor = null;

      return ReconciliationRunner.#output(state);
    }

    await store.saveIdentity({
      projectId,
      repositoryId: repository.id,
      repositoryUrl: repository.url,
    });

    if (hookPlan.kind === "manual") {
      await this.#record(repository.id, {
        manualActionRequired: true,
        outcome: "skipped",
        ping: "not-requested",
        pushProcessing: "unverified",
        reason: hookPlan.reason,
      });
      state.summary.manualActionRequired += 1;
      state.index += 1;
      state.attempts = 0;
      state.change = "none";

      return ReconciliationRunner.#output(state);
    }

    if (hookPlan.kind !== "reuse") {
      state.attempts += 1;

      const mutation =
        hookPlan.kind === "create"
          ? await github.createHook(repository)
          : await github.repairHook(repository, hookPlan.hookId);

      if (state.change === "none") {
        state.change = hookPlan.kind === "create" ? "created" : "repaired";
      }

      if (!mutation.ok) {
        return await this.#retry(state, mutation.error);
      }

      // Next durable step rediscovers hooks, including recovery after interrupted creation.
      return ReconciliationRunner.#output(state);
    }

    const baseline = await github.deliveries(repository, hookPlan.hookId);

    const previousIds = new Set(
      baseline.ok ? baseline.value.map((entry) => entry.id) : []
    );

    const ping = await github.pingHook(repository, hookPlan.hookId);
    const deliveries = await github.deliveries(repository, hookPlan.hookId);

    const delivery = deliveries.ok
      ? deliveries.value.find(
          (entry) =>
            baseline.ok &&
            ping.ok &&
            entry.event === "ping" &&
            !previousIds.has(entry.id)
        )
      : undefined;

    let pingDelivery: "verified" | "failed" | "pending" = "pending";

    if (delivery?.statusCode !== null && delivery?.statusCode !== undefined) {
      pingDelivery =
        delivery.statusCode >= 200 && delivery.statusCode < 300
          ? "verified"
          : "failed";
    }

    const outcome =
      state.change === "none" ? "already-configured" : state.change;

    await this.#record(repository.id, {
      hookId: hookPlan.hookId,
      manualActionRequired: true,
      outcome,
      ping: ping.ok ? "accepted" : "failed",
      pingDelivery,
      pushProcessing: "unverified",
      reason:
        "native-sync-configuration-and-project-routing-require-supported-api",
      supportedStateVerified: true,
    });

    if (state.change === "none") {
      state.summary.alreadyConfigured += 1;
    } else {
      state.summary[state.change] += 1;
    }

    state.summary.manualActionRequired += 1;
    state.index += 1;
    state.attempts = 0;
    state.change = "none";

    return ReconciliationRunner.#output(state);
  }

  static #refresh(state: Checkpoint, failure: ProviderFailure): StepOutput {
    // Even a rejected duplicate-id mutation can follow an earlier committed timeout.
    // Rediscovery decides recovery; never create under a fresh id on retry.
    state.phase = "projects";
    state.projects = [];
    state.cursor = null;
    const result = ReconciliationRunner.#output(state);

    return failure.retryAt === undefined
      ? result
      : { ...result, retryAt: failure.retryAt };
  }
}

/** Wire deployment credentials and durable metadata without exposing secret values.
 * @param env - Worker bindings.
 * @param storage - Durable Object storage.
 * @returns Bounded reconciliation runner.
 */
export const createRunner = (
  env: Env,
  storage: DurableObjectStorage
): StepRunner => {
  const store: ReconciliationStore = {
    identities: async () => {
      const identities = await storage.list<Identity>({ prefix: "identity:" });

      return [...identities.values()];
    },
    intent: async (repositoryId, kind) => {
      const key = `intent:${repositoryId}:${kind}`;
      const existing = await storage.get<string>(key);

      if (existing !== undefined) {
        return existing;
      }

      const id = crypto.randomUUID();
      await storage.put(key, id);

      return id;
    },
    record: async (repositoryId, result) => {
      await storage.put(`repository:${result.runId}:${repositoryId}`, result);
    },
    saveIdentity: async (identity) => {
      await storage.put(`identity:${identity.repositoryId}`, identity);
    },
  };

  return new ReconciliationRunner({
    endpoint: env.LINEAR_WEBHOOK_URL,
    github: new GitHubClient({
      endpoint: env.LINEAR_WEBHOOK_URL,
      owner: env.GITHUB_OWNER,
      token: env.GITHUB_TOKEN,
      webhookSecret: env.LINEAR_WEBHOOK_SECRET,
    }),
    linear: new LinearProjects(env.LINEAR_API_KEY),
    owner: env.GITHUB_OWNER,
    store,
    teamId: env.LINEAR_TEAM_ID,
  });
};
