/* oxlint-disable vitest/prefer-importing-vitest-globals -- Bun is the actual test runtime. */
/* oxlint-disable eslint/require-await, eslint/no-await-in-loop -- Deterministic storage fixture and sequential durable maintenance batches. */
import { expect, test } from "vitest";

import { pruneReportBatch } from "../../src/platform/retention";
import type { ReportRetentionStore } from "../../src/platform/retention";

const fixture = () => {
  const records = new Set<string>();
  let cursor: string | undefined;
  const deleted: string[][] = [];

  const store: ReportRetentionStore = {
    cursor: async () => cursor,
    keys: async (after, limit) =>
      [...records]
        .filter(
          (key) =>
            key.startsWith("repository:") &&
            (after === undefined || key > after)
        )
        .toSorted()
        .slice(0, limit),
    remove: async (keys) => {
      deleted.push(keys);

      for (const key of keys) {
        records.delete(key);
      }
    },
    saveCursor: async (next) => {
      cursor = next ?? undefined;
    },
  };

  return { deleted, records, store };
};

test("bounded retention keeps two report sets and stable identity/intent records", async () => {
  const state = fixture();

  for (let index = 0; index < 225; index += 1) {
    state.records.add(`repository:old:${String(index).padStart(3, "0")}`);
  }

  state.records.add("repository:current:42");
  state.records.add("repository:previous:43");
  state.records.add("identity:42");
  state.records.add("intent:42:project");
  let more = true;
  let batches = 0;

  while (more) {
    more = await pruneReportBatch(state.store, "current", "previous");
    batches += 1;
  }

  expect(batches).toBe(3);
  expect(state.deleted.every((batch) => batch.length <= 100)).toBe(true);
  expect([...state.records].toSorted()).toEqual([
    "identity:42",
    "intent:42:project",
    "repository:current:42",
    "repository:previous:43",
  ]);
});

test("interrupted cleanup replays safely without removing current/previous reports", async () => {
  const state = fixture();
  state.records.add("repository:old:1");
  state.records.add("repository:current:2");
  let fail = true;

  const failing = {
    ...state.store,
    saveCursor: async (next: string | null) => {
      if (fail) {
        fail = false;
        throw new Error("interrupted");
      }

      await state.store.saveCursor(next);
    },
  };

  let interrupted = false;

  try {
    await pruneReportBatch(failing, "current", undefined);
  } catch {
    interrupted = true;
  }

  expect(interrupted).toBe(true);
  expect(await pruneReportBatch(state.store, "current", undefined)).toBe(false);
  expect([...state.records]).toEqual(["repository:current:2"]);
});
