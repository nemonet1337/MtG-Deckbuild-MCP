import { USER_AGENT } from "../config.js";
import { ScryfallCard, ScryfallList, MtgColor, MtgFormat } from "../types/mtg.js";

const SCRYFALL_API = "https://api.scryfall.com";
const MAX_BANNED_LIST_RESULTS = 200;

type BannedListCache = Record<MtgFormat, Set<string>>;

const HEAVY_ENDPOINT_INTERVAL_MS = 500;
const MANIFEST_INTERVAL_MS = 10000;
const LIGHT_ENDPOINT_INTERVAL_MS = 100;

const MAX_RETRIES = 3;
const MAX_BACKOFF_MS = 30000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE_SIZE = 500;

const HEAVY_PATH_PREFIXES = [
  "/cards/search",
  "/cards/named",
  "/cards/random",
  "/cards/collection",
];

const MANIFEST_PATH_PREFIX = "/bulk-data";

type Tier = "heavy" | "manifest" | "light";

function endpointTier(pathname: string): Tier {
  if (pathname.startsWith(MANIFEST_PATH_PREFIX)) return "manifest";
  if (HEAVY_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return "heavy";
  return "light";
}

function tierIntervalMs(tier: Tier): number {
  switch (tier) {
    case "heavy":
      return HEAVY_ENDPOINT_INTERVAL_MS;
    case "manifest":
      return MANIFEST_INTERVAL_MS;
    case "light":
      return LIGHT_ENDPOINT_INTERVAL_MS;
  }
}

function tieredKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}?${u.search}`;
  } catch {
    return url;
  }
}

interface CacheEntry {
  expiresAt: number;
  value: unknown;
}

class TieredRateLimiter {
  private queues: Record<Tier, Promise<void>> = {
    heavy: Promise.resolve(),
    manifest: Promise.resolve(),
    light: Promise.resolve(),
  };
  private lastRequestAt: Record<Tier, number> = {
    heavy: 0,
    manifest: 0,
    light: 0,
  };

  async waitFor(tier: Tier): Promise<void> {
    const queue = this.queues[tier];
    const turn = queue.then(async () => {
      const wait = Math.max(0, tierIntervalMs(tier) - (Date.now() - this.lastRequestAt[tier]));
      if (wait > 0) {
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
      this.lastRequestAt[tier] = Date.now();
    });
    this.queues[tier] = turn;
    return turn;
  }
}

class InMemoryCache {
  private store = new Map<string, CacheEntry>();
  private insertionOrder: string[] = [];

  get(key: string): unknown | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: unknown): void {
    this.delete(key);
    if (this.store.size >= MAX_CACHE_SIZE) {
      const oldest = this.insertionOrder.shift();
      if (oldest !== undefined) {
        this.store.delete(oldest);
      }
    }
    this.store.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value });
    this.insertionOrder.push(key);
  }

  private delete(key: string): void {
    this.store.delete(key);
    const idx = this.insertionOrder.indexOf(key);
    if (idx !== -1) this.insertionOrder.splice(idx, 1);
  }
}

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
    vehicles: ["t:vehicle"],
  };

  return mechanics
    .flatMap((mechanic) => mapping[mechanic.toLowerCase()] ?? [`o:${JSON.stringify(mechanic)}`])
    .join(" ");
}

export class ScryfallClient {
  private rateLimiter = new TieredRateLimiter();
  private cache = new InMemoryCache();
  private bannedLists: BannedListCache = {} as BannedListCache;

  private cacheableTiers: Tier[] = ["heavy", "light"];

  private async fetchJson<T>(url: string, tier: Tier): Promise<T> {
    const cacheKey = this.cacheableTiers.includes(tier) ? tieredKey(url) : null;
    const cached = cacheKey !== null ? this.cache.get(cacheKey) : undefined;
    if (cached !== undefined) return cached as T;

    let attempt = 0;
    let backoffMs = 1000;

    while (true) {
      await this.rateLimiter.waitFor(tier);
      const response = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/json",
        },
      });

      if (response.status === 429 && attempt < MAX_RETRIES) {
        const retryAfter = response.headers.get("Retry-After");
        const waitMs = retryAfter !== null ? Number(retryAfter) * 1000 : backoffMs;
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        attempt += 1;
        continue;
      }

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Scryfall API error ${response.status}: ${text.slice(0, 500)}`);
      }

      const result = (await response.json()) as T;
      if (cacheKey !== null) this.cache.set(cacheKey, result);
      return result;
    }
  }

  async searchCards(query: string, options: { limit?: number; order?: string; unique?: "cards" | "art" | "prints" } = {}): Promise<ScryfallCard[]> {
    const limit = Math.max(1, Math.min(options.limit ?? 20, 175));
    const params = new URLSearchParams({
      q: query,
      order: options.order ?? "edhrec",
      unique: options.unique ?? "cards",
    });
    const url = `${SCRYFALL_API}/cards/search?${params.toString()}`;

    try {
      const result = await this.fetchJson<ScryfallList<ScryfallCard>>(url, "heavy");
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
    return this.fetchJson<ScryfallCard>(`${SCRYFALL_API}/cards/named?${params.toString()}`, "heavy");
  }

  async randomCard(query: string): Promise<ScryfallCard> {
    const params = new URLSearchParams({ q: query });
    return this.fetchJson<ScryfallCard>(`${SCRYFALL_API}/cards/random?${params.toString()}`, "heavy");
  }

  async autocompleteCardNames(query: string): Promise<string[]> {
    const params = new URLSearchParams({ q: query });
    const result = await this.fetchJson<{ data: string[] }>(`${SCRYFALL_API}/cards/autocomplete?${params.toString()}`, "light");
    return result.data;
  }

  async fetchBannedList(format: MtgFormat): Promise<Set<string>> {
    if (this.bannedLists[format]) return this.bannedLists[format];
    if (format === "premodern") {
      this.bannedLists[format] = new Set();
      return this.bannedLists[format];
    }
    const cards = await this.searchCards(`banned:${format}`, { limit: MAX_BANNED_LIST_RESULTS, unique: "cards" });
    const banned = new Set(cards.map((card) => card.name.toLowerCase()));
    this.bannedLists[format] = banned;
    return banned;
  }
}

export function summarizeCard(card: ScryfallCard): string {
  const faces = card.card_faces?.map((face) => `${face.name}: ${face.oracle_text ?? ""}`).join(" // ");
  const oracle = card.oracle_text ?? faces ?? "";
  const price = card.prices?.usd ? ` / $${card.prices.usd}` : "";
  return `${card.name} ${card.mana_cost ?? ""} — ${card.type_line ?? ""}${price}\n${oracle}\n${card.scryfall_uri ?? ""}`.trim();
}
