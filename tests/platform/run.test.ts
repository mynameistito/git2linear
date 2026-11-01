/* oxlint-disable eslint/require-await, unicorn/no-await-expression-member, vitest/prefer-importing-vitest-globals -- Bun async storage fixtures. */
import { expect, test } from "vitest";

import { authorized, scheduledReady } from "../../src/platform/auth";
import {
  RunCoordinator,
  emptySummary,
  checkpointDiagnostics,
  repositoryIdFromRecordKey,
} from "../../src/platform/run";
import type { RunRecord, RunStore, StepRunner } from "../../src/platform/run";

const memory = () => {
  let record: RunRecord | undefined;
  const alarms: number[] = [];

  const store: RunStore = {
    get: async () => record,
    getAlarm: async () => alarms.at(-1) ?? null,
    put: async (next) => {
      record = structuredClone(next);
    },
    schedule: async (at) => {
      alarms.push(at);
    },
    start: async (next) => {
      if (record?.status === "running") {
        return record;
      }

      record = structuredClone(next);

      return record;
    },
  };

  return { alarms, store };
};

test("overlapping starts reuse run and continuation recovers after coordinator replacement", async () => {
  const state = memory();

  const runner: StepRunner = {
    step: async (input) => ({
      checkpoint: input.checkpoint === null ? 1 : 2,
      done: input.checkpoint === 1,
      summary: { ...emptySummary(), discovered: 2 },
    }),
  };

  const first = new RunCoordinator(state.store, runner, () => 100);
  const run = await first.start(true);
  expect((await first.start(false)).runId).toBe(run.runId);
  await first.advance();
  expect((await state.store.get())?.checkpoint).toBe(1);
  const replacement = new RunCoordinator(state.store, runner, () => 200);
  await replacement.advance();
  expect((await state.store.get())?.status).toBe("complete");
  expect(state.alarms).toContain(120_100);
});

test("transient failed step retains checkpoint and redacts failure then resumes", async () => {
  const state = memory();
  let fail = true;

  const runner: StepRunner = {
    step: async () => {
      if (fail) {
        throw new Error("credential must never persist");
      }

      return { checkpoint: "done", done: true, summary: emptySummary() };
    },
  };

  const coordinator = new RunCoordinator(state.store, runner, () => 100);
  await coordinator.start(true);
  await coordinator.advance();
  expect((await state.store.get())?.checkpoint).toBeNull();
  expect(JSON.stringify(await state.store.get())).not.toContain("credential");
  fail = false;
  await coordinator.advance();
  expect((await state.store.get())?.status).toBe("complete");
});

test("manual authentication rejects missing, wrong and short tokens", async () => {
  expect(
    await authorized(new Request("https://worker/status"), undefined)
  ).toBe(false);
  const token = "x".repeat(43);
  expect(await authorized(new Request("https://worker/status"), token)).toBe(
    false
  );
  expect(
    await authorized(
      new Request("https://worker/status", {
        headers: { Authorization: `Bearer ${"y".repeat(43)}` },
      }),
      token
    )
  ).toBe(false);
  expect(
    await authorized(
      new Request("https://worker/status", {
        headers: { Authorization: `Bearer ${token}` },
      }),
      token
    )
  ).toBe(true);
  expect(await authorized(new Request("https://worker/status"), "weak")).toBe(
    false
  );
});

test("bootstrap cannot schedule work until every core credential is present", () => {
  const complete = {
    GITHUB_TOKEN: "github",
    LINEAR_API_KEY: "linear",
    MANUAL_TRIGGER_TOKEN: "x".repeat(43),
  };

  expect(scheduledReady({})).toBe(false);
  expect(scheduledReady({ ...complete, GITHUB_TOKEN: "" })).toBe(false);
  expect(scheduledReady({ ...complete, LINEAR_API_KEY: "" })).toBe(false);
  expect(scheduledReady({ ...complete, MANUAL_TRIGGER_TOKEN: "" })).toBe(false);
  expect(scheduledReady(complete)).toBe(true);
});

test("diagnostics expose only validated scalar fields and discard nested secret payloads", () => {
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
  ).toEqual({
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
  ).toEqual({});
});

test("provider reason diagnostics accept only the fixed nonsecret reason allowlist", () => {
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

test("overlapping manual starts preserve provider retry deadlines", async () => {
  const state = memory();

  const runner: StepRunner = {
    step: async () => ({
      checkpoint: 1,
      done: false,
      retryAt: 900_000,
      summary: emptySummary(),
    }),
  };

  const coordinator = new RunCoordinator(state.store, runner, () => 100);
  const run = await coordinator.start(true);
  await coordinator.advance();
  const alarmsBefore = state.alarms.length;
  expect((await coordinator.start(false)).runId).toBe(run.runId);
  expect(state.alarms).toHaveLength(alarmsBefore);
  expect(state.alarms.at(-1)).toBe(900_000);
});

test("missing alarm recovery respects persisted provider retry deadline", async () => {
  const state = memory();

  const runner: StepRunner = {
    step: async () => ({
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

test("run-scoped report keys retain stable repository IDs and reject foreign or malformed keys", () => {
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
