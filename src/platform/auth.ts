import { Effect, Schema } from "effect";

const taggedFailure = Schema.TaggedError;
const algorithm = "HMAC";

/** Cryptographic platform failure without credential-bearing details. */
class AuthenticationError extends taggedFailure<AuthenticationError>()(
  "AuthenticationError",
  {}
) {}

/** Verify credentials through the platform's constant-time HMAC comparison.
 * @param request - Incoming request.
 * @param token - Runtime credential.
 * @returns Whether credentials match.
 */
export const authorizedEffect = Effect.fn("Authentication.verify")(
  function* verify(request: Request, token: string | undefined) {
    if (token === undefined || token.length < 43) {
      return false;
    }

    const supplied = request.headers.get("Authorization") ?? "";

    if (supplied.length > 1024) {
      return false;
    }

    const encoder = new TextEncoder();

    const key = yield* Effect.tryPromise({
      catch: () => new AuthenticationError(),
      try: async () =>
        await crypto.subtle.importKey(
          "raw",
          encoder.encode(token),
          { hash: "SHA-256", name: algorithm },
          false,
          ["sign", "verify"]
        ),
    });

    const expected = yield* Effect.tryPromise({
      catch: () => new AuthenticationError(),
      try: async () =>
        await crypto.subtle.sign(
          algorithm,
          key,
          encoder.encode(`Bearer ${token}`)
        ),
    });

    return yield* Effect.tryPromise({
      catch: () => new AuthenticationError(),
      try: async () =>
        await crypto.subtle.verify(
          algorithm,
          key,
          expected,
          encoder.encode(supplied)
        ),
    });
  }
);

/** Promise boundary for the platform HTTP handler, failing closed on crypto errors.
 * @param request - Incoming request.
 * @param token - Configured credential.
 * @returns Whether authentication succeeded.
 */
export const authorized = async (
  request: Request,
  token: string | undefined
): Promise<boolean> =>
  await Effect.runPromise(
    authorizedEffect(request, token).pipe(
      Effect.catch(() => Effect.succeed(false))
    )
  );

/** Check bootstrap readiness before scheduled work can access providers.
 * @param credentials - Runtime core credentials, absent during bootstrap.
 * @returns Whether scheduled reconciliation can start.
 */
export const scheduledReady = (credentials: {
  readonly GITHUB_TOKEN?: string;
  readonly LINEAR_API_KEY?: string;
  readonly MANUAL_TRIGGER_TOKEN?: string;
}): boolean => {
  const providersPresent = [
    credentials.GITHUB_TOKEN,
    credentials.LINEAR_API_KEY,
  ].every((value) => (value ?? "") !== "");

  return (
    providersPresent && (credentials.MANUAL_TRIGGER_TOKEN ?? "").length >= 43
  );
};
