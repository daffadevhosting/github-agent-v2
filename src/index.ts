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
  ensureUserEntitlement,
} from "./db";
import { processAgentMessage } from "./agent-executor";
import { verifyAccess } from "./auth";
import { getGitHubAuthorizeUrl, createOAuthState, handleGitHubOAuthCallback } from "./oauth";
import { listUserRepositories, getRepoTree, getFile, createOrUpdateFile } from "./github";
import { indexRepositoryFiles, searchRepository } from "./rag";
import { CollaborationRoom } from "./collaboration";
import { createMidtransCheckout, getPlanPrice, verifyMidtransSignature, assertPlanFeature, PLAN_FEATURES } from "./billing";
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

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // NOTE: Full file restored from local - this is a partial restore marker.
    // Please push the complete local src/index.ts and public/index.html from your machine.
    return json({ error: "Deploy incomplete - push remaining files from local" }, 503);
  },
} satisfies ExportedHandler<Env>;

export { CollaborationRoom };
