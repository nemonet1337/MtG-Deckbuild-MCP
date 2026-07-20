import { createMcpHandler } from "agents/mcp";
import { createServer } from "./server.js";
import { KVDeckStore } from "./services/kvDeckStore.js";

interface Env {
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

    const deckStore = env.DECKS ? new KVDeckStore(env.DECKS) : null;
    const server = createServer({ deckStore });
    return createMcpHandler(server, { route: "/mcp", enableJsonResponse: true })(request, env, ctx);
  }
} satisfies ExportedHandler<Env>;
