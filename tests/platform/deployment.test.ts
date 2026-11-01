import { ConfigProvider, Effect } from "effect";
import { describe, expect, it } from "vitest";

import { teamIdConfig } from "../../src/platform/deployment";

describe("deployment team configuration", () => {
  it.each([undefined, "", "   ", "invalid"])(
    "rejects missing or malformed team ID %j",
    async (value) => {
      const failure = await Effect.runPromise(
        teamIdConfig.pipe(
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({ LINEAR_TEAM_ID: value })
            )
          ),
          Effect.flip
        )
      );

      expect(failure).toBeDefined();
    }
  );

  it("accepts an explicit team UUID", async () => {
    const id = "00000000-0000-4000-8000-000000000001";

    const value = await Effect.runPromise(
      teamIdConfig.pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({ LINEAR_TEAM_ID: id })
          )
        )
      )
    );

    expect(value).toBe(id);
  });
});
