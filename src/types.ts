export interface Env {
  AI: Ai;
  ASSETS: Fetcher;
  GitHubAgent: DurableObjectNamespace;
  GITHUB_TOKEN: string;
  GITHUB_OWNER: string;
  TEAM_DOMAIN: string;
  POLICY_AUD: string;
  AUTH_SECRET?: string;
}

export interface AgentState {
  currentRepo: string;
  currentBranch: string;
}
