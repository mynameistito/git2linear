import { AlchemyContext } from "alchemy/AlchemyContext";
import { deployMissing, upgradeOutdated } from "alchemy/State/Provisioning";
import { ConfigProvider, Effect } from "effect";
import { describe, expect, it } from "vitest";

import { stateContextLayer } from "../../alchemy/state-policy";

describe("shared state deployment policy", () => {
  it.each(["missing", "outdated"])(
    "rejects %s shared state even when Worker approval is enabled",
    async (condition) => {
      let mutated = false;

      const mutation = Effect.sync(() => {
        mutated = true;
      });

      const store = { backend: "cloudflare", label: "shared state" };

      const operation =
        condition === "missing"
          ? deployMissing(store, mutation)
          : upgradeOutdated({ ...store, expected: 2, observed: 1 }, mutation);

      const failed = await Effect.runPromise(
        operation.pipe(
          Effect.provide(stateContextLayer),
          Effect.provideService(AlchemyContext, {
            adopt: true,
            dev: false,
            dotAlchemy: ".alchemy",
            updateStateStore: true,
          }),
          Effect.provide(
            ConfigProvider.layer(ConfigProvider.fromUnknown({ CI: "true" }))
          ),
          Effect.match({ onFailure: () => true, onSuccess: () => false })
        )
      );

      expect(failed).toBeTruthy();
      expect(mutated).toBeFalsy();
    }
  );
});
