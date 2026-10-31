/* oxlint-disable eslint/require-await, anti-slop/no-unsafe-dictionary-type -- Fixture transport captures arbitrary protocol variable values. */
/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun provides the actual test runtime. */
import { expect, test } from "bun:test";

import type { HttpOptions } from "../../src/providers/http.ts";
import { LinearProjects } from "../../src/providers/linear.ts";

const node = {
  archivedAt: null,
  description: "GitHub repository: https://github.com/mynameistito/repo",
  externalLinks: { nodes: [], pageInfo: { hasNextPage: false } },
  id: "p1",
  name: "repo",
  teams: { nodes: [{ id: "team" }], pageInfo: { hasNextPage: false } },
};

const connection = (
  nodes: unknown[],
  hasNextPage = false,
  endCursor: string | null = null
) => ({ data: { projects: { nodes, pageInfo: { endCursor, hasNextPage } } } });

/* oxlint-disable anti-slop/no-runtime-typeof, sonarjs/expression-complexity -- The fake transport parses its request envelope. */
interface TestGraphqlRequest {
  readonly query: string;
  readonly variables: Record<string, unknown>;
}

// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- Test captures serialized GraphQL variables at the provider boundary.
type CapturedRequest = TestGraphqlRequest;

/* oxlint-disable anti-slop/no-unsafe-dictionary-type, anti-slop/no-unknown-returns -- Deliberately malformed provider responses exercise the JSON boundary. */
const transport =
  (
    handle: (body: TestGraphqlRequest) => unknown
  ): NonNullable<HttpOptions["fetch"]> =>
  async (_input, init) => {
    if (typeof init.body !== "string") {
      return Response.json({ errors: [] });
    }

    const body: unknown = JSON.parse(init.body);

    if (
      typeof body !== "object" ||
      body === null ||
      !("query" in body) ||
      typeof body.query !== "string" ||
      !("variables" in body) ||
      typeof body.variables !== "object" ||
      body.variables === null
    ) {
      return Response.json({ errors: [] });
    }

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: Envelope and variables object checked above.
    // SAFETY: The test transport just checked the GraphQL request envelope and variables object.
    return Response.json(
      handle({
        query: body.query,
        variables: Object.fromEntries(Object.entries(body.variables)),
      })
    );
  };

test("paginated inventory requests archived projects and retains existing summary identity", async () => {
  const cursors: unknown[] = [];

  const client = new LinearProjects("test-credential", {
    fetch: transport((body) => {
      expect(body.query).toContain("includeArchived:true");
      cursors.push(body.variables.after);

      return body.variables.after === null
        ? connection([node], true, "next")
        : connection([{ ...node, archivedAt: "2026-01-01", id: "p2" }]);
    }),
  });

  const first = await client.page(null);
  expect(first.ok).toBe(true);

  if (!first.ok) {
    return;
  }

  expect(first.value.nextCursor).toBe("next");
  expect(first.value.projects[0]?.summary).toBe(node.description);
  const second = await client.page(first.value.nextCursor);
  expect(second.ok && second.value.projects[0]?.archived).toBe(true);
  expect(cursors).toEqual([null, "next"]);
});

// oxlint-disable-next-line eslint/no-await-in-loop -- Each malformed response is an independent sequential fixture.
test("malformed, repeated-cursor and truncated nested inventories fail closed", async () => {
  for (const payload of [
    connection([{}]),
    connection([node], true, "same"),
    connection([
      { ...node, teams: { nodes: [], pageInfo: { hasNextPage: true } } },
    ]),
  ]) {
    const client = new LinearProjects("test", {
      fetch: transport(() => payload),
    });

    // oxlint-disable-next-line eslint/no-await-in-loop -- Independent fixture, no shared external I/O.
    expect(await client.page("same")).toEqual({
      error: { kind: "invalid-response" },
      ok: false,
    });
  }
});

test("GraphQL partial errors never expose provider text or credential", async () => {
  const client = new LinearProjects("secret-test", {
    fetch: transport(() => ({
      errors: [{ message: "sensitive provider detail" }],
      ...connection([node]),
    })),
  });

  expect(await client.page(null)).toEqual({
    error: { kind: "invalid-response" },
    ok: false,
  });
});

test("create uses persisted project UUID and rename preserves unrelated settings", async () => {
  const bodies: CapturedRequest[] = [];

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

  await client.create({
    id: "saved-uuid",
    name: "repo",
    repositoryUrl: "https://github.com/mynameistito/repo",
    teamId: "team",
  });
  await client.rename("saved-uuid", "renamed");
  await client.attach({
    id: "saved-link-uuid",
    projectId: "saved-uuid",
    url: "https://github.com/mynameistito/repo",
  });
  expect(bodies[0]?.variables.input).toEqual({
    description: node.description,
    id: "saved-uuid",
    name: "repo",
    teamIds: ["team"],
  });
  expect(bodies[1]?.variables).toEqual({
    id: "saved-uuid",
    input: { name: "renamed" },
  });
  expect(bodies[2]?.variables.input).toMatchObject({
    id: "saved-link-uuid",
    projectId: "saved-uuid",
  });
});

test("team identity is verified without integration mutations", async () => {
  const client = new LinearProjects("test", {
    fetch: transport(() => ({ data: { team: { id: "team", key: "MY" } } })),
  });

  expect(await client.verifyTeam("team", "MY")).toEqual({
    ok: true,
    value: true,
  });
  expect(await client.verifyTeam("team", "OTHER")).toEqual({
    ok: true,
    value: false,
  });
});
