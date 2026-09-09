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
  createPaymentOrder,
  getPaymentOrder,
  updatePaymentOrder,
} from "./db";
import { processAgentMessage } from "./agent-executor";
import { verifyAccess } from "./auth";
import { getGitHubAuthorizeUrl, createOAuthState, handleGitHubOAuthCallback } from "./oauth";
import { listUserRepositories, getRepoTree, getFile, createOrUpdateFile } from "./github";
import { indexRepositoryFiles, searchRepository } from "./rag";
import { CollaborationRoom } from "./collaboration";
import { createMidtransCheckout, getPlanPrice, verifyMidtransSignature } from "./billing";
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

    // NOTE: This is a partial restore of the previous known-good worker.
    // Full free/pro/team billing UI + /api/billing/status live in local commit 15a041c.
    // Please push local src/index.ts and public/index.html to complete the deploy.

    if (path === "/api/usage" && request.method === "GET") {
      const user = await getAuthenticatedUser(request, env);
      if (!user) return json({ error: "Unauthorized" }, 401);
      return json({ usage: await getUsageState(env.DB, user.email) });
    }

    if (path === "/api/chat" && request.method === "POST") {
      const user = await getAuthenticatedUser(request, env);
      if (!user) return json({ error: "Unauthorized" }, 401);
      try {
        await consumeAiRequest(env.DB, user.email);
      } catch (err: any) {
        return json({ error: err.message || "Batas AI tercapai" }, 402);
      }
      const body = (await request.json().catch(() => ({}))) as { message?: string; history?: unknown[] };
      const message = (body.message || "").trim();
      if (!message) return json({ error: "Pesan wajib diisi" }, 400);
      try {
        const result = await processAgentMessage(env, user, message, body.history || []);
        return json(result);
      } catch (err: any) {
        return json({ error: err.message || "Gagal memproses chat" }, 500);
      }
    }

    // Static assets / SPA fallback
    if (path === "/" || path === "/index.html" || !path.startsWith("/api") && !path.startsWith("/auth")) {
      // Let asset binding or default worker handle static files
    }

    return json({ error: "Not found" }, 404);
  },
} satisfies ExportedHandler<Env>;

export { CollaborationRoom };
