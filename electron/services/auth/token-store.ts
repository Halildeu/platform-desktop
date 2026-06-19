/**
 * Token store — OS keychain ile (Codex hardening, Halil #1).
 *
 * KVKK/güvenlik:
 * - access-token: **MEMORY-ONLY** (diske yazılmaz, renderer'a sızmaz)
 * - refresh-token: **OS keychain** (Electron `safeStorage` — macOS Keychain /
 *   Windows Credential Manager). electron-store encrypted YETMEZ (gömülü key =
 *   obfuscation); safeStorage OS-backed gerçek şifreleme.
 * - token exchange/refresh yalnız main-process; renderer'a refresh verilmez.
 *
 * Saf yardımcılar token-utils.ts'te (Electron'suz, unit-testable). Bu dosya
 * Electron runtime gerektirir (safeStorage) → e2e ile doğrulanır.
 */

import { safeStorage } from 'electron';
import Store from 'electron-store';

import { isExpired, type TokenSet } from './token-utils';

interface PersistShape {
  /** safeStorage ile şifreli refresh-token (base64). */
  refreshTokenEnc?: string;
}

/** Access memory-only + refresh OS-keychain (safeStorage). */
export class TokenStore {
  private memoryAccess: TokenSet | null = null;
  private readonly store: Store<PersistShape>;

  constructor() {
    this.store = new Store<PersistShape>({ name: 'auth', clearInvalidConfig: true });
  }

  /** Login/refresh sonrası oturumu kaydet. */
  setSession(tokens: TokenSet): void {
    this.memoryAccess = tokens;
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS encryption (safeStorage) unavailable — refresh token saklanamaz');
    }
    const enc = safeStorage.encryptString(tokens.refreshToken).toString('base64');
    this.store.set('refreshTokenEnc', enc);
  }

  /** Bellekteki access token seti (yoksa null). */
  getAccess(): TokenSet | null {
    return this.memoryAccess;
  }

  /** Keychain'den refresh-token (yalnız main-process; renderer'a verilmez). */
  getRefreshToken(): string | null {
    const enc = this.store.get('refreshTokenEnc');
    if (!enc || !safeStorage.isEncryptionAvailable()) {
      return null;
    }
    return safeStorage.decryptString(Buffer.from(enc, 'base64'));
  }

  hasValidAccess(nowMs: number = Date.now()): boolean {
    return this.memoryAccess !== null && !isExpired(this.memoryAccess, nowMs);
  }

  clear(): void {
    this.memoryAccess = null;
    this.store.delete('refreshTokenEnc');
  }
}
