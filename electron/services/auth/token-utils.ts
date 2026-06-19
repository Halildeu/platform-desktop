/**
 * Token saf yardımcıları — Electron/safeStorage'a BAĞIMSIZ (unit-testable).
 * TokenStore (OS keychain) ayrı dosyada (token-store.ts).
 */

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  /** Erişim token'ının son geçerlilik anı — epoch ms. */
  expiresAt: number;
  tokenType: string;
}

/** Token'ı süresinden biraz önce (skew) yenilemek için pay (ms). */
export const DEFAULT_SKEW_MS = 30_000;

/** OIDC `expires_in` (sn) → mutlak son-geçerlilik (epoch ms). */
export function expiresAtFromExpiresIn(expiresInSec: number, nowMs: number = Date.now()): number {
  return nowMs + expiresInSec * 1000;
}

/** Token süresi doldu mu (skew payı dahil)? */
export function isExpired(
  tokens: Pick<TokenSet, 'expiresAt'>,
  nowMs: number = Date.now(),
  skewMs: number = DEFAULT_SKEW_MS,
): boolean {
  return nowMs >= tokens.expiresAt - skewMs;
}
