import { USER_AGENT } from "../config.js";
import { ImageVersion, ScryfallCard, ScryfallLang, ScryfallList, MtgColor, MtgFormat } from "../types/mtg.js";

const SCRYFALL_API = "https://api.scryfall.com";
const MAX_BANNED_LIST_RESULTS = 200;

type BannedListCache = Record<MtgFormat, Set<string>>;

// Per-endpoint rate limits (scryfall.com/docs/api/rate-limits and the individual
// endpoint doc pages): the card-lookup endpoints cap at 2/sec (500ms), the bulk
// data manifest at 10/min (10,000ms), and everything else at 10/sec (100ms).
type Tier = "heavy" | "manifest" | "light";

const TIER_INTERVAL_MS: Record<Tier, number> = {
  heavy: 500,
  manifest: 10000,
  light: 100
};

const HEAVY_PATH_PREFIXES = ["/cards/search", "/cards/named", "/cards/random", "/cards/collection"];
const MANIFEST_PATH_PREFIXES = ["/bulk-data", "/cards/manifest"];

function tierFor(pathname: string): Tier {
  if (MANIFEST_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return "manifest";
  if (HEAVY_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return "heavy";
  return "light";
}

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

/** Serializes requests per tier so consecutive calls in the same tier never run closer than its documented interval. */
class TieredRateLimiter {
  private queues: Record<Tier, Promise<void>> = { heavy: Promise.resolve(), manifest: Promise.resolve(), light: Promise.resolve() };
  private lastRequestAt: Record<Tier, number> = { heavy: 0, manifest: 0, light: 0 };

  async wait(tier: Tier): Promise<void> {
    const turn = this.queues[tier].then(async () => {
      const elapsed = Date.now() - this.lastRequestAt[tier];
      const remaining = TIER_INTERVAL_MS[tier] - elapsed;
      if (remaining > 0) {
        await new Promise((resolve) => setTimeout(resolve, remaining));
      }
      this.lastRequestAt[tier] = Date.now();
    });
    this.queues[tier] = turn;
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
  private rateLimiter = new TieredRateLimiter();
  private cache = new InMemoryCache();
  private bannedLists: BannedListCache = {} as BannedListCache;

  private async fetchJson<T>(url: string): Promise<T> {
    const cacheKey = cacheKeyFor(url);
    const cached = cacheKey !== null ? this.cache.get(cacheKey) : undefined;
    if (cached !== undefined) return cached as T;

    const tier = tierFor(new URL(url).pathname);
    let attempt = 0;
    let backoffMs = 1000;

    while (true) {
      await this.rateLimiter.wait(tier);
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

  async searchCards(
    query: string,
    options: { limit?: number; order?: string; unique?: "cards" | "art" | "prints"; lang?: ScryfallLang } = {}
  ): Promise<ScryfallCard[]> {
    const limit = Math.max(1, Math.min(options.limit ?? 20, 175));
    let q = query.trim();
    if (options.lang && !/\blang(?:uage)?:/i.test(q)) {
      q = `${q} lang:${options.lang}`.trim();
    }
    const params = new URLSearchParams({
      q,
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

  /**
   * Resolve a card by English Oracle name or localized printed name.
   * Optionally re-fetch a print in `options.lang` (falls back to the first match if that language has no print).
   */
  async namedCard(name: string, options: { lang?: ScryfallLang } = {}): Promise<ScryfallCard> {
    let card = await this.resolveCardByName(name);
    if (options.lang && card.lang !== options.lang) {
      const localized = await this.findPrintInLang(card.name, options.lang);
      if (localized) card = localized;
    }
    return card;
  }

  private async resolveCardByName(name: string): Promise<ScryfallCard> {
    const trimmed = name.trim();
    try {
      const params = new URLSearchParams({ fuzzy: trimmed });
      return await this.fetchJson<ScryfallCard>(`${SCRYFALL_API}/cards/named?${params.toString()}`);
    } catch (error) {
      if (!(error instanceof ScryfallError) || (error.status !== 404 && error.code !== "not_found" && error.code !== "ambiguous")) {
        throw error;
      }
    }

    const exact = await this.searchCards(`!"${trimmed}" lang:any`, { limit: 2, unique: "cards", order: "name" });
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) {
      throw new ScryfallError(404, "ambiguous", `Multiple cards matched the name "${trimmed}".`);
    }

    const loose = await this.searchCards(`${JSON.stringify(trimmed)} lang:any`, { limit: 2, unique: "cards", order: "name" });
    if (loose.length === 1) return loose[0];
    if (loose.length > 1) {
      throw new ScryfallError(404, "ambiguous", `Multiple cards matched the name "${trimmed}".`);
    }

    throw new ScryfallError(404, "not_found", `No cards found matching "${trimmed}".`);
  }

  private async findPrintInLang(oracleName: string, lang: ScryfallLang): Promise<ScryfallCard | undefined> {
    // Prefer a recent print (dir=desc) so imagery and localization tend to be current.
    const prints = await this.searchCards(`!"${oracleName}" lang:${lang} direction:desc`, {
      limit: 1,
      unique: "prints",
      order: "released"
    });
    return prints[0];
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

export type CardLocaleFields = {
  name: string;
  printedName?: string;
  printedTypeLine?: string;
  printedText?: string;
  lang?: string;
  typeLine?: string;
  oracleText?: string;
};

/** Oracle name/text plus optional localized print fields from Scryfall. */
export function cardLocaleFields(card: ScryfallCard): CardLocaleFields {
  const facesOracle = card.card_faces?.map((face) => face.oracle_text ?? "").filter(Boolean).join("\n//\n");
  const facesPrinted = card.card_faces?.map((face) => face.printed_text ?? face.oracle_text ?? "").filter(Boolean).join("\n//\n");
  const printedName =
    card.printed_name ??
    card.card_faces?.map((face) => face.printed_name ?? face.name).filter(Boolean).join(" // ") ??
    undefined;
  const printedTypeLine =
    card.printed_type_line ??
    card.card_faces?.map((face) => face.printed_type_line ?? face.type_line).filter(Boolean).join(" // ") ??
    undefined;

  return {
    name: card.name,
    printedName: printedName && printedName !== card.name ? printedName : card.printed_name,
    printedTypeLine,
    printedText: card.printed_text ?? facesPrinted,
    lang: card.lang,
    typeLine: card.type_line,
    oracleText: card.oracle_text ?? facesOracle
  };
}

export function summarizeCard(card: ScryfallCard): string {
  const locale = cardLocaleFields(card);
  const faces = card.card_faces?.map((face) => {
    const faceName = face.printed_name && face.printed_name !== face.name
      ? `${face.printed_name} (${face.name})`
      : face.name;
    return `${faceName}: ${face.printed_text ?? face.oracle_text ?? ""}`;
  }).join(" // ");
  const body = locale.printedText && card.lang && card.lang !== "en"
    ? locale.printedText
    : (card.oracle_text ?? faces ?? "");
  const price = card.prices?.usd ? ` / $${card.prices.usd}` : "";
  const typeLine = (card.lang && card.lang !== "en" && locale.printedTypeLine)
    ? locale.printedTypeLine
    : (card.type_line ?? "");
  const heading = locale.printedName && locale.printedName !== card.name
    ? `${locale.printedName} (${card.name})`
    : card.name;
  return `${heading} ${card.mana_cost ?? ""} — ${typeLine}${price}\n${body}\n${card.scryfall_uri ?? ""}`.trim();
}

function faceImageUris(card: ScryfallCard, face: "front" | "back"): Record<string, string> | undefined {
  if (face === "back") return card.card_faces?.[1]?.image_uris;
  return card.image_uris ?? card.card_faces?.[0]?.image_uris;
}

/**
 * Resolves a card image URL from the already-fetched JSON card object, mirroring
 * the `version` (default "large") and `face` parameters of Scryfall's format=image
 * redirect endpoint (scryfall.com/docs/api Request Formats) without a second request.
 */
export function cardImageUri(card: ScryfallCard, opts: { version?: ImageVersion; face?: "front" | "back" } = {}): string | undefined {
  return faceImageUris(card, opts.face ?? "front")?.[opts.version ?? "large"];
}

/** Mirrors the 422 Scryfall returns for format=image&face=back on a card with no back face. */
export function hasBackFace(card: ScryfallCard): boolean {
  const back = card.card_faces?.[1];
  return Boolean(back && (back.image_uris ?? back.oracle_text));
}

/** Scryfall's image guidelines require crediting the artist wherever an art_crop image is shown. */
export function cardArtist(card: ScryfallCard): string | undefined {
  return card.artist ?? card.card_faces?.[0]?.artist;
}
