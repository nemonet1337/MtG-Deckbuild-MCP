import { createMcpHandler } from "agents/mcp";
import { resolveAuth } from "./auth.js";
import { createServer } from "./server.js";
import { KVDeckStore } from "./services/kvDeckStore.js";

interface Env {
  /** Secret: single bearer token enabling my-deck tools. */
  AUTH_TOKEN?: string;
  /** Secret: optional JSON map of token -> userId for multiple users. */
  AUTH_TOKENS?: string;
  /** KV namespace for saved decks. */
  DECKS?: KVNamespace;
}

export default {
  fetch: async (request: Request, env: Env, ctx: ExecutionContext) => {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      return new Response("MtG Deckbuild MCP server. Connect your MCP client to /mcp.", {
        headers: { "content-type": "text/plain" }
      });
    }
    if (url.pathname === "/mcp" && request.method === "GET") {
      // Stateless server: no server-initiated push, so no standalone SSE stream to offer.
      return new Response(null, {
        status: 405,
        headers: { Allow: "POST, DELETE, OPTIONS", "Access-Control-Allow-Origin": "*" }
      });
    }

    const resolution = resolveAuth(request.headers.get("authorization"), env);
    if (resolution.kind === "invalid_token") {
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Invalid bearer token" }, id: null }),
        {
          status: 401,
          headers: {
            "Content-Type": "application/json",
            "WWW-Authenticate": 'Bearer realm="mtg-deckbuild-mcp", error="invalid_token"',
            "Access-Control-Allow-Origin": "*"
          }
        }
      );
    }

    const deckStore = env.DECKS ? new KVDeckStore(env.DECKS) : null;
    const server = createServer({ auth: resolution.auth, deckStore });
    return createMcpHandler(server, { route: "/mcp", enableJsonResponse: true })(request, env, ctx);
  }
} satisfies ExportedHandler<Env>;
