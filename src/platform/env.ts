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
