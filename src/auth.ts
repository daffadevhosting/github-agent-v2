import { jwtVerify, createRemoteJWKSet } from "jose";
import type { Env } from "./types";

/**
 * Verify the Cloudflare Access JWT from the Cf-Access-Jwt-Assertion header.
 * Returns the user's email if valid, or null if not authenticated.
 *
 * After deploying, enable Cloudflare Access on your Worker:
 *   Dashboard -> Workers & Pages -> your worker -> Settings -> Domains & Routes -> Enable Cloudflare Access
 *
 * Set these secrets:
 *   npx wrangler secret put TEAM_DOMAIN   (e.g. https://your-team.cloudflareaccess.com)
 *   npx wrangler secret put POLICY_AUD    (your Access app AUD tag)
 */
export async function verifyAccess(
  request: Request,
  env: Env
): Promise<{ email: string } | null> {
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return null;

  if (!env.TEAM_DOMAIN || !env.POLICY_AUD) {
    console.warn("Access secrets not configured. Set TEAM_DOMAIN and POLICY_AUD.");
    return null;
  }

  try {
    const JWKS = createRemoteJWKSet(new URL(`${env.TEAM_DOMAIN}/cdn-cgi/access/certs`));
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: env.TEAM_DOMAIN,
      audience: env.POLICY_AUD,
    });
    return { email: (payload as any).email || "authenticated" };
  } catch {
    return null;
  }
}
