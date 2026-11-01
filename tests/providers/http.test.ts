import { Deferred, Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import { readJsonEffect, requestEffect } from "../../src/providers/http";

describe("HTTP requests", () => {
  it("cancels a stalled response body at its virtual deadline", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* stalledBody() {
          const ready = yield* Deferred.make<boolean>();
          let cancelled = false;

          const stream = new ReadableStream<Uint8Array>({
            cancel() {
              cancelled = true;
            },
            pull() {
              Effect.runSync(Deferred.succeed(ready, true));
            },
          });

          const fiber = yield* readJsonEffect(new Response(stream)).pipe(
            Effect.flip,
            Effect.forkScoped
          );

          yield* Deferred.await(ready);
          yield* TestClock.adjust("15 seconds");
          const failure = yield* Fiber.join(fiber);
          expect(failure.kind).toBe("invalid-response");
          expect(cancelled).toBeTruthy();
          expect(stream.locked).toBeFalsy();
        })
      ).pipe(Effect.provide(TestClock.layer()))
    );
  });

  it.each([
    [{ "x-ratelimit-reset": "invalid" }, 70_000],
    [{ "x-ratelimit-reset": "99999999999999999" }, 3_610_000],
    [{ "retry-after": "999999999999999999" }, 3_610_000],
  ])(
    "bounds malformed and oversized retry headers %j",
    async (headers, expected) => {
      const failure = await Effect.runPromise(
        requestEffect(
          "https://example.com",
          {},
          {
            fetch: async () =>
              await Promise.resolve(
                new Response(null, { headers, status: 429 })
              ),
            now: () => 10_000,
          }
        ).pipe(Effect.flip)
      );

      expect(failure.retryAt).toBe(expected);
      expect(Number.isFinite(failure.retryAt)).toBeTruthy();
    }
  );

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
