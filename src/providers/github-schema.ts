import { Schema } from "effect";

const Id = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
);

const Repository = Schema.Struct({
  archived: Schema.Boolean,
  disabled: Schema.Boolean,
  html_url: Schema.String,
  id: Id,
  name: Schema.String,
  owner: Schema.Struct({ login: Schema.String }),
});

const Hook = Schema.Struct({
  active: Schema.Boolean,
  config: Schema.Struct({
    content_type: Schema.String,
    insecure_ssl: Schema.String,
    url: Schema.String,
  }),
  events: Schema.Array(Schema.String),
  id: Id,
});

const Delivery = Schema.Struct({
  event: Schema.String,
  id: Id,
  status_code: Schema.NullOr(Schema.Number),
});

export const RepositoryPage = Schema.Array(Repository);
export const HookPage = Schema.Array(Hook);
export const DeliveryPage = Schema.Array(Delivery);
export const HookResponse = Hook;
