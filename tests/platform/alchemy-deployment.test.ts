import { ConfigProvider, Effect, Redacted } from "effect";
import { describe, expect, it } from "vitest";

import { deploymentConfig } from "../../alchemy/deployment";

const base = {
  ALCHEMY_CONFIRMED_BINDINGS: "core",
  GITHUB_TOKEN: "synthetic-github",
  LINEAR_API_KEY: "synthetic-linear",
  LINEAR_TEAM_ID: "00000000-0000-4000-8000-000000000001",
  MANUAL_TRIGGER_TOKEN:
    "synthetic-manual-test-value-with-at-least-43-characters",
};

const load = async (values: Record<string, string | null | undefined>) =>
  await Effect.runPromiseExit(
    deploymentConfig.pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(values)))
    )
  );

describe("Alchemy deployment configuration", () => {
  it("accepts the confirmed core inventory and keeps secrets redacted", async () => {
    const result = await Effect.runPromise(
      deploymentConfig.pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(base)))
      )
    );

    expect(Redacted.isRedacted(result.githubToken)).toBeTruthy();
    expect(result.webhook).toBeUndefined();
    expect(result.applyEnabled).toBeFalsy();
  });

  it("accepts both webhook bindings when confirmed", async () => {
    const result = await load({
      ...base,
      ALCHEMY_CONFIRMED_BINDINGS: "core+webhook",
      LINEAR_WEBHOOK_SECRET: "synthetic-secret",
      LINEAR_WEBHOOK_URL: "https://api.linear.app/hooks/test?token=synthetic",
    });

    expect(result._tag).toBe("Success");
  });

  it.each(["linear.app", "client-api.linear.app"])(
    "accepts supported host %s",
    async (host) => {
      const result = await load({
        ...base,
        ALCHEMY_CONFIRMED_BINDINGS: "core+webhook",
        LINEAR_WEBHOOK_SECRET: "synthetic-secret",
        LINEAR_WEBHOOK_URL: `https://${host}/hooks/test`,
      });

      expect(result._tag).toBe("Success");
    }
  );

  it.each([
    ["http:", "//linear.app/hook"].join(""),
    "https://evil.linear.app/hook",
    "https://linear.app.evil.test/hook",
    "https://user@linear.app/hook",
    "https://linear.app/hook#fragment",
    "invalid",
  ])("rejects unsafe webhook URL %#", async (url) => {
    const result = await load({
      ...base,
      ALCHEMY_CONFIRMED_BINDINGS: "core+webhook",
      LINEAR_WEBHOOK_SECRET: "synthetic",
      LINEAR_WEBHOOK_URL: url,
    });

    expect(result._tag).toBe("Failure");
  });

  it.each([
    { ALCHEMY_CONFIRMED_BINDINGS: null },
    { ALCHEMY_CONFIRMED_BINDINGS: "unknown" },
    { LINEAR_TEAM_ID: "invalid" },
    { GITHUB_TOKEN: null },
    { LINEAR_API_KEY: " " },
    { MANUAL_TRIGGER_TOKEN: "" },
    { MANUAL_TRIGGER_TOKEN: "too-short" },
    { LINEAR_WEBHOOK_URL: "synthetic-url" },
    { ALCHEMY_CONFIRMED_BINDINGS: "core+webhook" },
    {
      ALCHEMY_CONFIRMED_BINDINGS: "core+webhook",
      LINEAR_WEBHOOK_SECRET: "synthetic",
    },
    {
      ALCHEMY_CONFIRMED_BINDINGS: "core+webhook",
      LINEAR_WEBHOOK_URL: "https://linear.app/hooks/test",
    },
    {
      LINEAR_WEBHOOK_SECRET: "synthetic-secret",
      LINEAR_WEBHOOK_URL: "synthetic-url",
    },
    {
      ALCHEMY_CONFIRMED_BINDINGS: "core+webhook",
      LINEAR_WEBHOOK_SECRET: " ",
      LINEAR_WEBHOOK_URL: "synthetic-url",
    },
  ])(
    "rejects incomplete or unconfirmed configuration %#",
    async (overrides) => {
      const result = await load({ ...base, ...overrides });

      expect(result._tag).toBe("Failure");
    }
  );
});
