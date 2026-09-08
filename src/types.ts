export interface Env {
  AI: Ai;
  ASSETS?: Fetcher;
  DB: D1Database;
  VECTOR_INDEX?: VectorizeIndex;
  COLLABORATION_ROOM?: DurableObjectNamespace;
  BROWSER?: Fetcher;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  AUTH_SECRET?: string;
  TEAM_DOMAIN?: string;
  POLICY_AUD?: string;
  // Fallback opsional jika ingin token cadangan
  GITHUB_TOKEN?: string;
  GITHUB_OWNER?: string;
  MIDTRANS_SERVER_KEY?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  DEEPSEEK_API_KEY?: string;
  BYOK_ENCRYPTION_KEY?: string;
}

export interface VectorizeIndex {
  upsert(
    vectors: Array<{
      id: string;
      values: number[];
      namespace?: string;
      metadata?: Record<string, string | number | boolean>;
    }>
  ): Promise<unknown>;
  query(
    vector: number[],
    options?: {
      topK?: number;
      namespace?: string;
      returnMetadata?: "none" | "indexed" | "all";
    }
  ): Promise<{ matches?: Array<{ id: string; score?: number; metadata?: Record<string, unknown> }> }>;
}

export interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): { fetch(request: Request): Promise<Response> };
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

export type PlanName = "free" | "pro" | "team";

export interface UsageState {
  plan: PlanName;
  aiRequests: number;
  indexedRepos: number;
  aiRequestLimit: number;
  indexedRepoLimit: number;
  provider: string;
  subscriptionStatus: string;
  subscriptionExpiresAt: number | null;
}