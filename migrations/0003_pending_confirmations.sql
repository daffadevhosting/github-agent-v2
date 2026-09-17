CREATE TABLE IF NOT EXISTS pending_confirmations (
  email TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);