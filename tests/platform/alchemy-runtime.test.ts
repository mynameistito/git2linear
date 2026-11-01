import { execFileSync } from "node:child_process";

import { Effect } from "effect";
import { describe, expect, it } from "vitest";

describe("Alchemy runtime compatibility", () => {
  it("loads the deployment platform services under Bun", async () => {
    const output = await Effect.runPromise(
      Effect.try(() =>
        execFileSync(
          "bun",
          [
            "-e",
            'const runtime = await import("@effect/platform-bun/BunRuntime"); const auth = await import("alchemy/Auth/OAuthFlow"); console.log(typeof runtime.runMain + "," + typeof auth.makeOAuthClient);',
          ],
          {
            encoding: "utf-8",
            env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
            timeout: 30_000,
          }
        )
      )
    );

    expect(output.trim()).toBe("function,function");
  }, 35_000);

  it("loads authentication, stack, and Cloudflare state under Node", async () => {
    const output = await Effect.runPromise(
      Effect.try(() =>
        execFileSync(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `const [auth, stack, state] = await Promise.all([
            import("alchemy/Auth/OAuthFlow"),
            import("alchemy/Stack"),
            import("@alchemy.run/cloudflare/StateStore"),
          ]);
          console.log([typeof auth.makeOAuthClient, typeof stack.Stack, typeof state.state].join(","));`,
          ],
          {
            encoding: "utf-8",
            env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
            timeout: 30_000,
          }
        )
      )
    );

    expect(output.trim()).toBe("function,function,function");
  }, 35_000);
});
