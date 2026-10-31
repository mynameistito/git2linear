/* oxlint-disable anti-slop/no-runtime-typeof, anti-slop/no-unsafe-dictionary-type, anti-slop/no-object-parameters -- This adapter parses untrusted GraphQL JSON into domain records at the I/O boundary. */
/** Schema source: https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql */
import type { Project } from "../domain/reconciliation.ts";
import { readJson, request } from "./http.ts";
import type { HttpOptions, ProviderResult } from "./http.ts";

const invalid = { error: { kind: "invalid-response" }, ok: false } as const;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A single durable page of projects, including archived projects. */
export interface ProjectPage {
  readonly projects: readonly Project[];
  readonly nextCursor: string | null;
}

/** Supported public project operations; no native integration-settings mutations. */
export class LinearProjects {
  readonly #authorization: string;
  readonly #options: HttpOptions;
  /** Construct a secret-safe provider; authorization accepts API key or OAuth Bearer header.
   * @param authorization - Secret complete authorization header.
   * @param options - Injectable transport.
   */
  constructor(authorization: string, options: HttpOptions = {}) {
    this.#authorization = authorization;
    this.#options = options;
  }

  async #query(
    query: string,
    variables: object
  ): Promise<ProviderResult<Record<string, unknown>>> {
    const response = await request(
      "https://api.linear.app/graphql",
      {
        body: JSON.stringify({ query, variables }),
        headers: {
          Authorization: this.#authorization,
          "Content-Type": "application/json",
        },
        method: "POST",
      },
      this.#options
    );

    if (!response.ok) {
      return response;
    }

    const json = await readJson(response.value);

    if (!json.ok) {
      return json;
    }

    if (
      !record(json.value) ||
      json.value.errors !== undefined ||
      !record(json.value.data)
    ) {
      return invalid;
    }

    return { ok: true, value: json.value.data };
  }

  /* oxlint-disable eslint/complexity, sonarjs/cognitive-complexity, sonarjs/expression-complexity -- Complete protocol parsing is intentionally fail closed. */
  /** Fetch one bounded inventory page. Nested pagination overflow fails closed.
   * @param after - Previously saved cursor, or null.
   * @returns Parsed project page or sanitized provider error.
   */
  async page(after: string | null): Promise<ProviderResult<ProjectPage>> {
    const result = await this.#query(
      `query Projects($after:String){projects(first:50,after:$after,includeArchived:true){nodes{id name description archivedAt teams(first:100){nodes{id} pageInfo{hasNextPage}} externalLinks(first:100){nodes{url} pageInfo{hasNextPage}}}pageInfo{hasNextPage endCursor}}}`,
      { after }
    );

    if (!result.ok) {
      return result;
    }

    const connection = result.value.projects;

    if (
      !record(connection) ||
      !Array.isArray(connection.nodes) ||
      !record(connection.pageInfo)
    ) {
      return invalid;
    }

    const projects: Project[] = [];

    for (const node of connection.nodes) {
      if (
        !record(node) ||
        typeof node.id !== "string" ||
        typeof node.name !== "string" ||
        typeof node.description !== "string" ||
        !(node.archivedAt === null || typeof node.archivedAt === "string") ||
        !record(node.teams) ||
        !record(node.externalLinks)
      ) {
        return invalid;
      }

      const { teams } = node;
      const links = node.externalLinks;

      if (
        !Array.isArray(teams.nodes) ||
        !Array.isArray(links.nodes) ||
        !record(teams.pageInfo) ||
        teams.pageInfo.hasNextPage !== false ||
        !record(links.pageInfo) ||
        links.pageInfo.hasNextPage !== false
      ) {
        return invalid;
      }

      const teamIds: string[] = [];
      const urls: string[] = [];

      for (const team of teams.nodes) {
        if (!record(team) || typeof team.id !== "string") {
          return invalid;
        }

        teamIds.push(team.id);
      }

      for (const link of links.nodes) {
        if (!record(link) || typeof link.url !== "string") {
          return invalid;
        }

        urls.push(link.url);
      }

      projects.push({
        archived: node.archivedAt !== null,
        id: node.id,
        name: node.name,
        summary: node.description,
        teamIds,
        urls,
      });
    }

    const info = connection.pageInfo;

    if (
      typeof info.hasNextPage !== "boolean" ||
      (info.hasNextPage &&
        (typeof info.endCursor !== "string" || info.endCursor === after))
    ) {
      return invalid;
    }

    return {
      ok: true,
      value: {
        nextCursor:
          info.hasNextPage && typeof info.endCursor === "string"
            ? info.endCursor
            : null,
        projects,
      },
    };
  }

  /* oxlint-enable eslint/complexity, sonarjs/cognitive-complexity, sonarjs/expression-complexity */

  /** Verify the configured team identity without modifying its settings.
   * @param id - Configured team UUID.
   * @param key - Required team key.
   * @returns Whether the saved team matches.
   */
  async verifyTeam(id: string, key: string): Promise<ProviderResult<boolean>> {
    const result = await this.#query(
      "query Team($id:String!){team(id:$id){id key}}",
      { id }
    );

    if (!result.ok) {
      return result;
    }

    const { team } = result.value;

    return record(team) &&
      typeof team.id === "string" &&
      typeof team.key === "string"
      ? { ok: true, value: team.id === id && team.key === key }
      : invalid;
  }

  /** Create using a persisted UUID-v4 intent; callers verify inventory after every outcome.
   * @param input - Persisted project intent and team association.
   * @returns Mutation acknowledgement only, never proof of reconciliation.
   */
  async create(input: {
    readonly id: string;
    readonly name: string;
    readonly repositoryUrl: string;
    readonly teamId: string;
  }): Promise<ProviderResult<boolean>> {
    return await this.#mutation(
      "mutation Create($input:ProjectCreateInput!){projectCreate(input:$input){success}}",
      "projectCreate",
      {
        input: {
          description: `GitHub repository: ${input.repositoryUrl}`,
          id: input.id,
          name: input.name,
          teamIds: [input.teamId],
        },
      }
    );
  }

  /** Rename only; preserve descriptions, team settings and unrelated configuration.
   * @param id - Existing project UUID.
   * @param name - Current repository name.
   * @returns Mutation acknowledgement requiring subsequent verification.
   */
  async rename(id: string, name: string): Promise<ProviderResult<boolean>> {
    return await this.#mutation(
      "mutation Rename($id:String!,$input:ProjectUpdateInput!){projectUpdate(id:$id,input:$input){success}}",
      "projectUpdate",
      { id, input: { name } }
    );
  }

  /** Add a resource with a persisted UUID so interrupted creation can be recovered safely.
   * @param input - Persisted resource intent.
   * @returns Mutation acknowledgement requiring subsequent inventory verification.
   */
  async attach(input: {
    readonly id: string;
    readonly projectId: string;
    readonly url: string;
  }): Promise<ProviderResult<boolean>> {
    return await this.#mutation(
      "mutation Attach($input:EntityExternalLinkCreateInput!){entityExternalLinkCreate(input:$input){success}}",
      "entityExternalLinkCreate",
      { input: { ...input, label: "GitHub repository" } }
    );
  }

  async #mutation(
    query: string,
    field: string,
    variables: object
  ): Promise<ProviderResult<boolean>> {
    const result = await this.#query(query, variables);

    if (!result.ok) {
      return result;
    }

    const payload = result.value[field];

    return record(payload) && typeof payload.success === "boolean"
      ? { ok: true, value: payload.success }
      : invalid;
  }
}
