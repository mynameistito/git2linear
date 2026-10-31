/* oxlint-disable eslint/no-await-in-loop, eslint/complexity, sonarjs/expression-complexity, anti-slop/no-runtime-typeof -- Sequential secret writes and explicit boundary envelope parsing. */
const names = [
  "GITHUB_TOKEN",
  "LINEAR_API_KEY",
  "MANUAL_TRIGGER_TOKEN",
] as const;

/** Provision only declared secrets, keeping values in memory and HTTPS request bodies. */
const main = async (): Promise<void> => {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const worker = process.env.CLOUDFLARE_WORKER_NAME ?? "git2linear";
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const webhookNames = ["LINEAR_WEBHOOK_URL", "LINEAR_WEBHOOK_SECRET"] as const;

  const suppliedWebhookNames = webhookNames.filter(
    (name) => (process.env[name] ?? "") !== ""
  );

  if (suppliedWebhookNames.length === 1) {
    process.stderr.write(
      "Native webhook credentials must be supplied together.\n"
    );
    process.exitCode = 1;

    return;
  }

  if (suppliedWebhookNames.length === 2) {
    const endpoint = new URL(process.env.LINEAR_WEBHOOK_URL ?? "");

    const validHost = ["api.linear.app", "linear.app"].includes(
      endpoint.hostname
    );

    const validAddress =
      endpoint.protocol === "https:" &&
      endpoint.username === "" &&
      endpoint.password === "";

    if (!validHost || !validAddress || endpoint.hash !== "") {
      process.stderr.write(
        "Native endpoint must be a verified HTTPS Linear address.\n"
      );
      process.exitCode = 1;

      return;
    }
  }

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

  for (const name of [...names, ...suppliedWebhookNames]) {
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
} catch (error: unknown) {
  process.stderr.write(
    `${JSON.stringify({ error: "provision-failed", kind: error instanceof Error ? error.name : "unknown" })}\n`
  );
  process.exitCode = 1;
}
