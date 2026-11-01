import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import type { HttpOptions } from "../../src/providers/http.ts";
import { LinearProjects } from "../../src/providers/linear.ts";

const GraphqlRequestSchema = Schema.Struct({
  query: Schema.String,
  variables: Schema.JsonObject,
});

type GraphqlRequest = Schema.Schema.Type<typeof GraphqlRequestSchema>;

type JsonValue = Schema.Json;

const decodeRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(GraphqlRequestSchema)
);

const node = {
  archivedAt: null,
  description: "GitHub repository: https://github.com/mynameistito/repo",
  externalLinks: { nodes: [], pageInfo: { hasNextPage: false } },
  id: "p1",
  name: "repo",
  teams: { nodes: [{ id: "team" }], pageInfo: { hasNextPage: false } },
};

const connection = (
  nodes: readonly JsonValue[],
  hasNextPage = false,
  endCursor: string | null = null
) => ({ data: { projects: { nodes, pageInfo: { endCursor, hasNextPage } } } });

const transport =
  (
    handle: (body: GraphqlRequest) => JsonValue
  ): NonNullable<HttpOptions["fetch"]> =>
  async (_input, init) => {
    const body = decodeRequest(init.body);

    return await Promise.resolve(Response.json(handle(body)));
  };

describe("Linear projects", () => {
  it("paginates archived projects and retains existing summary identity", async () => {
    const cursors: (JsonValue | undefined)[] = [];

    const client = new LinearProjects("test-credential", {
      fetch: transport((body) => {
        expect(body.query).toContain("includeArchived:true");
        expect(body.query).toContain("projects(first:25");
        expect(body.query).toContain("teams(first:10)");
        expect(body.query).toContain("externalLinks(first:10)");
        cursors.push(body.variables.after);

        return body.variables.after === null
          ? connection([node], true, "next")
          : connection([{ ...node, archivedAt: "2026-01-01", id: "p2" }]);
      }),
    });

    const first = await client.page(null);

    if (!first.ok) {
      throw new Error("Expected the first page to succeed");
    }

    expect([
      first.value.nextCursor,
      first.value.projects[0]?.summary,
    ]).toStrictEqual(["next", node.description]);
    const second = await client.page(first.value.nextCursor);

    if (!second.ok) {
      throw new Error("Expected the second page to succeed");
    }

    expect([
      second.value.nextCursor,
      second.value.projects[0]?.archived,
    ]).toStrictEqual([null, true]);
    expect(cursors).toStrictEqual([null, "next"]);
  });

  it.each([
    ["malformed project", connection([{}])],
    ["repeated cursor", connection([node], true, "same")],
    [
      "truncated teams",
      connection([
        { ...node, teams: { nodes: [], pageInfo: { hasNextPage: true } } },
      ]),
    ],
    [
      "truncated external links",
      connection([
        {
          ...node,
          externalLinks: { nodes: [], pageInfo: { hasNextPage: true } },
        },
      ]),
    ],
  ])("rejects %s", async (_name, payload) => {
    const client = new LinearProjects("test", {
      fetch: transport(() => payload),
    });

    await expect(client.page("same")).resolves.toStrictEqual({
      error: { kind: "invalid-response" },
      ok: false,
    });
  });

  it("redacts GraphQL partial errors in successful HTTP responses", async () => {
    const client = new LinearProjects("secret-test", {
      fetch: transport(() => ({
        errors: [{ message: "sensitive provider detail" }],
        ...connection([node]),
      })),
    });

    await expect(client.page(null)).resolves.toStrictEqual({
      error: { kind: "invalid-response" },
      ok: false,
    });
  });

  it("uses persisted UUIDs and preserves unrelated settings when renaming", async () => {
    const bodies: GraphqlRequest[] = [];

    const client = new LinearProjects("test", {
      fetch: transport((body) => {
        bodies.push(body);

        return {
          data: {
            entityExternalLinkCreate: { success: true },
            projectCreate: { success: true },
            projectUpdate: { success: true },
          },
        };
      }),
    });

    await expect(
      client.create({
        id: "saved-uuid",
        name: "repo",
        repositoryUrl: "https://github.com/mynameistito/repo",
        teamId: "team",
      })
    ).resolves.toStrictEqual({ ok: true, value: true });
    await expect(client.rename("saved-uuid", "renamed")).resolves.toStrictEqual(
      {
        ok: true,
        value: true,
      }
    );
    await expect(
      client.attach({
        id: "saved-link-uuid",
        projectId: "saved-uuid",
        url: "https://github.com/mynameistito/repo",
      })
    ).resolves.toStrictEqual({ ok: true, value: true });
    expect(bodies.map((body) => body.variables)).toStrictEqual([
      {
        input: {
          description: node.description,
          id: "saved-uuid",
          name: "repo",
          teamIds: ["team"],
        },
      },
      { id: "saved-uuid", input: { name: "renamed" } },
      {
        input: {
          id: "saved-link-uuid",
          label: "GitHub repository",
          projectId: "saved-uuid",
          url: "https://github.com/mynameistito/repo",
        },
      },
    ]);
  });

  it("verifies team identity without integration mutations", async () => {
    const bodies: GraphqlRequest[] = [];

    const client = new LinearProjects("test", {
      fetch: transport((body) => {
        bodies.push(body);

        return { data: { team: { id: "team", key: "MY" } } };
      }),
    });

    await expect(client.verifyTeam("team", "MY")).resolves.toStrictEqual({
      ok: true,
      value: true,
    });
    await expect(client.verifyTeam("team", "OTHER")).resolves.toStrictEqual({
      ok: true,
      value: false,
    });
    expect(bodies).toHaveLength(2);
    expect(bodies.map((body) => body.variables)).toStrictEqual([
      { id: "team" },
      { id: "team" },
    ]);
    expect(
      bodies.every((body) => body.query.startsWith("query Team"))
    ).toBeTruthy();
  });
});
