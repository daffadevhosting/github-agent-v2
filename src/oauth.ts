import type { Env, UserRecord } from "./types";
import { upsertGitHubUser } from "./db";
import { issueToken } from "./users";

const GH_AUTHORIZE = "https://github.com/login/oauth/authorize";
const GH_TOKEN = "https://github.com/login/oauth/access_token";
const GH_USER = "https://api.github.com/user";
const GH_EMAILS = "https://api.github.com/user/emails";

const SCOPES = "read:user user:email repo";

export function isGitHubOAuthConfigured(env: Env): boolean {
  return !!(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
}

function redirectUri(request: Request): string {
  const url = new URL(request.url);
  return `${url.origin}/auth/github/callback`;
}

export function createOAuthState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function getGitHubAuthorizeUrl(env: Env, request: Request, state: string): string {
  const params = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID || "",
    redirect_uri: redirectUri(request),
    scope: SCOPES,
    state,
    allow_signup: "true",
  });
  return `${GH_AUTHORIZE}?${params.toString()}`;
}

async function exchangeCodeForToken(env: Env, request: Request, code: string): Promise<string> {
  const res = await fetch(GH_TOKEN, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "cloudflare-github-agent-oauth",
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri(request),
    }),
  });

  if (!res.ok) {
    throw new Error(`Gagal menukar token GitHub: HTTP ${res.status}`);
  }

  const data: any = await res.json();
  if (data.error || !data.access_token) {
    throw new Error(data.error_description || data.error || "Gagal mendapatkan access token GitHub");
  }

  return data.access_token;
}

async function fetchGitHubProfile(accessToken: string): Promise<{
  login: string;
  name: string;
  email: string;
  avatar_url: string;
}> {
  const res = await fetch(GH_USER, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "cloudflare-github-agent-oauth",
      Accept: "application/vnd.github+json",
    },
  });

  if (!res.ok) throw new Error("Gagal mengambil profil GitHub");
  const profile: any = await res.json();

  let email = profile.email;
  if (!email) {
    // Ambil email utama jika disembunyikan
    const emailsRes = await fetch(GH_EMAILS, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "cloudflare-github-agent-oauth",
        Accept: "application/vnd.github+json",
      },
    });
    if (emailsRes.ok) {
      const emails: any = await emailsRes.json();
      const primary = emails.find((e: any) => e.primary && e.verified);
      email = primary ? primary.email : emails[0]?.email;
    }
  }

  if (!email) {
    email = `${profile.login}@users.noreply.github.com`;
  }

  return {
    login: profile.login,
    name: profile.name || profile.login,
    email,
    avatar_url: profile.avatar_url || "",
  };
}

export async function handleGitHubOAuthCallback(
  env: Env,
  request: Request,
  code: string
): Promise<{ token: string; user: UserRecord }> {
  const ghAccessToken = await exchangeCodeForToken(env, request, code);
  const profile = await fetchGitHubProfile(ghAccessToken);

  const user = await upsertGitHubUser(env.DB, {
    email: profile.email,
    name: profile.name,
    githubUsername: profile.login,
    githubToken: ghAccessToken,
    avatarUrl: profile.avatar_url,
  });

  const sessionToken = await issueToken(env, { email: user.email, name: user.name });
  return { token: sessionToken, user };
}