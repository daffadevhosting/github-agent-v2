import { GitHubAgent } from "./agent";
import { verifyAccess } from "./auth";
import { verifyToken, extractBearer } from "./users";
import type { Env } from "./types";

// Wajib diexport agar Cloudflare runtime mengenali Durable Object
export { GitHubAgent };

const corsHeaders: HeadersInit = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-partykit-room, x-partykit-namespace, Upgrade",
};

function agentStub(env: Env, roomName: string = "default") {
  const id = env.GitHubAgent.idFromName(roomName);
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

    // 2. Auth API (Diteruskan ke Durable Object)
    if (path.startsWith("/auth/")) {
      const headers = new Headers(request.headers);
      headers.set("x-partykit-room", "default");
      headers.set("x-partykit-namespace", "github-agent");

      const modifiedReq = new Request(request.url, {
        method: request.method,
        headers,
        body: request.method !== "GET" && request.method !== "HEAD" ? request.body : undefined,
        redirect: request.redirect,
        // @ts-ignore
        duplex: "half",
      });

      try {
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
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message || "Auth proxy error" }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
    }

    // 3. WebSocket Upgrade
    const upgradeHeader = request.headers.get("Upgrade");
    const isWebSocket = upgradeHeader && upgradeHeader.toLowerCase() === "websocket";

    if (isWebSocket) {
      const tokenFromQuery = url.searchParams.get("token");
      const bearer = extractBearer(request) || tokenFromQuery || null;
      let authenticated = false;
      let userId: string | null = null;

      if (bearer) {
        try {
          const session = await verifyToken(env, bearer);
          if (session) {
            authenticated = true;
            userId = (session as any).id || (session as any).userId || (session as any).email || "default";
          }
        } catch (e) {
          console.warn("[WS Auth] Token verification failed:", e);
          authenticated = false;
        }
      }

      const accessConfigured = !!(env.TEAM_DOMAIN && env.POLICY_AUD);
      if (!authenticated && accessConfigured) {
        const user = await verifyAccess(request, env);
        if (user) {
          authenticated = true;
          userId = (user as any).email || "access-user";
        }
      }

      // Fallback dev mode jika Access belum disetup dan belum ada JWT_SECRET
      if (!authenticated && !accessConfigured && !env.JWT_SECRET) {
        authenticated = true;
      }

      if (!authenticated) {
        return new Response("Unauthorized — valid token required", {
          status: 401,
          headers: corsHeaders,
        });
      }

      // Siapkan request WebSocket dengan PartyKit / Durable Object headers
      const wsHeaders = new Headers(request.headers);
      wsHeaders.set("x-partykit-room", userId || "default");
      wsHeaders.set("x-partykit-namespace", "github-agent");
      if (bearer) {
        wsHeaders.set("Authorization", `Bearer ${bearer}`);
      }

      const wsRequest = new Request(request.url, {
        headers: wsHeaders,
      });

      // Teruskan koneksi WebSocket ke Durable Object instance
      return agentStub(env, userId || "default").fetch(wsRequest);
    }

    // 4. Static Assets (SPA)
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("Not Found", { status: 404, headers: corsHeaders });
  },
} satisfies ExportedHandler<Env>;