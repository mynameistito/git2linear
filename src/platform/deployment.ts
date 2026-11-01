import { Config, Schema } from "effect";

/** Required Linear UUID, validated before deployment configuration is constructed. */
export const teamIdConfig = Config.schema(
  Schema.String.check(
    Schema.isPattern(/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/iu)
  ),
  "LINEAR_TEAM_ID"
);
