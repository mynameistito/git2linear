import { Config, Effect, Option, Redacted, Schema } from "effect";

import { teamIdConfig } from "../src/platform/deployment";

const nonBlankSecret = (name: string) =>
  Config.Redacted(name).pipe(
    Config.mapEffect((secret) =>
      Schema.decodeUnknownEffect(Schema.Literal(true))(
        Redacted.value(secret).trim().length > 0
      ).pipe(
        Effect.mapError((issue) => new Config.ConfigError(issue)),
        Effect.as(secret)
      )
    )
  );

/** Load bindings after the operator confirms the complete remote inventory. */
export const deploymentConfig = Effect.gen(function* readDeploymentConfig() {
  const inventory = yield* Config.schema(
    Schema.Literals(["core", "core+webhook"]),
    "ALCHEMY_CONFIRMED_BINDINGS"
  );

  const teamId = yield* teamIdConfig;

  const applyEnabled = yield* Config.Boolean("APPLY_ENABLED").pipe(
    Config.withDefault(false)
  );

  const githubToken = yield* nonBlankSecret("GITHUB_TOKEN");
  const linearApiKey = yield* nonBlankSecret("LINEAR_API_KEY");
  const manualTriggerToken = yield* nonBlankSecret("MANUAL_TRIGGER_TOKEN");

  yield* Schema.decodeUnknownEffect(Schema.Literal(true))(
    Redacted.value(manualTriggerToken).length >= 43
  ).pipe(Effect.mapError((error) => new Config.ConfigError(error)));

  const webhookUrl = yield* Config.option(nonBlankSecret("LINEAR_WEBHOOK_URL"));

  if (Option.isSome(webhookUrl)) {
    const value = Redacted.value(webhookUrl.value);

    yield* Schema.decodeUnknownEffect(Schema.Literal(true))(
      URL.canParse(value)
    ).pipe(Effect.mapError((error) => new Config.ConfigError(error)));

    const address = new URL(value);

    const hasCredentialsOrFragment = Boolean(
      address.username || address.password || address.hash
    );

    yield* Schema.decodeUnknownEffect(Schema.Literal(true))(
      address.protocol === "https:" &&
        ["api.linear.app", "client-api.linear.app", "linear.app"].includes(
          address.hostname
        ) &&
        !hasCredentialsOrFragment
    ).pipe(Effect.mapError((error) => new Config.ConfigError(error)));
  }

  const webhookSecret = yield* Config.option(
    nonBlankSecret("LINEAR_WEBHOOK_SECRET")
  );

  const webhookPresent =
    Option.isSome(webhookUrl) && Option.isSome(webhookSecret);

  const webhookAbsent =
    Option.isNone(webhookUrl) && Option.isNone(webhookSecret);

  yield* Schema.decodeUnknownEffect(Schema.Literal(true))(
    inventory === "core+webhook" ? webhookPresent : webhookAbsent
  ).pipe(Effect.mapError((error) => new Config.ConfigError(error)));

  return {
    applyEnabled,
    githubToken,
    linearApiKey,
    manualTriggerToken,
    teamId,
    webhook:
      Option.isSome(webhookUrl) && Option.isSome(webhookSecret)
        ? { secret: webhookSecret.value, url: webhookUrl.value }
        : undefined,
  };
});
