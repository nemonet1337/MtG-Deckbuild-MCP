import { USER_AGENT } from "../config.js";
import { ScryfallCard, ScryfallList, MtgColor, MtgFormat } from "../types/mtg.js";

const SCRYFALL_API = "https://api.scryfall.com";
const MAX_BANNED_LIST_RESULTS = 200;

type BannedListCache = Record<MtgFormat, Set<string>>;

// Scryfall's documented guidance (scryfall.com/docs/api/rate-limits) is a flat
// 50-100ms delay between requests (under 10 req/s), not per-endpoint tiers.
const REQUEST_INTERVAL_MS = 100;

const MAX_RETRIES = 3;
// A 429 response blocks the caller for 30 seconds per Scryfall's docs; cap
// exponential backoff there so a retry never fires before the block lifts.
const MAX_BACKOFF_MS = 30000;
// Scryfall asks that responses be cached (or processed locally) for at least 24 hours.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE_SIZE = 500;

function cacheKeyFor(url: string): string | null {
  // A cached "random card" would defeat the point of the endpoint.
  const { pathname, search } = new URL(url);
  if (pathname.startsWith("/cards/random")) return null;
  return `${pathname}?${search}`;
}

interface CacheEntry {
  expiresAt: number;
  value: unknown;
}

/** Serializes requests so consecutive calls never run closer than REQUEST_INTERVAL_MS apart. */
class RateLimiter {
  private queue: Promise<void> = Promise.resolve();
  private lastRequestAt = 0;

  async wait(): Promise<void> {
    const turn = this.queue.then(async () => {
      const elapsed = Date.now() - this.lastRequestAt;
      const remaining = REQUEST_INTERVAL_MS - elapsed;
      if (remaining > 0) {
        await new Promise((resolve) => setTimeout(resolve, remaining));
      }
      this.lastRequestAt = Date.now();
    });
    this.queue = turn;
    return turn;
  }
}

/**
 * Mirrors Scryfall's documented Error object shape
 * (scryfall.com/docs/api/errors): { object: "error", code, status, details, warnings? }.
 */
export class ScryfallError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly details: string,
    public readonly warnings?: string[]
  ) {
    super(details);
    this.name = "ScryfallError";
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

async function toScryfallError(response: Response): Promise<ScryfallError> {
  const text = await response.text();
  try {
    const body = JSON.parse(text) as { object?: string; code?: string; details?: string; warnings?: string[] };
    if (body.object === "error") {
      return new ScryfallError(response.status, body.code ?? "unknown", body.details ?? text.slice(0, 500), body.warnings);
    }
  } catch {
    // Not a JSON error body (e.g. an upstream 502 HTML page); fall through.
  }
  return new ScryfallError(response.status, "unknown", text.slice(0, 500));
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
  private rateLimiter = new RateLimiter();
  private cache = new InMemoryCache();
  private bannedLists: BannedListCache = {} as BannedListCache;

  private async fetchJson<T>(url: string): Promise<T> {
    const cacheKey = cacheKeyFor(url);
    const cached = cacheKey !== null ? this.cache.get(cacheKey) : undefined;
    if (cached !== undefined) return cached as T;

    let attempt = 0;
    let backoffMs = 1000;

    while (true) {
      await this.rateLimiter.wait();
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
        throw await toScryfallError(response);
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
      const result = await this.fetchJson<ScryfallList<ScryfallCard>>(url);
      return result.data.slice(0, limit);
    } catch (error) {
      if (error instanceof ScryfallError && error.status === 404) {
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
