import { MtgColor, MtgFormat } from "../types/mtg.js";

export type SavedDeck = {
  id: string;
  name: string;
  format: MtgFormat;
  colors?: MtgColor[];
  strategy?: string;
  notes?: string;
  /** Source of truth: newline-separated "N Card Name" entries. */
  decklist: string;
  createdAt: string;
  updatedAt: string;
};

export type DeckSummary = Pick<SavedDeck, "id" | "name" | "format" | "updatedAt">;

export interface DeckStore {
  save(userId: string, deck: SavedDeck): Promise<void>;
  get(userId: string, id: string): Promise<SavedDeck | null>;
  list(userId: string): Promise<DeckSummary[]>;
  delete(userId: string, id: string): Promise<boolean>;
}

// Structural subset of Cloudflare's KVNamespace so this module typechecks in
// both the node and worker builds without the workers-types global.
export interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { metadata?: unknown }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string; cursor?: string }): Promise<{
    keys: Array<{ name: string; metadata?: unknown }>;
    list_complete: boolean;
    cursor?: string;
  }>;
}

export function deckSummary(deck: SavedDeck): DeckSummary {
  return { id: deck.id, name: deck.name, format: deck.format, updatedAt: deck.updatedAt };
}
