import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ReconciliationRunner } from "../../src/application/runner";
import type {
  ReconciliationStore,
  RepositoryStatus,
  RunnerOptions,
} from "../../src/application/runner";
import { CheckpointSchema } from "../../src/application/runner-adapters";
import type { Project } from "../../src/domain/reconciliation";
import type { StepOutput } from "../../src/platform/run";
import { emptySummary } from "../../src/platform/run";

const configuredOptions = (records: RepositoryStatus[]): RunnerOptions => ({
  endpoint: "https://native.example",
  github: {
    createHook: async () =>
      await Effect.runPromise(
        Effect.sync(() => {
          throw new Error("unexpected mutation");
        })
      ),
    deliveries: async () =>
      await Effect.runPromise(
        Effect.sync(() => ({
          ok: true,
          value: [{ event: "ping", id: 10, statusCode: 200 }],
        }))
      ),
    listHooks: async () =>
      await Effect.runPromise(
        Effect.sync(() => ({
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
        }))
      ),
    listRepositoryPage: async () =>
      await Effect.runPromise(
        Effect.sync(() => ({
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
        }))
      ),
    pingHook: async () =>
      await Effect.runPromise(Effect.sync(() => ({ ok: true, value: null }))),
    repairHook: async () =>
      await Effect.runPromise(
        Effect.sync(() => {
          throw new Error("unexpected mutation");
        })
      ),
  },
  linear: {
    attach: async () =>
      await Effect.runPromise(
        Effect.sync(() => {
          throw new Error("unexpected mutation");
        })
      ),
    create: async () =>
      await Effect.runPromise(
        Effect.sync(() => {
          throw new Error("unexpected mutation");
        })
      ),
    page: async () =>
      await Effect.runPromise(
        Effect.sync(() => ({
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
        }))
      ),
    rename: async () =>
      await Effect.runPromise(
        Effect.sync(() => {
          throw new Error("unexpected mutation");
        })
      ),
    verifyTeam: async () =>
      await Effect.runPromise(Effect.sync(() => ({ ok: true, value: true }))),
  },
  owner: "owner",
  store: {
    identities: async () => await Effect.runPromise(Effect.sync(() => [])),
    intent: async () => await Effect.runPromise(Effect.sync(() => "id")),
    record: async (_id, status) => {
      await Effect.runPromise(
        Effect.sync(() => {
          records.push(status);
        })
      );
    },
    saveIdentity: async () => {
      await Effect.runPromise(Effect.sync(() => {}));
    },
  },
  teamId: "team",
  teamKey: "MY",
});

const runSteps = async (
  runner: ReconciliationRunner,
  dryRun: boolean,
  runId: string,
  limit: number
): Promise<StepOutput> =>
  await Effect.runPromise(
    Effect.gen(function* runStepsEffect() {
      let result = yield* runner.stepEffect({
        checkpoint: null,
        dryRun,
        runId,
      });

      for (let step = 0; step < limit && !result.done; step += 1) {
        result = yield* runner.stepEffect({
          checkpoint: result.checkpoint,
          dryRun,
          runId,
        });
      }

      return result;
    })
  );

const finish = async (
  options: RunnerOptions,
  dryRun = false
): Promise<StepOutput> =>
  await runSteps(new ReconciliationRunner(options), dryRun, "regression", 20);

const withoutEndpoint = ({
  endpoint,
  ...options
}: RunnerOptions): RunnerOptions => {
  expect(endpoint).toBe("https://native.example");

  return options;
};

describe("reconciliation runner regressions", () => {
  it.each(["baseline", "ping", "delivery"])(
    "records %s provider verification failures without counting success",
    async (stage) => {
      const records: RepositoryStatus[] = [];
      const options = configuredOptions(records);
      const originalDeliveries = options.github.deliveries;
      let reads = 0;

      options.github.deliveries = async (repository, id) => {
        reads += 1;

        if (
          (stage === "baseline" && reads === 1) ||
          (stage === "delivery" && reads === 2)
        ) {
          return await Promise.resolve({
            error: { kind: "http", status: 403 },
            ok: false,
          });
        }

        return await originalDeliveries(repository, id);
      };

      if (stage === "ping") {
        options.github.pingHook = async () =>
          await Promise.resolve({
            error: { kind: "http", status: 403 },
            ok: false,
          });
      }

      const result = await finish(options);
      expect(result.summary.failed).toBe(1);
      expect(result.summary.alreadyConfigured).toBe(0);
      expect(records).toHaveLength(1);
      expect(records[0]?.outcome).toBe("failed");
      expect(records[0]?.supportedStateVerified).not.toBeTruthy();
    }
  );

  it("resets successful project-page retries and clears recovered diagnostics", async () => {
    const options = configuredOptions([]);
    const originalPage = options.linear.page;
    let calls = 0;

    options.linear.page = async () => {
      calls += 1;

      if (calls % 2 === 1) {
        return await Promise.resolve({
          error: { kind: "http", retryAt: 1000, status: 503 },
          ok: false,
        });
      }

      const result = await originalPage(null);

      if (!result.ok) {
        return result;
      }

      return {
        ok: true,
        value: {
          nextCursor: calls < 8 ? String(calls) : null,
          projects: calls === 8 ? result.value.projects : [],
        },
      };
    };

    const result = await finish(options);

    const checkpoint = Schema.decodeUnknownSync(CheckpointSchema)(
      result.checkpoint
    );

    expect(result.done).toBeTruthy();
    expect(result.summary).toMatchObject({ alreadyConfigured: 1, failed: 0 });
    expect(calls).toBe(8);
    expect(checkpoint.inventoryAttempts).toBe(0);
    expect(checkpoint.providerFailure).toBeUndefined();
  });

  it("preserves mutation attempts while resetting a successful inventory page", async () => {
    const runner = new ReconciliationRunner(configuredOptions([]));

    const result = await runner.step({
      checkpoint: {
        attempts: 3,
        change: "created",
        cursor: null,
        index: 0,
        inventoryAttempts: 2,
        page: 1,
        phase: "projects",
        projects: [],
        providerFailure: { kind: "http", status: 503 },
        repositories: [],
        summary: emptySummary(),
      },
      dryRun: false,
      runId: "mutation-budget",
    });

    const checkpoint = Schema.decodeUnknownSync(CheckpointSchema)(
      result.checkpoint
    );

    expect(checkpoint.attempts).toBe(3);
    expect(checkpoint.inventoryAttempts).toBe(0);
    expect(checkpoint.providerFailure).toBeUndefined();
  });

  it("resets per-repository state after a manual project decision", async () => {
    const runner = new ReconciliationRunner(configuredOptions([]));

    const result = await runner.step({
      checkpoint: {
        attempts: 2,
        change: "created",
        cursor: null,
        index: 0,
        page: 1,
        phase: "reconcile",
        projects: [
          {
            archived: false,
            id: "p1",
            name: "repo",
            teamIds: ["team"],
            urls: [],
          },
          {
            archived: false,
            id: "p2",
            name: "repo",
            teamIds: ["team"],
            urls: [],
          },
        ],
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
        summary: emptySummary(),
      },
      dryRun: false,
      runId: "manual-state",
    });

    const checkpoint = Schema.decodeUnknownSync(CheckpointSchema)(
      result.checkpoint
    );

    expect(checkpoint.index).toBe(1);
    expect(checkpoint.attempts).toBe(0);
    expect(checkpoint.change).toBe("none");
    expect(result.summary.created).toBe(0);
  });

  it("verifies the configured team key before applying a project", async () => {
    const options = configuredOptions([]);
    let verified = false;
    options.linear.verifyTeam = async (id, key) => {
      expect(id).toBe("team");
      expect(key).toBe("CUSTOM");
      verified = true;

      return await Promise.resolve({ ok: true, value: true });
    };

    await finish({ ...options, teamKey: "CUSTOM" });
    expect(verified).toBeTruthy();
  });

  it("dry run discovers and plans without external mutations or identity writes", async () => {
    const repo = {
      archived: false,
      disabled: false,
      id: 1,
      name: "repo",
      owner: "owner",
      url: "https://github.com/owner/repo",
    };

    let mutations = 0;

    const forbidden = async () =>
      await Effect.runPromise(
        Effect.sync(() => {
          mutations += 1;

          return { ok: true, value: true } as const;
        })
      );

    const store: ReconciliationStore = {
      identities: async () => await Effect.runPromise(Effect.sync(() => [])),
      intent: async () =>
        await Effect.runPromise(
          Effect.sync(() => {
            mutations += 1;

            return "id";
          })
        ),
      record: async () => {
        await Effect.runPromise(Effect.sync(() => {}));
      },
      saveIdentity: async () => {
        await Effect.runPromise(
          Effect.sync(() => {
            mutations += 1;
          })
        );
      },
    };

    const options: RunnerOptions = {
      endpoint: "https://native.example/private",
      github: {
        createHook: async () =>
          await Effect.runPromise(
            Effect.sync(() => {
              throw new Error("forbidden");
            })
          ),
        deliveries: async () =>
          await Effect.runPromise(Effect.sync(() => ({ ok: true, value: [] }))),
        listHooks: async () =>
          await Effect.runPromise(Effect.sync(() => ({ ok: true, value: [] }))),
        listRepositoryPage: async (page) =>
          await Effect.runPromise(
            Effect.sync(() => ({
              ok: true,
              value: {
                hasNextPage: page === 1,
                repositories: page === 1 ? [repo] : [],
              },
            }))
          ),
        pingHook: async () =>
          await Effect.runPromise(
            Effect.sync(() => {
              throw new Error("forbidden");
            })
          ),
        repairHook: async () =>
          await Effect.runPromise(
            Effect.sync(() => {
              throw new Error("forbidden");
            })
          ),
      },
      linear: {
        attach: forbidden,
        create: forbidden,
        page: async () =>
          await Effect.runPromise(
            Effect.sync(() => ({
              ok: true,
              value: { nextCursor: null, projects: [] },
            }))
          ),
        rename: forbidden,
        verifyTeam: async () =>
          await Effect.runPromise(
            Effect.sync(() => ({ ok: true, value: true }))
          ),
      },
      owner: "owner",
      store,
      teamId: "team",
      teamKey: "MY",
    };

    const runner = new ReconciliationRunner(options);

    const output = await runSteps(runner, true, "run", 10);

    expect(output.done).toBeTruthy();
    expect(output.summary.discovered).toBe(1);
    expect(output.summary.created).toBe(1);
    expect(mutations).toBe(0);
    expect(JSON.stringify(output)).not.toContain("native.example");
  });

  it("committed timeout reuses persisted project intent", async () => {
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
      identities: async () => await Effect.runPromise(Effect.sync(() => [])),
      intent: async () =>
        await Effect.runPromise(
          Effect.sync(() => {
            intentSaved = true;

            return "persisted-uuid";
          })
        ),
      record: async () => {
        await Effect.runPromise(Effect.sync(() => {}));
      },
      saveIdentity: async () => {
        await Effect.runPromise(Effect.sync(() => {}));
      },
    };

    const runner = new ReconciliationRunner({
      endpoint: "https://native.example",
      github: {
        createHook: async () =>
          await Effect.runPromise(
            Effect.sync(() => {
              throw new Error("must reuse hook");
            })
          ),
        deliveries: async () =>
          await Effect.runPromise(Effect.sync(() => ({ ok: true, value: [] }))),
        listHooks: async () =>
          await Effect.runPromise(
            Effect.sync(() => ({
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
            }))
          ),
        listRepositoryPage: async () =>
          await Effect.runPromise(
            Effect.sync(() => ({
              ok: true,
              value: { hasNextPage: false, repositories: [repo] },
            }))
          ),
        pingHook: async () =>
          await Effect.runPromise(
            Effect.sync(() => ({ ok: true, value: null }))
          ),
        repairHook: async () =>
          await Effect.runPromise(
            Effect.sync(() => {
              throw new Error("must reuse hook");
            })
          ),
      },
      linear: {
        attach: async () =>
          await Effect.runPromise(
            Effect.sync(() => {
              throw new Error("already attached");
            })
          ),
        create: async (input) =>
          await Effect.runPromise(
            Effect.sync(() => {
              expect(intentSaved).toBeTruthy();
              creates += 1;
              projects.push({
                archived: false,
                id: input.id,
                name: input.name,
                teamIds: [input.teamId],
                urls: [repo.url],
              });

              return { error: { kind: "network", retryAt: 1000 }, ok: false };
            })
          ),
        page: async () =>
          await Effect.runPromise(
            Effect.sync(() => ({
              ok: true,
              value: { nextCursor: null, projects: [...projects] },
            }))
          ),
        rename: async () =>
          await Effect.runPromise(
            Effect.sync(() => {
              throw new Error("must reuse project");
            })
          ),
        verifyTeam: async () =>
          await Effect.runPromise(
            Effect.sync(() => ({ ok: true, value: true }))
          ),
      },
      owner: "owner",
      store,
      teamId: "team",
      teamKey: "MY",
    });

    const result = await runSteps(runner, false, "run", 15);

    expect(result.done).toBeTruthy();
    expect(creates).toBe(1);
    expect(result.summary.created).toBe(1);
  });

  it("old successful ping never proves newly requested delivery", async () => {
    const records: RepositoryStatus[] = [];
    const result = await finish(configuredOptions(records));
    expect(result.summary.alreadyConfigured).toBe(1);
    expect(records[0]?.pingDelivery).toBe("pending");
    expect(records[0]?.supportedStateVerified).toBeTruthy();
    expect(records[0]?.runId).toBe("regression");
  });

  it("repository provider failure is persisted and processing completes", async () => {
    const records: RepositoryStatus[] = [];
    const base = configuredOptions(records);

    const result = await finish({
      ...base,
      github: {
        ...base.github,
        listHooks: async () =>
          await Effect.runPromise(
            Effect.sync(() => ({
              error: { kind: "http", status: 403 },
              ok: false,
            }))
          ),
      },
    });

    expect(result.done).toBeTruthy();
    expect(result.summary.failed).toBe(1);
    expect(records[0]?.outcome).toBe("failed");
  });

  it("wrong saved MY team identity prevents mutations and records failure", async () => {
    const records: RepositoryStatus[] = [];
    const base = configuredOptions(records);

    const result = await finish({
      ...base,
      linear: {
        ...base.linear,
        verifyTeam: async () =>
          await Effect.runPromise(
            Effect.sync(() => ({ ok: true, value: false }))
          ),
      },
    });

    expect(result.summary.failed).toBe(1);
    expect(records[0]?.outcome).toBe("failed");
  });

  it("dry-run repository plan is persisted with run metadata and no endpoint", async () => {
    const records: RepositoryStatus[] = [];
    await finish(configuredOptions(records), true);
    expect(records[0]?.dryRun).toBeTruthy();
    expect(records[0]?.plannedActions).toStrictEqual([
      "project:reuse",
      "hook:reuse",
      "native-sync:manual",
    ]);
    expect(JSON.stringify(records)).not.toContain("native.example");
  });

  it("only a delivery absent from the baseline verifies requested ping", async () => {
    const records: RepositoryStatus[] = [];
    const base = configuredOptions(records);
    let reads = 0;

    const result = await finish({
      ...base,
      github: {
        ...base.github,
        deliveries: async () =>
          await Effect.runPromise(
            Effect.sync(() => {
              reads += 1;

              return {
                ok: true,
                value: [
                  { event: "ping", id: reads === 1 ? 10 : 11, statusCode: 200 },
                ],
              };
            })
          ),
      },
    });

    expect(result.summary.alreadyConfigured).toBe(1);
    expect(records[0]?.pingDelivery).toBe("verified");
  });

  it("duplicate endpoint hooks produce persisted manual action", async () => {
    const records: RepositoryStatus[] = [];
    const base = configuredOptions(records);

    const result = await finish({
      ...base,
      github: {
        ...base.github,
        listHooks: async () =>
          await Effect.runPromise(
            Effect.sync(() => ({
              ok: true,
              value: [99, 100].map((id) => ({
                active: true,
                contentType: "json",
                endpoint: "https://native.example",
                events: ["push"],
                id,
                insecureSsl: "0",
              })),
            }))
          ),
      },
    });

    expect(result.done).toBeTruthy();
    expect(result.summary.manualActionRequired).toBe(1);
    expect(records[0]?.reason).toBe("duplicate-endpoint-hooks");
  });

  it("missing commit credentials still reconcile project identity without accessing hooks", async () => {
    const records: RepositoryStatus[] = [];
    const base = withoutEndpoint(configuredOptions(records));
    let identities = 0;

    const result = await finish({
      ...base,
      github: {
        ...base.github,
        listHooks: async () =>
          await Effect.runPromise(
            Effect.sync(() => {
              throw new Error("must not access hooks");
            })
          ),
      },
      store: {
        ...base.store,
        saveIdentity: async () => {
          await Effect.runPromise(
            Effect.sync(() => {
              identities += 1;
            })
          );
        },
      },
    });

    expect(result.done).toBeTruthy();
    expect(identities).toBe(1);
    expect(result.summary.failed).toBe(0);
    expect(records[0]?.reason).toBe("commit-webhook-credentials-unavailable");
    expect(result.summary.manualActionRequired).toBe(1);
  });

  it("missing commit credentials dry run reports manual hooks and project plan", async () => {
    const records: RepositoryStatus[] = [];
    const base = withoutEndpoint(configuredOptions(records));
    await finish(
      {
        ...base,
        github: {
          ...base.github,
          listHooks: async () =>
            await Effect.runPromise(
              Effect.sync(() => {
                throw new Error("must not access hooks");
              })
            ),
        },
      },
      true
    );
    expect(records[0]?.reason).toBe("commit-webhook-credentials-unavailable");
    expect(records[0]?.plannedActions).toStrictEqual([
      "project:reuse",
      "hook:manual",
      "native-sync:manual",
    ]);
  });

  it("dry run names project rename and repository attachment without exposing URLs", async () => {
    const records: RepositoryStatus[] = [];
    const base = configuredOptions(records);
    await finish(
      {
        ...base,
        linear: {
          ...base.linear,
          page: async () =>
            await Effect.runPromise(
              Effect.sync(() => ({
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
              }))
            ),
        },
        store: {
          ...base.store,
          identities: async () =>
            await Effect.runPromise(
              Effect.sync(() => [
                {
                  projectId: "p",
                  repositoryId: 1,
                  repositoryUrl: "https://github.com/owner/repo",
                },
              ])
            ),
        },
      },
      true
    );
    expect(records[0]?.plannedActions).toContain("project:rename");
    expect(records[0]?.plannedActions).toContain(
      "project:attach-repository-url"
    );
    expect(JSON.stringify(records[0]?.plannedActions)).not.toContain("https:");
  });
});
