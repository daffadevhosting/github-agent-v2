export interface Env {
  AI: Ai;
  ASSETS?: Fetcher;
  DB: D1Database; // Binding database Cloudflare D1
  GITHUB_TOKEN: string;
  GITHUB_OWNER: string;
  TEAM_DOMAIN?: string;
  POLICY_AUD?: string;
  AUTH_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
}

export interface AgentState {
  currentRepo: string;
  currentBranch: string;
}

export interface UserRecord {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  salt: string;
  createdAt: number;
}