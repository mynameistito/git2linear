import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { authorized, scheduledReady } from "../../src/platform/auth";
import {
  RunCoordinator,
  emptySummary,
  checkpointDiagnostics,
  repositoryIdFromRecordKey,
  nativeRunPersistence,
} from "../../src/platform/run";
import type { RunRecord, RunStore, StepRunner } from "../../src/platform/run";

const memory = () => {
  let record: RunRecord | undefined;
  const alarms: number[] = [];

  const store: RunStore = {
    get: async () => await Promise.resolve(record),
    getAlarm: async () => await Promise.resolve(alarms.at(-1) ?? null),
    put: async (next) => {
      await Effect.runPromise(
        Effect.sync(() => {
          record = structuredClone(next);
        })
      );
    },
    schedule: async (at) => {
      await Effect.runPromise(
        Effect.sync(() => {
          alarms.push(at);
        })
      );
    },
    start: async (next) =>
      await Effect.runPromise(
        Effect.sync(() => {
          if (record?.status === "running") {
            return record;
          }

          record = structuredClone(next);

          return record;
        })
      ),
  };

  return { alarms, store };
};

describe("RunCoordinator and platform helpers", () => {
  it("overlapping starts reuse run and continuation recovers after coordinator replacement", async () => {
    const state = memory();

    const runner: StepRunner = {
      step: async (input) =>
        await Promise.resolve({
          checkpoint: input.checkpoint === null ? 1 : 2,
          done: input.checkpoint === 1,
          summary: { ...emptySummary(), discovered: 2 },
        }),
    };

    const first = new RunCoordinator(state.store, runner, () => 100);
    const run = await first.start(true);
    const overlapping = await first.start(false);
    expect(overlapping.runId).toBe(run.runId);
    await first.advance();
    await expect(state.store.get()).resolves.toMatchObject({ checkpoint: 1 });
    const replacement = new RunCoordinator(state.store, runner, () => 200);
    await replacement.advance();
    await expect(state.store.get()).resolves.toMatchObject({
      status: "complete",
    });
    expect(state.alarms).toContain(120_100);
  });

  it("transient failed step retains checkpoint and redacts failure then resumes", async () => {
    const state = memory();
    let fail = true;

    const runner: StepRunner = {
      step: async () =>
        fail
          ? await Promise.reject(new Error("credential must never persist"))
          : await Promise.resolve({
              checkpoint: "done",
              done: true,
              summary: emptySummary(),
            }),
    };

    const coordinator = new RunCoordinator(state.store, runner, () => 100);
    await coordinator.start(true);
    await coordinator.advance();
    await expect(state.store.get()).resolves.toMatchObject({
      checkpoint: null,
    });
    expect(JSON.stringify(await state.store.get())).not.toContain("credential");
    fail = false;
    await coordinator.advance();
    await expect(state.store.get()).resolves.toMatchObject({
      status: "complete",
    });
  });

  it("manual authentication rejects missing, wrong and short tokens", async () => {
    await expect(
      authorized(new Request("https://worker/status"), undefined)
    ).resolves.toBeFalsy();
    const token = "x".repeat(43);
    await expect(
      authorized(new Request("https://worker/status"), token)
    ).resolves.toBeFalsy();
    await expect(
      authorized(
        new Request("https://worker/status", {
          headers: { Authorization: `Bearer ${"y".repeat(43)}` },
        }),
        token
      )
    ).resolves.toBeFalsy();
    await expect(
      authorized(
        new Request("https://worker/status", {
          headers: { Authorization: `Bearer ${token}` },
        }),
        token
      )
    ).resolves.toBeTruthy();
    await expect(
      authorized(new Request("https://worker/status"), "weak")
    ).resolves.toBeFalsy();
  });

  it("bootstrap cannot schedule work until every core credential is present", () => {
    const complete = {
      GITHUB_TOKEN: "github",
      LINEAR_API_KEY: "linear",
      MANUAL_TRIGGER_TOKEN: "x".repeat(43),
    };

    expect(scheduledReady({})).toBeFalsy();
    expect(scheduledReady({ ...complete, GITHUB_TOKEN: "" })).toBeFalsy();
    expect(scheduledReady({ ...complete, LINEAR_API_KEY: "" })).toBeFalsy();
    expect(
      scheduledReady({ ...complete, MANUAL_TRIGGER_TOKEN: "" })
    ).toBeFalsy();
    expect(scheduledReady(complete)).toBeTruthy();
  });

  it("diagnostics expose only validated scalar fields and discard nested secret payloads", () => {
    expect(
      checkpointDiagnostics({
        attempts: 1,
        phase: "repositories",
        providerFailure: {
          kind: "http",
          retryAt: 1000,
          secret: "hidden",
          status: 429,
        },
        token: "hidden",
      })
    ).toStrictEqual({
      attempts: 1,
      phase: "repositories",
      providerFailure: { kind: "http", retryAt: 1000, status: 429 },
    });
    expect(
      checkpointDiagnostics({
        attempts: "hidden",
        phase: "hidden",
        providerFailure: { kind: "hidden", status: 999 },
      })
    ).toStrictEqual({});
  });

  it("provider reason diagnostics accept only the fixed nonsecret reason allowlist", () => {
    expect(
      checkpointDiagnostics({
        providerFailure: { kind: "network", reason: "illegal-invocation" },
      }).providerFailure?.reason
    ).toBe("illegal-invocation");
    expect(
      checkpointDiagnostics({
        providerFailure: { kind: "network", reason: "secret-token" },
      }).providerFailure?.reason
    ).toBeUndefined();
  });

  it("overlapping manual starts preserve provider retry deadlines", async () => {
    const state = memory();

    const coordinator = new RunCoordinator({
      now: () => 100,
      runner: {
        stepEffect: () =>
          Effect.succeed({
            checkpoint: 1,
            done: false,
            retryAt: 900_000,
            summary: emptySummary(),
          }),
      },
      store: nativeRunPersistence(state.store),
    });

    const run = await Effect.runPromise(coordinator.startEffect(true));
    await Effect.runPromise(coordinator.advanceEffect());
    const alarmsBefore = state.alarms.length;
    const overlapping = await coordinator.start(false);
    expect(overlapping.runId).toBe(run.runId);
    expect(state.alarms).toHaveLength(alarmsBefore);
    expect(state.alarms.at(-1)).toBe(900_000);
  });

  it("missing alarm recovery respects persisted provider retry deadline", async () => {
    const state = memory();

    const runner: StepRunner = {
      step: async () =>
        await Promise.resolve({
          checkpoint: 1,
          done: false,
          retryAt: 900_000,
          summary: emptySummary(),
        }),
    };

    const coordinator = new RunCoordinator(state.store, runner, () => 100);
    await coordinator.start(true);
    await coordinator.advance();
    state.alarms.length = 0;
    await coordinator.start(true);
    expect(state.alarms.at(-1)).toBe(900_000);
  });

  it("run-scoped report keys retain stable repository IDs and reject foreign or malformed keys", () => {
    expect(
      repositoryIdFromRecordKey("repository:run:42", "repository:run:")
    ).toBe(42);
    expect(
      repositoryIdFromRecordKey("repository:other:42", "repository:run:")
    ).toBeNull();
    expect(
      repositoryIdFromRecordKey("repository:run:not-id", "repository:run:")
    ).toBeNull();
  });
});
