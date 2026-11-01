import { describe, expect, it } from "vitest";

import { planHook, planProject } from "../../src/domain/reconciliation.ts";
import type {
  Project,
  ProjectEvidence,
  RepositoryHook,
} from "../../src/domain/reconciliation.ts";

describe("reconciliation", () => {
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
    it("reuses a unique existing team project after a lost create checkpoint", () => {
      expect(planProject(evidence)).toStrictEqual({
        attachUrl: repository.url,
        kind: "reuse",
        projectId: project.id,
        updateName: null,
      });
    });

    it("stable ID survives rename and preserves unrelated attachments", () => {
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
      ).toStrictEqual({
        attachUrl: repository.url,
        kind: "reuse",
        projectId: prior.id,
        updateName: "current",
      });
      expect(prior.urls).toStrictEqual(["https://example.test/docs"]);
    });

    it("URL identity wins over a coincidental team name", () => {
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

    it("ambiguous names and URLs refuse creation", () => {
      expect(
        planProject({
          ...evidence,
          projects: [project, { ...project, id: "other" }],
        })
      ).toStrictEqual({ kind: "manual", reason: "ambiguous-project" });
      expect(
        planProject({
          ...evidence,
          projects: [project, { ...project, id: "other" }].map((entry) => ({
            ...entry,
            urls: [repository.url],
          })),
        })
      ).toStrictEqual({ kind: "manual", reason: "ambiguous-project" });
    });

    it("missing mapped project cannot silently create a duplicate", () => {
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
      ).toStrictEqual({ kind: "manual", reason: "missing-mapped-project" });
    });

    it("one project cannot be claimed by two stable repository IDs", () => {
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
      ).toStrictEqual({ kind: "manual", reason: "identity-conflict" });
    });

    it("archived projects are not replaced or unarchived", () => {
      expect(
        planProject({ ...evidence, projects: [{ ...project, archived: true }] })
      ).toStrictEqual({ kind: "manual", reason: "archived-project" });
    });

    it("new repository gets a project only with no matching evidence", () => {
      expect(planProject({ ...evidence, projects: [] })).toStrictEqual({
        kind: "create",
        name: repository.name,
        repositoryUrl: repository.url,
      });
    });

    it("foreign, archived and disabled repositories are skipped individually", () => {
      for (const [change, reason] of [
        [{ owner: "organisation" }, "foreign-owner"],
        [{ archived: true }, "archived"],
        [{ disabled: true }, "disabled"],
      ] as const) {
        expect(
          planProject({ ...evidence, repository: { ...repository, ...change } })
        ).toStrictEqual({ kind: "skip", reason });
      }
    });
  });

  describe("native commit hooks", () => {
    it("unrelated hooks are neither adopted nor edited", () => {
      expect(planHook([hook], "https://example.test/another")).toStrictEqual({
        kind: "create",
      });
      expect(hook.events).toStrictEqual(["push"]);
    });

    it("correct existing hook is reused with no secret rotation", () => {
      expect(planHook([hook], hook.endpoint)).toStrictEqual({
        hookId: 7,
        kind: "reuse",
      });
    });

    it("unsafe SSL, extra events and inactive hooks plan safe repairs", () => {
      for (const change of [
        { insecureSsl: "1" },
        { events: ["push", "issues"] },
        { active: false },
        { contentType: "form" },
      ]) {
        expect(planHook([{ ...hook, ...change }], hook.endpoint)).toStrictEqual(
          {
            hookId: 7,
            kind: "repair",
          }
        );
      }
    });

    it("duplicate endpoint hooks require manual action without deleting either", () => {
      expect(planHook([hook, { ...hook, id: 8 }], hook.endpoint)).toStrictEqual(
        {
          kind: "manual",
          reason: "duplicate-endpoint-hooks",
        }
      );
    });
  });

  it("existing Linear summary links identify projects outside name/team fallback", () => {
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
});
