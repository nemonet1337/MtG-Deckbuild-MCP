import { USER_AGENT } from "../config.js";
import { FORMAT_LABELS, MtgFormat } from "../types/mtg.js";

export type TournamentReference = {
  source: string;
  title: string;
  url: string;
  excerpts: string[];
};

// Fetches third-party tournament sites (not Scryfall), so this stays outside ScryfallClient.
async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html, text/plain;q=0.9, */*;q=0.8"
    }
  });
  if (!response.ok) {
    throw new Error(`Reference fetch failed ${response.status}`);
  }
  return response.text();
}

function htmlToLines(html: string): string[] {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 2);
}

function excerpts(lines: string[], needles: string[], limit: number): string[] {
  const loweredNeedles = needles.map((needle) => needle.toLowerCase()).filter(Boolean);
  const matched = lines.filter((line) => loweredNeedles.some((needle) => line.toLowerCase().includes(needle)));
  return (matched.length ? matched : lines).slice(0, limit);
}

export async function getTournamentReferences(format: MtgFormat, archetype = "", limit = 8): Promise<TournamentReference[]> {
  const formatLabel = FORMAT_LABELS[format];
  const sources = [
    {
      source: "MTGDecks",
      title: `${formatLabel} tournament events and decklists`,
      url: `https://mtgdecks.net/${formatLabel}/tournaments`
    },
    {
      source: "MTGGoldfish",
      title: "Recent Magic tournament decklists",
      url: "https://www.mtggoldfish.com/tournaments/all"
    },
    {
      source: "MTGTop8",
      title: "MTGTop8 tournament archive",
      url: "https://mtgtop8.com/"
    }
  ];

  const refs: TournamentReference[] = [];
  for (const source of sources) {
    try {
      const text = await fetchText(source.url);
      const lines = htmlToLines(text);
      refs.push({
        ...source,
        excerpts: excerpts(lines, [archetype, formatLabel], limit)
      });
    } catch {
      refs.push({
        ...source,
        excerpts: ["Source could not be fetched in this environment; use the URL for manual verification."]
      });
    }
  }
  return refs;
}
