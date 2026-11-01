import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { pruneEffect, pruneReportBatch } from "../../src/platform/retention";
import type { ReportRetentionStore } from "../../src/platform/retention";

const fixture = () => {
  const records = new Set<string>();
  let cursor: string | undefined;
  const deleted: number[] = [];

  const store: ReportRetentionStore = {
    cursor: async () => await Effect.runPromise(Effect.sync(() => cursor)),
    keys: async (after, limit) =>
      await Promise.resolve(
        [...records]
          .toSorted()
          .filter((key) => key.startsWith("repository:") && key > (after ?? ""))
          .slice(0, limit)
      ),
    remove: async (keys) => {
      deleted.push(keys.length);

      for (const key of keys) {
        records.delete(key);
      }

      await Promise.resolve();
    },
    saveCursor: async (next) => {
      cursor = next ?? undefined;
      await Promise.resolve();
    },
  };

  return { deleted, records, store };
};

describe("report retention", () => {
  it("bounds cleanup and keeps current, previous, identity and intent records", async () => {
    const state = fixture();

    for (let index = 0; index < 225; index += 1) {
      state.records.add(`repository:old:${String(index).padStart(3, "0")}`);
    }

    state.records.add("repository:current:42");
    state.records.add("repository:previous:43");
    state.records.add("identity:42");
    state.records.add("intent:42:project");

    const batches = await Effect.runPromise(
      Effect.gen(function* cleanup() {
        return [
          yield* pruneEffect(state.store, "current", "previous"),
          yield* pruneEffect(state.store, "current", "previous"),
          yield* pruneEffect(state.store, "current", "previous"),
        ];
      })
    );

    expect(batches).toStrictEqual([true, true, false]);
    expect(state.deleted.every((size) => size <= 100)).toBeTruthy();
    expect([...state.records].toSorted()).toStrictEqual([
      "identity:42",
      "intent:42:project",
      "repository:current:42",
      "repository:previous:43",
    ]);
  });

  it("replays interrupted cleanup safely", async () => {
    const state = fixture();

    state.records.add("repository:old:1");
    state.records.add("repository:current:2");
    state.records.add("repository:previous:3");

    const failing: ReportRetentionStore = {
      ...state.store,
      saveCursor: async () =>
        await Effect.runPromise(Effect.fail(new Error("interrupted"))),
    };

    const failure = await Effect.runPromise(
      Effect.flip(pruneEffect(failing, "current", "previous"))
    );

    expect(failure.operation).toBe("retention-save-cursor");
    await expect(
      pruneReportBatch(state.store, "current", "previous")
    ).resolves.toBeFalsy();
    expect([...state.records].toSorted()).toStrictEqual([
      "repository:current:2",
      "repository:previous:3",
    ]);
  });
});
