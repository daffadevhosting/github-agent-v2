import type { Env } from "./types";
import { issueToken } from "./users";

const GH_AUTHORIZE = "https://github.com/login/oauth/authorize";
const GH_TOKEN = "https://github.com/login/oauth/access_token";
const GH_USER = "https://api.github.com/user";
const GH_EMAILS = "https://api.github.com/user/emails";

/** Scopes: identity + repo access so the agent can act on the user's repos */
const SCOPES = "read:user user:email repo";

export function isGitHubOAuthConfigured(env: Env): boolean {
  return !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
}

function redirectUri(request: Request): string {
  const url = new URL(request.url);
  return `${url.origin}/auth/github/callback`;
}

/** Create a short-lived opaque state for CSRF protection */
export function createOAuthState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function githubAuthorizeUrl(env: Env, request: Request, state: string): string {
  const params = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID!,
    redirect_uri: redirectUri(request),
    scope: SCOPES,
    state,
    allow_signup: "true",
  });
  return `${GH_AUTHORIZE}?${params}`;
}

interface GitHubTokenResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string;
}

async function exchangeCode(
  env: Env,
  request: Request,
  code: string
): Promise<string> {
  const res = await fetch(GH_TOKEN, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri(request),
    }),
  });

  const data = (await res.json()) as GitHubTokenResponse;
  if (!res.ok || !data.access_token) {
    throw new Error(
      data.error_description || data.error || "Gagal menukar code OAuth"
    );
  }
  return data.access_token;
}

async function fetchGitHubUser(accessToken: string): Promise<GitHubUser & { email: string }> {
  const res = await fetch(GH_USER, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "cloudflare-github-agent",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub user API ${res.status}`);
  }
  const user = (await res.json()) as GitHubUser;

  let email = user.email || "";
  if (!email) {
    const er = await fetch(GH_EMAILS, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "cloudflare-github-agent",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (er.ok) {
      const emails = (await er.json()) as Array<{
        email: string;
        primary: boolean;
        verified: boolean;
      }>;
      const primary =
        emails.find((e) => e.primary && e.verified) ||
        emails.find((e) => e.verified) ||
        emails[0];
      email = primary?.email || `${user.login}@users.noreply.github.com`;
    } else {
      email = `${user.login}@users.noreply.github.com`;
    }
  }

  return { ...user, email };
}

export interface OAuthSessionUser {
  email: string;
  name: string;
  login: string;
  avatar: string;
  githubId: number;
  /** User's GitHub OAuth token — used for API calls on their behalf */
  githubToken: string;
}

/**
 * Complete OAuth callback: exchange code → profile → session JWT + user payload
 */
export async function completeGitHubOAuth(
  env: Env,
  request: Request,
  code: string
): Promise<{ token: string; user: OAuthSessionUser }> {
  const accessToken = await exchangeCode(env, request, code);
  const gh = await fetchGitHubUser(accessToken);

  const user: OAuthSessionUser = {
    email: gh.email,
    name: gh.name || gh.login,
    login: gh.login,
    avatar: gh.avatar_url,
    githubId: gh.id,
    githubToken: accessToken,
  };

  const token = await issueToken(env, {
    email: user.email,
    name: user.name,
    login: user.login,
    avatar: user.avatar,
    githubId: user.githubId,
    // Do not put the long-lived GitHub token in the JWT; store separately if needed
  });

  return { token, user };
}

/** HTML page that hands the token to the SPA via postMessage / hash, then closes the loop */
export function oauthSuccessRedirect(origin: string, token: string, user: OAuthSessionUser): Response {
  const payload = encodeURIComponent(
    JSON.stringify({
      token,
      user: {
        email: user.email,
        name: user.name,
        login: user.login,
        avatar: user.avatar,
      },
    })
  );
  // Redirect to SPA with auth payload in hash (never sent to server on subsequent nav)
  return Response.redirect(`${origin}/#auth=${payload}`, 302);
}

export function oauthErrorRedirect(origin: string, message: string): Response {
  const q = encodeURIComponent(message);
  return Response.redirect(`${origin}/?auth_error=${q}`, 302);
}
