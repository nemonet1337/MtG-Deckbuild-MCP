#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { FileDeckStore } from "./services/fileDeckStore.js";

async function main() {
  // Decks are stored as JSON files under ~/.mtg-deckbuild-mcp/decks/.
  const server = createServer({ deckStore: new FileDeckStore() });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MtG Deckbuild MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
