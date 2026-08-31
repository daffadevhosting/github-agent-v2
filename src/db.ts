import type { UserRecord, AgentState } from "./types";

/**
 * Mengambil data pengguna berdasarkan email
 */
export async function getUserByEmail(db: D1Database, email: string): Promise<UserRecord | null> {
  const row = await db
    .prepare(
      `SELECT id, email, name, 
              github_username as githubUsername, 
              github_token as githubToken, 
              avatar_url as avatarUrl, 
              password_hash as passwordHash, 
              salt, 
              created_at as createdAt, 
              updated_at as updatedAt 
       FROM users WHERE email = ?`
    )
    .bind(email.toLowerCase())
    .first<UserRecord>();

  return row || null;
}

/**
 * Mendaftarkan atau memperbarui pengguna yang login via GitHub OAuth
 */
export async function upsertGitHubUser(
  db: D1Database,
  data: {
    email: string;
    name: string;
    githubUsername: string;
    githubToken: string;
    avatarUrl?: string;
  }
): Promise<UserRecord> {
  const now = Date.now();
  const emailNorm = data.email.toLowerCase();
  const existing = await getUserByEmail(db, emailNorm);

  if (existing) {
    await db
      .prepare(
        `UPDATE users 
         SET name = ?, github_username = ?, github_token = ?, avatar_url = ?, updated_at = ? 
         WHERE email = ?`
      )
      .bind(data.name, data.githubUsername, data.githubToken, data.avatarUrl || null, now, emailNorm)
      .run();

    return {
      ...existing,
      name: data.name,
      githubUsername: data.githubUsername,
      githubToken: data.githubToken,
      avatarUrl: data.avatarUrl || null,
      updatedAt: now,
    };
  }

  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO users (id, email, name, github_username, github_token, avatar_url, password_hash, salt, created_at, updated_at) 
       VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`
    )
    .bind(id, emailNorm, data.name, data.githubUsername, data.githubToken, data.avatarUrl || null, now, now)
    .run();

  await db
    .prepare("INSERT OR REPLACE INTO user_states (email, current_repo, current_branch, updated_at) VALUES (?, '', 'main', ?)")
    .bind(emailNorm, now)
    .run();

  return {
    id,
    email: emailNorm,
    name: data.name,
    githubUsername: data.githubUsername,
    githubToken: data.githubToken,
    avatarUrl: data.avatarUrl || null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Pendaftaran akun manual (email & password)
 */
export async function createManualUser(
  db: D1Database,
  user: { email: string; name: string; passwordHash: string; salt: string }
): Promise<UserRecord> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const emailNorm = user.email.toLowerCase();

  await db
    .prepare(
      `INSERT INTO users (id, email, name, github_username, github_token, avatar_url, password_hash, salt, created_at, updated_at) 
       VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?)`
    )
    .bind(id, emailNorm, user.name, user.passwordHash, user.salt, now, now)
    .run();

  await db
    .prepare("INSERT OR REPLACE INTO user_states (email, current_repo, current_branch, updated_at) VALUES (?, '', 'main', ?)")
    .bind(emailNorm, now)
    .run();

  return {
    id,
    email: emailNorm,
    name: user.name,
    passwordHash: user.passwordHash,
    salt: user.salt,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Mengambil status repositori dan branch aktif
 */
export async function getUserState(db: D1Database, email: string): Promise<AgentState> {
  const row = await db
    .prepare("SELECT current_repo as currentRepo, current_branch as currentBranch FROM user_states WHERE email = ?")
    .bind(email.toLowerCase())
    .first<{ currentRepo: string; currentBranch: string }>();

  return {
    currentRepo: row?.currentRepo || "",
    currentBranch: row?.currentBranch || "main",
  };
}

/**
 * Menyimpan status repositori dan branch aktif
 */
export async function saveUserState(
  db: D1Database,
  email: string,
  state: Partial<AgentState>
): Promise<AgentState> {
  const current = await getUserState(db, email);
  const updatedRepo = state.currentRepo !== undefined ? state.currentRepo : current.currentRepo;
  const updatedBranch = state.currentBranch !== undefined ? state.currentBranch : current.currentBranch;

  await db
    .prepare(
      `INSERT INTO user_states (email, current_repo, current_branch, updated_at) 
       VALUES (?, ?, ?, ?) 
       ON CONFLICT(email) DO UPDATE SET 
         current_repo = excluded.current_repo, 
         current_branch = excluded.current_branch, 
         updated_at = excluded.updated_at`
    )
    .bind(email.toLowerCase(), updatedRepo, updatedBranch, Date.now())
    .run();

  return { currentRepo: updatedRepo, currentBranch: updatedBranch };
}

/**
 * Mencatat log riwayat percakapan
 */
export async function logChatMessage(
  db: D1Database,
  email: string,
  role: string,
  message: string
): Promise<void> {
  try {
    await db
      .prepare("INSERT INTO chat_logs (id, email, role, message, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), email.toLowerCase(), role, message, Date.now())
      .run();
  } catch (err) {
    console.warn("Gagal menyimpan chat log:", err);
  }
}