/** Compare fixed-size digests.
 * @param request - Incoming request.
 * @param token - Runtime credential.
 * @returns Whether credentials match.
 */
export const authorized = async (
  request: Request,
  token: string
): Promise<boolean> => {
  if (token.length < 43) {
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
