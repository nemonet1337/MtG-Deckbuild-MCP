#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { FileDeckStore } from "./services/fileDeckStore.js";

async function main() {
  // Local stdio runs are inherently single-user: always authenticated, decks
  // stored as JSON files under ~/.mtg-deckbuild-mcp/decks/local/.
  const server = createServer({
    auth: { authenticated: true, userId: "local" },
    deckStore: new FileDeckStore()
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MtG Deckbuild MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
