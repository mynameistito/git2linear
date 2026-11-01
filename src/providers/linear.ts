/** Schema source: https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql */
import { Effect, Layer, Schema } from "effect";

import type { Project } from "../domain/reconciliation.ts";
import {
  ProviderError,
  ProviderFailureSchema,
  readJsonEffect,
  requestEffect,
} from "./http.ts";
import type { HttpOptions, ProviderResult } from "./http.ts";
import {
  AttachResponse,
  CreateResponse,
  ProjectsResponse,
  LinearService,
  TeamResponse,
  UpdateResponse,
} from "./linear-schema.ts";

/** A single durable page of projects, including archived projects. */
export interface ProjectPage {
  readonly projects: readonly Project[];
  readonly nextCursor: string | null;
}

/** Persisted intent for project creation. */
export interface CreateProjectInput {
  readonly id: string;
  readonly name: string;
  readonly repositoryUrl: string;
  readonly teamId: string;
}

/** Persisted intent for adding a project link. */
export interface AttachLinkInput {
  readonly id: string;
  readonly projectId: string;
  readonly url: string;
}

/** Native operations supported by the Linear provider. */
export interface LinearOperations {
  readonly page: (
    after: string | null
  ) => Effect.Effect<ProjectPage, ProviderError>;
  readonly verifyTeam: (
    id: string,
    key: string
  ) => Effect.Effect<boolean, ProviderError>;
  readonly create: (
    input: CreateProjectInput
  ) => Effect.Effect<boolean, ProviderError>;
  readonly rename: (
    id: string,
    name: string
  ) => Effect.Effect<boolean, ProviderError>;
  readonly attach: (
    input: AttachLinkInput
  ) => Effect.Effect<boolean, ProviderError>;
}

export { LinearService } from "./linear-schema.ts";

type Variables =
  | { readonly after: string | null }
  | { readonly id: string }
  | { readonly id: string; readonly input: { readonly name: string } }
  | {
      readonly input:
        | {
            readonly description: string;
            readonly id: string;
            readonly name: string;
            readonly teamIds: readonly string[];
          }
        | (AttachLinkInput & { readonly label: string });
    };

const invalid = () => new ProviderError({ kind: "invalid-response" });

/** Construct the native adapter.
 * @param authorization - Authorization header.
 * @param options - Optional transport.
 * @returns Native operations.
 */
export const makeLinearOperations = (
  authorization: string,
  options: HttpOptions = {}
): LinearOperations => {
  const query = Effect.fn("Linear.query")(function* query(
    document: string,
    variables: Variables
  ) {
    const response = yield* requestEffect(
      "https://api.linear.app/graphql",
      {
        body: JSON.stringify({ query: document, variables }),
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
        },
        method: "POST",
      },
      options
    );

    return yield* readJsonEffect(response);
  });

  const page = Effect.fn("Linear.page")(function* page(after: string | null) {
    const json = yield* query(
      `query Projects($after:String){projects(first:25,after:$after,includeArchived:true){nodes{id name description archivedAt teams(first:10){nodes{id} pageInfo{hasNextPage}} externalLinks(first:10){nodes{url} pageInfo{hasNextPage}}}pageInfo{hasNextPage endCursor}}}`,
      { after }
    );

    const result = yield* Schema.decodeUnknownEffect(ProjectsResponse)(
      json
    ).pipe(Effect.mapError(invalid));

    const { nodes, pageInfo } = result.data.projects;

    if (pageInfo.hasNextPage && pageInfo.endCursor === after) {
      return yield* Effect.fail(invalid());
    }

    return {
      nextCursor: pageInfo.hasNextPage ? pageInfo.endCursor : null,
      projects: nodes.map((node) => ({
        archived: node.archivedAt !== null,
        id: node.id,
        name: node.name,
        summary: node.description,
        teamIds: node.teams.nodes.map((team) => team.id),
        urls: node.externalLinks.nodes.map((link) => link.url),
      })),
    };
  });

  const verifyTeam = Effect.fn("Linear.verifyTeam")(function* verifyTeam(
    id: string,
    key: string
  ) {
    const json = yield* query("query Team($id:String!){team(id:$id){id key}}", {
      id,
    });

    const result = yield* Schema.decodeUnknownEffect(TeamResponse)(json).pipe(
      Effect.mapError(invalid)
    );

    return result.data.team.id === id && result.data.team.key === key;
  });

  const create = Effect.fn("Linear.create")(function* create(
    input: CreateProjectInput
  ) {
    const json = yield* query(
      "mutation Create($input:ProjectCreateInput!){projectCreate(input:$input){success}}",
      {
        input: {
          description: `GitHub repository: ${input.repositoryUrl}`,
          id: input.id,
          name: input.name,
          teamIds: [input.teamId],
        },
      }
    );

    const result = yield* Schema.decodeUnknownEffect(CreateResponse)(json).pipe(
      Effect.mapError(invalid)
    );

    return result.data.projectCreate.success;
  });

  const rename = Effect.fn("Linear.rename")(function* rename(
    id: string,
    name: string
  ) {
    const json = yield* query(
      "mutation Rename($id:String!,$input:ProjectUpdateInput!){projectUpdate(id:$id,input:$input){success}}",
      { id, input: { name } }
    );

    const result = yield* Schema.decodeUnknownEffect(UpdateResponse)(json).pipe(
      Effect.mapError(invalid)
    );

    return result.data.projectUpdate.success;
  });

  const attach = Effect.fn("Linear.attach")(function* attach(
    input: AttachLinkInput
  ) {
    const json = yield* query(
      "mutation Attach($input:EntityExternalLinkCreateInput!){entityExternalLinkCreate(input:$input){success}}",
      { input: { ...input, label: "GitHub repository" } }
    );

    const result = yield* Schema.decodeUnknownEffect(AttachResponse)(json).pipe(
      Effect.mapError(invalid)
    );

    return result.data.entityExternalLinkCreate.success;
  });

  return { attach, create, page, rename, verifyTeam };
};

/** Construct a layer providing the native Linear adapter.
 * @param authorization - Authorization header.
 * @param options - Optional transport.
 * @returns Provider layer.
 */
export const linearLayer = (authorization: string, options: HttpOptions = {}) =>
  Layer.effect(
    LinearService,
    Effect.sync(() =>
      LinearService.of(makeLinearOperations(authorization, options))
    )
  );

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

/** Supported project operations with Promise compatibility and native Effects. */
export class LinearProjects {
  /** Native operations for Effect consumers. */
  readonly effects: LinearOperations;
  /** Construct a provider with an authorization header and optional transport. */
  constructor(authorization: string, options: HttpOptions = {}) {
    this.effects = makeLinearOperations(authorization, options);
  }
  /** Fetch one bounded inventory page.
   * @param after - Saved cursor.
   * @returns Provider result.
   */
  async page(after: string | null): Promise<ProviderResult<ProjectPage>> {
    return await legacy(this.effects.page(after));
  }
  /** Verify the configured team identity.
   * @param id - Team ID.
   * @param key - Team key.
   * @returns Provider result.
   */
  async verifyTeam(id: string, key: string): Promise<ProviderResult<boolean>> {
    return await legacy(this.effects.verifyTeam(id, key));
  }
  /** Create a project using a persisted intent.
   * @param input - Persisted intent.
   * @returns Provider result.
   */
  async create(input: CreateProjectInput): Promise<ProviderResult<boolean>> {
    return await legacy(this.effects.create(input));
  }
  /** Rename a project without changing other fields.
   * @param id - Project ID.
   * @param name - New name.
   * @returns Provider result.
   */
  async rename(id: string, name: string): Promise<ProviderResult<boolean>> {
    return await legacy(this.effects.rename(id, name));
  }
  /** Attach a link using a persisted intent.
   * @param input - Persisted intent.
   * @returns Provider result.
   */
  async attach(input: AttachLinkInput): Promise<ProviderResult<boolean>> {
    return await legacy(this.effects.attach(input));
  }
}
