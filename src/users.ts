import { SignJWT, jwtVerify } from "jose";
import type { Env } from "./types";

export interface UserRecord {
  email: string;
  name: string;
  passwordHash: string;
  salt: string;
  createdAt: number;
}

const JWT_ISSUER = "github-agent";
const JWT_AUD = "github-agent-session";
const TOKEN_TTL = "7d";

function getJwtSecret(env: Env): Uint8Array {
  // Prefer dedicated secret; fall back to a derived key from existing secrets
  const raw =
    (env as any).AUTH_SECRET ||
    env.GITHUB_TOKEN ||
    "github-agent-dev-secret-change-me";
  return new TextEncoder().encode(raw.slice(0, 64).padEnd(32, "0"));
}

export async function hashPassword(
  password: string,
  salt?: string
): Promise<{ hash: string; salt: string }> {
  const saltBytes = salt
    ? Uint8Array.from(atob(salt), (c) => c.charCodeAt(0))
    : crypto.getRandomValues(new Uint8Array(16));
  const saltB64 = btoa(String.fromCharCode(...saltBytes));

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const derived = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: saltBytes,
      iterations: 100_000,
      hash: "SHA-256",
    },
    keyMaterial,
    256
  );
  const hash = btoa(String.fromCharCode(...new Uint8Array(derived)));
  return { hash, salt: saltB64 };
}

export async function verifyPassword(
  password: string,
  salt: string,
  expectedHash: string
): Promise<boolean> {
  const { hash } = await hashPassword(password, salt);
  return hash === expectedHash;
}

export async function issueToken(
  env: Env,
  user: { email: string; name: string }
): Promise<string> {
  const secret = getJwtSecret(env);
  return new SignJWT({ email: user.email, name: user.name })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUD)
    .setSubject(user.email)
    .setIssuedAt()
    .setExpirationTime(TOKEN_TTL)
    .sign(secret);
}

export async function verifyToken(
  env: Env,
  token: string
): Promise<{ email: string; name: string } | null> {
  try {
    const secret = getJwtSecret(env);
    const { payload } = await jwtVerify(token, secret, {
      issuer: JWT_ISSUER,
      audience: JWT_AUD,
    });
    return {
      email: String(payload.email || payload.sub || ""),
      name: String(payload.name || ""),
    };
  } catch {
    return null;
  }
}

export function extractBearer(request: Request): string | null {
  const h = request.headers.get("Authorization");
  if (!h?.startsWith("Bearer ")) return null;
  return h.slice(7).trim() || null;
}
