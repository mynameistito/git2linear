/* oxlint-disable sonarjs/max-union-size -- Explicit actionable failure variants preserve exhaustive handling. */
/** Repository inventory parsed by the GitHub boundary. */
export interface Repository {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  readonly url: string;
  readonly archived: boolean;
  readonly disabled: boolean;
}

/** Existing Linear project with its repository attachment URLs. */
export interface Project {
  readonly summary?: string;
  readonly id: string;
  readonly name: string;
  readonly urls: readonly string[];
  readonly teamIds: readonly string[];
  readonly archived: boolean;
}

/** Durable identity retained across repository renames and partial runs. */
export interface Identity {
  readonly repositoryId: number;
  readonly projectId: string;
  readonly repositoryUrl: string;
}

/** Safe project decision; manual outcomes forbid automatic creation. */
export type ProjectPlan =
  | {
      readonly kind: "skip";
      readonly reason: "foreign-owner" | "archived" | "disabled";
    }
  | {
      readonly kind: "manual";
      // oxlint-disable-next-line sonarjs/max-union-size -- Distinct manual outcomes are actionable operational states.
      readonly reason:
        | "ambiguous-project"
        | "missing-mapped-project"
        | "archived-project"
        | "identity-conflict";
    }
  | {
      readonly kind: "create";
      readonly name: string;
      readonly repositoryUrl: string;
    }
  | {
      readonly kind: "reuse";
      readonly projectId: string;
      readonly updateName: string | null;
      readonly attachUrl: string | null;
    };

/** All evidence needed for a deterministic project decision. */
export interface ProjectEvidence {
  readonly repository: Repository;
  readonly owner: string;
  readonly teamId: string;
  readonly projects: readonly Project[];
  readonly identities: readonly Identity[];
}

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
    return { kind: "manual", reason: "identity-conflict" };
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
    return { kind: "manual", reason: "identity-conflict" };
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

/** Existing hook projection; the endpoint must never enter reports or persisted plans. */
export interface RepositoryHook {
  readonly id: number;
  readonly endpoint: string;
  readonly active: boolean;
  readonly events: readonly string[];
  readonly contentType: string;
  readonly insecureSsl: string;
}

/** Hook actions contain no endpoint or secret. Repairs deliberately omit secret changes. */
export type HookPlan =
  | { readonly kind: "create" }
  | { readonly kind: "reuse"; readonly hookId: number }
  | { readonly kind: "repair"; readonly hookId: number }
  | { readonly kind: "manual"; readonly reason: "duplicate-endpoint-hooks" };

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
