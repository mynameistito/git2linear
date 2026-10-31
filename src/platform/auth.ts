/** Compare fixed-size digests.
 * @param request - Incoming request.
 * @param token - Runtime credential.
 * @returns Whether credentials match.
 */
export const authorized = async (
  request: Request,
  token: string | undefined
): Promise<boolean> => {
  if (token === undefined || token.length < 43) {
    return false;
  }

  const supplied = request.headers.get("Authorization") ?? "";

  if (supplied.length > 1024) {
    return false;
  }

  const encoder = new TextEncoder();

  const [actual, expected] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(supplied)),
    crypto.subtle.digest("SHA-256", encoder.encode(`Bearer ${token}`)),
  ]);

  const left = new Uint8Array(actual);
  const right = new Uint8Array(expected);
  let difference = 0;

  for (let index = 0; index < left.length; index += 1) {
    // oxlint-disable-next-line eslint/no-bitwise -- Constant-time digest comparison.
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }

  return difference === 0;
};

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
