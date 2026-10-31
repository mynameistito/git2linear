/* oxlint-disable eslint/require-await, unicorn/no-await-expression-member, vitest/prefer-importing-vitest-globals -- Bun async storage fixtures. */
import { expect, test } from "bun:test";

import { authorized } from "../../src/platform/auth";
import { RunCoordinator, emptySummary } from "../../src/platform/run";
import type { RunRecord, RunStore, StepRunner } from "../../src/platform/run";

const memory = () => {
  let record: RunRecord | undefined;
  const alarms: number[] = [];

  const store: RunStore = {
    get: async () => record,
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
