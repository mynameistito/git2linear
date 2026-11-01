/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun provides the actual test runtime. */
import { describe, expect, test } from "vitest";

import { planHook, planProject } from "../../src/domain/reconciliation.ts";
import type {
  Project,
  ProjectEvidence,
  RepositoryHook,
} from "../../src/domain/reconciliation.ts";

const repository = {
  archived: false,
  disabled: false,
  id: 42,
  name: "current",
  owner: "mynameistito",
  url: "https://github.com/mynameistito/current",
};

const project: Project = {
  archived: false,
  id: "project-1",
  name: "current",
  teamIds: ["MY"],
  urls: [],
};

const evidence: ProjectEvidence = {
  identities: [],
  owner: "mynameistito",
  projects: [project],
  repository,
  teamId: "MY",
};

const hook: RepositoryHook = {
  active: true,
  contentType: "json",
  endpoint: "https://example.test/native",
  events: ["push"],
  id: 7,
  insecureSsl: "0",
};

describe("project identity", () => {
  test("reuses a unique existing team project after a lost create checkpoint", () => {
    expect(planProject(evidence)).toEqual({
      attachUrl: repository.url,
      kind: "reuse",
      projectId: project.id,
      updateName: null,
    });
  });
  test("stable ID survives rename and preserves unrelated attachments", () => {
    const prior = {
      ...project,
      name: "old",
      urls: ["https://example.test/docs"],
    };

    expect(
      planProject({
        ...evidence,
        identities: [
          {
            projectId: prior.id,
            repositoryId: 42,
            repositoryUrl: "https://github.com/mynameistito/old",
          },
        ],
        projects: [prior],
      })
    ).toEqual({
      attachUrl: repository.url,
      kind: "reuse",
      projectId: prior.id,
      updateName: "current",
    });
    expect(prior.urls).toEqual(["https://example.test/docs"]);
  });
  test("URL identity wins over a coincidental team name", () => {
    expect(
      planProject({
        ...evidence,
        projects: [
          project,
          {
            ...project,
            id: "url-project",
            name: "old",
            teamIds: [],
            urls: [repository.url],
          },
        ],
      })
    ).toMatchObject({ kind: "reuse", projectId: "url-project" });
  });
  test("ambiguous names and URLs refuse creation", () => {
    expect(
      planProject({
        ...evidence,
        projects: [project, { ...project, id: "other" }],
      })
    ).toEqual({ kind: "manual", reason: "ambiguous-project" });
    expect(
      planProject({
        ...evidence,
        projects: [project, { ...project, id: "other" }].map((entry) => ({
          ...entry,
          urls: [repository.url],
        })),
      })
    ).toEqual({ kind: "manual", reason: "ambiguous-project" });
  });
  test("missing mapped project cannot silently create a duplicate", () => {
    expect(
      planProject({
        ...evidence,
        identities: [
          {
            projectId: "missing",
            repositoryId: 42,
            repositoryUrl: repository.url,
          },
        ],
      })
    ).toEqual({ kind: "manual", reason: "missing-mapped-project" });
  });
  test("one project cannot be claimed by two stable repository IDs", () => {
    expect(
      planProject({
        ...evidence,
        identities: [
          {
            projectId: project.id,
            repositoryId: 99,
            repositoryUrl: "https://github.com/mynameistito/other",
          },
        ],
      })
    ).toEqual({ kind: "manual", reason: "identity-conflict" });
  });
  test("archived projects are not replaced or unarchived", () => {
    expect(
      planProject({ ...evidence, projects: [{ ...project, archived: true }] })
    ).toEqual({ kind: "manual", reason: "archived-project" });
  });
  test("new repository gets a project only with no matching evidence", () => {
    expect(planProject({ ...evidence, projects: [] })).toEqual({
      kind: "create",
      name: repository.name,
      repositoryUrl: repository.url,
    });
  });
  test("foreign, archived and disabled repositories are skipped individually", () => {
    for (const [change, reason] of [
      [{ owner: "organisation" }, "foreign-owner"],
      [{ archived: true }, "archived"],
      [{ disabled: true }, "disabled"],
    ] as const) {
      expect(
        planProject({ ...evidence, repository: { ...repository, ...change } })
      ).toEqual({ kind: "skip", reason });
    }
  });
});

describe("native commit hooks", () => {
  test("unrelated hooks are neither adopted nor edited", () => {
    expect(planHook([hook], "https://example.test/another")).toEqual({
      kind: "create",
    });
    expect(hook.events).toEqual(["push"]);
  });
  test("correct existing hook is reused with no secret rotation", () => {
    expect(planHook([hook], hook.endpoint)).toEqual({
      hookId: 7,
      kind: "reuse",
    });
  });
  test("unsafe SSL, extra events and inactive hooks plan safe repairs", () => {
    for (const change of [
      { insecureSsl: "1" },
      { events: ["push", "issues"] },
      { active: false },
      { contentType: "form" },
    ]) {
      expect(planHook([{ ...hook, ...change }], hook.endpoint)).toEqual({
        hookId: 7,
        kind: "repair",
      });
    }
  });
  test("duplicate endpoint hooks require manual action without deleting either", () => {
    expect(planHook([hook, { ...hook, id: 8 }], hook.endpoint)).toEqual({
      kind: "manual",
      reason: "duplicate-endpoint-hooks",
    });
  });
});

test("existing Linear summary links identify projects outside name/team fallback", () => {
  expect(
    planProject({
      ...evidence,
      projects: [
        {
          ...project,
          name: "old",
          summary: `GitHub repository: ${repository.url}`,
          teamIds: [],
        },
      ],
    })
  ).toMatchObject({ kind: "reuse", projectId: project.id });
});
