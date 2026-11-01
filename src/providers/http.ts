import { Clock, Effect, Schema } from "effect";

const FailureReason = Schema.Literals([
  "illegal-invocation",
  "timeout",
  "unsupported-redirect",
  "invalid-header",
  "other",
]);

/** Sanitized provider evidence. */
export const ProviderFailureSchema = Schema.Struct({
  kind: Schema.Literals(["http", "network", "invalid-response"]),
  reason: Schema.optionalKey(FailureReason),
  retryAt: Schema.optionalKey(Schema.Number),
  status: Schema.optionalKey(Schema.Number),
});

/** Parsed provider failure evidence. */
export type ProviderFailure = Schema.Schema.Type<typeof ProviderFailureSchema>;

const taggedFailure = Schema.TaggedError;

/** Expected provider failure in the Effect error channel. */
export class ProviderError extends taggedFailure<ProviderError>()(
  "ProviderError",
  ProviderFailureSchema.fields
) {}

/** Transitional result for adapters not yet migrated to Effect. */
export type ProviderResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ProviderFailure };

/** Injectable edge transport and clock. */
export interface HttpOptions {
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  readonly now?: () => number;
}

const transportReason = (
  error: Error
): Schema.Schema.Type<typeof FailureReason> => {
  if (error.message.includes("Illegal invocation")) {
    return "illegal-invocation";
  }

  if (error.name === "TimeoutError" || error.name === "AbortError") {
    return "timeout";
  }

  if (error.message.toLowerCase().includes("header")) {
    return "invalid-header";
  }

  if (error.message.toLowerCase().includes("redirect")) {
    return "unsupported-redirect";
  }

  return "other";
};

const retryDeadline = (headers: Headers, now: number): number => {
  const retry = headers.get("retry-after");
  const seconds = retry === null ? Number.NaN : Number(retry);
  const date = retry === null ? Number.NaN : Date.parse(retry);
  const resetSeconds = Number(headers.get("x-ratelimit-reset"));
  const reset = Number.isFinite(resetSeconds) ? resetSeconds * 1000 : 0;
  const bounded = (deadline: number) => Math.min(deadline, now + 3_600_000);

  if (Number.isFinite(seconds)) {
    return bounded(Math.max(now + 1000, now + seconds * 1000));
  }

  if (Number.isFinite(date)) {
    return bounded(Math.max(now + 1000, date));
  }

  return bounded(Math.max(now + 60_000, reset));
};

const responseFailure = (response: Response, now: number): ProviderError => {
  const limited =
    response.headers.get("x-ratelimit-remaining") === "0" ||
    response.headers.has("retry-after");

  const retryable =
    response.status === 429 ||
    response.status >= 500 ||
    (response.status === 403 && limited);

  if (retryable) {
    return new ProviderError({
      kind: "http",
      retryAt: retryDeadline(response.headers, now),
      status: response.status,
    });
  }

  return new ProviderError({ kind: "http", status: response.status });
};

/** Execute one cancellable edge request; durable callers own retries.
 * @param url - Trusted provider endpoint.
 * @param init - Request configuration kept out of errors.
 * @param options - Edge transport and clock overrides.
 * @returns A native Effect with sanitized failures.
 */
export const requestEffect = Effect.fn("ProviderHttp.request")(
  function* requestEffect(
    url: string,
    init: RequestInit,
    options: HttpOptions
  ) {
    const now =
      options.now === undefined
        ? yield* Clock.currentTimeMillis
        : options.now();

    const networkFailure = (reason: Schema.Schema.Type<typeof FailureReason>) =>
      new ProviderError({ kind: "network", reason, retryAt: now + 60_000 });

    const response = yield* Effect.tryPromise({
      catch: (error) =>
        networkFailure(
          error instanceof Error ? transportReason(error) : "other"
        ),
      try: async (signal) => {
        const requestInit: RequestInit = {
          ...init,
          redirect: "manual",
          signal,
        };

        return await (options.fetch === undefined
          ? globalThis.fetch(url, requestInit)
          : options.fetch(url, requestInit));
      },
    }).pipe(
      Effect.timeoutOrElse({
        duration: "15 seconds",
        orElse: () => Effect.fail(networkFailure("timeout")),
      })
    );

    if (!response.ok) {
      return yield* Effect.fail(responseFailure(response, now));
    }

    return response;
  }
);

const invalidBody = () => new ProviderError({ kind: "invalid-response" });

const cancelReader = (reader: { readonly cancel: () => Promise<void> }) =>
  Effect.sync(() => {
    void reader.cancel().catch(() => null);
  });

/** Parse bounded JSON and cancel the reader when interrupted.
 * @param response - Provider response.
 * @returns Unknown JSON for the provider schema decoder.
 */
export const readJsonEffect = Effect.fn("ProviderHttp.readJson")(
  function* readJson(response: Response) {
    const { body } = response;

    if (body === null) {
      return yield* Effect.fail(invalidBody());
    }

    return yield* Effect.acquireUseRelease(
      Effect.try({ catch: invalidBody, try: () => body.getReader() }),
      (reader) =>
        Effect.gen(function* readBody() {
          const decoder = new TextDecoder();
          let text = "";

          while (true) {
            const chunk = yield* Effect.tryPromise({
              catch: invalidBody,
              try: async () => await reader.read(),
            });

            if (chunk.done) {
              break;
            }

            const bytes = yield* Schema.decodeUnknownEffect(Schema.Uint8Array)(
              chunk.value
            ).pipe(Effect.mapError(invalidBody));

            text += decoder.decode(bytes, { stream: true });
          }

          return yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(Schema.Unknown)
          )(text + decoder.decode()).pipe(Effect.mapError(invalidBody));
        }).pipe(
          Effect.onInterrupt(() => cancelReader(reader)),
          Effect.timeoutOrElse({
            duration: "15 seconds",
            orElse: () => Effect.fail(invalidBody()),
          })
        ),
      (reader) =>
        Effect.sync(() => {
          reader.releaseLock();
        })
    );
  }
);

const decodeFailure = Schema.decodeUnknownSync(ProviderFailureSchema);

const legacyResult = async <T>(
  effect: Effect.Effect<T, ProviderError>
): Promise<ProviderResult<T>> =>
  await Effect.runPromise(
    effect.pipe(
      Effect.match({
        onFailure: (error): ProviderResult<T> => ({
          error: decodeFailure(error),
          ok: false,
        }),
        onSuccess: (value): ProviderResult<T> => ({ ok: true, value }),
      })
    )
  );

/** Promise boundary for existing provider consumers.
 * @param url - Provider endpoint.
 * @param init - Request configuration.
 * @param options - Transport overrides.
 * @returns Sanitized compatibility result.
 */
export const request = async (
  url: string,
  init: RequestInit,
  options: HttpOptions
): Promise<ProviderResult<Response>> =>
  await legacyResult(requestEffect(url, init, options));

/** Promise boundary for existing JSON consumers.
 * @param response - Provider response.
 * @returns Sanitized compatibility result.
 */
export const readJson = async (
  response: Response
): Promise<ProviderResult<unknown>> =>
  await legacyResult(readJsonEffect(response));
