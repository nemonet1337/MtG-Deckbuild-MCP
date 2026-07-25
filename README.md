# MtG-Deckbuild-MCP

> 日本語: [README_ja.md](./README_ja.md)

An MCP server that connects to the Scryfall API so AI models can build practical Magic: The Gathering decks.

## Features

- Scryfall card search, fuzzy name resolution, and format legality checks
- Card recommendations by format, colors, mechanics, budget, and power level
- Singleton construction for Commander / Brawl / Oathbreaker and 60-card shells
- Categorized suggestions: lands, ramp, draw, interaction, synergy, win conditions, sideboard
- Tournament reference snippets from MTGDecks, MTGGoldfish, and MTGTop8
- Lightweight analysis of existing decklists (counts, name resolution, legality, singleton issues)
- Interactive wizard that gathers colors, keywords, and playstyle, then builds a deck
- Budget alternatives for expensive cards (with estimated savings)
- Save / list / get / edit / delete personal decks (Workers KV or local JSON; no login)

## Setup

```bash
npm install
npm run build
```

## MCP client configuration example

```json
{
  "mcpServers": {
    "mtg-deckbuild": {
      "command": "node",
      "args": ["C:/github/MtG-Deckbuild-MCP/dist/index.js"]
    }
  }
}
```

For development:

```bash
npm run dev
```

## Remote deploy on Cloudflare Workers

Besides the stdio entrypoint, the same tools run as a remote MCP server on Cloudflare Workers (Streamable HTTP at `/mcp`). Tool definitions live in `createServer()` in `src/server.ts` and are shared by stdio (`src/index.ts`) and Workers (`src/worker.ts`).

### Local check

```bash
npm run dev:worker
```

The MCP endpoint is `http://127.0.0.1:8787/mcp`. You can verify with [MCP Inspector](https://github.com/modelcontextprotocol/inspector) or Streamable HTTP `curl` requests.

### Deploy

On first setup, run `npx wrangler login` and create a KV namespace for saved decks:

```bash
npx wrangler kv namespace create DECKS
```

Paste the returned `id` into `wrangler.jsonc` under `kv_namespaces` (`REPLACE_WITH_KV_NAMESPACE_ID`).

```bash
npm run deploy
```

After deploy, the public endpoint is `https://mtg-deckbuild-mcp.<your-subdomain>.workers.dev/mcp`. **There is no login or auth: anyone who can reach `/mcp` can run every tool, including save/edit/delete for decks.** Decks share a single KV bucket, so multiple users on the same endpoint can see each other's decks.

stdio decks (`dist/index.js`) are stored as JSON under `~/.mtg-deckbuild-mcp/decks/`.

### Auto-deploy (GitHub Actions)

Pushes to `main` that touch `src/`, `wrangler.jsonc`, or `package.json` run `wrangler deploy` via [.github/workflows/deploy.yml](.github/workflows/deploy.yml). Manual runs (`workflow_dispatch`) are supported.

Register these repository secrets under Settings → Secrets and variables → Actions:

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | API token from the Cloudflare dashboard (prefer a custom token limited to “Edit Cloudflare Workers”) |
| `CLOUDFLARE_ACCOUNT_ID` | Account ID from the Cloudflare dashboard sidebar |

After that, pushes to `main` deploy without a manual `npm run deploy`.

> **Note**: Auto-deploy fails until the KV namespace `id` in `wrangler.jsonc` is a real value (secrets persist across deploys; no workflow change needed for that).

### Connect from Claude Web as a custom connector

1. claude.ai → Settings → Connectors → Add custom connector
2. Paste the `/mcp` URL (no auth)
3. After connecting, tools such as `search_cards` are available in chat

### Connect from Grok as a custom connector

1. grok.com/connectors → **New Connector** → **Custom**
2. Paste the `/mcp` URL
3. Done when tools are auto-detected

### CORS / CSP

- **Access to this server**: `POST` / `OPTIONS` / `GET` on `/mcp` return `Access-Control-Allow-Origin: *` (`GET` is implemented here; `POST` / `OPTIONS` get the header from `createMcpHandler` in the `agents` package). Browser MCP clients can call the endpoint directly (verified with `wrangler dev` + `curl -H "Origin: ..."`).
- **Calls from this server to Scryfall**: All Scryfall traffic is server-side `fetch` on Workers / Node.js, so [Scryfall CORS rules](https://scryfall.com/docs/api) for browser origins do not apply.
- **If you build a UI that shows images**: `imageUri` points at `*.scryfall.io`. Follow Scryfall CSP guidance and allow `img-src *.scryfall.io`; if the UI also calls `api.scryfall.com` directly, add `connect-src api.scryfall.com`. This MCP server only returns URLs; it does not render images in the browser.

### Known limitations

- Scryfall rate limiting and caching are in-process memory. Workers may run separate isolates per request, so control is best-effort. Fine for personal use.
- `find_tournament_decks` fetches up to three external sites per call.
- Bulk name resolution (`analyze_deck`, `suggest_budget_alternatives`) calls `/cards/named` sequentially and can take several seconds at the card limits.

## Public tools

| Tool | Purpose |
| --- | --- |
| `search_cards` | Search with Scryfall syntax, format, colors, mechanics (includes image URL and artist) |
| `get_card_details` | Card details, text, price, legality, image URL, artist, Scryfall URL |
| `recommend_cards` | Category recommendations for a deck plan |
| `build_deck` | Practical deck shell and decklist |
| `analyze_deck` | Light validation of an existing decklist |
| `find_tournament_decks` | Tournament page snippets and citation URLs |
| `deck_wizard` | Interactive questions for colors, keywords, playstyle, then build |
| `suggest_budget_alternatives` | Cheaper substitutes for expensive cards with estimated savings |
| `save_deck` | Save a personal deck |
| `list_decks` | List saved decks |
| `get_deck` | Fetch a saved deck |
| `update_deck` | Edit name, notes, list; add/remove cards |
| `delete_deck` | Delete a saved deck |

### Deck wizard usage

`deck_wizard` is stateless. With no args it returns `questions` for missing settings (format, colors, playstyle, etc.). The client merges user answers into the returned `state` and calls again. When required fields are set, it builds a deck. With `format` and `colors` present you can pass `finalize: true` to build immediately.

### Personal deck edit example

```json
{
  "id": "<id from get_deck or list_decks>",
  "addCards": ["2 Lightning Bolt"],
  "removeCards": ["Shock"]
}
```

### Card images

`search_cards`, `recommend_cards`, `build_deck`, and `get_card_details` return `image_uris` already embedded in Scryfall card JSON, so no extra [image-format](https://scryfall.com/docs/api) request is needed. `get_card_details` accepts the same `version` (`small` / `normal` / `large` / `png` / `art_crop` / `border_crop`, default `large`) and `face` (`front` / `back`) as that endpoint. Requesting a back face on a single-faced card returns a Scryfall-style 422 message. `artist` is always included so `art_crop` UIs can credit the illustrator (Scryfall image guidelines).

### Multilingual support

Card I/O follows [Scryfall Languages](https://scryfall.com/docs/api/languages).

- **Input**: English Oracle names and localized printed names (e.g. `太陽の指輪`, `Contresort`) resolve via `get_card_details`, `analyze_deck`, `build_deck` commander/mustInclude, and `suggest_budget_alternatives`
- **Output**: Optional `lang` (Scryfall code) prefers that language’s print and returns `printedName` / `printedTypeLine` / `printedText` / `lang` plus that print’s image URL
- **`name` field**: Always the English Oracle name. Decklist strings are normalized to English Oracle names
- **Codes**: `en` `es` `fr` `de` `it` `pt` `ja` `ko` `ru` `zhs` `zht` `he` `la` `grc` `ar` `sa` `ph` `qya` `dw`
- **Default**: English Oracle print when `lang` is omitted
- **Missing language print**: Falls back to a resolved print without error; printed fields may be omitted
- **Limits**: Scryfall `/cards/autocomplete` is English-only, so this server does not offer multilingual autocomplete. Oracle text is always English (rules)

Example: details by Japanese printed name.

```json
{
  "name": "太陽の指輪",
  "lang": "ja"
}
```

Result: `name` is `Sol Ring`, `printedName` is `太陽の指輪`, image from the Japanese print.

English name with Japanese print:

```json
{
  "name": "Sol Ring",
  "lang": "ja"
}
```

The same `lang` is accepted on `search_cards`, `recommend_cards`, `build_deck`, `analyze_deck`, `suggest_budget_alternatives`, and `deck_wizard` (`state.lang`).

## Usage examples

```json
{
  "format": "pioneer",
  "colors": ["B", "R"],
  "strategy": "Rakdos sacrifice",
  "mechanics": ["sacrifice", "graveyard"],
  "budget": "mid",
  "powerLevel": "competitive",
  "includeSideboard": true
}
```

Commander example:

```json
{
  "format": "commander",
  "colors": ["G", "U"],
  "strategy": "Simic landfall ramp",
  "mechanics": ["landfall", "ramp", "draw"],
  "commander": "Aesi, Tyrant of Gyre Strait",
  "budget": "mid",
  "powerLevel": "focused"
}
```

## Scryfall API guideline compliance

This server follows the [Scryfall API documentation](https://scryfall.com/docs/api).

- **Required headers**: Every Scryfall request sends an app-specific `User-Agent` (versioned in `src/config.ts`) and `Accept: application/json`
- **Rate limits**: Per [official rate limits](https://scryfall.com/docs/api/rate-limits), `TieredRateLimiter` in `src/services/scryfall.ts` serializes by path tier: `/cards/search`, `/cards/named`, `/cards/random`, `/cards/collection` at 2 req/s (500 ms); bulk-data manifests at 10 req/min (10,000 ms); others (e.g. autocomplete) at 10 req/s (100 ms). On HTTP 429 (documented 30s block), it honors `Retry-After` or exponential backoff from 1s up to 30s
- **Caching**: Responses are cached in memory for 24 hours per Scryfall guidance (`/cards/random` excluded)
- **Errors**: [Error objects](https://scryfall.com/docs/api/errors) (`object`, `code`, `status`, `details`, `warnings`) are parsed into `ScryfallError` without ad-hoc string chopping
- **Bulk name lookups**: Scryfall recommends bulk data for high-volume name/price work. This server only resolves names for single-deck analysis/alternatives, so it uses sequential `/cards/named` with caps (`analyze_deck` 120 cards; budget alternatives top 10 expensive cards). No login; all users share the same cache and rate limiter
- **Image format**: `version` / `face` match [Request Formats](https://scryfall.com/docs/api) via embedded `image_uris` (no second request). Back face on a non-DFC returns a 422-style error
- **Image usage**: Image URLs are returned as-is (no crop, watermark strip, or custom logos). Responses that include `art_crop` also include `artist`
- **CORS / CSP**: Scryfall [CORS/CSP](https://scryfall.com/docs/api) apply to browser JS calling Scryfall directly. This server only uses server-side `fetch`. Its own `/mcp` endpoint sets `Access-Control-Allow-Origin` for browser MCP clients (see deploy section)
- **No paywall**: All tools work without login
- **Languages**: Uses [Languages](https://scryfall.com/docs/api/languages) and [search `lang:`](https://scryfall.com/docs/syntax) for printed fields; Oracle names stay English for identity (e.g. ban lists)
- **Value-add**: Deck building, analysis, and recommendations—not a bare Scryfall mirror

## Sources and notes

- Card data, image URLs, prices, and legality come from the Scryfall API.
- Tournament references return public page URLs and available snippets from MTGDecks, MTGGoldfish, and MTGTop8.
- Generated lists are starting points. Before events, check the latest bans, event rules, and local metagame.
