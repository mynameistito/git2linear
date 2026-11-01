import { Config, Effect, Redacted, Schema } from "effect";

import { workerIdentity } from "../src/platform/deployment";
import { readJsonEffect, requestEffect } from "../src/providers/http";
import type { HttpOptions } from "../src/providers/http";
import { deploymentConfig } from "./deployment";

const Binding = Schema.Struct({
  class_name: Schema.optionalKey(Schema.String),
  name: Schema.String,
  namespace_id: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
  type: Schema.String,
});

export const Settings = Schema.Struct({
  result: Schema.Struct({ bindings: Schema.Array(Binding) }),
  success: Schema.Literal(true),
});

export const Schedules = Schema.Struct({
  result: Schema.Struct({
    schedules: Schema.Array(Schema.Struct({ cron: Schema.String })),
  }),
  success: Schema.Literal(true),
});

const Failure = Schema.TaggedError;

class PreflightFailure extends Failure<PreflightFailure>()(
  "PreflightFailure",
  {}
) {}

const expectedText = {
  APPLY_ENABLED: "true",
  GITHUB_OWNER: workerIdentity.owner,
  LINEAR_TEAM_ID: "00091889-0699-4cd5-8e23-ef401294956f",
  LINEAR_TEAM_KEY: workerIdentity.teamKey,
};

const alchemyText = {
  ALCHEMY_CLOUDFLARE_ACCOUNT_ID: workerIdentity.accountId,
  ALCHEMY_PHASE: "runtime",
  ALCHEMY_STACK_NAME: workerIdentity.name,
  ALCHEMY_STAGE: "production",
  ALCHEMY_WORKER_NAME: workerIdentity.name,
};

const webhookSecrets = ["LINEAR_WEBHOOK_URL", "LINEAR_WEBHOOK_SECRET"];

const requiredSecrets = [
  "GITHUB_TOKEN",
  "LINEAR_API_KEY",
  "MANUAL_TRIGGER_TOKEN",
];

type WebhookMode = "absent" | "transition" | "required";

const validWebhookCount = (mode: WebhookMode, count: number) => {
  if (mode === "absent") {
    return count === 0;
  }

  if (mode === "required") {
    return count === 2;
  }

  return count === 0 || count === 2;
};

/** Reject unaccounted bindings or changes to production identity and schedule. */
export const validateInventory = Effect.fn("Preflight.validateInventory")(
  function* validateInventory(
    settings: typeof Settings.Type,
    schedules: typeof Schedules.Type,
    webhookMode: WebhookMode = "absent"
  ) {
    const { bindings } = settings.result;
    const names = new Set(bindings.map((binding) => binding.name));

    const alchemyCount = Object.keys(alchemyText).filter((name) =>
      names.has(name)
    ).length;

    const allowed = new Set([
      ...Object.keys(expectedText),
      ...requiredSecrets,
      ...webhookSecrets,
      "RECONCILER",
      ...Object.keys(alchemyText),
    ]);

    if (
      names.size !== bindings.length ||
      bindings.some((binding) => !allowed.has(binding.name)) ||
      (alchemyCount !== 0 && alchemyCount !== Object.keys(alchemyText).length)
    ) {
      return yield* Effect.fail(new PreflightFailure());
    }

    const webhookCount = webhookSecrets.filter((name) =>
      names.has(name)
    ).length;

    if (
      !validWebhookCount(webhookMode, webhookCount) ||
      bindings.length !== 8 + alchemyCount + webhookCount
    ) {
      return yield* Effect.fail(new PreflightFailure());
    }

    if (
      schedules.result.schedules.length !== 1 ||
      schedules.result.schedules[0]?.cron !== workerIdentity.cron
    ) {
      return yield* Effect.fail(new PreflightFailure());
    }

    const textBindings =
      alchemyCount === 0 ? expectedText : { ...expectedText, ...alchemyText };

    for (const [name, value] of Object.entries(textBindings)) {
      if (
        !bindings.some(
          (binding) =>
            binding.name === name &&
            binding.type === "plain_text" &&
            binding.text === value
        )
      ) {
        return yield* Effect.fail(new PreflightFailure());
      }
    }

    for (const name of [
      ...requiredSecrets,
      ...webhookSecrets.filter((secretName) => names.has(secretName)),
    ]) {
      if (
        !bindings.some(
          (binding) => binding.name === name && binding.type === "secret_text"
        )
      ) {
        return yield* Effect.fail(new PreflightFailure());
      }
    }

    if (
      !bindings.some(
        (binding) =>
          binding.name === "RECONCILER" &&
          binding.type === "durable_object_namespace" &&
          binding.class_name === "Reconciler" &&
          binding.namespace_id === "b5361ed9579b4c4d8c768f7d5658faab"
      )
    ) {
      return yield* Effect.fail(new PreflightFailure());
    }

    return {
      bindingCount: bindings.length,
      scheduleCount: 1,
      status: "ok" as const,
    };
  }
);

/** Read only public binding metadata; errors never include provider responses. */
export const preflight = Effect.fn("Preflight.run")(function* preflight(
  options: HttpOptions = {},
  final = false
) {
  const config = yield* deploymentConfig;
  const account = yield* Config.String("CLOUDFLARE_ACCOUNT_ID");
  const token = yield* Config.Redacted("CLOUDFLARE_API_TOKEN");

  if (
    account !== workerIdentity.accountId ||
    config.teamId !== expectedText.LINEAR_TEAM_ID ||
    !config.applyEnabled
  ) {
    return yield* Effect.fail(new PreflightFailure());
  }

  if (Redacted.value(token).trim() === "") {
    return yield* Effect.fail(new PreflightFailure());
  }

  const base = `https://api.cloudflare.com/client/v4/accounts/${workerIdentity.accountId}/workers/scripts/${workerIdentity.name}`;
  const headers = { Authorization: `Bearer ${Redacted.value(token)}` };

  const settings = yield* requestEffect(
    `${base}/settings`,
    { headers },
    options
  ).pipe(Effect.flatMap(readJsonEffect));

  const schedules = yield* requestEffect(
    `${base}/schedules`,
    { headers },
    options
  ).pipe(Effect.flatMap(readJsonEffect));

  const settingsObject = yield* Schema.decodeUnknownEffect(Settings)(settings);

  const schedulesObject =
    yield* Schema.decodeUnknownEffect(Schedules)(schedules);

  let mode: WebhookMode = "absent";

  if (config.webhook !== undefined) {
    mode = final === true ? "required" : "transition";
  }

  return yield* validateInventory(settingsObject, schedulesObject, mode);
});
