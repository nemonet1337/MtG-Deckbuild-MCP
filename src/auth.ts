export type AuthContext = {
  authenticated: boolean;
  userId: string;
};

export type AuthEnv = {
  AUTH_TOKEN?: string;
  AUTH_TOKENS?: string;
};

export type AuthResolution =
  | { kind: "ok"; auth: AuthContext }
  | { kind: "invalid_token" };

export function timingSafeEqualStr(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < length; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function parseTokenMap(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).filter(
          ([token, userId]) => typeof token === "string" && typeof userId === "string"
        )
      ) as Record<string, string>;
    }
  } catch {
    // Malformed AUTH_TOKENS secret: ignore rather than lock everyone out of card data.
  }
  return {};
}

function bearerToken(authorizationHeader: string | null): string | null {
  if (!authorizationHeader) return null;
  const match = authorizationHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/**
 * Resolves the auth state for a request.
 * - No secrets configured: open mode, everything allowed.
 * - Secrets configured, no Authorization header: anonymous. Card-data tools stay
 *   available (Scryfall data must never be paywalled); personal deck tools refuse.
 * - Secrets configured, matching token: authenticated as the mapped user.
 * - Secrets configured, wrong token: invalid_token (caller should return 401).
 */
export function resolveAuth(authorizationHeader: string | null, env: AuthEnv): AuthResolution {
  const tokenMap = parseTokenMap(env.AUTH_TOKENS);
  if (env.AUTH_TOKEN) {
    tokenMap[env.AUTH_TOKEN] = tokenMap[env.AUTH_TOKEN] ?? "default";
  }

  if (Object.keys(tokenMap).length === 0) {
    return { kind: "ok", auth: { authenticated: true, userId: "default" } };
  }

  const token = bearerToken(authorizationHeader);
  if (token === null) {
    return { kind: "ok", auth: { authenticated: false, userId: "anonymous" } };
  }

  for (const [candidate, userId] of Object.entries(tokenMap)) {
    if (timingSafeEqualStr(candidate, token)) {
      return { kind: "ok", auth: { authenticated: true, userId } };
    }
  }
  return { kind: "invalid_token" };
}
