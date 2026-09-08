import type { Env, UserRecord } from "./types";
import { hashPassword, verifyPassword, issueToken, verifyToken, extractBearer } from "./users";
import {
  getUserByEmail,
  createManualUser,
  getUserState,
  saveUserState,
  consumeAiRequest,
  getUsageState,
  reserveIndexedRepository,
  getProviderSettings,
  updateProviderSettings,
  updateSubscription,
} from "./db";
import { processAgentMessage } from "./agent-executor";
import { verifyAccess } from "./auth";
import { getGitHubAuthorizeUrl, createOAuthState, handleGitHubOAuthCallback } from "./oauth";
import { listUserRepositories, getRepoTree, getFile, createOrUpdateFile } from "./github";
import { indexRepositoryFiles, searchRepository } from "./rag";
import { CollaborationRoom } from "./collaboration";
import { verifyMidtransSignature } from "./billing";
import { encryptProviderKey, type ProviderName } from "./providers";

const corsHeaders: HeadersInit = {
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  Vary: "Origin",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

async function approvalSignature(env: Env, payload: string): Promise<string> {
  if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 32) throw new Error("AUTH_SECRET wajib dikonfigurasi.");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.AUTH_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return base64Url(new Uint8Array(signature));
}

async function createApprovalToken(env: Env, claims: Record<string, unknown>): Promise<string> {
  const encoded = base64Url(new TextEncoder().encode(JSON.stringify(claims)));
  return `${encoded}.${await approvalSignature(env, encoded)}`;
}

async function verifyApprovalToken(env: Env, token: string, expected: Record<string, unknown>): Promise<boolean> {
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.AUTH_SECRET || ""),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    fromBase64Url(signature).buffer as ArrayBuffer,
    new TextEncoder().encode(encoded)
  );
  if (!valid) return false;
  const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(encoded))) as Record<string, unknown>;
  return Number(claims.exp) > Date.now()
    && Object.entries(expected).every(([keyName, value]) => claims[keyName] === value);
}

async function getAuthenticatedUser(request: Request, env: Env): Promise<UserRecord | null> {
  const token = extractBearer(request);
  if (token) {
    const session = await verifyToken(env, token);
    if (session && session.email) {
      const user = await getUserByEmail(env.DB, session.email);
      if (user) return user;
    }
  }

  if (env.TEAM_DOMAIN && env.POLICY_AUD) {
    const accessUser = await verifyAccess(request, env);
    if (accessUser && accessUser.email) {
      const user = await getUserByEmail(env.DB, accessUser.email);
      if (user) return user;
    }
  }

  return null;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // 1. CORS Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // 2. GitHub OAuth Endpoints
    if (path === "/auth/github" && request.method === "GET") {
      if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
        return json({ error: "GITHUB_CLIENT_ID belum dikonfigurasi di Worker secrets." }, 500);
      }
      const state = createOAuthState();
      const authUrl = getGitHubAuthorizeUrl(env, request, state);
      return new Response(null, {
        status: 302,
        headers: {
          Location: authUrl,
          "Set-Cookie": `github_oauth_state=${state}; Max-Age=600; Path=/auth/github; HttpOnly; Secure; SameSite=Lax`,
        },
      });
    }

    if (path === "/auth/github/callback" && request.method === "GET") {
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const stateCookie = request.headers.get("Cookie")?.match(/(?:^|;\s*)github_oauth_state=([^;]+)/)?.[1];
      const error = url.searchParams.get("error_description") || url.searchParams.get("error");

      if (error) {
        return Response.redirect(`${url.origin}/?error=${encodeURIComponent(error)}`, 302);
      }
      if (!code) {
        return Response.redirect(`${url.origin}/?error=Kode+autentikasi+tidak+ditemukan`, 302);
      }
      if (!state || !stateCookie || state !== stateCookie) {
        return Response.redirect(`${url.origin}/?error=OAuth+state+tidak+valid`, 302);
      }

      try {
        const { token, user } = await handleGitHubOAuthCallback(env, request, code);
        const authPayload = encodeURIComponent(
          JSON.stringify({
            token,
            user: {
              email: user.email,
              name: user.name,
              githubUsername: user.githubUsername,
              avatarUrl: user.avatarUrl,
            },
          })
        );
        return new Response(null, {
          status: 302,
          headers: {
            Location: `${url.origin}/#auth=${authPayload}`,
            "Set-Cookie": "github_oauth_state=; Max-Age=0; Path=/auth/github; HttpOnly; Secure; SameSite=Lax",
          },
        });
      } catch (err: any) {
        return Response.redirect(`${url.origin}/?error=${encodeURIComponent(err.message || "Gagal login dengan GitHub")}`, 302);
      }
    }

    // 3. Manual Auth Endpoints
    if (path === "/auth/register" && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const email = (body.email || "").trim().toLowerCase();
        const password = body.password || "";
        const name = (body.name || "").trim() || email.split("@")[0];

        if (!email || !email.includes("@")) return json({ error: "Email tidak valid" }, 400);
        if (password.length < 6) return json({ error: "Password minimal 6 karakter" }, 400);

        const existing = await getUserByEmail(env.DB, email);
        if (existing) return json({ error: "Email sudah terdaftar" }, 409);

        const { hash, salt } = await hashPassword(password);
        const user = await createManualUser(env.DB, { email, name, passwordHash: hash, salt });
        const token = await issueToken(env, { email: user.email, name: user.name });

        return json({
          token,
          user: {
            email: user.email,
            name: user.name,
            githubUsername: user.githubUsername,
            avatarUrl: user.avatarUrl,
          },
        }, 201);
      } catch (err: any) {
        return json({ error: err.message || "Gagal registrasi" }, 500);
      }
    }

    if (path === "/auth/login" && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const email = (body.email || "").trim().toLowerCase();
        const password = body.password || "";

        if (!email || !password) return json({ error: "Email dan password wajib diisi" }, 400);

        const user = await getUserByEmail(env.DB, email);
        if (!user || !user.passwordHash || !user.salt) {
          return json({ error: "Email atau password salah" }, 401);
        }

        const valid = await verifyPassword(password, user.salt, user.passwordHash);
        if (!valid) return json({ error: "Email atau password salah" }, 401);

        const token = await issueToken(env, { email: user.email, name: user.name });
        return json({
          token,
          user: {
            email: user.email,
            name: user.name,
            githubUsername: user.githubUsername,
            avatarUrl: user.avatarUrl,
          },
        });
      } catch (err: any) {
        return json({ error: err.message || "Gagal login" }, 500);
      }
    }

    if (path === "/auth/me" && request.method === "GET") {
      const user = await getAuthenticatedUser(request, env);
      if (!user) return json({ error: "Unauthorized" }, 401);
      return json({
        user: {
          email: user.email,
          name: user.name,
          githubUsername: user.githubUsername,
          avatarUrl: user.avatarUrl,
          hasGitHub: !!user.githubToken,
        },
      });
    }

    // 4. Repositories & File Tree API (Untuk Sidebar Pengguna)
    if (path === "/api/repos" && request.method === "GET") {
      const user = await getAuthenticatedUser(request, env);
      if (!user) return json({ error: "Unauthorized" }, 401);

      const token = user.githubToken || env.GITHUB_TOKEN;
      if (!token) {
        return json({ repos: [], message: "Akun GitHub belum terhubung" });
      }

      try {
        const repos = await listUserRepositories(token);
        return json({ repos });
      } catch (err: any) {
        return json({ error: err.message || "Gagal mengambil daftar repo" }, 500);
      }
    }

    if (path.startsWith("/api/repos/") && path.endsWith("/tree") && request.method === "GET") {
      const user = await getAuthenticatedUser(request, env);
      if (!user) return json({ error: "Unauthorized" }, 401);

      const token = user.githubToken || env.GITHUB_TOKEN;
      if (!token) return json({ error: "Akun GitHub belum terhubung" }, 400);

      const parts = path.replace("/api/repos/", "").replace("/tree", "").split("/");
      const owner = parts[0];
      const repo = parts[1];
      const branch = url.searchParams.get("branch") || "main";

      try {
        const files = await getRepoTree(token, owner, repo, branch);
        return json({ files });
      } catch (err: any) {
        return json({ error: err.message || "Gagal mengambil struktur berkas" }, 500);
      }
    }

    if (path.startsWith("/api/repos/") && path.endsWith("/file") && request.method === "GET") {
      const user = await getAuthenticatedUser(request, env);
      if (!user) return json({ error: "Unauthorized" }, 401);

      const token = user.githubToken || env.GITHUB_TOKEN;
      if (!token) return json({ error: "Akun GitHub belum terhubung" }, 400);

      const parts = path.replace("/api/repos/", "").replace("/file", "").split("/");
      const owner = parts[0];
      const repo = parts[1];
      const filePath = url.searchParams.get("path") || "";
      const branch = url.searchParams.get("branch") || "main";

      if (!filePath) return json({ error: "Parameter path file wajib disertakan" }, 400);

      try {
        const file = await getFile(token, owner, repo, filePath, branch);
        return json({ file });
      } catch (err: any) {
        return json({ error: err.message || "Gagal membaca isi file" }, 500);
      }
    }

    if (path === "/api/repo/file" && request.method === "PUT") {
      const user = await getAuthenticatedUser(request, env);
      if (!user) return json({ error: "Unauthorized" }, 401);
      const token = user.githubToken || env.GITHUB_TOKEN;
      if (!token) return json({ error: "Akun GitHub belum terhubung." }, 400);
      const body = (await request.json().catch(() => ({}))) as {
        owner?: string;
        repo?: string;
        branch?: string;
        path?: string;
        content?: string;
        message?: string;
        baseSha?: string;
        approved?: boolean;
        approvalToken?: string;
      };
      const owner = body.owner || user.githubUsername || env.GITHUB_OWNER;
      if (!owner || !body.repo || !body.branch || !body.path || typeof body.content !== "string") {
        return json({ error: "Owner, repo, branch, path, dan content wajib disertakan." }, 400);
      }
      if (!body.approvalToken) return json({ error: "Perubahan harus direview dan disetujui sebelum commit." }, 428);
      try {
        const contentHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.content));
        const hash = Array.from(new Uint8Array(contentHash), (byte) => byte.toString(16).padStart(2, "0")).join("");
        const approved = await verifyApprovalToken(env, body.approvalToken, {
          email: user.email,
          owner,
          repo: body.repo,
          branch: body.branch,
          path: body.path,
          baseSha: body.baseSha || "",
          contentHash: hash,
        });
        if (!approved) return json({ error: "Approval diff tidak valid atau sudah kedaluwarsa." }, 428);
        const result = await createOrUpdateFile(
          token,
          owner,
          body.repo,
          body.path,
          body.content,
          body.message || `Update ${body.path} via GitHub Agent`,
          body.branch,
          { name: user.name, email: user.email },
          body.baseSha
        );
        return json({ saved: true, path: body.path, branch: body.branch, commit: result?.commit || null });
      } catch (err: any) {
        return json({ error: err.message || "Gagal menyimpan file." }, 500);
      }
    }

    if (path === "/api/repo/preview" && request.method === "POST") {
      const user = await getAuthenticatedUser(request, env);
      if (!user) return json({ error: "Unauthorized" }, 401);
      const token = user.githubToken || env.GITHUB_TOKEN;
      const body = (await request.json().catch(() => ({}))) as {
        owner?: string; repo?: string; branch?: string; path?: string; content?: string;
      };
      const owner = body.owner || user.githubUsername || env.GITHUB_OWNER;
      if (!token || !owner || !body.repo || !body.branch || !body.path || typeof body.content !== "string") {
        return json({ error: "Owner, repo, branch, path, dan content wajib disertakan." }, 400);
      }
      try {
        const current = await getFile(token, owner, body.repo, body.path, body.branch);
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.content));
        const contentHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
        const approvalToken = await createApprovalToken(env, {
          email: user.email, owner, repo: body.repo, branch: body.branch, path: body.path,
          baseSha: current.sha, contentHash, exp: Date.now() + 10 * 60 * 1000,
        });
        return json({ approved: true, baseSha: current.sha, approvalToken, expiresIn: 600 });
      } catch (err: any) {
        return json({ error: err.message || "Gagal membuat preview perubahan." }, 409);
      }
    }

    // 5. Chat & Context API
    if (path === "/api/state" && request.method === "GET") {
      const user = await getAuthenticatedUser(request, env);
      if (!user) return json({ error: "Unauthorized" }, 401);

      const state = await getUserState(env.DB, user.email);
      return json({
        state,
        github: {
          connected: !!user.githubToken,
          username: user.githubUsername,
        },
      });
    }

    if (path === "/api/repo/index" && request.method === "POST") {
      const user = await getAuthenticatedUser(request, env);
      if (!user) return json({ error: "Unauthorized" }, 401);
      if (!env.VECTOR_INDEX) return json({ error: "Vectorize belum dikonfigurasi." }, 503);
      const body = (await request.json().catch(() => ({}))) as {
        owner?: string;
        repo?: string;
        branch?: string;
      };
      const owner = body.owner || user.githubUsername || env.GITHUB_OWNER;
      const repo = body.repo;
      const token = user.githubToken || env.GITHUB_TOKEN;
      if (!owner || !repo || !token) return json({ error: "Owner, repo, dan koneksi GitHub wajib tersedia." }, 400);
      const branch = body.branch || await (await import("./github")).getDefaultBranch(token, owner, repo);
      try {
        await reserveIndexedRepository(env.DB, user.email, owner, repo, branch);
      } catch (err: any) {
        return json({ error: err.message || "Batas repository terindeks tercapai." }, 402);
      }
      const paths = await (await import("./github")).listFiles(token, owner, repo, branch);
      const sourcePaths = paths
        .filter((path) => !/(^|\/)(node_modules|dist|build|vendor)\//.test(path))
        .filter((path) => /\.(ts|tsx|js|jsx|py|go|rs|java|php|rb|vue|svelte|md|json|yml|yaml)$/i.test(path))
        .slice(0, 100);
      const files = [];
      for (const path of sourcePaths) {
        try {
          const file = await getFile(token, owner, repo, path, branch);
          files.push({ path, content: file.content });
        } catch {
          // Skip files that disappear during indexing; GitHub remains the source of truth.
        }
      }
      try {
        const result = await indexRepositoryFiles(env, owner, repo, branch, files);
        return json({ ...result, owner, repo, branch });
      } catch (err: any) {
        return json({ error: err.message || "Gagal mengindeks repository." }, 500);
      }
    }

    if (path === "/api/usage" && request.method === "GET") {
      const user = await getAuthenticatedUser(request, env);
      if (!user) return json({ error: "Unauthorized" }, 401);
      return json({ usage: await getUsageState(env.DB, user.email) });
    }

    if (path === "/api/provider" && request.method === "GET") {
      const user = await getAuthenticatedUser(request, env);
      if (!user) return json({ error: "Unauthorized" }, 401);
      const settings = await getProviderSettings(env.DB, user.email);
      return json({ provider: settings.provider, hasApiKey: !!settings.encryptedKey });
    }

    if (path === "/api/provider" && request.method === "PUT") {
      const user = await getAuthenticatedUser(request, env);
      if (!user) return json({ error: "Unauthorized" }, 401);
      const body = (await request.json().catch(() => ({}))) as { provider?: ProviderName; apiKey?: string };
      const provider = body.provider || "workers-ai";
      if (!["workers-ai", "openai", "anthropic", "deepseek"].includes(provider)) {
        return json({ error: "Provider tidak didukung." }, 400);
      }
      if (provider !== "workers-ai" && !body.apiKey) {
        return json({ error: "API key wajib diisi untuk provider eksternal." }, 400);
      }
      const encrypted = body.apiKey ? await encryptProviderKey(env, body.apiKey.trim()) : null;
      await updateProviderSettings(env.DB, user.email, provider, encrypted?.encrypted || null, encrypted?.iv || null);
      return json({ saved: true, provider, hasApiKey: !!encrypted });
    }

    if (path === "/api/repo/search" && request.method === "POST") {
      const user = await getAuthenticatedUser(request, env);
      if (!user) return json({ error: "Unauthorized" }, 401);
      if (!env.VECTOR_INDEX) return json({ error: "Vectorize belum dikonfigurasi." }, 503);
      const body = (await request.json().catch(() => ({}))) as {
        owner?: string;
        repo?: string;
        branch?: string;
        query?: string;
      };
      const token = user.githubToken || env.GITHUB_TOKEN;
      const owner = body.owner || user.githubUsername || env.GITHUB_OWNER;
      if (!token || !owner || !body.repo || !body.query) {
        return json({ error: "Owner, repo, dan query wajib disertakan." }, 400);
      }
      const branch = body.branch || await (await import("./github")).getDefaultBranch(token, owner, body.repo);
      try {
        const matches = await searchRepository(env, owner, body.repo, branch, body.query);
        return json({ matches, owner, repo: body.repo, branch });
      } catch (err: any) {
        return json({ error: err.message || "Gagal mencari codebase." }, 500);
      }
    }

    if (path.startsWith("/api/collaboration/") && request.method === "GET") {
      const websocketToken = url.searchParams.get("token");
      const authRequest = websocketToken
        ? new Request(request, { headers: new Headers({ ...Object.fromEntries(request.headers), Authorization: `Bearer ${websocketToken}` }) })
        : request;
      const user = await getAuthenticatedUser(authRequest, env);
      if (!user) return json({ error: "Unauthorized" }, 401);
      if (!env.COLLABORATION_ROOM) return json({ error: "Collaboration belum dikonfigurasi." }, 503);
      const roomName = decodeURIComponent(path.slice("/api/collaboration/".length)).trim();
      if (!roomName || roomName.length > 120) return json({ error: "Nama room tidak valid." }, 400);
      const id = env.COLLABORATION_ROOM.idFromName(roomName);
      return env.COLLABORATION_ROOM.get(id).fetch(authRequest);
    }

    if (path === "/api/billing/midtrans/webhook" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as {
        order_id?: string;
        status_code?: string;
        gross_amount?: string;
        signature_key?: string;
        transaction_status?: string;
      };
      if (!body.order_id || !body.status_code || !body.gross_amount || !body.signature_key) {
        return json({ error: "Payload Midtrans tidak lengkap." }, 400);
      }
      try {
        const valid = await verifyMidtransSignature(
          env,
          body.order_id,
          body.status_code,
          body.gross_amount,
          body.signature_key
        );
        if (!valid) return json({ error: "Signature Midtrans tidak valid." }, 401);
        const email = (body as any).email || (body as any).customer_details?.email;
        const status = body.transaction_status || "unknown";
        if (email && (status === "settlement" || status === "capture")) {
          const plan = String((body as any).plan || "pro") as "pro" | "team";
          if (plan === "pro" || plan === "team") {
            await updateSubscription(env.DB, email, plan, status, Date.now() + 30 * 24 * 60 * 60 * 1000);
          }
        }
        return json({ accepted: true, transactionStatus: status });
      } catch (err: any) {
        return json({ error: err.message || "Webhook billing belum dikonfigurasi." }, 503);
      }
    }

    if (path === "/api/chat" && request.method === "POST") {
      const user = await getAuthenticatedUser(request, env);
      if (!user) return json({ error: "Unauthorized" }, 401);

      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const message = body.message || "";
        const context = body.context || null;

        // Jika context repo dikirim, simpan sebagai state aktif (termasuk branch dinamis)
        if (context && context.repo) {
          const stateUpdate: { currentRepo: string; currentBranch?: string } = {
            currentRepo: context.repo,
          };
          if (context.branch) {
            stateUpdate.currentBranch = context.branch;
          }
          await saveUserState(env.DB, user.email, stateUpdate);
        }

        await consumeAiRequest(env.DB, user.email);
        const result = await processAgentMessage(env, user, message);
        return json(result);
      } catch (err: any) {
        const message = err.message || "Gagal memproses pesan";
        return json({ error: message }, message.includes("Batas AI") ? 402 : 500);
      }
    }

    // 6. Static Assets (Frontend UI)
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("Not Found", { status: 404, headers: corsHeaders });
  },
} satisfies ExportedHandler<Env>;

export { CollaborationRoom };