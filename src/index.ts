import { GitHubAgent } from "./agent";
import { verifyAccess } from "./auth";
import { verifyToken, extractBearer } from "./users";
import type { Env } from "./types";

export { GitHubAgent };

function agentStub(env: Env) {
  const id = env.GitHubAgent.idFromName("default");
  return env.GitHubAgent.get(id);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // --- Auth API (proxied to Durable Object storage) ---
    if (path.startsWith("/auth/")) {
      return agentStub(env).fetch(request);
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
        return new Response("Unauthorized — login required", { status: 401 });
      }

      return agentStub(env).fetch(request);
    }

    // --- Static assets (SPA) ---
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
