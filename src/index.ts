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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // 1. Handle CORS Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // 2. Auth API (diteruskan ke Durable Object)
    if (path.startsWith("/auth/")) {
      const headers = new Headers(request.headers);
      headers.set("x-partykit-room", "default");
      headers.set("x-partykit-namespace", "github-agent");

      const modifiedReq = new Request(request.url, {
        method: request.method,
        headers,
        body: request.body,
        redirect: request.redirect,
        // @ts-ignore
        duplex: "half",
      });

      const response = await agentStub(env).fetch(modifiedReq);
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

    // 3. WebSocket Upgrade
    const isWebSocket =
      request.headers.get("Upgrade")?.toLowerCase() === "websocket";

    if (isWebSocket) {
      const bearer =
        extractBearer(request) || url.searchParams.get("token") || null;
      let authenticated = false;

      if (bearer) {
        try {
          const session = await verifyToken(env, bearer);
          authenticated = !!session;
        } catch {
          authenticated = false;
        }
      }

      const accessConfigured = !!(env.TEAM_DOMAIN && env.POLICY_AUD);
      if (!authenticated && accessConfigured) {
        const user = await verifyAccess(request, env);
        authenticated = !!user;
      }

      // Local / Dev Fallback: jika token ada atau dev mode
      if (!authenticated && !accessConfigured && (!env.JWT_SECRET || !bearer)) {
        authenticated = true;
      }

      if (!authenticated) {
        return new Response("Unauthorized — login required", {
          status: 401,
          headers: corsHeaders,
        });
      }

      // Teruskan WebSocket handshaking langsung ke stub Durable Object
      return agentStub(env).fetch(request);
    }

    // 4. Static assets (SPA)
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("Not Found", { status: 404, headers: corsHeaders });
  },
} satisfies ExportedHandler<Env>;