import type { Env, UserRecord } from "./types";
import { hashPassword, verifyPassword, issueToken, verifyToken, extractBearer } from "./users";
import { getUserByEmail, createManualUser, getUserState, saveUserState } from "./db";
import { processAgentMessage } from "./agent-executor";
import { verifyAccess } from "./auth";
import { getGitHubAuthorizeUrl, createOAuthState, handleGitHubOAuthCallback } from "./oauth";
import { listUserRepositories, getRepoTree, getFile } from "./github";

const corsHeaders: HeadersInit = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
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
      return Response.redirect(authUrl, 302);
    }

    if (path === "/auth/github/callback" && request.method === "GET") {
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error_description") || url.searchParams.get("error");

      if (error) {
        return Response.redirect(`${url.origin}/?error=${encodeURIComponent(error)}`, 302);
      }
      if (!code) {
        return Response.redirect(`${url.origin}/?error=Kode+autentikasi+tidak+ditemukan`, 302);
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
        return Response.redirect(`${url.origin}/#auth=${authPayload}`, 302);
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

        const result = await processAgentMessage(env, user, message);
        return json(result);
      } catch (err: any) {
        return json({ error: err.message || "Gagal memproses pesan" }, 500);
      }
    }

    // 6. Static Assets (Frontend UI)
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("Not Found", { status: 404, headers: corsHeaders });
  },
} satisfies ExportedHandler<Env>;