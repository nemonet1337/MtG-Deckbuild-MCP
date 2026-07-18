import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DeckStore, DeckSummary, SavedDeck, deckSummary } from "./deckStore.js";

export class FileDeckStore implements DeckStore {
  constructor(private readonly baseDir = join(homedir(), ".mtg-deckbuild-mcp", "decks")) {}

  private userDir(userId: string): string {
    return join(this.baseDir, userId);
  }

  private deckPath(userId: string, deckId: string): string {
    return join(this.userDir(userId), `${deckId}.json`);
  }

  async save(userId: string, deck: SavedDeck): Promise<void> {
    await mkdir(this.userDir(userId), { recursive: true });
    await writeFile(this.deckPath(userId, deck.id), JSON.stringify(deck, null, 2), "utf8");
  }

  async get(userId: string, id: string): Promise<SavedDeck | null> {
    try {
      return JSON.parse(await readFile(this.deckPath(userId, id), "utf8")) as SavedDeck;
    } catch {
      return null;
    }
  }

  async list(userId: string): Promise<DeckSummary[]> {
    let files: string[];
    try {
      files = await readdir(this.userDir(userId));
    } catch {
      return [];
    }
    const summaries: DeckSummary[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const deck = await this.get(userId, file.slice(0, -".json".length));
      if (deck) summaries.push(deckSummary(deck));
    }
    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async delete(userId: string, id: string): Promise<boolean> {
    if ((await this.get(userId, id)) === null) return false;
    await rm(this.deckPath(userId, id), { force: true });
    return true;
  }
}
