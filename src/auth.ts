import { jwtVerify, createRemoteJWKSet } from "jose";
import type { Env } from "./types";

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getAccessJwks(teamDomain: string): ReturnType<typeof createRemoteJWKSet> {
  const certsUrl = `${teamDomain}/cdn-cgi/access/certs`;
  let jwks = jwksCache.get(certsUrl);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(certsUrl));
    jwksCache.set(certsUrl, jwks);
  }
  return jwks;
}

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
    return null;
  }

  try {
    const { payload } = await jwtVerify(token, getAccessJwks(env.TEAM_DOMAIN), {
      issuer: env.TEAM_DOMAIN,
      audience: env.POLICY_AUD,
      algorithms: ["RS256"],
    });
    const email = typeof payload.email === "string" ? payload.email.trim() : "";
    return email ? { email } : null;
  } catch {
    return null;
  }
}
