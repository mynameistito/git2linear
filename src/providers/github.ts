/* oxlint-disable sonarjs/no-duplicate-string -- Repeated protocol failure tags remain local to their parsing branches. */
/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unknown-parameters, anti-slop/no-unsafe-dictionary-type -- Protocol parsers accept untrusted JSON and produce fully checked domain records. */
/* oxlint-disable sonarjs/expression-complexity -- Fail-closed boundary parsers require complete field conjunctions. */
import type { Repository, RepositoryHook } from "../domain/reconciliation";
import { readJson, request } from "./http";
import type { HttpOptions, ProviderResult } from "./http";

/** Credentials stay inside this adapter and must never enter status output. */
export interface GitHubOptions extends HttpOptions {
  readonly token: string;
  readonly owner: string;
  readonly endpoint: string;
  readonly webhookSecret: string;
}

const record = (input: unknown): input is Record<string, unknown> =>
  typeof input === "object" && input !== null;

const positiveId = (input: unknown): input is number =>
  typeof input === "number" && Number.isSafeInteger(input) && input > 0;

const parseRepository = (input: unknown): Repository | null => {
  if (
    !record(input) ||
    !positiveId(input.id) ||
    !record(input.owner) ||
    typeof input.owner.login !== "string" ||
    typeof input.name !== "string" ||
    typeof input.html_url !== "string" ||
    typeof input.archived !== "boolean" ||
    typeof input.disabled !== "boolean"
  ) {
    return null;
  }

  return {
    archived: input.archived,
    disabled: input.disabled,
    id: input.id,
    name: input.name,
    owner: input.owner.login,
    url: input.html_url,
  };
};

const parseHook = (input: unknown): RepositoryHook | null => {
  if (
    !record(input) ||
    !positiveId(input.id) ||
    typeof input.active !== "boolean" ||
    !Array.isArray(input.events) ||
    !input.events.every(
      (event): event is string => typeof event === "string"
    ) ||
    !record(input.config) ||
    typeof input.config.url !== "string" ||
    typeof input.config.content_type !== "string" ||
    typeof input.config.insecure_ssl !== "string"
  ) {
    return null;
  }

  return {
    active: input.active,
    contentType: input.config.content_type,
    endpoint: input.config.url,
    events: input.events,
    id: input.id,
    insecureSsl: input.config.insecure_ssl,
  };
};

/** GitHub REST adapter with complete pagination and no credential-bearing diagnostics. */
export class GitHubClient {
  readonly #options: GitHubOptions;
  /** Construct the authenticated GitHub boundary.
   * @param options - Credentials and transport kept inside the adapter.
   */
  constructor(options: GitHubOptions) {
    this.#options = options;
  }

  /** Read one bounded inventory page for durable continuation.
   * @param page - One-based page number.
   * @returns Parsed owned repositories and whether discovery should continue.
   */
  async listRepositoryPage(
    page: number
  ): Promise<
    ProviderResult<{ repositories: Repository[]; hasNextPage: boolean }>
  > {
    const result = await this.#call(
      `/user/repos?affiliation=owner&visibility=all&sort=full_name&direction=asc&per_page=100&page=${page}`
    );

    if (!result.ok) {
      return result;
    }

    const json = await readJson(result.value);

    if (!json.ok) {
      return json;
    }

    if (!Array.isArray(json.value)) {
      return { error: { kind: "invalid-response" }, ok: false };
    }

    const repositories: Repository[] = [];

    for (const value of json.value) {
      const repository = parseRepository(value);

      if (!repository) {
        return { error: { kind: "invalid-response" }, ok: false };
      }

      if (
        repository.owner.toLowerCase() === this.#options.owner.toLowerCase()
      ) {
        repositories.push(repository);
      }
    }

    return {
      ok: true,
      value: { hasNextPage: json.value.length > 0, repositories },
    };
  }

  async #call(
    path: string,
    method = "GET",
    body?: unknown
  ): Promise<ProviderResult<Response>> {
    return await request(
      `https://api.github.com${path}`,
      {
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.#options.token}`,
          "Content-Type": "application/json",
          "User-Agent": "git2linear-reconciler",
          "X-GitHub-Api-Version": "2026-03-10",
        },
        method,
      },
      this.#options
    );
  }

  /* oxlint-disable eslint/no-await-in-loop -- Sequential pages must respect provider order and rate limits. */
  async #list<T>(
    path: string,
    parse: (input: unknown) => T | null,
    maxPages = 5
  ): Promise<ProviderResult<T[]>> {
    const values: T[] = [];

    for (let page = 1; page <= maxPages; page += 1) {
      const result = await this.#call(
        `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`
      );

      if (!result.ok) {
        return result;
      }

      const json = await readJson(result.value);

      if (!json.ok) {
        return json;
      }

      if (!Array.isArray(json.value)) {
        return { error: { kind: "invalid-response" }, ok: false };
      }

      for (const item of json.value) {
        const parsed = parse(item);

        if (parsed === null) {
          return { error: { kind: "invalid-response" }, ok: false };
        }

        values.push(parsed);
      }

      // An extra empty-page read avoids trusting pagination URLs supplied by a remote server.
      if (json.value.length === 0) {
        return { ok: true, value: values };
      }
    }

    return { error: { kind: "invalid-response" }, ok: false };
  }

  /** Discover all visible owned repositories, including private repositories and forks.
   * @returns Complete visible owned inventory, or safe error.
   */
  async listRepositories(): Promise<ProviderResult<Repository[]>> {
    const result = await this.#list(
      "/user/repos?affiliation=owner&visibility=all&sort=full_name&direction=asc",
      parseRepository,
      10_000
    );

    return result.ok
      ? {
          ok: true,
          value: result.value.filter(
            (repo) =>
              repo.owner.toLowerCase() === this.#options.owner.toLowerCase()
          ),
        }
      : result;
  }

  static #path(repository: Repository): string {
    return `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/hooks`;
  }

  /** Read all hooks; unrelated hooks are returned solely for safe planning.
   * @param repository - Existing verified repository or hook identity.
   * @returns Provider result requiring saved-state verification.
   */
  async listHooks(
    repository: Repository
  ): Promise<ProviderResult<RepositoryHook[]>> {
    return await this.#list(GitHubClient.#path(repository), parseHook);
  }

  /** Create one native push hook. Caller must rediscover after ambiguous failures.
   * @param repository - Existing verified repository or hook identity.
   * @returns Provider result requiring saved-state verification.
   */
  async createHook(
    repository: Repository
  ): Promise<ProviderResult<RepositoryHook>> {
    return await this.#writeHook(repository, null);
  }

  /** Repair only an existing exact endpoint match, retaining its existing signing secret.
   * @param repository - Existing verified repository or hook identity.
   * @param hookId - Existing verified repository or hook identity.
   * @returns Provider result requiring saved-state verification.
   */
  async repairHook(
    repository: Repository,
    hookId: number
  ): Promise<ProviderResult<RepositoryHook>> {
    const hooks = await this.listHooks(repository);

    if (!hooks.ok) {
      return hooks;
    }

    if (
      !hooks.value.some(
        (hook) => hook.id === hookId && hook.endpoint === this.#options.endpoint
      )
    ) {
      return { error: { kind: "invalid-response" }, ok: false };
    }

    return await this.#writeHook(repository, hookId);
  }

  async #writeHook(
    repository: Repository,
    id: number | null
  ): Promise<ProviderResult<RepositoryHook>> {
    const result = await this.#call(
      GitHubClient.#path(repository) + (id === null ? "" : `/${id}`),
      id === null ? "POST" : "PATCH",
      {
        active: true,
        config: {
          content_type: "json",
          insecure_ssl: "0",
          url: this.#options.endpoint,
          // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- Omitting secret on PATCH preserves the existing secret; undefined is not sent.
          ...(id === null ? { secret: this.#options.webhookSecret } : {}),
        },
        events: ["push"],
        name: "web",
      }
    );

    if (!result.ok) {
      return result;
    }

    const json = await readJson(result.value);

    if (!json.ok) {
      return json;
    }

    const parsed = parseHook(json.value);

    return parsed === null
      ? { error: { kind: "invalid-response" }, ok: false }
      : { ok: true, value: parsed };
  }

  /** Request GitHub's ping; acceptance is distinct from delivery success.
   * @param repository - Existing verified repository or hook identity.
   * @param hookId - Existing verified repository or hook identity.
   * @returns Provider result requiring saved-state verification.
   */
  async pingHook(
    repository: Repository,
    hookId: number
  ): Promise<ProviderResult<null>> {
    const result = await this.#call(
      `${GitHubClient.#path(repository)}/${hookId}/pings`,
      "POST"
    );

    return result.ok ? { ok: true, value: null } : result;
  }

  /** Inspect delivery status without fetching request/response payloads.
   * @param repository - Existing verified repository or hook identity.
   * @param hookId - Existing verified repository or hook identity.
   * @returns Provider result requiring saved-state verification.
   */
  async deliveries(
    repository: Repository,
    hookId: number
  ): Promise<
    ProviderResult<{ id: number; event: string; statusCode: number | null }[]>
  > {
    return await this.#list(
      `${GitHubClient.#path(repository)}/${hookId}/deliveries`,
      (input) => {
        if (
          !record(input) ||
          !positiveId(input.id) ||
          typeof input.event !== "string" ||
          !(input.status_code === null || typeof input.status_code === "number")
        ) {
          return null;
        }

        return {
          event: input.event,
          id: input.id,
          statusCode: input.status_code,
        };
      }
    );
  }
}
