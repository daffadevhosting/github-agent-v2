import type { UserRecord, AgentState } from "./types";
import type { PlanName, UsageState } from "./types";
import { PLAN_LIMITS } from "./billing";

let schemaReady: Promise<void> | null = null;

export async function ensurePlatformSchema(db: D1Database): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await db.prepare(`CREATE TABLE IF NOT EXISTS account_entitlements (
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
        )`).run();
      await db.prepare(`CREATE TABLE IF NOT EXISTS indexed_repositories (
          email TEXT NOT NULL,
          owner TEXT NOT NULL,
          repo TEXT NOT NULL,
          branch TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (email, owner, repo, branch)
        )`).run();
      await db.prepare("CREATE INDEX IF NOT EXISTS idx_indexed_repositories_email ON indexed_repositories(email)").run();
      await db.prepare(`CREATE TABLE IF NOT EXISTS payment_orders (
        order_id TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        plan TEXT NOT NULL,
        gross_amount INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`).run();
    })().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }

  await schemaReady;
}

export async function createPaymentOrder(
  db: D1Database,
  order: { orderId: string; email: string; plan: string; grossAmount: number }
): Promise<void> {
  await ensurePlatformSchema(db);
  const now = Date.now();
  await db.prepare(
    `INSERT INTO payment_orders (order_id, email, plan, gross_amount, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?)`
  ).bind(order.orderId, order.email.toLowerCase(), order.plan, order.grossAmount, now, now).run();
}

export async function getPaymentOrder(db: D1Database, orderId: string): Promise<{ email: string; plan: string; grossAmount: number; status: string } | null> {
  await ensurePlatformSchema(db);
  return db.prepare(
    "SELECT email, plan, gross_amount as grossAmount, status FROM payment_orders WHERE order_id = ?"
  ).bind(orderId).first();
}

export async function updatePaymentOrder(db: D1Database, orderId: string, status: string): Promise<void> {
  await ensurePlatformSchema(db);
  await db.prepare("UPDATE payment_orders SET status = ?, updated_at = ? WHERE order_id = ?")
    .bind(status, Date.now(), orderId).run();
}

export async function getUsageState(db: D1Database, email: string): Promise<UsageState> {
  await ensurePlatformSchema(db);
  const normalized = email.toLowerCase();
  const now = Date.now();
  const row = await db.prepare("SELECT * FROM account_entitlements WHERE email = ?").bind(normalized).first<any>();
  if (!row) {
    await db.prepare(
      `INSERT INTO account_entitlements
       (email, plan, period_start, ai_requests, provider, subscription_status, updated_at)
       VALUES (?, 'free', ?, 0, 'workers-ai', 'inactive', ?)`
    ).bind(normalized, now, now).run();
    return getUsageState(db, normalized);
  }
  let plan = (row.plan in PLAN_LIMITS ? row.plan : "free") as PlanName;
  const periodStart = Number(row.period_start || now);
  const month = 30 * 24 * 60 * 60 * 1000;
  if (now - periodStart >= month) {
    await db.prepare("UPDATE account_entitlements SET period_start = ?, ai_requests = 0, updated_at = ? WHERE email = ?")
      .bind(now, now, normalized).run();
    row.ai_requests = 0;
  }
  if (row.subscription_expires_at && Number(row.subscription_expires_at) <= now && plan !== "free") {
    plan = "free";
    await db.prepare(
      "UPDATE account_entitlements SET plan = 'free', subscription_status = 'expired', updated_at = ? WHERE email = ?"
    ).bind(now, normalized).run();
  }
  const indexed = await db.prepare("SELECT COUNT(*) AS count FROM indexed_repositories WHERE email = ?")
    .bind(normalized).first<{ count: number }>();
  return {
    plan,
    aiRequests: Number(row.ai_requests || 0),
    indexedRepos: Number(indexed?.count || 0),
    aiRequestLimit: PLAN_LIMITS[plan].aiRequests,
    indexedRepoLimit: PLAN_LIMITS[plan].indexedRepos,
    provider: row.provider || "workers-ai",
    subscriptionStatus: row.subscription_status || "inactive",
    subscriptionExpiresAt: row.subscription_expires_at ? Number(row.subscription_expires_at) : null,
  };
}

export async function consumeAiRequest(db: D1Database, email: string): Promise<UsageState> {
  const current = await getUsageState(db, email);
  if (current.aiRequests >= current.aiRequestLimit) {
    throw new Error(`Batas AI paket ${current.plan} sudah tercapai. Upgrade paket untuk melanjutkan.`);
  }
  const result = await db.prepare(
    "UPDATE account_entitlements SET ai_requests = ai_requests + 1, updated_at = ? WHERE email = ? AND ai_requests < ?"
  ).bind(Date.now(), email.toLowerCase(), current.aiRequestLimit).run();
  if (!(result as any).meta?.changes) throw new Error(`Batas AI paket ${current.plan} sudah tercapai.`);
  return getUsageState(db, email);
}

export async function reserveIndexedRepository(
  db: D1Database,
  email: string,
  owner: string,
  repo: string,
  branch: string
): Promise<UsageState> {
  const current = await getUsageState(db, email);
  const existing = await db.prepare(
    "SELECT 1 FROM indexed_repositories WHERE email = ? AND owner = ? AND repo = ? AND branch = ?"
  ).bind(email.toLowerCase(), owner, repo, branch).first();
  if (existing) return current;
  if (current.indexedRepos >= current.indexedRepoLimit) {
    throw new Error(`Batas repository terindeks paket ${current.plan} sudah tercapai.`);
  }
  await db.prepare(
    "INSERT OR IGNORE INTO indexed_repositories (email, owner, repo, branch, created_at) VALUES (?, ?, ?, ?, ?)"
  ).bind(email.toLowerCase(), owner, repo, branch, Date.now()).run();
  return getUsageState(db, email);
}

export async function updateProviderSettings(
  db: D1Database,
  email: string,
  provider: string,
  encryptedKey: string | null,
  iv: string | null
): Promise<void> {
  await ensurePlatformSchema(db);
  await db.prepare(
    `INSERT INTO account_entitlements (email, period_start, provider, encrypted_provider_key, provider_key_iv, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET provider = excluded.provider,
       encrypted_provider_key = excluded.encrypted_provider_key, provider_key_iv = excluded.provider_key_iv,
       updated_at = excluded.updated_at`
  ).bind(email.toLowerCase(), Date.now(), provider, encryptedKey, iv, Date.now()).run();
}

export async function getProviderSettings(db: D1Database, email: string): Promise<{ provider: string; encryptedKey: string | null; iv: string | null }> {
  await ensurePlatformSchema(db);
  const row = await db.prepare(
    "SELECT provider, encrypted_provider_key as encryptedKey, provider_key_iv as iv FROM account_entitlements WHERE email = ?"
  ).bind(email.toLowerCase()).first<{ provider: string; encryptedKey: string | null; iv: string | null }>();
  return { provider: row?.provider || "workers-ai", encryptedKey: row?.encryptedKey || null, iv: row?.iv || null };
}

export async function updateSubscription(
  db: D1Database,
  email: string,
  plan: PlanName,
  status: string,
  expiresAt: number | null
): Promise<void> {
  await ensurePlatformSchema(db);
  const now = Date.now();
  // Aktivasi paket: reset kuota periode + status normalisasi (active/expired)
  const normalizedStatus =
    status === "settlement" || status === "capture" || status === "active"
      ? "active"
      : status === "expire" || status === "deny" || status === "cancel"
        ? "expired"
        : status;
  await db.prepare(
    `INSERT INTO account_entitlements
      (email, plan, period_start, ai_requests, provider, subscription_status, subscription_expires_at, updated_at)
     VALUES (?, ?, ?, 0, 'workers-ai', ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       plan = excluded.plan,
       period_start = excluded.period_start,
       ai_requests = 0,
       subscription_status = excluded.subscription_status,
       subscription_expires_at = excluded.subscription_expires_at,
       updated_at = excluded.updated_at`
  ).bind(email.toLowerCase(), plan, now, normalizedStatus, expiresAt, now).run();
}

/** Pastikan baris entitlement free tersedia untuk user baru */
export async function ensureUserEntitlement(db: D1Database, email: string): Promise<void> {
  await getUsageState(db, email);
}

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

    await ensureUserEntitlement(db, emailNorm);
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
  try {
    await db
      .prepare(
        `INSERT INTO users (id, email, name, github_username, github_token, avatar_url, password_hash, salt, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`
      )
      .bind(id, emailNorm, data.name, data.githubUsername, data.githubToken, data.avatarUrl || null, now, now)
      .run();
  } catch (error) {
    throw new Error(`Gagal menyimpan pengguna GitHub ${emailNorm}.`, { cause: error });
  }

  await db
    .prepare("INSERT OR REPLACE INTO user_states (email, current_repo, current_branch, updated_at) VALUES (?, '', 'main', ?)")
    .bind(emailNorm, now)
    .run();

  await ensurePlatformSchema(db);
  await db.prepare(
    `INSERT OR IGNORE INTO account_entitlements
      (email, plan, period_start, ai_requests, provider, subscription_status, updated_at)
     VALUES (?, 'free', ?, 0, 'workers-ai', 'inactive', ?)`
  ).bind(emailNorm, now, now).run();

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

  // Akun baru selalu mulai dari paket free + kuota 0
  await ensurePlatformSchema(db);
  await db.prepare(
    `INSERT OR IGNORE INTO account_entitlements
      (email, plan, period_start, ai_requests, provider, subscription_status, updated_at)
     VALUES (?, 'free', ?, 0, 'workers-ai', 'inactive', ?)`
  ).bind(emailNorm, now, now).run();

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
