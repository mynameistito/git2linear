import { Context, Effect, Layer, Schema } from "effect";

import type {
  HookPlan,
  Identity,
  Project,
  ProjectPlan,
  Repository,
} from "../domain/reconciliation";
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
import type { PersistenceError } from "./persistence-error";
import {
  adaptLegacy,
  CheckpointSchema,
  nativeOptions,
  nativePersistenceService,
  ReconciliationError,
} from "./runner-adapters";
import type { NativeOptions } from "./runner-adapters";

export {
  nativePersistenceService,
  PersistenceService,
  persistenceLayer,
} from "./runner-adapters";

export { PersistenceError } from "./persistence-error";

export { ReconciliationError } from "./reconciliation-error";

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

type SuccessfulOutcome = "already-configured" | "created" | "repaired";

type OtherOutcome = "skipped" | "failed";

const notRequested = "not-requested";

/** Safe repository status never includes native endpoint or provider payloads. */
export interface RepositoryStatus {
  readonly outcome: SuccessfulOutcome | OtherOutcome;
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
  providerFailure?: ProviderFailure;
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
  readonly endpoint?: string;
}

type ActionPlan = Extract<ProjectPlan, { kind: "create" | "reuse" }>;

type ActionHook =
  | HookPlan
  | {
      readonly kind: "manual";
      readonly reason: "commit-webhook-credentials-unavailable";
    };

/** Each step handles one inventory page or one repository, with bounded durable retry. */
export class ReconciliationRunner implements StepRunner {
  readonly #options: NativeOptions;
  #runId = "";
  #dryRun = true;
  /** Construct a runner from application-owned ports.
   * @param options - Provider and durable persistence dependencies.
   */
  constructor(options: RunnerOptions | { native: NativeOptions }) {
    this.#options = "native" in options ? options.native : adaptLegacy(options);
  }

  /** Construct a runner from native ports.
   * @param options - Native dependencies.
   * @returns A runner.
   */
  static fromNative(options: NativeOptions): ReconciliationRunner {
    return new ReconciliationRunner({ native: options });
  }

  /** Advance a durable reconciliation by one bounded unit.
   * @param input - Durable internal checkpoint and dry-run mode.
   * @returns The next checkpoint and verified status counters.
   */
  async step(input: StepInput): Promise<StepOutput> {
    return await Effect.runPromise(this.stepEffect(input));
  }

  stepEffect = (input: StepInput) =>
    new ReconciliationRunner({ native: this.#options }).#execute(input);

  readonly #execute = Effect.fn("Reconciliation.step")(
    function* stepEffect(this: ReconciliationRunner, input: StepInput) {
      const checkpoint =
        input.checkpoint === null
          ? null
          : yield* Schema.decodeUnknownEffect(CheckpointSchema)(
              input.checkpoint
            ).pipe(
              Effect.mapError(
                () =>
                  new ReconciliationError({ operation: "decode-checkpoint" })
              )
            );

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
        const result = yield* this.#options.github.listRepositoryPage(
          state.page
        );

        if (!result.ok) {
          return yield* this.#retry(state, result.error);
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
        const result = yield* this.#options.linear.page(state.cursor);

        if (!result.ok) {
          return yield* this.#retry(state, result.error);
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

      return yield* this.#repository(state, repository, input.dryRun);
    }.bind(this)
  );

  static #output(state: Checkpoint, done = false): StepOutput {
    return { checkpoint: state, done, summary: state.summary };
  }

  readonly #record = Effect.fn("Reconciliation.record")(
    function* record(
      this: ReconciliationRunner,
      repositoryId: number,
      result: RepositoryStatus
    ) {
      yield* this.#options.store.record(repositoryId, {
        ...result,
        dryRun: this.#dryRun,
        runId: this.#runId,
      });
    }.bind(this)
  );

  readonly #retry = Effect.fn("Reconciliation.retry")(
    function* retry(
      this: ReconciliationRunner,
      state: Checkpoint,
      failure: ProviderFailure
    ) {
      // Explicit projection: never persist a vendor exception, response, or request.
      state.providerFailure = { kind: failure.kind };

      if (failure.reason !== undefined) {
        state.providerFailure = {
          ...state.providerFailure,
          reason: failure.reason,
        };
      }

      if (failure.status !== undefined) {
        state.providerFailure = {
          ...state.providerFailure,
          status: failure.status,
        };
      }

      if (failure.retryAt !== undefined) {
        state.providerFailure = {
          ...state.providerFailure,
          retryAt: failure.retryAt,
        };
      }

      state.attempts += 1;

      if (state.attempts >= 4 || failure.retryAt === undefined) {
        if (state.phase !== "reconcile") {
          return yield* Effect.fail(
            new ReconciliationError({ operation: "inventory-unavailable" })
          );
        }

        state.summary.failed += 1;
        const repository = state.repositories[state.index];

        if (repository) {
          yield* this.#record(repository.id, {
            manualActionRequired: true,
            outcome: "failed",
            ping: notRequested,
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

      return {
        ...ReconciliationRunner.#output(state),
        retryAt: failure.retryAt,
      };
    }.bind(this)
  );

  readonly #repository = Effect.fn("Reconciliation.repository")(
    function* reconcileRepository(
      this: ReconciliationRunner,
      state: Checkpoint,
      repository: Repository,
      dryRun: boolean
    ) {
      const { github, store } = this.#options;

      if (state.attempts >= 4) {
        yield* this.#record(repository.id, {
          manualActionRequired: true,
          outcome: "failed",
          ping: notRequested,
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
        identities: yield* store.identities(),
        owner: this.#options.owner,
        projects: state.projects,
        repository,
        teamId: this.#options.teamId,
      });

      if (plan.kind === "skip" || plan.kind === "manual") {
        yield* this.#record(repository.id, {
          manualActionRequired: true,
          outcome: "skipped",
          ping: notRequested,
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

      const hooks =
        this.#options.endpoint === undefined
          ? { ok: true as const, value: [] }
          : yield* github.listHooks(repository);

      if (!hooks.ok) {
        return yield* this.#retry(state, hooks.error);
      }

      const hookPlan =
        this.#options.endpoint === undefined
          ? {
              kind: "manual" as const,
              reason: "commit-webhook-credentials-unavailable" as const,
            }
          : planHook(hooks.value, this.#options.endpoint);

      if (dryRun) {
        return yield* this.#dryPlan(state, repository, plan, hookPlan);
      }

      return yield* this.#applyProject(state, repository, plan, hookPlan);
    }.bind(this)
  );

  readonly #dryPlan = Effect.fn("Reconciliation.dryPlan")(
    function* dryPlan(
      this: ReconciliationRunner,
      state: Checkpoint,
      repository: Repository,
      plan: ActionPlan,
      hookPlan: ActionHook
    ) {
      const plannedActions = [
        `project:${plan.kind}`,
        `hook:${hookPlan.kind}`,
        "native-sync:manual",
      ];

      if (plan.kind === "reuse" && plan.updateName !== null) {
        plannedActions.push("project:rename");
      }

      if (plan.kind === "reuse" && plan.attachUrl !== null) {
        plannedActions.push("project:attach-repository-url");
      }

      yield* this.#record(repository.id, {
        manualActionRequired: true,
        outcome: "skipped",
        ping: notRequested,
        plannedActions,
        pushProcessing: "unverified",
        reason: hookPlan.kind === "manual" ? hookPlan.reason : "dry-run-plan",
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
    }.bind(this)
  );

  readonly #applyProject = Effect.fn("Reconciliation.applyProject")(
    function* applyProject(
      this: ReconciliationRunner,
      state: Checkpoint,
      repository: Repository,
      plan: ActionPlan,
      hookPlan: ActionHook
    ) {
      const { linear, store } = this.#options;
      const team = yield* linear.verifyTeam(this.#options.teamId, "MY");

      if (!team.ok) {
        return yield* this.#retry(state, team.error);
      }

      if (!team.value) {
        return yield* this.#retry(state, { kind: "invalid-response" });
      }

      const projectId =
        plan.kind === "create"
          ? yield* store.intent(repository.id, "project")
          : plan.projectId;

      let changed = false;

      if (plan.kind === "create") {
        state.attempts += 1;

        const created = yield* linear.create({
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
        const renamed = yield* linear.rename(projectId, plan.updateName);

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

        const attached = yield* linear.attach({
          id: yield* store.intent(repository.id, "link"),
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

      yield* store.saveIdentity({
        projectId,
        repositoryId: repository.id,
        repositoryUrl: repository.url,
      });

      return yield* this.#applyHook(state, repository, hookPlan);
    }.bind(this)
  );

  readonly #applyHook = Effect.fn("Reconciliation.applyHook")(
    function* applyHook(
      this: ReconciliationRunner,
      state: Checkpoint,
      repository: Repository,
      hookPlan: ActionHook
    ) {
      const { github } = this.#options;

      if (hookPlan.kind === "manual") {
        const projectOutcome =
          state.change === "none" ? "already-configured" : state.change;

        yield* this.#record(repository.id, {
          manualActionRequired: true,
          outcome: projectOutcome,
          ping: notRequested,
          pushProcessing: "unverified",
          reason: hookPlan.reason,
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

      if (hookPlan.kind !== "reuse") {
        state.attempts += 1;

        const mutation =
          hookPlan.kind === "create"
            ? yield* github.createHook(repository)
            : yield* github.repairHook(repository, hookPlan.hookId);

        if (state.change === "none") {
          state.change = hookPlan.kind === "create" ? "created" : "repaired";
        }

        if (!mutation.ok && mutation.error.retryAt !== undefined) {
          return {
            ...ReconciliationRunner.#output(state),
            retryAt: mutation.error.retryAt,
          };
        }

        // Next durable step rediscovers hooks, including recovery after interrupted creation.
        return ReconciliationRunner.#output(state);
      }

      return yield* this.#verifyHook(state, repository, hookPlan.hookId);
    }.bind(this)
  );

  readonly #verifyHook = Effect.fn("Reconciliation.verifyHook")(
    function* verifyHook(
      this: ReconciliationRunner,
      state: Checkpoint,
      repository: Repository,
      hookId: number
    ) {
      const { github } = this.#options;
      const baseline = yield* github.deliveries(repository, hookId);

      const previousIds = new Set(
        baseline.ok ? baseline.value.map((entry) => entry.id) : []
      );

      const ping = yield* github.pingHook(repository, hookId);
      const deliveries = yield* github.deliveries(repository, hookId);

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

      yield* this.#record(repository.id, {
        hookId,
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
    }.bind(this)
  );

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

/** Construct the production runner using native provider and durable storage effects.
 * @param env - Worker bindings.
 * @param storage - Durable storage.
 * @returns The native runner.
 */
export const createRunner = (
  env: Env,
  storage: DurableObjectStorage
): ReconciliationRunner => {
  const github = new GitHubClient({
    endpoint: env.LINEAR_WEBHOOK_URL,
    owner: env.GITHUB_OWNER,
    token: env.GITHUB_TOKEN,
    webhookSecret: env.LINEAR_WEBHOOK_SECRET,
  });

  const linear = new LinearProjects(env.LINEAR_API_KEY);

  return ReconciliationRunner.fromNative(
    nativeOptions(
      github.effects,
      linear.effects,
      nativePersistenceService(storage),
      env.GITHUB_OWNER,
      env.LINEAR_TEAM_ID,
      env.LINEAR_WEBHOOK_URL
    )
  );
};

/** Native reconciliation contract. */
export interface ReconciliationOperations {
  readonly stepEffect: (
    input: StepInput
  ) => Effect.Effect<StepOutput, ReconciliationError | PersistenceError>;
}

export const ReconciliationService = Context.Service<ReconciliationOperations>(
  "git2linear/Reconciliation"
);

/** Provide the reconciliation contract.
 * @param runner - Native runner.
 * @returns Its service layer.
 */
export const reconciliationLayer = (runner: ReconciliationRunner) =>
  Layer.effect(
    ReconciliationService,
    Effect.succeed(ReconciliationService.of({ stepEffect: runner.stepEffect }))
  );
