import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { APP_VERSION } from "./config.js";
import { BudgetAlternativesService } from "./services/budgetAlternatives.js";
import { DeckAnalyzerService, parseDecklist } from "./services/deckAnalyzer.js";
import { DeckBuilderService } from "./services/deckbuilder.js";
import { DeckStore, SavedDeck, deckSummary } from "./services/deckStore.js";
import { PLAYSTYLES, runWizard, WizardState } from "./services/deckWizard.js";
import { colorIdentityQuery, formatLegalityQuery, mechanicQuery, ScryfallClient, summarizeCard } from "./services/scryfall.js";
import { getTournamentReferences } from "./services/tournamentSources.js";
import { BUDGET_TIERS, COST_MODELS, CostModel, DeckBuildRequest, MTG_COLORS, MTG_FORMATS, MtgColor, MtgFormat, normalizeColors, POWER_LEVELS } from "./types/mtg.js";

export interface ServerDeps {
  deckStore: DeckStore | null;
}

const DEFAULT_DEPS: ServerDeps = {
  deckStore: null
};

// Single-tenant: there is no login, so all saved decks live under one shared user bucket.
const DECK_OWNER = "default";

const formatSchema = z.enum(MTG_FORMATS);
const colorSchema = z.enum(MTG_COLORS);
const budgetSchema = z.enum(BUDGET_TIERS);
const powerLevelSchema = z.enum(POWER_LEVELS);
const costModelSchema = z.enum(COST_MODELS);

const deckPlanSchema = {
  format: formatSchema,
  colors: z.array(colorSchema).min(1),
  strategy: z.string().describe("Archetype or game plan, e.g. Azorius Control, Rakdos Sacrifice, Simic Landfall."),
  mechanics: z.array(z.string()).optional(),
  budget: budgetSchema.optional(),
  powerLevel: powerLevelSchema.optional(),
  costModel: costModelSchema.optional()
};

function jsonText(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }]
  };
}

function text(data: string) {
  return {
    content: [{ type: "text" as const, text: data }]
  };
}

function requestFromArgs(args: {
  format: MtgFormat;
  colors: MtgColor[];
  strategy: string;
  mechanics?: string[];
  commander?: string;
  mustInclude?: string[];
  budget?: DeckBuildRequest["budget"];
  powerLevel?: DeckBuildRequest["powerLevel"];
  costModel?: DeckBuildRequest["costModel"];
  includeSideboard?: boolean;
}): DeckBuildRequest {
  return {
    ...args,
    colors: normalizeColors(args.colors),
    budget: args.budget ?? "any",
    powerLevel: args.powerLevel ?? "focused",
    costModel: args.costModel ?? "paper",
    includeSideboard: args.includeSideboard ?? true
  };
}

const wizardStateSchema = z.object({
  format: formatSchema.optional(),
  colors: z.array(colorSchema).optional(),
  playstyle: z.enum(PLAYSTYLES).optional(),
  strategy: z.string().optional(),
  mechanics: z.array(z.string()).optional(),
  commander: z.string().optional(),
  budget: budgetSchema.optional(),
  powerLevel: powerLevelSchema.optional(),
  costModel: costModelSchema.optional(),
  skippedOptional: z.boolean().optional()
});

function parseCardLine(line: string): { quantity: number; name: string } {
  const match = line.trim().match(/^(\d+)[xX]?\s+(.+)$/);
  if (match) return { quantity: Number(match[1]), name: match[2].trim() };
  return { quantity: 1, name: line.trim() };
}

function serializeDecklist(entries: Map<string, number>): string {
  return [...entries.entries()].map(([name, quantity]) => `${quantity} ${name}`).join("\n");
}

export function createServer(deps?: Partial<ServerDeps>): McpServer {
  const { deckStore } = { ...DEFAULT_DEPS, ...deps };
  const client = new ScryfallClient();
  const deckBuilder = new DeckBuilderService(client);
  const deckAnalyzer = new DeckAnalyzerService(client);
  const budgetAlternatives = new BudgetAlternativesService(client);

  const server = new McpServer({
    name: "mtg-deckbuild-mcp",
    version: APP_VERSION
  });

  server.registerTool(
    "search_cards",
    {
      title: "Search MTG Cards",
      description: "Search Scryfall with format, color identity, mechanics, card text, type, and price filters.",
      inputSchema: {
        query: z.string().describe("Additional Scryfall query text, e.g. 't:creature o:draw'."),
        format: formatSchema.optional(),
        colors: z.array(colorSchema).optional(),
        mechanics: z.array(z.string()).optional(),
        exactColors: z.boolean().optional(),
        limit: z.number().int().min(1).max(50).optional(),
        order: z.enum(["name", "set", "released", "rarity", "color", "usd", "tix", "eur", "cmc", "power", "toughness", "edhrec", "artist", "review"]).optional()
      }
    },
    async ({ query, format, colors, mechanics, exactColors, limit, order }) => {
      const parts = [query];
      if (format) parts.push(formatLegalityQuery(format));
      if (colors?.length) parts.push(colorIdentityQuery(normalizeColors(colors), exactColors ?? false));
      if (mechanics?.length) parts.push(mechanicQuery(mechanics));
      const cards = await client.searchCards(parts.filter(Boolean).join(" "), { limit: limit ?? 20, order: order ?? "edhrec" });
      return jsonText(cards.map((card) => ({
        name: card.name,
        manaCost: card.mana_cost,
        typeLine: card.type_line,
        oracleText: card.oracle_text,
        colorIdentity: card.color_identity,
        legalities: card.legalities,
        edhrecRank: card.edhrec_rank,
        priceUsd: card.prices?.usd,
        scryfallUri: card.scryfall_uri
      })));
    }
  );

  server.registerTool(
    "get_card_details",
    {
      title: "Get Card Details",
      description: "Resolve a card name with Scryfall fuzzy matching and return rules text, legality, pricing, and links.",
      inputSchema: {
        name: z.string()
      }
    },
    async ({ name }) => text(summarizeCard(await client.namedCard(name)))
  );

  server.registerTool(
    "recommend_cards",
    {
      title: "Recommend Cards",
      description: "Recommend ramp, draw, interaction, synergy pieces, win conditions, lands, and sideboard cards for a requested deck plan.",
      inputSchema: deckPlanSchema
    },
    async (args) => {
      const recommendations = await deckBuilder.recommendCards(requestFromArgs(args));
      return jsonText(Object.fromEntries(Object.entries(recommendations).map(([category, cards]) => [
        category,
        cards.slice(0, 12).map((card) => ({
          name: card.name,
          typeLine: card.type_line,
          oracleText: card.oracle_text,
          priceUsd: card.prices?.usd,
          edhrecRank: card.edhrec_rank,
          scryfallUri: card.scryfall_uri
        }))
      ])));
    }
  );

  server.registerTool(
    "build_deck",
    {
      title: "Build MTG Deck",
      description: "Build a practical MTG deck shell using Scryfall card data, format legality, colors, mechanics, budget, and tournament reference links.",
      inputSchema: {
        ...deckPlanSchema,
        commander: z.string().optional(),
        mustInclude: z.array(z.string()).optional(),
        includeSideboard: z.boolean().optional()
      }
    },
    async (args) => jsonText(await deckBuilder.buildDeck(requestFromArgs(args)))
  );

  server.registerTool(
    "analyze_deck",
    {
      title: "Analyze MTG Deck",
      description: "Analyze an existing decklist for card count, fuzzy-resolved names, basic legality, and singleton issues.",
      inputSchema: {
        format: formatSchema,
        decklist: z.string()
      }
    },
    async ({ format, decklist }) => jsonText(await deckAnalyzer.analyzeDecklist(format, decklist))
  );

  server.registerTool(
    "find_tournament_decks",
    {
      title: "Find Tournament Deck References",
      description: "Fetch reference snippets and citations from MTGDecks, MTGGoldfish, and MTGTop8 for competitive deckbuilding context.",
      inputSchema: {
        format: formatSchema,
        archetype: z.string().optional(),
        limit: z.number().int().min(1).max(20).optional()
      }
    },
    async ({ format, archetype, limit }) => jsonText(await getTournamentReferences(format, archetype ?? "", limit ?? 8))
  );

  server.registerTool(
    "deck_wizard",
    {
      title: "Interactive Deck Wizard",
      description:
        "Interactively gather deck preferences (format, colors, playstyle, mechanics, budget, power level) and build an optimal deck. " +
        "Stateless: ask the user the returned questions, merge the answers into the returned `state`, and call this tool again with that state. " +
        "Set finalize:true to build immediately once format and colors are known.",
      inputSchema: {
        state: wizardStateSchema.optional(),
        finalize: z.boolean().optional()
      }
    },
    async ({ state, finalize }) => jsonText(await runWizard(deckBuilder, (state ?? {}) as WizardState, finalize ?? false))
  );

  server.registerTool(
    "suggest_budget_alternatives",
    {
      title: "Suggest Budget Alternatives",
      description:
        "Find expensive cards in an existing decklist (by Scryfall USD price) and suggest cheaper functional alternatives with estimated savings.",
      inputSchema: {
        decklist: z.string().describe("Decklist as newline-separated 'N Card Name' entries."),
        format: formatSchema.optional(),
        thresholdUsd: z.number().positive().optional().describe("Cards above this USD price get alternatives. Default 5."),
        maxCards: z.number().int().min(1).max(20).optional()
      }
    },
    async ({ decklist, format, thresholdUsd, maxCards }) =>
      jsonText(await budgetAlternatives.suggest(decklist, { format, thresholdUsd, maxCards }))
  );

  if (deckStore) {
    server.registerTool(
      "save_deck",
      {
        title: "Save My Deck",
        description: "Save a deck to personal storage.",
        inputSchema: {
          name: z.string(),
          format: formatSchema,
          decklist: z.string().describe("Newline-separated 'N Card Name' entries."),
          strategy: z.string().optional(),
          colors: z.array(colorSchema).optional(),
          notes: z.string().optional()
        }
      },
      async ({ name, format, decklist, strategy, colors, notes }) => {
        const now = new Date().toISOString();
        const deck: SavedDeck = {
          id: crypto.randomUUID(),
          name,
          format,
          decklist,
          strategy,
          colors: colors ? normalizeColors(colors) : undefined,
          notes,
          createdAt: now,
          updatedAt: now
        };
        await deckStore.save(DECK_OWNER, deck);
        return jsonText({ saved: true, deck: deckSummary(deck) });
      }
    );

    server.registerTool(
      "list_decks",
      {
        title: "List My Decks",
        description: "List saved decks (id, name, format, updatedAt).",
        inputSchema: {}
      },
      async () => jsonText(await deckStore.list(DECK_OWNER))
    );

    server.registerTool(
      "get_deck",
      {
        title: "Get My Deck",
        description: "Fetch a saved deck by id, including its full decklist.",
        inputSchema: { id: z.string() }
      },
      async ({ id }) => {
        const deck = await deckStore.get(DECK_OWNER, id);
        if (!deck) return { isError: true, content: [{ type: "text" as const, text: `Deck not found: ${id}` }] };
        return jsonText(deck);
      }
    );

    server.registerTool(
      "update_deck",
      {
        title: "Update My Deck",
        description:
          "Edit a saved deck: rename, update notes, replace the whole decklist, or add/remove cards ('2 Lightning Bolt' or a bare card name for quantity 1).",
        inputSchema: {
          id: z.string(),
          name: z.string().optional(),
          notes: z.string().optional(),
          decklist: z.string().optional().describe("Replaces the entire decklist when provided."),
          addCards: z.array(z.string()).optional(),
          removeCards: z.array(z.string()).optional()
        }
      },
      async ({ id, name, notes, decklist, addCards, removeCards }) => {
        const deck = await deckStore.get(DECK_OWNER, id);
        if (!deck) return { isError: true, content: [{ type: "text" as const, text: `Deck not found: ${id}` }] };

        if (name !== undefined) deck.name = name;
        if (notes !== undefined) deck.notes = notes;
        if (decklist !== undefined) {
          deck.decklist = decklist;
        } else if (addCards?.length || removeCards?.length) {
          const entries = new Map<string, number>();
          for (const entry of parseDecklist(deck.decklist)) {
            entries.set(entry.name, (entries.get(entry.name) ?? 0) + entry.quantity);
          }
          for (const line of addCards ?? []) {
            const { quantity, name: cardName } = parseCardLine(line);
            entries.set(cardName, (entries.get(cardName) ?? 0) + quantity);
          }
          for (const line of removeCards ?? []) {
            const { quantity, name: cardName } = parseCardLine(line);
            const existing = [...entries.keys()].find((key) => key.toLowerCase() === cardName.toLowerCase());
            if (existing === undefined) continue;
            const remaining = (entries.get(existing) ?? 0) - quantity;
            if (remaining > 0) entries.set(existing, remaining);
            else entries.delete(existing);
          }
          deck.decklist = serializeDecklist(entries);
        }
        deck.updatedAt = new Date().toISOString();
        await deckStore.save(DECK_OWNER, deck);
        return jsonText({ updated: true, deck });
      }
    );

    server.registerTool(
      "delete_deck",
      {
        title: "Delete My Deck",
        description: "Delete a saved deck by id.",
        inputSchema: { id: z.string() }
      },
      async ({ id }) => {
        const deleted = await deckStore.delete(DECK_OWNER, id);
        if (!deleted) return { isError: true, content: [{ type: "text" as const, text: `Deck not found: ${id}` }] };
        return jsonText({ deleted: true, id });
      }
    );
  }

  server.registerResource(
    "deckbuilding-frameworks",
    "mtg://deckbuilding/frameworks",
    {
      title: "MTG deckbuilding frameworks",
      description: "Recommended deck structure targets by format.",
      mimeType: "application/json"
    },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify({
          commander: { cards: 100, lands: 36, ramp: 10, draw: 10, interaction: 9, wipes: 3, winConditions: 6, notes: "Singleton and color identity enforced." },
          constructed60: { cards: 60, lands: 24, interaction: 8, draw: 6, threatsAndSynergy: 18, sideboard: 15, notes: "Up to four copies except basic lands and special card text." },
          citations: ["https://scryfall.com/docs/api", "https://mtgdecks.net/", "https://www.mtggoldfish.com/tournaments/all", "https://mtgtop8.com/"]
        }, null, 2)
      }]
    })
  );

  server.registerPrompt(
    "competitive_deckbuilding_brief",
    {
      title: "Competitive deckbuilding brief",
      description: "Prompt template for using this MCP server to build and tune an MTG deck.",
      argsSchema: {
        format: formatSchema,
        colors: z.string(),
        strategy: z.string(),
        metagameConcerns: z.string().optional()
      }
    },
    ({ format, colors, strategy, metagameConcerns }) => ({
      messages: [{
        role: "user",
        content: {
          type: "text",
          text: `Build a practical ${format} MTG deck in ${colors} for ${strategy}. Use search_cards, recommend_cards, build_deck, and find_tournament_decks. Consider curve, mana base, interaction, sideboard, budget, format legality, and tournament references.${metagameConcerns ? ` Metagame concerns: ${metagameConcerns}` : ""}`
        }
      }]
    })
  );

  return server;
}
