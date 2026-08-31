import type { Env } from "./types";
import { hashPassword, verifyPassword, issueToken, verifyToken, extractBearer } from "./users";
import { getUserByEmail, createUser, getUserState } from "./db";
import { AgentHandler } from "./agent-handler";
import { verifyAccess } from "./auth";

const corsHeaders: HeadersInit = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Upgrade",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // 1. Tangani CORS Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // 2. Auth Endpoints Menggunakan Database D1
    if (path === "/auth/register" && request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const email = (body.email || "").trim().toLowerCase();
        const password = body.password || "";
        const name = (body.name || "").trim() || email.split("@")[0];

        if (!email || !email.includes("@")) {
          return json({ error: "Email tidak valid" }, 400);
        }
        if (password.length < 6) {
          return json({ error: "Password minimal 6 karakter" }, 400);
        }

        const existing = await getUserByEmail(env.DB, email);
        if (existing) {
          return json({ error: "Email sudah terdaftar" }, 409);
        }

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

        if (!email || !password) {
          return json({ error: "Email dan password wajib diisi" }, 400);
        }

        const user = await getUserByEmail(env.DB, email);
        if (!user) {
          return json({ error: "Email atau password salah" }, 401);
        }

        const valid = await verifyPassword(password, user.salt, user.passwordHash);
        if (!valid) {
          return json({ error: "Email atau password salah" }, 401);
        }

        const token = await issueToken(env, { email: user.email, name: user.name });
        return json({ token, user: { email: user.email, name: user.name } });
      } catch (err: any) {
        return json({ error: err.message || "Gagal login" }, 500);
      }
    }

    if (path === "/auth/me" && request.method === "GET") {
      const token = extractBearer(request);
      if (!token) return json({ error: "Unauthorized" }, 401);
      const payload = await verifyToken(env, token);
      if (!payload) return json({ error: "Token tidak valid" }, 401);
      return json({ user: payload });
    }

    // 3. WebSocket Upgrade Native Cloudflare Workers (Tanpa Durable Objects)
    const upgradeHeader = request.headers.get("Upgrade");
    if (upgradeHeader && upgradeHeader.toLowerCase() === "websocket") {
      const token = extractBearer(request) || url.searchParams.get("token");
      let userEmail: string | null = null;

      if (token) {
        const session = await verifyToken(env, token);
        if (session) userEmail = session.email;
      }

      // Verifikasi Cloudflare Access jika diaktifkan
      if (!userEmail && env.TEAM_DOMAIN && env.POLICY_AUD) {
        const accessUser = await verifyAccess(request, env);
        if (accessUser) userEmail = accessUser.email;
      }

      // Mode dev fallback jika secret belum diset
      if (!userEmail && !env.AUTH_SECRET && !token) {
        userEmail = "guest@dev.local";
      }

      if (!userEmail) {
        return new Response("Unauthorized — Token autentikasi diperlukan", {
          status: 401,
          headers: corsHeaders,
        });
      }

      // Buat pasangan WebSocket native Cloudflare
      const webSocketPair = new WebSocketPair();
      const [client, server] = Object.values(webSocketPair);

      // Terima koneksi pada sisi server
      server.accept();

      // Inisialisasi state agen dari database D1
      ctx.waitUntil(
        (async () => {
          const state = await getUserState(env.DB, userEmail);
          const agent = new AgentHandler(env, userEmail, state, server);

          await agent.onConnect();

          server.addEventListener("message", async (event) => {
            const message = typeof event.data === "string" ? event.data : "";
            await agent.handleUserMessage(message);
          });

          server.addEventListener("close", () => {
            console.log(`[WS] Koneksi ditutup untuk: ${userEmail}`);
          });

          server.addEventListener("error", (e) => {
            console.warn(`[WS Error] Pengguna ${userEmail}:`, e);
          });
        })()
      );

      // Kembalikan respons 101 Switching Protocols ke browser
      return new Response(null, {
        status: 101,
        webSocket: client,
        headers: corsHeaders,
      });
    }

    // 4. Static Assets (Jika frontend disajikan oleh Worker)
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("Endpoint tidak ditemukan", { status: 404, headers: corsHeaders });
  },
} satisfies ExportedHandler<Env>;