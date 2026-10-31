/* oxlint-disable eslint/complexity, sonarjs/max-union-size -- Safe diagnostic reasons are a fixed explicit allowlist. */
/** Sanitized provider failure; deliberately excludes raw responses and request URLs. */
export interface ProviderFailure {
  readonly kind: "http" | "network" | "invalid-response";
  readonly status?: number;
  readonly retryAt?: number;
  readonly reason?:
    | "illegal-invocation"
    | "timeout"
    | "unsupported-redirect"
    | "invalid-header"
    | "other";
}

/** Expected network and parsing failures remain values. */
export type ProviderResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ProviderFailure };

/** Injectable HTTP boundary. */
export interface HttpOptions {
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  readonly now?: () => number;
}

/** Perform one bounded attempt; durable callers schedule retries rather than sleeping.
 * @param url - Trusted provider URL.
 * @param init - Request including credentials, never retained in errors.
 * @param options - Transport and clock.
 * @returns Response or sanitized failure with a durable retry deadline.
 */
export const request = async (
  url: string,
  init: RequestInit,
  options: HttpOptions
): Promise<ProviderResult<Response>> => {
  const now = options.now ?? Date.now;

  try {
    const requestInit: RequestInit = {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    };

    const response =
      options.fetch === undefined
        ? await globalThis.fetch(url, requestInit)
        : await options.fetch(url, requestInit);

    if (response.ok) {
      return { ok: true, value: response };
    }

    const limited =
      response.headers.get("x-ratelimit-remaining") === "0" ||
      response.headers.has("retry-after");

    const retryable =
      response.status === 429 ||
      response.status >= 500 ||
      (response.status === 403 && limited);

    if (!retryable) {
      return { error: { kind: "http", status: response.status }, ok: false };
    }

    const retry = response.headers.get("retry-after");
    const seconds = retry === null ? Number.NaN : Number(retry);
    const retryDate = retry === null ? Number.NaN : Date.parse(retry);
    const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000;

    const deadline = Number.isFinite(seconds)
      ? now() + seconds * 1000
      : retryDate;

    let fallback = now() + 60_000;

    if (reset > now()) {
      fallback = reset;
    }

    const retryAt = Math.max(
      now() + 1000,
      Number.isFinite(deadline) ? deadline : fallback
    );

    return {
      error: {
        kind: "http",
        retryAt,
        status: response.status,
      },
      ok: false,
    };
  } catch (error) {
    let reason:
      | "illegal-invocation"
      | "timeout"
      | "unsupported-redirect"
      | "invalid-header"
      | "other" = "other";

    if (error instanceof Error) {
      if (error.message.includes("Illegal invocation")) {
        reason = "illegal-invocation";
      } else if (error.name === "TimeoutError" || error.name === "AbortError") {
        reason = "timeout";
      } else if (error.message.toLowerCase().includes("header")) {
        reason = "invalid-header";
      } else if (error.message.toLowerCase().includes("redirect")) {
        reason = "unsupported-redirect";
      }
    }

    return {
      error: { kind: "network", reason, retryAt: now() + 60_000 },
      ok: false,
    };
  }
};

/** Parse JSON without retaining untrusted response content.
 * @param response - Provider response.
 * @returns Unknown JSON or safe failure.
 */
export const readJson = async (
  response: Response
): Promise<ProviderResult<unknown>> => {
  try {
    return { ok: true, value: await response.json() };
  } catch {
    return { error: { kind: "invalid-response" }, ok: false };
  }
};
