import { Context, Schema } from "effect";

import type { LinearOperations } from "./linear.ts";

/** Injectable Linear operations. */
export class LinearService extends Context.Service<
  LinearService,
  LinearOperations
>()("git2linear/LinearService") {}

const complete = Schema.Struct({ hasNextPage: Schema.Literal(false) });

const teams = Schema.Struct({
  nodes: Schema.Array(Schema.Struct({ id: Schema.String })),
  pageInfo: complete,
});

const links = Schema.Struct({
  nodes: Schema.Array(Schema.Struct({ url: Schema.String })),
  pageInfo: complete,
});

const project = Schema.Struct({
  archivedAt: Schema.NullOr(Schema.String),
  description: Schema.String,
  externalLinks: links,
  id: Schema.String,
  name: Schema.String,
  teams,
});

const pageInfo = Schema.Union([
  Schema.Struct({
    endCursor: Schema.String,
    hasNextPage: Schema.Literal(true),
  }),
  Schema.Struct({
    endCursor: Schema.optionalKey(Schema.Unknown),
    hasNextPage: Schema.Literal(false),
  }),
]);

const envelope = <T extends Schema.Constraint>(data: T) =>
  Schema.Struct({ data, errors: Schema.optionalKey(Schema.Never) });

/** GraphQL project inventory response. */
export const ProjectsResponse = envelope(
  Schema.Struct({
    projects: Schema.Struct({ nodes: Schema.Array(project), pageInfo }),
  })
);

/** GraphQL team identity response. */
export const TeamResponse = envelope(
  Schema.Struct({
    team: Schema.Struct({ id: Schema.String, key: Schema.String }),
  })
);

const success = Schema.Struct({ success: Schema.Boolean });

/** GraphQL project creation acknowledgement. */
export const CreateResponse = envelope(
  Schema.Struct({ projectCreate: success })
);

/** GraphQL project update acknowledgement. */
export const UpdateResponse = envelope(
  Schema.Struct({ projectUpdate: success })
);

/** GraphQL external link acknowledgement. */
export const AttachResponse = envelope(
  Schema.Struct({ entityExternalLinkCreate: success })
);
