CREATE TABLE IF NOT EXISTS account_entitlements (
  email TEXT PRIMARY KEY,
  plan TEXT NOT NULL DEFAULT 'free',
  period_start INTEGER NOT NULL,
  ai_requests INTEGER NOT NULL DEFAULT 0,
  provider TEXT NOT NULL DEFAULT 'workers-ai',
  subscription_status TEXT NOT NULL DEFAULT 'inactive',
  subscription_expires_at INTEGER,
  encrypted_provider_key TEXT,
  provider_key_iv TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS indexed_repositories (
  email TEXT NOT NULL,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  branch TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (email, owner, repo, branch)
);

CREATE INDEX IF NOT EXISTS idx_indexed_repositories_email
  ON indexed_repositories(email);
