/* oxlint-disable eslint/complexity, sonarjs/expression-complexity -- Single operator boundary rejects malformed authentication and URLs before network IO. */
/** Operator client accepts credentials only through the process environment. */
const main = async (): Promise<void> => {
  const origin = process.env.WORKER_ORIGIN;
  const token = process.env.MANUAL_TRIGGER_TOKEN;
  const action = process.argv[2] ?? "status";

  if (
    (origin ?? "") === "" ||
    (token ?? "") === "" ||
    (token ?? "").length < 43 ||
    !["status", "dry-run", "apply"].includes(action)
  ) {
    process.stderr.write(
      "Required: WORKER_ORIGIN, strong MANUAL_TRIGGER_TOKEN and status|dry-run|apply.\n"
    );
    process.exitCode = 1;

    return;
  }

  const url = new URL(origin ?? "");

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    process.stderr.write(
      "WORKER_ORIGIN must be an HTTPS origin without credentials or query.\n"
    );
    process.exitCode = 1;

    return;
  }

  url.pathname = action === "status" ? "/status" : "/reconcile";

  if (action !== "status") {
    url.searchParams.set("dryRun", String(action === "dry-run"));
  }

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    method: action === "status" ? "GET" : "POST",
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });

  const body: unknown = await response.json();

  // Project only known safe fields; never echo arbitrary remote error bodies.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Boundary projects only known response fields.
  if (typeof body === "object" && body !== null) {
    const fields = new Set([
      "status",
      "dryRun",
      "runId",
      "summary",
      "startedAt",
      "updatedAt",
      "error",
    ]);

    const safe = Object.fromEntries(
      Object.entries(body).filter(([key]) => fields.has(key))
    );

    process.stdout.write(
      `${JSON.stringify({ httpStatus: response.status, ...safe }, null, 2)}\n`
    );
  }

  if (!response.ok) {
    process.exitCode = 1;
  }
};

try {
  await main();
} catch {
  process.stderr.write(
    "Operator request failed; credentials and remote response suppressed.\n"
  );
  process.exitCode = 1;
}
