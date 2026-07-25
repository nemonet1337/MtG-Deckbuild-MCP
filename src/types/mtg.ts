export const MTG_FORMATS = [
  "standard",
  "pioneer",
  "modern",
  "legacy",
  "vintage",
  "pauper",
  "commander",
  "brawl",
  "historic",
  "explorer",
  "timeless",
  "alchemy",
  "oathbreaker",
  "premodern"
] as const;

export const MTG_COLORS = ["W", "U", "B", "R", "G", "C"] as const;

export const BUDGET_TIERS = ["any", "budget", "mid", "premium"] as const;

export const COST_MODELS = ["paper", "arena"] as const;

export const POWER_LEVELS = ["casual", "focused", "competitive", "cedh"] as const;

// Scryfall language codes: https://scryfall.com/docs/api/languages
export const SCRYFALL_LANGS = [
  "en",
  "es",
  "fr",
  "de",
  "it",
  "pt",
  "ja",
  "ko",
  "ru",
  "zhs",
  "zht",
  "he",
  "la",
  "grc",
  "ar",
  "sa",
  "ph",
  "qya",
  "dw"
] as const;

export type MtgFormat = (typeof MTG_FORMATS)[number];
export type MtgColor = (typeof MTG_COLORS)[number];
export type BudgetTier = (typeof BUDGET_TIERS)[number];
export type CostModel = (typeof COST_MODELS)[number];
export type PowerLevel = (typeof POWER_LEVELS)[number];
export type ScryfallLang = (typeof SCRYFALL_LANGS)[number];

export const FORMAT_LABELS: Record<MtgFormat, string> = {
  standard: "Standard",
  pioneer: "Pioneer",
  modern: "Modern",
  legacy: "Legacy",
  vintage: "Vintage",
  pauper: "Pauper",
  commander: "Commander",
  brawl: "Brawl",
  historic: "Historic",
  explorer: "Explorer",
  timeless: "Timeless",
  alchemy: "Alchemy",
  oathbreaker: "Oathbreaker",
  premodern: "Premodern"
};

const SINGLETON_FORMATS: ReadonlySet<MtgFormat> = new Set(["commander", "brawl", "oathbreaker"]);

export function isSingletonFormat(format: MtgFormat): boolean {
  return SINGLETON_FORMATS.has(format);
}

export function normalizeColors(colors: MtgColor[]): MtgColor[] {
  return [...new Set(colors.map((color) => color.toUpperCase() as MtgColor))];
}

export type ScryfallCard = {
  id: string;
  name: string;
  /** ISO-like Scryfall language code for this printing (en, ja, zhs, ...). */
  lang?: string;
  mana_cost?: string;
  cmc?: number;
  type_line?: string;
  oracle_text?: string;
  /** Localized name printed on this card, if any. */
  printed_name?: string;
  /** Localized type line printed on this card, if any. */
  printed_type_line?: string;
  /** Localized text printed on this card, if any. */
  printed_text?: string;
  colors?: string[];
  color_identity?: string[];
  legalities?: Record<string, string>;
  rarity?: string;
  set_name?: string;
  prices?: Record<string, string | null>;
  /** Keyed by version: small, normal, large, png, art_crop, border_crop. Absent on the root object for double-faced cards; use card_faces instead. */
  image_uris?: Record<string, string>;
  scryfall_uri?: string;
  edhrec_rank?: number;
  keywords?: string[];
  produced_mana?: string[];
  /** Required alongside art_crop images per Scryfall's image usage guidelines. */
  artist?: string;
  card_faces?: Array<{
    name?: string;
    mana_cost?: string;
    type_line?: string;
    oracle_text?: string;
    printed_name?: string;
    printed_type_line?: string;
    printed_text?: string;
    colors?: string[];
    image_uris?: Record<string, string>;
    artist?: string;
  }>;
};

export const IMAGE_VERSIONS = ["small", "normal", "large", "png", "art_crop", "border_crop"] as const;
export type ImageVersion = (typeof IMAGE_VERSIONS)[number];

export type ScryfallList<T> = {
  object: "list";
  total_cards?: number;
  has_more: boolean;
  next_page?: string;
  data: T[];
};

export type DeckCard = {
  name: string;
  quantity: number;
  category: string;
  role: string;
  rationale: string;
  scryfallUri?: string;
  priceUsd?: string | null;
  wildcardCost?: number;
  imageUri?: string;
  artist?: string;
  /** Localized printed name when a non-English lang was requested. */
  printedName?: string;
  lang?: string;
};

export type DeckBuildRequest = {
  format: MtgFormat;
  colors: MtgColor[];
  strategy: string;
  mechanics?: string[];
  commander?: string;
  mustInclude?: string[];
  budget?: BudgetTier;
  powerLevel?: PowerLevel;
  costModel?: CostModel;
  includeSideboard?: boolean;
  /** Preferred Scryfall print language for images and printed_* fields. */
  lang?: ScryfallLang;
};

export type DeckBuildResult = {
  name: string;
  format: MtgFormat;
  colors: MtgColor[];
  strategy: string;
  mainboard: DeckCard[];
  sideboard: DeckCard[];
  citations: Array<{ title: string; url: string }>;
  notes: string[];
  decklist: string;
  totalWildcardCost?: number;
};
