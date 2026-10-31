/* oxlint-disable eslint/no-await-in-loop, sonarjs/expression-complexity, anti-slop/no-runtime-typeof -- Sequential secret writes and explicit boundary envelope parsing. */
const names = [
  "GITHUB_TOKEN",
  "LINEAR_API_KEY",
  "LINEAR_WEBHOOK_URL",
  "LINEAR_WEBHOOK_SECRET",
  "MANUAL_TRIGGER_TOKEN",
] as const;

/** Provision only declared secrets, keeping values in memory and HTTPS request bodies. */
const main = async (): Promise<void> => {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const worker = process.env.CLOUDFLARE_WORKER_NAME ?? "git2linear";
  const token = process.env.CLOUDFLARE_API_TOKEN;

  if (
    (account ?? "") === "" ||
    !/^[a-f\d]{32}$/u.test(account ?? "") ||
    !/^[a-z\d-]+$/u.test(worker) ||
    (token ?? "") === "" ||
    names.some((name) => (process.env[name] ?? "") === "")
  ) {
    process.stderr.write(
      "Missing required deployment metadata or injected credentials.\n"
    );
    process.exitCode = 1;

    return;
  }

  for (const name of names) {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${worker}/secrets`,
      {
        body: JSON.stringify({
          name,
          text: process.env[name],
          type: "secret_text",
        }),
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        method: "PUT",
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      }
    );

    const body: unknown = await response.json();

    // oxlint-disable-next-line sonarjs/expression-complexity, anti-slop/no-runtime-typeof -- Parse the API success envelope only.
    const success =
      response.ok &&
      typeof body === "object" &&
      body !== null &&
      "success" in body &&
      body.success === true;

    process.stdout.write(
      `${JSON.stringify({ binding: name, httpStatus: response.status, provisioned: success })}\n`
    );

    if (!success) {
      process.exitCode = 1;

      return;
    }
  }
};

try {
  await main();
} catch {
  process.stderr.write(
    "Secret provisioning failed; credential and provider details suppressed.\n"
  );
  process.exitCode = 1;
}
