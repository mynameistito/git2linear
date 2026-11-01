import { ConfigProvider, Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  preflight,
  Schedules,
  Settings,
  validateInventory,
} from "../../alchemy/preflight";

const bindings = [
  { name: "APPLY_ENABLED", text: "true", type: "plain_text" },
  { name: "GITHUB_OWNER", text: "mynameistito", type: "plain_text" },
  {
    name: "LINEAR_TEAM_ID",
    text: "00091889-0699-4cd5-8e23-ef401294956f",
    type: "plain_text",
  },
  { name: "LINEAR_TEAM_KEY", text: "MY", type: "plain_text" },
  { name: "GITHUB_TOKEN", type: "secret_text" },
  { name: "LINEAR_API_KEY", type: "secret_text" },
  { name: "MANUAL_TRIGGER_TOKEN", type: "secret_text" },
  {
    class_name: "Reconciler",
    name: "RECONCILER",
    namespace_id: "b5361ed9579b4c4d8c768f7d5658faab",
    type: "durable_object_namespace",
  },
];

const schedules = {
  result: { schedules: [{ cron: "0 * * * *" }] },
  success: true,
};

const settings = (items: unknown[]) => ({
  result: { bindings: items },
  success: true,
});

const check = async (
  items: unknown[],
  cron: typeof Schedules.Type = Schema.decodeUnknownSync(Schedules)(schedules)
) =>
  await Effect.runPromiseExit(
    validateInventory(Schema.decodeUnknownSync(Settings)(settings(items)), cron)
  );

describe("deployment preflight", () => {
  it("accepts the exact production metadata", async () => {
    const result = await check(bindings);
    expect(result._tag).toBe("Success");
  });

  it.each(
    [
      bindings.slice(1),
      [...bindings, { name: "UNEXPECTED", type: "secret_text" }],
      [...bindings, ...bindings.slice(0, 1)],
      bindings.map((binding) =>
        binding.name === "RECONCILER"
          ? { ...binding, namespace_id: "wrong" }
          : binding
      ),
      bindings.map((binding) =>
        binding.name === "APPLY_ENABLED"
          ? { ...binding, text: "false" }
          : binding
      ),
      [...bindings, { name: "LINEAR_WEBHOOK_URL", type: "secret_text" }],
    ].map((items) => ({ items }))
  )("rejects changed or incomplete bindings %#", async ({ items }) => {
    const result = await check(items);
    expect(result._tag).toBe("Failure");
  });

  it("rejects changed schedules", async () => {
    const result = await check(bindings, {
      result: { schedules: [] },
      success: true,
    });

    expect(result._tag).toBe("Failure");
  });

  it("fails before an API request when a required secret is missing", async () => {
    let called = false;

    const result = await Effect.runPromiseExit(
      preflight({
        fetch: async () => {
          called = true;

          return await Promise.reject(new Error("unexpected request"));
        },
      }).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              ALCHEMY_CONFIRMED_BINDINGS: "core",
              APPLY_ENABLED: "true",
              CLOUDFLARE_ACCOUNT_ID: "402722ab1f598e783cd6dcdedc37e1d0",
              CLOUDFLARE_API_TOKEN: "synthetic",
              GITHUB_TOKEN: "synthetic",
              LINEAR_TEAM_ID: "00091889-0699-4cd5-8e23-ef401294956f",
              MANUAL_TRIGGER_TOKEN:
                "synthetic-manual-test-value-with-at-least-43-characters",
            })
          )
        )
      )
    );

    expect(result._tag).toBe("Failure");
    expect(called).toBeFalsy();
  });
});
