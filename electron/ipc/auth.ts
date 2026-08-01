/**
 * Auth IPC handlers (#1) — main process köprüsü.
 *
 * Renderer login'i tetikler; gerçek OAuth akışı + token main-process'te kalır.
 * **Token RENDERER'a verilmez** (KVKK/Codex): yalnız `loggedIn` / `expiresAt` döner.
 */

import { ipcMain, shell } from 'electron';

import { assertKeycloakConfigReady, loadKeycloakConfig } from '../services/auth/keycloak-config.js';
import { performLogin } from '../services/auth/login-service.js';
import { safeJwtClaims, type SafeJwtClaims } from '../services/auth/jwt-claims.js';
import {
  isReauthenticationRequired,
  refreshAccessToken,
  revokeRefreshToken,
} from '../services/auth/oauth-flow.js';
import type { TokenSet } from '../services/auth/token-utils.js';
import { TokenStore } from '../services/auth/token-store.js';

export interface AuthStatus {
  loggedIn: boolean;
  expiresAt?: number;
  claims?: SafeJwtClaims | null;
}

let tokenStore: TokenStore | null = null;
let refreshInFlight: Promise<TokenSet> | null = null;

function store(): TokenStore {
  tokenStore ??= new TokenStore();
  return tokenStore;
}

/** Paylaşılan token deposu (audio IPC gateway JWT'si için). */
export function getTokenStore(): TokenStore {
  return store();
}

async function refreshStoredSession(): Promise<TokenSet> {
  if (refreshInFlight) {
    return refreshInFlight;
  }

  const pending = (async (): Promise<TokenSet> => {
    const current = store().getAccess();
    if (current && store().hasValidAccess()) {
      return current;
    }

    const refreshToken = store().getRefreshToken();
    if (!refreshToken) {
      throw new Error('not logged in (no refresh token)');
    }

    const cfg = loadKeycloakConfig();
    assertKeycloakConfigReady(cfg);

    try {
      const tokens = await refreshAccessToken(cfg, refreshToken);
      if (store().getRefreshToken() !== refreshToken) {
        const replacement = store().getAccess();
        if (replacement && store().hasValidAccess()) {
          return replacement;
        }
        throw new Error('authentication session changed during token refresh');
      }
      store().setSession(tokens);
      return tokens;
    } catch (error) {
      if (isReauthenticationRequired(error) && store().getRefreshToken() === refreshToken) {
        store().clear();
        throw new Error('authentication expired; sign in again');
      }
      throw error;
    }
  })();

  refreshInFlight = pending;
  try {
    return await pending;
  } finally {
    if (refreshInFlight === pending) {
      refreshInFlight = null;
    }
  }
}

export async function getValidAccessToken(): Promise<string> {
  const current = store().getAccess();
  if (current && store().hasValidAccess()) {
    return current.accessToken;
  }

  return (await refreshStoredSession()).accessToken;
}

export function registerAuthIpc(): void {
  ipcMain.handle('auth:login', async (): Promise<AuthStatus> => {
    const cfg = loadKeycloakConfig();
    assertKeycloakConfigReady(cfg);
    const tokens = await performLogin(cfg, {
      openExternal: (url) => shell.openExternal(url),
    });
    store().setSession(tokens);
    return {
      loggedIn: true,
      expiresAt: tokens.expiresAt,
      claims: safeJwtClaims(tokens.accessToken),
    };
  });

  ipcMain.handle('auth:status', async (): Promise<AuthStatus> => {
    const t = store().getAccess();
    if (!store().hasValidAccess() && store().getRefreshToken()) {
      try {
        const tokens = await refreshStoredSession();
        return {
          loggedIn: true,
          expiresAt: tokens.expiresAt,
          claims: safeJwtClaims(tokens.accessToken),
        };
      } catch {
        return { loggedIn: false };
      }
    }

    return {
      loggedIn: store().hasValidAccess(),
      expiresAt: t?.expiresAt,
      claims: safeJwtClaims(t?.accessToken),
    };
  });

  ipcMain.handle('auth:logout', async (): Promise<AuthStatus> => {
    const refreshToken = store().getRefreshToken();
    try {
      if (refreshToken) {
        const cfg = loadKeycloakConfig();
        assertKeycloakConfigReady(cfg);
        await revokeRefreshToken(cfg, refreshToken);
      }
      return { loggedIn: false };
    } finally {
      store().clear();
    }
  });
}
