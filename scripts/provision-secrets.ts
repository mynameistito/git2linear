import { Config, Effect, Option, Redacted, Schema } from "effect";

import { readJsonEffect, requestEffect } from "../src/providers/http";

const taggedFailure = Schema.TaggedError;

class ProvisionError extends taggedFailure<ProvisionError>()("ProvisionError", {
  operation: Schema.Literals(["configuration", "response", "write"]),
}) {}

const invalidConfig = new ProvisionError({ operation: "configuration" });
const { forEach: forEachEffect } = Effect;

const responseSchema = Schema.Struct({ success: Schema.Boolean });

const provision = Effect.fn("Secrets.provision")(function* provision() {
  const account = yield* Config.String("CLOUDFLARE_ACCOUNT_ID");

  const worker = yield* Config.String("CLOUDFLARE_WORKER_NAME").pipe(
    Config.withDefault("git2linear")
  );

  const token = yield* Config.Redacted("CLOUDFLARE_API_TOKEN");
  const github = yield* Config.Redacted("GITHUB_TOKEN");
  const linear = yield* Config.Redacted("LINEAR_API_KEY");
  const manual = yield* Config.Redacted("MANUAL_TRIGGER_TOKEN");

  const webhookUrl = yield* Config.option(
    Config.Redacted("LINEAR_WEBHOOK_URL")
  );

  const webhookSecret = yield* Config.option(
    Config.Redacted("LINEAR_WEBHOOK_SECRET")
  );

  const secrets = [
    { name: "GITHUB_TOKEN", value: Redacted.value(github) },
    { name: "LINEAR_API_KEY", value: Redacted.value(linear) },
    { name: "MANUAL_TRIGGER_TOKEN", value: Redacted.value(manual) },
  ];

  if (
    !/^[a-f\d]{32}$/u.test(account) ||
    !/^[a-z\d-]+$/u.test(worker) ||
    !Redacted.value(token) ||
    secrets.some((secret) => !secret.value)
  ) {
    yield* Effect.fail(invalidConfig);
  }

  if (Redacted.value(manual).length < 43) {
    yield* Effect.fail(invalidConfig);
  }

  if (Option.isSome(webhookUrl) && Option.isSome(webhookSecret)) {
    const address = yield* Effect.try({
      catch: () => invalidConfig,
      try: () => new URL(Redacted.value(webhookUrl.value)),
    });

    const invalidAddress = Boolean(
      address.username || address.password || address.hash
    );

    if (
      address.protocol !== "https:" ||
      !["api.linear.app", "linear.app"].includes(address.hostname) ||
      invalidAddress ||
      !Redacted.value(webhookSecret.value)
    ) {
      yield* Effect.fail(invalidConfig);
    }

    secrets.push(
      { name: "LINEAR_WEBHOOK_URL", value: Redacted.value(webhookUrl.value) },
      {
        name: "LINEAR_WEBHOOK_SECRET",
        value: Redacted.value(webhookSecret.value),
      }
    );
  } else if (Option.isSome(webhookUrl) || Option.isSome(webhookSecret)) {
    yield* Effect.fail(invalidConfig);
  }

  yield* forEachEffect(
    secrets,
    Effect.fn("Secrets.write")(function* write(secret) {
      const response = yield* requestEffect(
        `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${worker}/secrets`,
        {
          body: JSON.stringify({
            name: secret.name,
            text: secret.value,
            type: "secret_text",
          }),
          headers: {
            Authorization: `Bearer ${Redacted.value(token)}`,
            "Content-Type": "application/json",
          },
          method: "PUT",
        },
        {}
      );

      const body = yield* readJsonEffect(response);

      const result = yield* Schema.decodeUnknownEffect(responseSchema)(
        body
      ).pipe(
        Effect.mapError(() => new ProvisionError({ operation: "response" }))
      );

      process.stdout.write(
        `${JSON.stringify({ binding: secret.name, httpStatus: response.status, provisioned: result.success })}\n`
      );

      if (!result.success) {
        yield* Effect.fail(new ProvisionError({ operation: "write" }));
      }
    }),
    { concurrency: 1 }
  );
});

await Effect.runPromise(
  provision().pipe(
    Effect.catch(() =>
      Effect.sync(() => {
        process.stderr.write("Provisioning failed.\n");
        process.exitCode = 1;
      })
    )
  )
);
