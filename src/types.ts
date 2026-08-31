export interface Env {
  AI: Ai;
  ASSETS?: Fetcher;
  DB: D1Database;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  AUTH_SECRET?: string;
  TEAM_DOMAIN?: string;
  POLICY_AUD?: string;
  // Fallback opsional jika ingin token cadangan
  GITHUB_TOKEN?: string;
  GITHUB_OWNER?: string;
}

export interface AgentState {
  currentRepo: string;
  currentBranch: string;
}

export interface UserRecord {
  id: string;
  email: string;
  name: string;
  githubUsername?: string | null;
  githubToken?: string | null;
  avatarUrl?: string | null;
  passwordHash?: string | null;
  salt?: string | null;
  createdAt: number;
  updatedAt: number;
}