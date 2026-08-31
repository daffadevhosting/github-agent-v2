import type { UserRecord, AgentState } from "./types";

/**
 * Mencari data pengguna berdasarkan email
 */
export async function getUserByEmail(db: D1Database, email: string): Promise<UserRecord | null> {
  const row = await db
    .prepare("SELECT id, email, name, password_hash as passwordHash, salt, created_at as createdAt FROM users WHERE email = ?")
    .bind(email.toLowerCase())
    .first<UserRecord>();

  return row || null;
}

/**
 * Menyimpan pengguna baru ke dalam database D1
 */
export async function createUser(
  db: D1Database,
  user: { email: string; name: string; passwordHash: string; salt: string }
): Promise<UserRecord> {
  const id = crypto.randomUUID();
  const createdAt = Date.now();
  const emailNorm = user.email.toLowerCase();

  await db
    .prepare("INSERT INTO users (id, email, name, password_hash, salt, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, emailNorm, user.name, user.passwordHash, user.salt, createdAt)
    .run();

  // Inisialisasi state default untuk pengguna baru
  await db
    .prepare("INSERT OR REPLACE INTO user_states (email, current_repo, current_branch, updated_at) VALUES (?, '', 'main', ?)")
    .bind(emailNorm, createdAt)
    .run();

  return {
    id,
    email: emailNorm,
    name: user.name,
    passwordHash: user.passwordHash,
    salt: user.salt,
    createdAt,
  };
}

/**
 * Mengambil state repositori aktif (repo & branch) untuk pengguna
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
 * Memperbarui state repositori aktif (repo & branch) pengguna
 */
export async function saveUserState(
  db: D1Database,
  email: string,
  state: Partial<AgentState>
): Promise<void> {
  const current = await getUserState(db, email);
  const updatedRepo = state.currentRepo !== undefined ? state.currentRepo : current.currentRepo;
  const updatedBranch = state.currentBranch !== undefined ? state.currentBranch : current.currentBranch;

  await db
    .prepare("INSERT INTO user_states (email, current_repo, current_branch, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET current_repo = excluded.current_repo, current_branch = excluded.current_branch, updated_at = excluded.updated_at")
    .bind(email.toLowerCase(), updatedRepo, updatedBranch, Date.now())
    .run();
}

/**
 * Menyimpan riwayat obrolan (opsional untuk audit/log)
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
    console.warn("Gagal menyimpan log chat:", err);
  }
}