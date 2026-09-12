# REVIEW.md

## What matters in this repository
- Honor Scryfall rate limits (heavy 2/s, light 10/s, bulk 10/min) and the 24h cache. Do not add unbounded parallel fetches.
- Format legality, singleton (Commander / Brawl / Oathbreaker), and deck-size rules must stay correct.
- Tool definitions live in `createServer()` and are shared by stdio (`src/index.ts`) and Workers (`src/worker.ts`).
- The Workers `/mcp` endpoint has no auth; saved decks share one KV bucket (`DECK_OWNER = "default"`). Do not add a fake login that does not actually isolate users.
- Prefer small, explicit fixes over broad refactors.

## Severity calibration
- Critical: KV wipe of all decks, ignoring 429/backoff, injecting untrusted card text into shell or file paths.
- Warning: legality bugs, missing Zod validation, cache TTL regression, untested format edge cases.
- Do not flag `dist/` or formatting already covered by `tsc`.

## Verification expectations
- New format or legality rules need tests that assert the observable deck result.
- `wrangler.jsonc` KV or binding changes need a deploy-notes look.
- Shared tool-schema changes must keep stdio and Workers behavior in sync.
