import { Config, Schema } from "effect";

/** Stable identity shared by both deployment adapters. */
export const workerIdentity = {
  accountId: "402722ab1f598e783cd6dcdedc37e1d0",
  compatibilityDate: "2026-10-31",
  cron: "0 * * * *",
  name: "git2linear",
  owner: "mynameistito",
  teamKey: "MY",
} as const;

/** Required Linear UUID, validated before deployment configuration is constructed. */
export const teamIdConfig = Config.schema(
  Schema.String.check(
    Schema.isPattern(/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/iu)
  ),
  "LINEAR_TEAM_ID"
);
