import { MtgColor, MtgFormat, ScryfallCard } from "../types/mtg.js";
import { parseDecklist } from "./deckAnalyzer.js";
import { colorIdentityQuery, formatLegalityQuery, ScryfallClient } from "./scryfall.js";

export type BudgetAlternative = {
  name: string;
  priceUsd: string | null;
  typeLine?: string;
  oracleText?: string;
  scryfallUri?: string;
};

export type BudgetSwap = {
  original: { name: string; quantity: number; priceUsd: string | null; typeLine?: string };
  alternatives: BudgetAlternative[];
  note?: string;
};

export type BudgetReport = {
  thresholdUsd: number;
  deckTotalUsd: number;
  expensiveCards: number;
  swaps: BudgetSwap[];
  estimatedSavingsUsd: number;
  unresolved: string[];
};

export type BudgetOptions = {
  thresholdUsd?: number;
  format?: MtgFormat;
  maxCards?: number;
  alternativesPerCard?: number;
};

const DEFAULT_THRESHOLD_USD = 5;
const DEFAULT_MAX_CARDS = 10;
const DEFAULT_ALTERNATIVES = 4;

const PRIMARY_TYPES = [
  "Creature",
  "Planeswalker",
  "Instant",
  "Sorcery",
  "Artifact",
  "Enchantment",
  "Battle",
  "Land"
] as const;

// Oracle-text phrases that capture a card's function, used when Scryfall
// provides no keywords for the card.
const FUNCTION_PHRASES = [
  "destroy",
  "exile",
  "counter target",
  "draw",
  "search your library",
  "add {",
  "sacrifice",
  "return target",
  "graveyard",
  "damage"
] as const;

function cardPriceUsd(card: ScryfallCard): number | null {
  const raw = card.prices?.usd ?? card.prices?.usd_foil ?? null;
  if (raw === null || raw === undefined) return null;
  const price = Number(raw);
  return Number.isFinite(price) ? price : null;
}

function primaryType(card: ScryfallCard): string | null {
  const typeLine = card.type_line ?? "";
  return PRIMARY_TYPES.find((type) => typeLine.includes(type)) ?? null;
}

function functionTerms(card: ScryfallCard): string[] {
  if (card.keywords?.length) {
    return card.keywords.slice(0, 2).map((keyword) => `o:${JSON.stringify(keyword)}`);
  }
  const oracle = (card.oracle_text ?? card.card_faces?.map((face) => face.oracle_text ?? "").join(" ") ?? "").toLowerCase();
  return FUNCTION_PHRASES.filter((phrase) => oracle.includes(phrase))
    .slice(0, 2)
    .map((phrase) => `o:${JSON.stringify(phrase)}`);
}

function isBasicLand(card: ScryfallCard): boolean {
  return (card.type_line ?? "").includes("Basic");
}

export class BudgetAlternativesService {
  constructor(private readonly client: ScryfallClient) {}

  async suggest(decklist: string, opts: BudgetOptions = {}): Promise<BudgetReport> {
    const thresholdUsd = opts.thresholdUsd ?? DEFAULT_THRESHOLD_USD;
    const maxCards = opts.maxCards ?? DEFAULT_MAX_CARDS;
    const alternativesPerCard = opts.alternativesPerCard ?? DEFAULT_ALTERNATIVES;

    const entries = parseDecklist(decklist);
    const unresolved: string[] = [];
    const resolved: Array<{ card: ScryfallCard; quantity: number; price: number | null }> = [];
    let deckTotalUsd = 0;

    for (const entry of entries) {
      try {
        const card = await this.client.namedCard(entry.name);
        const price = cardPriceUsd(card);
        if (price !== null) deckTotalUsd += price * entry.quantity;
        resolved.push({ card, quantity: entry.quantity, price });
      } catch {
        unresolved.push(entry.name);
      }
    }

    const expensive = resolved
      .filter((item) => item.price !== null && item.price > thresholdUsd && !isBasicLand(item.card))
      .sort((a, b) => (b.price ?? 0) - (a.price ?? 0))
      .slice(0, maxCards);

    const swaps: BudgetSwap[] = [];
    let estimatedSavingsUsd = 0;

    for (const { card, quantity, price } of expensive) {
      const baseParts = [
        opts.format ? formatLegalityQuery(opts.format) : "",
        colorIdentityQuery(((card.color_identity ?? []) as MtgColor[])),
        `usd<=${thresholdUsd}`,
        `-!"${card.name}"`,
        "-is:funny"
      ];
      const type = primaryType(card);
      if (type) baseParts.push(`t:${type.toLowerCase()}`);

      const keywordParts = functionTerms(card);
      let note: string | undefined;
      let alternatives = await this.client.searchCards(
        [...baseParts, ...keywordParts].filter(Boolean).join(" "),
        { limit: alternativesPerCard, order: "edhrec" }
      );
      if (alternatives.length === 0 && keywordParts.length > 0) {
        alternatives = await this.client.searchCards(baseParts.filter(Boolean).join(" "), {
          limit: alternativesPerCard,
          order: "edhrec"
        });
        note = "loose match";
      }

      const alternativePrices = alternatives
        .map((alt) => cardPriceUsd(alt))
        .filter((value): value is number => value !== null);
      if (alternativePrices.length && price !== null) {
        estimatedSavingsUsd += Math.max(0, (price - Math.min(...alternativePrices)) * quantity);
      }

      swaps.push({
        original: {
          name: card.name,
          quantity,
          priceUsd: card.prices?.usd ?? card.prices?.usd_foil ?? null,
          typeLine: card.type_line
        },
        alternatives: alternatives.map((alt) => ({
          name: alt.name,
          priceUsd: alt.prices?.usd ?? alt.prices?.usd_foil ?? null,
          typeLine: alt.type_line,
          oracleText: alt.oracle_text,
          scryfallUri: alt.scryfall_uri
        })),
        note
      });
    }

    return {
      thresholdUsd,
      deckTotalUsd: Math.round(deckTotalUsd * 100) / 100,
      expensiveCards: expensive.length,
      swaps,
      estimatedSavingsUsd: Math.round(estimatedSavingsUsd * 100) / 100,
      unresolved
    };
  }
}
