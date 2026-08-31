import type { Env } from "./types";
import { hashPassword, verifyPassword, issueToken, verifyToken, extractBearer } from "./users";
import { getUserByEmail, createUser, getUserState } from "./db";
import { processAgentMessage } from "./agent-handler";
import { verifyAccess } from "./auth";

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

async function authenticateRequest(request: Request, env: Env): Promise<string | null> {
  const token = extractBearer(request);
  if (token) {
    const session = await verifyToken(env, token);
    if (session) return session.email;
  }

  if (env.TEAM_DOMAIN && env.POLICY_AUD) {
    const accessUser = await verifyAccess(request, env);
    if (accessUser) return accessUser.email;
  }

  // Fallback dev mode jika secret belum diatur
  if (!env.AUTH_SECRET && !token) {
    return "guest@dev.local";
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

    // 2. Auth Endpoints
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
        const user = await createUser(env.DB, { email, name, passwordHash: hash, salt });
        const token = await issueToken(env, { email: user.email, name: user.name });

        return json({ token, user: { email: user.email, name: user.name } }, 201);
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
        if (!user) return json({ error: "Email atau password salah" }, 401);

        const valid = await verifyPassword(password, user.salt, user.passwordHash);
        if (!valid) return json({ error: "Email atau password salah" }, 401);

        const token = await issueToken(env, { email: user.email, name: user.name });
        return json({ token, user: { email: user.email, name: user.name } });
      } catch (err: any) {
        return json({ error: err.message || "Gagal login" }, 500);
      }
    }

    if (path === "/auth/me" && request.method === "GET") {
      const userEmail = await authenticateRequest(request, env);
      if (!userEmail) return json({ error: "Unauthorized" }, 401);
      const user = await getUserByEmail(env.DB, userEmail);
      return json({ user: user ? { email: user.email, name: user.name } : { email: userEmail, name: "User" } });
    }

    // 3. API Chat & State Endpoints (REST API)
    if (path === "/api/state" && request.method === "GET") {
      const userEmail = await authenticateRequest(request, env);
      if (!userEmail) return json({ error: "Unauthorized" }, 401);

      const state = await getUserState(env.DB, userEmail);
      return json({ state });
    }

    if (path === "/api/chat" && request.method === "POST") {
      const userEmail = await authenticateRequest(request, env);
      if (!userEmail) return json({ error: "Unauthorized" }, 401);

      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const message = body.message || "";
        const result = await processAgentMessage(env, userEmail, message);
        return json(result);
      } catch (err: any) {
        return json({ error: err.message || "Gagal memproses pesan" }, 500);
      }
    }

    // 4. Static Assets (Frontend UI)
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("Not Found", { status: 404, headers: corsHeaders });
  },
} satisfies ExportedHandler<Env>;