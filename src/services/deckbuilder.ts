import { CostModel, DeckBuildRequest, DeckBuildResult, DeckCard, FORMAT_LABELS, isSingletonFormat, MtgColor, MtgFormat, POWER_LEVELS, PowerLevel, ScryfallCard } from "../types/mtg.js";
import { colorIdentityQuery, formatLegalityQuery, mechanicQuery, ScryfallClient } from "./scryfall.js";

const BASIC_LANDS: Record<Exclude<MtgColor, "C">, string> = {
  W: "Plains",
  U: "Island",
  B: "Swamp",
  R: "Mountain",
  G: "Forest"
};

const COLORLESS_BASIC_LAND = "Wastes";

const COLOR_NAMES: Record<MtgColor, string> = {
  W: "White",
  U: "Blue",
  B: "Black",
  R: "Red",
  G: "Green",
  C: "Colorless"
};

function targetMainboardSize(format: MtgFormat): number {
  return format === "commander" ? 100 : 60;
}

function landTarget(format: MtgFormat): number {
  return format === "commander" ? 36 : 24;
}

const POWER_LEVEL_CONFIG: Record<PowerLevel, { edhrecThreshold: number | null; priceMultiplier: number }> = {
  casual: { edhrecThreshold: 50000, priceMultiplier: 1.0 },
  focused: { edhrecThreshold: 20000, priceMultiplier: 1.2 },
  competitive: { edhrecThreshold: 5000, priceMultiplier: 1.5 },
  cedh: { edhrecThreshold: 1000, priceMultiplier: 2.0 }
};

function powerLevelQuery(powerLevel: PowerLevel): string {
  return "";
}

function arenaBudgetQuery(budget: DeckBuildRequest["budget"]): string {
  switch (budget) {
    case "budget":
      return "rarity:common";
    case "mid":
      return "rarity:uncommon";
    case "premium":
      return "rarity:rare";
    default:
      return "";
  }
}

function paperBudgetQuery(budget: DeckBuildRequest["budget"], powerLevel: PowerLevel): string {
  const multiplier = POWER_LEVEL_CONFIG[powerLevel].priceMultiplier;
  switch (budget) {
    case "budget":
      return `usd<=${(3 * multiplier).toFixed(2)}`;
    case "mid":
      return `usd<=${(15 * multiplier).toFixed(2)}`;
    default:
      return "";
  }
}

function budgetQuery(request: DeckBuildRequest): string {
  if (request.costModel === "arena") {
    return arenaBudgetQuery(request.budget);
  }
  return paperBudgetQuery(request.budget, request.powerLevel ?? "focused");
}

function rarityToWildcardCost(rarity?: string): number {
  switch (rarity?.toLowerCase()) {
    case "common":
      return 1;
    case "uncommon":
      return 2;
    case "rare":
      return 4;
    case "mythic":
      return 8;
    default:
      return 0;
  }
}

function sanitizeStrategy(strategy: string): string[] {
  return strategy
    .toLowerCase()
    .split(/[^a-z0-9+/-]+/i)
    .filter((part) => part.length > 2)
    .slice(0, 6);
}

function uniqueCards(cards: ScryfallCard[], used: Set<string>): ScryfallCard[] {
  const seen = new Set<string>();
  return cards.filter((card) => {
    const key = card.name.toLowerCase();
    if (used.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function toDeckCard(card: ScryfallCard, quantity: number, category: string, role: string, rationale: string): DeckCard {
  return {
    name: card.name,
    quantity,
    category,
    role,
    rationale,
    scryfallUri: card.scryfall_uri,
    priceUsd: card.prices?.usd ?? null,
    wildcardCost: rarityToWildcardCost(card.rarity) * quantity
  };
}

function addCards(target: DeckCard[], cards: ScryfallCard[], used: Set<string>, desiredSlots: number, category: string, role: string, rationale: string, singleton: boolean): void {
  let remaining = desiredSlots;
  for (const card of uniqueCards(cards, used)) {
    if (remaining <= 0) break;
    const quantity = singleton ? 1 : Math.min(4, remaining);
    target.push(toDeckCard(card, quantity, category, role, rationale));
    used.add(card.name.toLowerCase());
    remaining -= quantity;
  }
}

function basicLandCard(name: string, quantity: number, colorName: string): DeckCard {
  return {
    name,
    quantity,
    category: "lands",
    role: "basic mana source",
    rationale: `${colorName} mana consistency`,
    scryfallUri: `https://scryfall.com/search?q=%21%22${encodeURIComponent(name)}%22`
  };
}

function addBasics(target: DeckCard[], colors: MtgColor[], needed: number): void {
  if (needed <= 0) return;
  const landColors = colors.filter((color): color is Exclude<MtgColor, "C"> => color !== "C");
  if (landColors.length === 0) {
    target.push(basicLandCard(COLORLESS_BASIC_LAND, needed, COLOR_NAMES.C));
    return;
  }

  const base = Math.floor(needed / landColors.length);
  let remainder = needed % landColors.length;
  for (const color of landColors) {
    const quantity = base + (remainder > 0 ? 1 : 0);
    remainder -= 1;
    if (quantity > 0) {
      target.push(basicLandCard(BASIC_LANDS[color], quantity, COLOR_NAMES[color]));
    }
  }
}

function totalCards(cards: DeckCard[]): number {
  return cards.reduce((sum, card) => sum + card.quantity, 0);
}

function decklistSection(cards: DeckCard[]): string {
  return cards.map((card) => `${card.quantity} ${card.name}`).join("\n");
}

async function searchPackage(client: ScryfallClient, base: string, queries: string[], limit = 16): Promise<ScryfallCard[]> {
  const found: ScryfallCard[] = [];
  const seen = new Set<string>();
  for (const query of queries) {
    try {
      const cards = await client.searchCards(`${base} ${query}`, { limit, order: "edhrec" });
      for (const card of cards) {
        const key = card.name.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          found.push(card);
        }
      }
    } catch {
      continue;
    }
  }
  return found;
}

export class DeckBuilderService {
  constructor(private readonly client: ScryfallClient) {}

  async recommendCards(request: DeckBuildRequest): Promise<Record<string, ScryfallCard[]>> {
    const base = [formatLegalityQuery(request.format), colorIdentityQuery(request.colors), budgetQuery(request), powerLevelQuery(request.powerLevel ?? "focused"), "-is:funny"].filter(Boolean).join(" ");
    const strategyTerms = sanitizeStrategy(request.strategy);
    const mechanics = mechanicQuery([...(request.mechanics ?? []), ...strategyTerms]);
    const synergyQuery = mechanics || strategyTerms.map((term) => `o:${term}`).join(" ");

    const [ramp, draw, interaction, synergy, winConditions, lands, sideboard] = await Promise.all([
      searchPackage(this.client, base, ["-t:land o:add o:mana", "t:artifact o:add o:mana", "o:search o:library o:land"], 12),
      searchPackage(this.client, base, ["o:draw", "o:look o:library", "o:impulse"], 12),
      searchPackage(this.client, base, ["o:destroy", "o:exile", "o:counter", "o:damage t:instant"], 14),
      searchPackage(this.client, base, [synergyQuery || "sort:edhrec", ...strategyTerms.map((term) => `o:${term}`)], 20),
      searchPackage(this.client, base, ["pow>=4", "o:\"win the game\"", "t:planeswalker", "o:double"], 10),
      searchPackage(this.client, base, ["t:land -t:basic", "t:land"], 16),
      searchPackage(this.client, base, ["o:graveyard", "o:artifact o:destroy", "o:enchantment o:destroy", "o:counter", "o:exile"], 15)
    ]);

    const threshold = POWER_LEVEL_CONFIG[request.powerLevel ?? "focused"].edhrecThreshold;
    const filterByPower = (cards: ScryfallCard[]) => threshold === null ? cards : cards.filter((c) => !c.edhrec_rank || c.edhrec_rank <= threshold);

    return {
      ramp: filterByPower(ramp),
      draw: filterByPower(draw),
      interaction: filterByPower(interaction),
      synergy: filterByPower(synergy),
      winConditions: filterByPower(winConditions),
      lands: filterByPower(lands),
      sideboard: filterByPower(sideboard)
    };
  }

  async buildDeck(request: DeckBuildRequest): Promise<DeckBuildResult> {
    const singleton = isSingletonFormat(request.format);
    const targetSize = targetMainboardSize(request.format);
    const desiredLands = landTarget(request.format);
    const recommendations = await this.recommendCards(request);
    const mainboard: DeckCard[] = [];
    const sideboard: DeckCard[] = [];
    const used = new Set<string>();

    if (request.commander) {
      try {
        const commander = await this.client.namedCard(request.commander);
        addCards(mainboard, [commander], used, 1, "commander", "deck identity", "Commander or signature build-around requested by the user", true);
      } catch {
        mainboard.push({
          name: request.commander,
          quantity: 1,
          category: "commander",
          role: "requested commander",
          rationale: "Requested commander could not be resolved through Scryfall fuzzy lookup"
        });
        used.add(request.commander.toLowerCase());
      }
    }

    for (const name of request.mustInclude ?? []) {
      try {
        const card = await this.client.namedCard(name);
        addCards(mainboard, [card], used, singleton ? 1 : 4, "must-include", "user requested card", "Explicitly requested by the user", singleton);
      } catch {
        mainboard.push({ name, quantity: 1, category: "must-include", role: "unresolved requested card", rationale: "Could not resolve with Scryfall fuzzy lookup" });
        used.add(name.toLowerCase());
      }
    }

    const slotsBeforeLands = targetSize - desiredLands;
    const rampSlots = request.format === "commander" ? 10 : 4;
    const drawSlots = request.format === "commander" ? 10 : 6;
    const interactionSlots = request.format === "commander" ? 9 : 8;
    const winSlots = request.format === "commander" ? 6 : 8;
    const synergySlots = Math.max(0, slotsBeforeLands - totalCards(mainboard) - rampSlots - drawSlots - interactionSlots - winSlots);

    addCards(mainboard, recommendations.ramp, used, rampSlots, "ramp", "mana acceleration", "Improves speed and color consistency", singleton);
    addCards(mainboard, recommendations.draw, used, drawSlots, "card advantage", "draw and selection", "Keeps threats and answers flowing", singleton);
    addCards(mainboard, recommendations.interaction, used, interactionSlots, "interaction", "removal or stack interaction", "Answers opposing threats and protects the game plan", singleton);
    addCards(mainboard, recommendations.synergy, used, synergySlots, "synergy", request.strategy, "Supports the requested strategy and mechanics", singleton);
    addCards(mainboard, recommendations.winConditions, used, winSlots, "win condition", "closer", "Converts board presence or resources into wins", singleton);

    const nonBasicLandSlots = Math.min(singleton ? 14 : 12, desiredLands);
    addCards(mainboard, recommendations.lands, used, nonBasicLandSlots, "lands", "mana fixing", "Improves access to requested colors", singleton);
    addBasics(mainboard, request.colors, targetSize - totalCards(mainboard));

    if (request.includeSideboard !== false && !singleton) {
      addCards(sideboard, recommendations.sideboard, new Set(used), 15, "sideboard", "metagame answer", "Flexible cards for graveyards, artifacts, enchantments, control, and creature decks", false);
    }

    const totalWildcardCost = mainboard.reduce((sum, card) => sum + (card.wildcardCost ?? 0), 0) + sideboard.reduce((sum, card) => sum + (card.wildcardCost ?? 0), 0);

    const formatLabel = FORMAT_LABELS[request.format];
    const citations = [
      { title: "Scryfall API card data and legality", url: "https://scryfall.com/docs/api" },
      { title: `${formatLabel} tournament results on MTGDecks`, url: `https://mtgdecks.net/${formatLabel}/tournaments` },
      { title: "Recent tournament decklists on MTGGoldfish", url: "https://www.mtggoldfish.com/tournaments/all" },
      { title: "MTGTop8 tournament archive", url: "https://mtgtop8.com/" }
    ];

    const name = `${request.colors.join("") || "Colorless"} ${request.strategy} ${formatLabel}`;
    const decklist = [`# ${name}`, "", "## Mainboard", decklistSection(mainboard), sideboard.length ? `\n## Sideboard\n${decklistSection(sideboard)}` : ""].filter(Boolean).join("\n");

    const notes = [
      `Mainboard target: ${targetSize} cards; generated: ${totalCards(mainboard)} cards`,
      singleton ? "Singleton construction was enforced for this format" : "Up to four copies were used for non-singleton formats",
      "Validate final legality and local metagame expectations before tournament play"
    ];
    if (request.costModel === "arena") {
      notes.push(`Estimated wildcard cost: ${totalWildcardCost} WC`);
    }

    return {
      name,
      format: request.format,
      colors: request.colors,
      strategy: request.strategy,
      mainboard,
      sideboard,
      citations,
      notes,
      decklist,
      totalWildcardCost
    };
  }
}
