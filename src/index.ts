import { GitHubAgent } from "./agent";
import { verifyAccess } from "./auth";
import type { Env } from "./types";

export { GitHubAgent };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Cloudflare Access authentication
    const isWebSocket =
  request.headers.get("Upgrade")?.toLowerCase() === "websocket";
    const skipAuth = !env.TEAM_DOMAIN || !env.POLICY_AUD;

    if (!skipAuth) {
      const user = await verifyAccess(request, env);
      if (!user) {
        return new Response("Unauthorized. Cloudflare Access authentication required.", {
          status: 401,
          headers: { "Content-Type": "text/plain" },
        });
      }
    }

    // WebSocket upgrade for the agent
    if (isWebSocket) {
      const id = env.GitHubAgent.idFromName("default");
      const stub = env.GitHubAgent.get(id);
      return stub.fetch(request);
    }

    // Serve static UI
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
