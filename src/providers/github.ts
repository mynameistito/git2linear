import { Context, Effect, Layer, Schema } from "effect";

import type { Repository, RepositoryHook } from "../domain/reconciliation";
import {
  DeliveryPage,
  HookPage,
  HookResponse,
  RepositoryPage,
} from "./github-schema";
import {
  ProviderError,
  ProviderFailureSchema,
  readJsonEffect,
  requestEffect,
} from "./http";
import type { HttpOptions, ProviderResult } from "./http";

/** Credentials stay inside this adapter and must never enter status output. */
export interface GitHubOptions extends HttpOptions {
  readonly token: string;
  readonly owner: string;
  readonly endpoint?: string;
  readonly webhookSecret?: string;
}

interface Delivery {
  id: number;
  event: string;
  statusCode: number | null;
}

interface Page {
  repositories: Repository[];
  hasNextPage: boolean;
}

interface Port {
  readonly listRepositoryPage: (
    page: number
  ) => Effect.Effect<Page, ProviderError>;
  readonly listRepositories: () => Effect.Effect<Repository[], ProviderError>;
  readonly listHooks: (
    repository: Repository
  ) => Effect.Effect<RepositoryHook[], ProviderError>;
  readonly createHook: (
    repository: Repository
  ) => Effect.Effect<RepositoryHook, ProviderError>;
  readonly repairHook: (
    repository: Repository,
    hookId: number
  ) => Effect.Effect<RepositoryHook, ProviderError>;
  readonly pingHook: (
    repository: Repository,
    hookId: number
  ) => Effect.Effect<null, ProviderError>;
  readonly deliveries: (
    repository: Repository,
    hookId: number
  ) => Effect.Effect<Delivery[], ProviderError>;
}

/** Injectable native GitHub provider port. */
export const GitHubService = Context.Service<Port>("git2linear/GitHub");

const invalid = () => new ProviderError({ kind: "invalid-response" });

const repositoryPath = (repository: Repository) =>
  `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/hooks`;

const reposPath =
  "/user/repos?affiliation=owner&visibility=all&sort=full_name&direction=asc";

const pagePath = (path: string, page: number) =>
  `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`;

const collect = <T>(
  getPage: (page: number) => Effect.Effect<readonly T[], ProviderError>,
  maxPages: number
) =>
  Effect.gen(function* collectPages() {
    const items: T[] = [];

    for (let page = 1; page <= maxPages; page += 1) {
      const values = yield* getPage(page);

      if (values.length === 0) {
        return items;
      }

      items.push(...values);
    }

    return yield* Effect.fail(invalid());
  });

const makeGitHub = (options: GitHubOptions): Port => {
  const call = Effect.fn("GitHub.request")(function* call(
    path: string,
    method?: string,
    body?: string
  ) {
    return yield* requestEffect(
      `https://api.github.com${path}`,
      {
        body,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${options.token}`,
          "Content-Type": "application/json",
          "User-Agent": "git2linear-reconciler",
          "X-GitHub-Api-Version": "2026-03-10",
        },
        method: method ?? "GET",
      },
      options
    );
  });

  const repositoryPage = Effect.fn("GitHub.listRepositoryPage")(
    function* repositoryPage(page: number) {
      const response = yield* call(pagePath(reposPath, page));
      const json = yield* readJsonEffect(response);

      const entries = yield* Schema.decodeUnknownEffect(RepositoryPage)(
        json
      ).pipe(Effect.mapError(invalid));

      const repositories = entries
        .filter(
          (entry) =>
            entry.owner.login.toLowerCase() === options.owner.toLowerCase()
        )
        .map((entry) => ({
          archived: entry.archived,
          disabled: entry.disabled,
          id: entry.id,
          name: entry.name,
          owner: entry.owner.login,
          url: entry.html_url,
        }));

      return { hasNextPage: entries.length > 0, repositories };
    }
  );

  const listRepositories = Effect.fn("GitHub.listRepositories")(
    function* listRepositories() {
      // Continue based on raw page size, even if owner filtering removes every entry.
      const repositories: Repository[] = [];

      for (let page = 1; page <= 10_000; page += 1) {
        const result = yield* repositoryPage(page);
        repositories.push(...result.repositories);

        if (!result.hasNextPage) {
          return repositories;
        }
      }

      return yield* Effect.fail(invalid());
    }
  );

  const hookPage = Effect.fn("GitHub.hookPage")(function* hookPage(
    repository: Repository,
    page: number
  ) {
    const response = yield* call(pagePath(repositoryPath(repository), page));
    const json = yield* readJsonEffect(response);

    const hooks = yield* Schema.decodeUnknownEffect(HookPage)(json).pipe(
      Effect.mapError(invalid)
    );

    return hooks.map((hook) => ({
      active: hook.active,
      contentType: hook.config.content_type ?? "",
      endpoint: hook.config.url ?? "",
      events: hook.events,
      id: hook.id,
      insecureSsl: String(hook.config.insecure_ssl ?? ""),
    }));
  });

  const listHooks = Effect.fn("GitHub.listHooks")((repository: Repository) =>
    collect((page) => hookPage(repository, page), 5)
  );

  const writeHook = Effect.fn("GitHub.writeHook")(function* writeHook(
    repository: Repository,
    id: number | null
  ) {
    const { endpoint, webhookSecret } = options;

    if (endpoint === undefined || webhookSecret === undefined) {
      return yield* Effect.fail(invalid());
    }

    const parsed = yield* Effect.try({
      catch: invalid,
      try: () => new URL(endpoint),
    });

    if (
      parsed.protocol !== "https:" ||
      !(
        parsed.hostname === "linear.app" ||
        parsed.hostname.endsWith(".linear.app")
      ) ||
      parsed.username + parsed.password !== ""
    ) {
      return yield* Effect.fail(invalid());
    }

    const config = { content_type: "json", insecure_ssl: "0", url: endpoint };

    const response = yield* call(
      repositoryPath(repository) + (id === null ? "" : `/${id}`),
      id === null ? "POST" : "PATCH",
      JSON.stringify({
        active: true,
        config: id === null ? { ...config, secret: webhookSecret } : config,
        events: ["push"],
        name: "web",
      })
    );

    const json = yield* readJsonEffect(response);

    const hook = yield* Schema.decodeUnknownEffect(HookResponse)(json).pipe(
      Effect.mapError(invalid)
    );

    return {
      active: hook.active,
      contentType: hook.config.content_type ?? "",
      endpoint: hook.config.url ?? "",
      events: hook.events,
      id: hook.id,
      insecureSsl: String(hook.config.insecure_ssl ?? ""),
    };
  });

  const createHook = Effect.fn("GitHub.createHook")((repository: Repository) =>
    writeHook(repository, null)
  );

  const repairHook = Effect.fn("GitHub.repairHook")(function* repairHook(
    repository: Repository,
    hookId: number
  ) {
    if (options.endpoint === undefined || options.webhookSecret === undefined) {
      return yield* Effect.fail(invalid());
    }

    const hooks = yield* listHooks(repository);

    if (
      !hooks.some(
        (hook) => hook.id === hookId && hook.endpoint === options.endpoint
      )
    ) {
      return yield* Effect.fail(invalid());
    }

    return yield* writeHook(repository, hookId);
  });

  const pingHook = Effect.fn("GitHub.pingHook")(function* pingHook(
    repository: Repository,
    hookId: number
  ) {
    yield* call(`${repositoryPath(repository)}/${hookId}/pings`, "POST");

    return null;
  });

  const deliveryPage = Effect.fn("GitHub.deliveryPage")(function* deliveryPage(
    repository: Repository,
    hookId: number
  ) {
    const response = yield* call(
      `${repositoryPath(repository)}/${hookId}/deliveries?per_page=100`
    );

    const json = yield* readJsonEffect(response);

    const deliveries = yield* Schema.decodeUnknownEffect(DeliveryPage)(
      json
    ).pipe(Effect.mapError(invalid));

    return deliveries.map((delivery) => ({
      event: delivery.event,
      id: delivery.id,
      statusCode: delivery.status_code,
    }));
  });

  const deliveries = Effect.fn("GitHub.deliveries")(
    (repository: Repository, hookId: number) => deliveryPage(repository, hookId)
  );

  return GitHubService.of({
    createHook,
    deliveries,
    listHooks,
    listRepositories,
    listRepositoryPage: repositoryPage,
    pingHook,
    repairHook,
  });
};

/** Construct a layer for the native GitHub port.
 * @param options - Provider configuration.
 * @returns The provider layer.
 */
export const githubLayer = (options: GitHubOptions) =>
  Layer.succeed(GitHubService, makeGitHub(options));

const decodeFailure = Schema.decodeUnknownSync(ProviderFailureSchema);

const legacy = async <T>(
  effect: Effect.Effect<T, ProviderError>
): Promise<ProviderResult<T>> =>
  await Effect.runPromise(
    effect.pipe(
      Effect.match({
        onFailure: (error): ProviderResult<T> => ({
          error: decodeFailure(error),
          ok: false,
        }),
        onSuccess: (value): ProviderResult<T> => ({ ok: true, value }),
      })
    )
  );

/** GitHub REST adapter with native effects and transitional Promise methods. */
export class GitHubClient {
  /** Native provider operations for Effect consumers. */
  readonly effects: Port;
  /** Construct the authenticated provider. */
  constructor(options: GitHubOptions) {
    this.effects = makeGitHub(options);
  }
  /** Read one bounded inventory page.
   * @param page - One-based page number.
   * @returns A provider result.
   */
  async listRepositoryPage(page: number): Promise<ProviderResult<Page>> {
    return await legacy(this.effects.listRepositoryPage(page));
  }
  /** Discover all owned repositories.
   * @returns A provider result.
   */
  async listRepositories(): Promise<ProviderResult<Repository[]>> {
    return await legacy(this.effects.listRepositories());
  }
  /** Read repository hooks.
   * @param repository - Target repository.
   * @returns A provider result.
   */
  async listHooks(
    repository: Repository
  ): Promise<ProviderResult<RepositoryHook[]>> {
    return await legacy(this.effects.listHooks(repository));
  }
  /** Create a push hook.
   * @param repository - Target repository.
   * @returns A provider result.
   */
  async createHook(
    repository: Repository
  ): Promise<ProviderResult<RepositoryHook>> {
    return await legacy(this.effects.createHook(repository));
  }
  /** Repair a matching hook without replacing its secret.
   * @param repository - Target repository.
   * @param hookId - Hook identifier.
   * @returns A provider result.
   */
  async repairHook(
    repository: Repository,
    hookId: number
  ): Promise<ProviderResult<RepositoryHook>> {
    return await legacy(this.effects.repairHook(repository, hookId));
  }
  /** Request a ping.
   * @param repository - Target repository.
   * @param hookId - Hook identifier.
   * @returns A provider result.
   */
  async pingHook(
    repository: Repository,
    hookId: number
  ): Promise<ProviderResult<null>> {
    return await legacy(this.effects.pingHook(repository, hookId));
  }
  /** Read delivery summaries.
   * @param repository - Target repository.
   * @param hookId - Hook identifier.
   * @returns A provider result.
   */
  async deliveries(
    repository: Repository,
    hookId: number
  ): Promise<ProviderResult<Delivery[]>> {
    return await legacy(this.effects.deliveries(repository, hookId));
  }
}
