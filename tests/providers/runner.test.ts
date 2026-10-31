/* oxlint-disable sonarjs/no-undefined-assignment -- Tests explicitly remove an optional capability from a shared fixture. */
import { expect, test } from "bun:test";

import { ReconciliationRunner } from "../../src/application/runner";
import type {
  ReconciliationStore,
  RepositoryStatus,
  RunnerOptions,
} from "../../src/application/runner";
/* oxlint-disable eslint/require-await, eslint/no-await-in-loop -- Deterministic fake async ports and sequential durable step execution model the application contract. */
/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun is the actual test runtime. */
import type { Project } from "../../src/domain/reconciliation";
import type { StepOutput } from "../../src/platform/run";

test("dry run discovers and plans without external mutations or identity writes", async () => {
  const repo = {
    archived: false,
    disabled: false,
    id: 1,
    name: "repo",
    owner: "owner",
    url: "https://github.com/owner/repo",
  };

  let mutations = 0;

  const forbidden = async () => {
    mutations += 1;

    return { ok: true, value: true } as const;
  };

  const store: ReconciliationStore = {
    identities: async () => [],
    intent: async () => {
      mutations += 1;

      return "id";
    },
    record: async () => {},
    saveIdentity: async () => {
      mutations += 1;
    },
  };

  const options: RunnerOptions = {
    endpoint: "https://native.example/private",
    github: {
      createHook: async () => {
        throw new Error("forbidden");
      },
      deliveries: async () => ({ ok: true, value: [] }),
      listHooks: async () => ({ ok: true, value: [] }),
      listRepositoryPage: async (page) => ({
        ok: true,
        value: {
          hasNextPage: page === 1,
          repositories: page === 1 ? [repo] : [],
        },
      }),
      pingHook: async () => {
        throw new Error("forbidden");
      },
      repairHook: async () => {
        throw new Error("forbidden");
      },
    },
    linear: {
      attach: forbidden,
      create: forbidden,
      page: async () => ({
        ok: true,
        value: { nextCursor: null, projects: [] },
      }),
      rename: forbidden,
      verifyTeam: async () => ({ ok: true, value: true }),
    },
    owner: "owner",
    store,
    teamId: "team",
  };

  const runner = new ReconciliationRunner(options);

  let output: StepOutput = await runner.step({
    checkpoint: null,
    dryRun: true,
    runId: "run",
  });

  for (let step = 0; step < 10 && !output.done; step += 1) {
    output = await runner.step({
      checkpoint: output.checkpoint,
      dryRun: true,
      runId: "run",
    });
  }

  expect(output.done).toBe(true);
  expect(output.summary.discovered).toBe(1);
  expect(output.summary.created).toBe(1);
  expect(mutations).toBe(0);
  expect(JSON.stringify(output)).not.toContain("native.example");
});

test("committed timeout reuses persisted project intent", async () => {
  const repo = {
    archived: false,
    disabled: false,
    id: 7,
    name: "repo",
    owner: "owner",
    url: "https://github.com/owner/repo",
  };

  const projects: Project[] = [];
  let creates = 0;
  let intentSaved = false;

  const store: ReconciliationStore = {
    identities: async () => [],
    intent: async () => {
      intentSaved = true;

      return "persisted-uuid";
    },
    record: async () => {},
    saveIdentity: async () => {},
  };

  const runner = new ReconciliationRunner({
    endpoint: "https://native.example",
    github: {
      createHook: async () => {
        throw new Error("must reuse hook");
      },
      deliveries: async () => ({ ok: true, value: [] }),
      listHooks: async () => ({
        ok: true,
        value: [
          {
            active: true,
            contentType: "json",
            endpoint: "https://native.example",
            events: ["push"],
            id: 99,
            insecureSsl: "0",
          },
        ],
      }),
      listRepositoryPage: async () => ({
        ok: true,
        value: { hasNextPage: false, repositories: [repo] },
      }),
      pingHook: async () => ({ ok: true, value: null }),
      repairHook: async () => {
        throw new Error("must reuse hook");
      },
    },
    linear: {
      attach: async () => {
        throw new Error("already attached");
      },
      create: async (input) => {
        expect(intentSaved).toBe(true);
        creates += 1;
        projects.push({
          archived: false,
          id: input.id,
          name: input.name,
          teamIds: [input.teamId],
          urls: [repo.url],
        });

        return { error: { kind: "network", retryAt: 1000 }, ok: false };
      },
      page: async () => ({
        ok: true,
        value: { nextCursor: null, projects: [...projects] },
      }),
      rename: async () => {
        throw new Error("must reuse project");
      },
      verifyTeam: async () => ({ ok: true, value: true }),
    },
    owner: "owner",
    store,
    teamId: "team",
  });

  let result = await runner.step({
    checkpoint: null,
    dryRun: false,
    runId: "run",
  });

  for (let step = 0; step < 15 && !result.done; step += 1) {
    result = await runner.step({
      checkpoint: result.checkpoint,
      dryRun: false,
      runId: "run",
    });
  }

  expect(result.done).toBe(true);
  expect(creates).toBe(1);
  expect(result.summary.created).toBe(1);
});

const configuredOptions = (records: RepositoryStatus[]): RunnerOptions => ({
  endpoint: "https://native.example",
  github: {
    createHook: async () => {
      throw new Error("unexpected mutation");
    },
    deliveries: async () => ({
      ok: true,
      value: [{ event: "ping", id: 10, statusCode: 200 }],
    }),
    listHooks: async () => ({
      ok: true,
      value: [
        {
          active: true,
          contentType: "json",
          endpoint: "https://native.example",
          events: ["push"],
          id: 99,
          insecureSsl: "0",
        },
      ],
    }),
    listRepositoryPage: async () => ({
      ok: true,
      value: {
        hasNextPage: false,
        repositories: [
          {
            archived: false,
            disabled: false,
            id: 1,
            name: "repo",
            owner: "owner",
            url: "https://github.com/owner/repo",
          },
        ],
      },
    }),
    pingHook: async () => ({ ok: true, value: null }),
    repairHook: async () => {
      throw new Error("unexpected mutation");
    },
  },
  linear: {
    attach: async () => {
      throw new Error("unexpected mutation");
    },
    create: async () => {
      throw new Error("unexpected mutation");
    },
    page: async () => ({
      ok: true,
      value: {
        nextCursor: null,
        projects: [
          {
            archived: false,
            id: "p",
            name: "repo",
            teamIds: ["team"],
            urls: ["https://github.com/owner/repo"],
          },
        ],
      },
    }),
    rename: async () => {
      throw new Error("unexpected mutation");
    },
    verifyTeam: async () => ({ ok: true, value: true }),
  },
  owner: "owner",
  store: {
    identities: async () => [],
    intent: async () => "id",
    record: async (_id, status) => {
      records.push(status);
    },
    saveIdentity: async () => {},
  },
  teamId: "team",
});

const finish = async (
  options: RunnerOptions,
  dryRun = false
): Promise<StepOutput> => {
  const runner = new ReconciliationRunner(options);

  let result = await runner.step({
    checkpoint: null,
    dryRun,
    runId: "regression",
  });

  for (let step = 0; step < 20 && !result.done; step += 1) {
    result = await runner.step({
      checkpoint: result.checkpoint,
      dryRun,
      runId: "regression",
    });
  }

  return result;
};

test("old successful ping never proves newly requested delivery", async () => {
  const records: RepositoryStatus[] = [];
  const result = await finish(configuredOptions(records));
  expect(result.summary.alreadyConfigured).toBe(1);
  expect(records[0]?.pingDelivery).toBe("pending");
  expect(records[0]?.supportedStateVerified).toBe(true);
  expect(records[0]?.runId).toBe("regression");
});

test("repository provider failure is persisted and processing completes", async () => {
  const records: RepositoryStatus[] = [];
  const base = configuredOptions(records);

  const result = await finish({
    ...base,
    github: {
      ...base.github,
      listHooks: async () => ({
        error: { kind: "http", status: 403 },
        ok: false,
      }),
    },
  });

  expect(result.done).toBe(true);
  expect(result.summary.failed).toBe(1);
  expect(records[0]?.outcome).toBe("failed");
});

test("wrong saved MY team identity prevents mutations and records failure", async () => {
  const records: RepositoryStatus[] = [];
  const base = configuredOptions(records);

  const result = await finish({
    ...base,
    linear: {
      ...base.linear,
      verifyTeam: async () => ({ ok: true, value: false }),
    },
  });

  expect(result.summary.failed).toBe(1);
  expect(records[0]?.outcome).toBe("failed");
});

test("dry-run repository plan is persisted with run metadata and no endpoint", async () => {
  const records: RepositoryStatus[] = [];
  await finish(configuredOptions(records), true);
  expect(records[0]?.dryRun).toBe(true);
  expect(records[0]?.plannedActions).toEqual([
    "project:reuse",
    "hook:reuse",
    "native-sync:manual",
  ]);
  expect(JSON.stringify(records)).not.toContain("native.example");
});

test("only a delivery absent from the baseline verifies requested ping", async () => {
  const records: RepositoryStatus[] = [];
  const base = configuredOptions(records);
  let reads = 0;

  const result = await finish({
    ...base,
    github: {
      ...base.github,
      deliveries: async () => {
        reads += 1;

        return {
          ok: true,
          value: [
            { event: "ping", id: reads === 1 ? 10 : 11, statusCode: 200 },
          ],
        };
      },
    },
  });

  expect(result.summary.alreadyConfigured).toBe(1);
  expect(records[0]?.pingDelivery).toBe("verified");
});

test("duplicate endpoint hooks produce persisted manual action", async () => {
  const records: RepositoryStatus[] = [];
  const base = configuredOptions(records);

  const result = await finish({
    ...base,
    github: {
      ...base.github,
      listHooks: async () => ({
        ok: true,
        value: [99, 100].map((id) => ({
          active: true,
          contentType: "json",
          endpoint: "https://native.example",
          events: ["push"],
          id,
          insecureSsl: "0",
        })),
      }),
    },
  });

  expect(result.done).toBe(true);
  expect(result.summary.manualActionRequired).toBe(1);
  expect(records[0]?.reason).toBe("duplicate-endpoint-hooks");
});

test("missing commit credentials still reconcile project identity without accessing hooks", async () => {
  const records: RepositoryStatus[] = [];
  const base = configuredOptions(records);
  let identities = 0;

  const result = await finish({
    ...base,
    endpoint: undefined,
    github: {
      ...base.github,
      listHooks: async () => {
        throw new Error("must not access hooks");
      },
    },
    store: {
      ...base.store,
      saveIdentity: async () => {
        identities += 1;
      },
    },
  });

  expect(result.done).toBe(true);
  expect(identities).toBe(1);
  expect(result.summary.failed).toBe(0);
  expect(records[0]?.reason).toBe("commit-webhook-credentials-unavailable");
  expect(result.summary.manualActionRequired).toBe(1);
});

test("missing commit credentials dry run reports manual hooks and project plan", async () => {
  const records: RepositoryStatus[] = [];
  const base = configuredOptions(records);
  await finish(
    {
      ...base,
      endpoint: undefined,
      github: {
        ...base.github,
        listHooks: async () => {
          throw new Error("must not access hooks");
        },
      },
    },
    true
  );
  expect(records[0]?.reason).toBe("commit-webhook-credentials-unavailable");
  expect(records[0]?.plannedActions).toEqual([
    "project:reuse",
    "hook:manual",
    "native-sync:manual",
  ]);
});

test("dry run names project rename and repository attachment without exposing URLs", async () => {
  const records: RepositoryStatus[] = [];
  const base = configuredOptions(records);
  await finish(
    {
      ...base,
      linear: {
        ...base.linear,
        page: async () => ({
          ok: true,
          value: {
            nextCursor: null,
            projects: [
              {
                archived: false,
                id: "p",
                name: "old",
                teamIds: ["team"],
                urls: [],
              },
            ],
          },
        }),
      },
      store: {
        ...base.store,
        identities: async () => [
          {
            projectId: "p",
            repositoryId: 1,
            repositoryUrl: "https://github.com/owner/repo",
          },
        ],
      },
    },
    true
  );
  expect(records[0]?.plannedActions).toContain("project:rename");
  expect(records[0]?.plannedActions).toContain("project:attach-repository-url");
  expect(JSON.stringify(records[0]?.plannedActions)).not.toContain("https:");
});
