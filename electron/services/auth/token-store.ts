/**
 * Token store — OAuth token'larını main process'te, şifreli (at-rest) saklar.
 *
 * KVKK/güvenlik (CLAUDE.md): token RENDERER'a sızmaz, yalnız main process tutar.
 * electron-store `encryptionKey` ile disk'te şifreli; saf yardımcılar (isExpired,
 * expiresAtFromExpiresIn) electron-store'a bağımsız → unit-testable.
 */

import Store from 'electron-store';

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

interface StoreShape {
  tokens?: TokenSet;
}

/** Main process token deposu — electron-store ile şifreli kalıcılık. */
export class TokenStore {
  private readonly store: Store<StoreShape>;

  constructor(encryptionKey?: string) {
    this.store = new Store<StoreShape>({
      name: 'auth',
      encryptionKey,
      clearInvalidConfig: true,
    });
  }

  save(tokens: TokenSet): void {
    this.store.set('tokens', tokens);
  }

  get(): TokenSet | undefined {
    return this.store.get('tokens');
  }

  clear(): void {
    this.store.delete('tokens');
  }

  /** Geçerli (süresi dolmamış) bir access token var mı? */
  hasValid(nowMs: number = Date.now()): boolean {
    const t = this.get();
    return t !== undefined && !isExpired(t, nowMs);
  }
}
