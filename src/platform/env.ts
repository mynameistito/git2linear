import {
  Config,
  ConfigProvider,
  Context,
  Effect,
  Layer,
  Redacted,
} from "effect";

/** Platform lifecycle contract. */
export interface Env {
  RECONCILER: DurableObjectNamespace;
  GITHUB_TOKEN: string;
  LINEAR_API_KEY: string;
  LINEAR_WEBHOOK_URL?: string;
  LINEAR_WEBHOOK_SECRET?: string;
  MANUAL_TRIGGER_TOKEN: string;
  GITHUB_OWNER: string;
  LINEAR_TEAM_ID: string;
  LINEAR_TEAM_KEY: string;
  APPLY_ENABLED: string;
}

/** Runtime values are parsed once through the Worker binding provider. */
export interface RuntimeConfig {
  readonly githubToken: Redacted.Redacted;
  readonly linearApiKey: Redacted.Redacted;
  readonly manualTriggerToken: Redacted.Redacted;
  readonly applyEnabled: string;
}

export const RuntimeConfigService = Context.Service<RuntimeConfig>(
  "git2linear/RuntimeConfig"
);

/** Read Worker bindings into redacted runtime configuration.
 * @param env - Worker bindings.
 * @returns A layer providing runtime configuration.
 */
export const runtimeConfigLayer = (env: Env) =>
  Layer.effect(
    RuntimeConfigService,
    Effect.gen(function* readRuntimeConfig() {
      return RuntimeConfigService.of({
        applyEnabled: yield* Config.String("APPLY_ENABLED").pipe(
          Config.withDefault("")
        ),
        githubToken: yield* Config.Redacted("GITHUB_TOKEN").pipe(
          Config.withDefault(Redacted.make(""))
        ),
        linearApiKey: yield* Config.Redacted("LINEAR_API_KEY").pipe(
          Config.withDefault(Redacted.make(""))
        ),
        manualTriggerToken: yield* Config.Redacted("MANUAL_TRIGGER_TOKEN").pipe(
          Config.withDefault(Redacted.make(""))
        ),
      });
    }).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            APPLY_ENABLED: env.APPLY_ENABLED,
            GITHUB_TOKEN: env.GITHUB_TOKEN,
            LINEAR_API_KEY: env.LINEAR_API_KEY,
            MANUAL_TRIGGER_TOKEN: env.MANUAL_TRIGGER_TOKEN,
          })
        )
      )
    )
  );
