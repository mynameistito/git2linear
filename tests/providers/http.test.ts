import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import { requestEffect } from "../../src/providers/http";

describe("HTTP requests", () => {
  it("rejects redirects without exposing response data", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* redirect() {
          let calls = 0;

          const result = yield* requestEffect(
            "https://example.com/private",
            {},
            {
              fetch: async (_url, init) => {
                calls += 1;
                expect(init.redirect).toBe("manual");

                return await Promise.resolve(
                  new Response(null, {
                    headers: { location: "https://other.example/private" },
                    status: 302,
                  })
                );
              },
            }
          ).pipe(Effect.flip);

          expect(result.status).toBe(302);
          expect(calls).toBe(1);
          expect(JSON.stringify(result)).not.toContain("private");
        })
      ).pipe(Effect.provide(TestClock.layer()))
    );
  });

  it("calculates bounded retry deadlines with the Effect clock", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* rateLimit() {
          yield* TestClock.setTime(10_000);

          const negative = yield* requestEffect(
            "https://example.com",
            {},
            {
              fetch: async () =>
                await Promise.resolve(
                  new Response(null, {
                    headers: { "retry-after": "-5" },
                    status: 429,
                  })
                ),
            }
          ).pipe(Effect.flip);

          expect(negative.retryAt).toBe(11_000);

          const reset = yield* requestEffect(
            "https://example.com",
            {},
            {
              fetch: async () =>
                await Promise.resolve(
                  new Response(null, {
                    headers: { "x-ratelimit-reset": "90" },
                    status: 503,
                  })
                ),
            }
          ).pipe(Effect.flip);

          expect(reset.retryAt).toBe(90_000);

          const date = yield* requestEffect(
            "https://example.com",
            {},
            {
              fetch: async () =>
                await Promise.resolve(
                  new Response(null, {
                    headers: { "retry-after": new Date(120_000).toUTCString() },
                    status: 429,
                  })
                ),
            }
          ).pipe(Effect.flip);

          expect(date.retryAt).toBe(120_000);
        })
      ).pipe(Effect.provide(TestClock.layer()))
    );
  });

  it("interrupts the transport when its virtual timeout expires", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* timeout() {
          const ready = yield* Deferred.make<AbortSignal>();

          const fiber = yield* requestEffect(
            "https://example.com",
            {},
            {
              fetch: async (_url, init) =>
                await (async () => {
                  const { promise, reject } = Promise.withResolvers<Response>();
                  const { signal } = init;

                  if (signal === undefined || signal === null) {
                    reject(
                      new Error(
                        "Transport did not receive a cancellation signal"
                      )
                    );

                    throw new Error(
                      "Transport did not receive a cancellation signal"
                    );
                  }

                  signal.addEventListener(
                    "abort",
                    () => {
                      reject(new Error("private transport detail"));
                    },
                    { once: true }
                  );
                  Effect.runSync(Deferred.succeed(ready, signal));

                  return await promise;
                })(),
            }
          ).pipe(Effect.flip, Effect.forkScoped);

          const signal = yield* Deferred.await(ready);
          yield* TestClock.adjust("15 seconds");
          const failure = yield* Fiber.join(fiber);
          expect(failure.reason).toBe("timeout");
          expect(signal.aborted).toBeTruthy();
          expect(JSON.stringify(failure)).not.toContain("private");
        })
      ).pipe(Effect.provide(TestClock.layer()))
    );
  });
});
