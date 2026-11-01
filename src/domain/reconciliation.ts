import { Schema } from "effect";

export const RepositorySchema = Schema.Struct({
  archived: Schema.Boolean,
  disabled: Schema.Boolean,
  id: Schema.Number,
  name: Schema.String,
  owner: Schema.String,
  url: Schema.String,
});

/** Repository domain model. */
export type Repository = typeof RepositorySchema.Type;

export const ProjectSchema = Schema.Struct({
  archived: Schema.Boolean,
  id: Schema.String,
  name: Schema.String,
  summary: Schema.optionalKey(Schema.String),
  teamIds: Schema.Array(Schema.String),
  urls: Schema.Array(Schema.String),
});

/** Project domain model. */
export type Project = typeof ProjectSchema.Type;

export const IdentitySchema = Schema.Struct({
  projectId: Schema.String,
  repositoryId: Schema.Number,
  repositoryUrl: Schema.String,
});

/** Identity domain model. */
export type Identity = typeof IdentitySchema.Type;

const identityConflict = "identity-conflict";

export const ProjectPlanSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("skip"),
    reason: Schema.Literals(["foreign-owner", "archived", "disabled"]),
  }),
  Schema.Struct({
    kind: Schema.Literal("manual"),
    reason: Schema.Literals([
      "ambiguous-project",
      "missing-mapped-project",
      "archived-project",
      identityConflict,
    ]),
  }),
  Schema.Struct({
    kind: Schema.Literal("create"),
    name: Schema.String,
    repositoryUrl: Schema.String,
  }),
  Schema.Struct({
    attachUrl: Schema.NullOr(Schema.String),
    kind: Schema.Literal("reuse"),
    projectId: Schema.String,
    updateName: Schema.NullOr(Schema.String),
  }),
]);

/** ProjectPlan domain model. */
export type ProjectPlan = typeof ProjectPlanSchema.Type;

export const ProjectEvidenceSchema = Schema.Struct({
  identities: Schema.Array(IdentitySchema),
  owner: Schema.String,
  projects: Schema.Array(ProjectSchema),
  repository: RepositorySchema,
  teamId: Schema.String,
});

/** ProjectEvidence domain model. */
export type ProjectEvidence = typeof ProjectEvidenceSchema.Type;

const canonicalUrl = (url: string): string => {
  let normalized = url.toLowerCase();

  while (normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }

  return normalized.endsWith(".git") ? normalized.slice(0, -4) : normalized;
};

const projectHasUrl = (project: Project, url: string): boolean => {
  const summaryUrl =
    project.summary !== undefined &&
    project.summary.startsWith("GitHub repository: ")
      ? project.summary.slice("GitHub repository: ".length).trim()
      : null;

  return (
    project.urls.some((entry) => canonicalUrl(entry) === canonicalUrl(url)) ||
    (summaryUrl !== null && canonicalUrl(summaryUrl) === canonicalUrl(url))
  );
};

/** Choose a project conservatively, preferring persisted stable identity over mutable names.
 * @param evidence - Complete discovery evidence.
 * @returns A safe project action.
 */
export const planProject = (evidence: ProjectEvidence): ProjectPlan => {
  const { repository, projects, identities } = evidence;

  if (repository.owner.toLowerCase() !== evidence.owner.toLowerCase()) {
    return { kind: "skip", reason: "foreign-owner" };
  }

  if (repository.archived) {
    return { kind: "skip", reason: "archived" };
  }

  if (repository.disabled) {
    return { kind: "skip", reason: "disabled" };
  }

  const saved = identities.filter(
    (identity) => identity.repositoryId === repository.id
  );

  if (new Set(saved.map((identity) => identity.projectId)).size > 1) {
    return { kind: "manual", reason: identityConflict };
  }

  const [identity] = saved;
  let matches: readonly Project[];

  if (identity) {
    matches = projects.filter((project) => project.id === identity.projectId);

    if (matches.length === 0) {
      return { kind: "manual", reason: "missing-mapped-project" };
    }
  } else {
    matches = projects.filter((project) =>
      projectHasUrl(project, repository.url)
    );

    if (matches.length === 0) {
      matches = projects.filter(
        (project) =>
          project.name === repository.name &&
          project.teamIds.includes(evidence.teamId)
      );
    }
  }

  if (matches.length > 1) {
    return { kind: "manual", reason: "ambiguous-project" };
  }

  const [project] = matches;

  if (!project) {
    return {
      kind: "create",
      name: repository.name,
      repositoryUrl: repository.url,
    };
  }

  if (
    identities.some(
      (entry) =>
        entry.projectId === project.id && entry.repositoryId !== repository.id
    )
  ) {
    return { kind: "manual", reason: identityConflict };
  }

  if (project.archived) {
    return { kind: "manual", reason: "archived-project" };
  }

  return {
    attachUrl: project.urls.some(
      (url) => canonicalUrl(url) === canonicalUrl(repository.url)
    )
      ? null
      : repository.url,
    kind: "reuse",
    projectId: project.id,
    updateName: project.name === repository.name ? null : repository.name,
  };
};

export const RepositoryHookSchema = Schema.Struct({
  active: Schema.Boolean,
  contentType: Schema.String,
  endpoint: Schema.String,
  events: Schema.Array(Schema.String),
  id: Schema.Number,
  insecureSsl: Schema.String,
});

/** RepositoryHook domain model. */
export type RepositoryHook = typeof RepositoryHookSchema.Type;

export const HookPlanSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("create") }),
  Schema.Struct({ hookId: Schema.Number, kind: Schema.Literal("reuse") }),
  Schema.Struct({ hookId: Schema.Number, kind: Schema.Literal("repair") }),
  Schema.Struct({
    kind: Schema.Literal("manual"),
    reason: Schema.Literal("duplicate-endpoint-hooks"),
  }),
]);

/** HookPlan domain model. */
export type HookPlan = typeof HookPlanSchema.Type;

/** Manage only exact endpoint matches, leaving unrelated hooks untouched.
 * @param hooks - Discovered repository hooks.
 * @param configuredEndpoint - Secret native endpoint used only for comparison.
 * @returns A safe hook action without credentials.
 */
export const planHook = (
  hooks: readonly RepositoryHook[],
  configuredEndpoint: string
): HookPlan => {
  const matches = hooks.filter((hook) => hook.endpoint === configuredEndpoint);

  if (matches.length > 1) {
    return { kind: "manual", reason: "duplicate-endpoint-hooks" };
  }

  const [hook] = matches;

  if (!hook) {
    return { kind: "create" };
  }

  const configurationCorrect =
    hook.contentType === "json" && hook.insecureSsl === "0";

  const correct =
    configurationCorrect &&
    hook.active &&
    hook.events.length === 1 &&
    hook.events[0] === "push";

  return { hookId: hook.id, kind: correct ? "reuse" : "repair" };
};
