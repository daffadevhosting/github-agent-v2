import { GitHubAgent } from "./agent";
import { verifyAccess } from "./auth";
import { verifyToken, extractBearer } from "./users";
import type { Env } from "./types";

export { GitHubAgent };

const corsHeaders: HeadersInit = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-partykit-room, x-partykit-namespace",
};

function agentStub(env: Env) {
  const id = env.GitHubAgent.idFromName("default");
  return env.GitHubAgent.get(id);
}

/**
 * Forward request ke Durable Object dengan menyertakan header room/namespace
 * agar kompatibel dengan Cloudflare Agents / PartyServer SDK.
 */
function forwardToAgent(env: Env, request: Request): Promise<Response> {
  const headers = new Headers(request.headers);
  if (!headers.has("x-partykit-room")) {
    headers.set("x-partykit-room", "default");
  }
  if (!headers.has("x-partykit-namespace")) {
    headers.set("x-partykit-namespace", "github-agent");
  }

  const modifiedReq = new Request(request.url, {
    method: request.method,
    headers,
    body: request.body,
    redirect: request.redirect,
    // @ts-ignore
    duplex: "half",
  });

  return agentStub(env).fetch(modifiedReq);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // --- Handle CORS Preflight ---
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // --- Auth API (proxied to Durable Object storage) ---
    if (path.startsWith("/auth/")) {
      const response = await forwardToAgent(env, request);
      const responseHeaders = new Headers(response.headers);
      Object.entries(corsHeaders).forEach(([k, v]) => {
        responseHeaders.set(k, v as string);
      });
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    }

    // --- WebSocket upgrade ---
    const isWebSocket =
      request.headers.get("Upgrade")?.toLowerCase() === "websocket";

    if (isWebSocket) {
      const bearer =
        extractBearer(request) || url.searchParams.get("token") || null;
      let authenticated = false;

      if (bearer) {
        const session = await verifyToken(env, bearer);
        authenticated = !!session;
      }

      const accessConfigured = !!(env.TEAM_DOMAIN && env.POLICY_AUD);
      if (!authenticated && accessConfigured) {
        const user = await verifyAccess(request, env);
        authenticated = !!user;
      }

      // Local/dev without Access secrets: allow connection
      if (!authenticated && !accessConfigured && !bearer) {
        authenticated = true;
      }

      if (!authenticated) {
        return new Response("Unauthorized — login required", {
          status: 401,
          headers: corsHeaders,
        });
      }

      return forwardToAgent(env, request);
    }

    // --- Static assets (SPA) ---
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("Not Found", { status: 404, headers: corsHeaders });
  },
} satisfies ExportedHandler<Env>;