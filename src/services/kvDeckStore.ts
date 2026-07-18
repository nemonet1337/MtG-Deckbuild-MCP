import { DeckStore, DeckSummary, KVLike, SavedDeck, deckSummary } from "./deckStore.js";

function deckKey(userId: string, deckId: string): string {
  return `deck:${userId}:${deckId}`;
}

export class KVDeckStore implements DeckStore {
  constructor(private readonly kv: KVLike) {}

  async save(userId: string, deck: SavedDeck): Promise<void> {
    // Summary rides along as KV metadata so list() needs no extra reads and
    // no separate index key that could drift from the values.
    await this.kv.put(deckKey(userId, deck.id), JSON.stringify(deck), { metadata: deckSummary(deck) });
  }

  async get(userId: string, id: string): Promise<SavedDeck | null> {
    const raw = await this.kv.get(deckKey(userId, id));
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as SavedDeck;
    } catch {
      return null;
    }
  }

  async list(userId: string): Promise<DeckSummary[]> {
    const prefix = `deck:${userId}:`;
    const summaries: DeckSummary[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.kv.list({ prefix, cursor });
      for (const key of page.keys) {
        const metadata = key.metadata as DeckSummary | undefined;
        if (metadata?.id) {
          summaries.push(metadata);
        } else {
          // Metadata missing (e.g. written by an older version): fall back to the value.
          const deck = await this.get(userId, key.name.slice(prefix.length));
          if (deck) summaries.push(deckSummary(deck));
        }
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async delete(userId: string, id: string): Promise<boolean> {
    const exists = (await this.kv.get(deckKey(userId, id))) !== null;
    if (exists) await this.kv.delete(deckKey(userId, id));
    return exists;
  }
}
