import { spawnSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const cli = "node_modules/varlock/bin/cli.js";
const manual = "synthetic-manual-test-value-with-at-least-43-characters";

const base = {
  ALCHEMY_CONFIRMED_BINDINGS: "core",
  CLOUDFLARE_ACCOUNT_ID: "00000000000000000000000000000000",
  CLOUDFLARE_API_TOKEN: "synthetic-cloudflare-token",
  GITHUB_TOKEN: "synthetic-github-token",
  LINEAR_API_KEY: "synthetic-linear-key",
  LINEAR_TEAM_ID: "00000000-0000-4000-8000-000000000001",
  MANUAL_TRIGGER_TOKEN: manual,
};

const run = (values: Record<string, string>) =>
  spawnSync(
    process.execPath,
    [
      cli,
      "run",
      "--filter=#deploy",
      "--inject=vars",
      "--",
      process.execPath,
      "-e",
      "process.exit(0)",
    ],
    {
      encoding: "utf-8",
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        ...values,
      },
    }
  );

describe("Varlock deployment schema", () => {
  it("accepts a synthetic complete environment", () => {
    expect(run(base).status).toBe(0);
  });

  it.each([
    { GITHUB_TOKEN: "" },
    { MANUAL_TRIGGER_TOKEN: "too-short" },
    { LINEAR_TEAM_ID: "invalid" },
  ])("fails closed without exposing credentials %#", (overrides) => {
    const result = run({ ...base, ...overrides });
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).not.toContain(manual);
    expect(result.stdout + result.stderr).not.toContain(base.GITHUB_TOKEN);
  });
});
