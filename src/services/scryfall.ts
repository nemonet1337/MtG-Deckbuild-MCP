import { ScryfallCard, ScryfallList, MtgColor, MtgFormat } from "../types/mtg.js";

const SCRYFALL_API = "https://api.scryfall.com";
const USER_AGENT = "MtG-Deckbuild-MCP/1.0 (Model Context Protocol deckbuilding assistant)";
const MIN_REQUEST_INTERVAL_MS = 90;

export function colorIdentityQuery(colors: MtgColor[], exact = false): string {
  if (colors.includes("C")) {
    return exact ? "id=c" : "id<=c";
  }
  const colorText = colors.filter((color) => color !== "C").join("").toLowerCase();
  if (!colorText) {
    return "id<=c";
  }
  return exact ? `id=${colorText}` : `id<=${colorText}`;
}

export function formatLegalityQuery(format: MtgFormat): string {
  if (format === "premodern") {
    return "date<=2003-07-28 -is:digital";
  }
  return `legal:${format}`;
}

export function mechanicQuery(mechanics: string[] = []): string {
  const mapping: Record<string, string[]> = {
    tokens: ["o:token"],
    token: ["o:token"],
    lifegain: ["o:life"],
    blink: ["o:exile", "o:return"],
    reanimator: ["o:return", "o:graveyard", "t:creature"],
    aristocrats: ["o:sacrifice", "o:dies"],
    sacrifice: ["o:sacrifice"],
    spellslinger: ["o:instant", "o:sorcery"],
    prowess: ["o:prowess"],
    counters: ["o:\"+1/+1 counter\""],
    artifacts: ["o:artifact"],
    enchantments: ["o:enchantment"],
    graveyard: ["o:graveyard"],
    ramp: ["o:add", "o:mana"],
    control: ["o:counter", "o:destroy"],
    aggro: ["pow>=2", "mv<=3"],
    mill: ["o:mill"],
    poison: ["o:poison"],
    toxic: ["o:toxic"],
    energy: ["o:energy"],
    equipment: ["t:equipment"],
    vehicles: ["t:vehicle"]
  };

  return mechanics
    .flatMap((mechanic) => mapping[mechanic.toLowerCase()] ?? [`o:${JSON.stringify(mechanic)}`])
    .join(" ");
}

export class ScryfallClient {
  // Serializes requests so concurrent callers still respect Scryfall's
  // 50-100ms courtesy interval (https://scryfall.com/docs/api).
  private queue: Promise<void> = Promise.resolve();
  private lastRequestAt = 0;

  private waitForRateLimit(): Promise<void> {
    const turn = this.queue.then(async () => {
      const wait = Math.max(0, MIN_REQUEST_INTERVAL_MS - (Date.now() - this.lastRequestAt));
      if (wait > 0) {
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
      this.lastRequestAt = Date.now();
    });
    this.queue = turn;
    return turn;
  }

  private async fetchJson<T>(url: string): Promise<T> {
    await this.waitForRateLimit();
    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json"
      }
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Scryfall API error ${response.status}: ${text.slice(0, 500)}`);
    }

    return response.json() as Promise<T>;
  }

  async searchCards(query: string, options: { limit?: number; order?: string; unique?: "cards" | "art" | "prints" } = {}): Promise<ScryfallCard[]> {
    const limit = Math.max(1, Math.min(options.limit ?? 20, 175));
    const params = new URLSearchParams({
      q: query,
      order: options.order ?? "edhrec",
      unique: options.unique ?? "cards"
    });
    const url = `${SCRYFALL_API}/cards/search?${params.toString()}`;

    try {
      const result = await this.fetchJson<ScryfallList<ScryfallCard>>(url);
      return result.data.slice(0, limit);
    } catch (error) {
      if (error instanceof Error && error.message.includes("404")) {
        return [];
      }
      throw error;
    }
  }

  async namedCard(name: string): Promise<ScryfallCard> {
    const params = new URLSearchParams({ fuzzy: name });
    return this.fetchJson<ScryfallCard>(`${SCRYFALL_API}/cards/named?${params.toString()}`);
  }

  async randomCard(query: string): Promise<ScryfallCard> {
    const params = new URLSearchParams({ q: query });
    return this.fetchJson<ScryfallCard>(`${SCRYFALL_API}/cards/random?${params.toString()}`);
  }

  async autocompleteCardNames(query: string): Promise<string[]> {
    const params = new URLSearchParams({ q: query });
    const result = await this.fetchJson<{ data: string[] }>(`${SCRYFALL_API}/cards/autocomplete?${params.toString()}`);
    return result.data;
  }
}

export function summarizeCard(card: ScryfallCard): string {
  const faces = card.card_faces?.map((face) => `${face.name}: ${face.oracle_text ?? ""}`).join(" // ");
  const oracle = card.oracle_text ?? faces ?? "";
  const price = card.prices?.usd ? ` / $${card.prices.usd}` : "";
  return `${card.name} ${card.mana_cost ?? ""} — ${card.type_line ?? ""}${price}\n${oracle}\n${card.scryfall_uri ?? ""}`.trim();
}
