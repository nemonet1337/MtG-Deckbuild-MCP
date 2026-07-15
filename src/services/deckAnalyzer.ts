import { isSingletonFormat, MtgFormat } from "../types/mtg.js";
import { ScryfallClient } from "./scryfall.js";

const MAX_CARDS_TO_RESOLVE = 120;

// Cards whose rules text allows any number of copies.
const SINGLETON_EXEMPT = /^persistent petitioners$|^relentless rats$|^rat colony$|^shadowborn apostle$/i;

export type DecklistEntry = {
  quantity: number;
  name: string;
};

export type AnalyzedCard = DecklistEntry & {
  resolvedName?: string;
  typeLine?: string;
  legality: string;
  singletonIssue: boolean;
};

export type DeckAnalysis = {
  format: MtgFormat;
  total: number;
  uniqueCards: number;
  issues: AnalyzedCard[];
  cards: AnalyzedCard[];
};

export function parseDecklist(decklist: string): DecklistEntry[] {
  return decklist
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const match = line.match(/^(\d+)\s+(.+?)(?:\s+\(.+\))?$/);
      if (!match) return [];
      return [{ quantity: Number(match[1]), name: match[2].replace(/\s+#.+$/, "").trim() }];
    });
}

export class DeckAnalyzerService {
  constructor(private readonly client: ScryfallClient) {}

  async analyzeDecklist(format: MtgFormat, decklist: string): Promise<DeckAnalysis> {
    const entries = parseDecklist(decklist);
    const singleton = isSingletonFormat(format);
    const total = entries.reduce((sum, entry) => sum + entry.quantity, 0);

    const checked: AnalyzedCard[] = [];
    for (const entry of entries.slice(0, MAX_CARDS_TO_RESOLVE)) {
      try {
        const card = await this.client.namedCard(entry.name);
        const legality = format === "premodern" ? "manual-check" : card.legalities?.[format] ?? "unknown";
        checked.push({
          ...entry,
          resolvedName: card.name,
          typeLine: card.type_line,
          legality,
          singletonIssue: singleton && entry.quantity > 1 && !SINGLETON_EXEMPT.test(card.name)
        });
      } catch {
        checked.push({ ...entry, legality: "unresolved", singletonIssue: false });
      }
    }

    return {
      format,
      total,
      uniqueCards: entries.length,
      issues: checked.filter((entry) => (entry.legality !== "legal" && entry.legality !== "manual-check") || entry.singletonIssue),
      cards: checked
    };
  }
}
