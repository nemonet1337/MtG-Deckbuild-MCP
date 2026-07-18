// Shared application identity. Keep APP_VERSION in sync with package.json.
export const APP_NAME = "MtG-Deckbuild-MCP";
export const APP_VERSION = "1.1.0";

// Scryfall requires an accurate, application-specific User-Agent on every request.
// https://scryfall.com/docs/api
export const USER_AGENT = `${APP_NAME}/${APP_VERSION} (https://github.com/nemonet1337/MtG-Deckbuild-MCP)`;
