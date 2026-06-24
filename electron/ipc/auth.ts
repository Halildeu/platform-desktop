/**
 * Auth IPC handlers (#1) — main process köprüsü.
 *
 * Renderer login'i tetikler; gerçek OAuth akışı + token main-process'te kalır.
 * **Token RENDERER'a verilmez** (KVKK/Codex): yalnız `loggedIn` / `expiresAt` döner.
 */

import { ipcMain, shell } from 'electron';

import { loadKeycloakConfig } from '../services/auth/keycloak-config';
import { performLogin } from '../services/auth/login-service';
import { safeJwtClaims, type SafeJwtClaims } from '../services/auth/jwt-claims';
import { refreshAccessToken, revokeRefreshToken } from '../services/auth/oauth-flow';
import { TokenStore } from '../services/auth/token-store';

export interface AuthStatus {
  loggedIn: boolean;
  expiresAt?: number;
  claims?: SafeJwtClaims | null;
}

let tokenStore: TokenStore | null = null;

function store(): TokenStore {
  tokenStore ??= new TokenStore();
  return tokenStore;
}

/** Paylaşılan token deposu (audio IPC gateway JWT'si için). */
export function getTokenStore(): TokenStore {
  return store();
}

export async function getValidAccessToken(): Promise<string> {
  const current = store().getAccess();
  if (current && store().hasValidAccess()) {
    return current.accessToken;
  }

  const refreshToken = store().getRefreshToken();
  if (!refreshToken) {
    throw new Error('not logged in (no refresh token)');
  }

  const tokens = await refreshAccessToken(loadKeycloakConfig(), refreshToken);
  store().setSession(tokens);
  return tokens.accessToken;
}

export function registerAuthIpc(): void {
  ipcMain.handle('auth:login', async (): Promise<AuthStatus> => {
    const cfg = loadKeycloakConfig();
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
    if (t && !store().hasValidAccess()) {
      const refreshToken = store().getRefreshToken();
      if (refreshToken) {
        try {
          const tokens = await refreshAccessToken(loadKeycloakConfig(), refreshToken);
          store().setSession(tokens);
          return {
            loggedIn: true,
            expiresAt: tokens.expiresAt,
            claims: safeJwtClaims(tokens.accessToken),
          };
        } catch {
          store().clear();
          return { loggedIn: false };
        }
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
        await revokeRefreshToken(loadKeycloakConfig(), refreshToken);
      }
      return { loggedIn: false };
    } finally {
      store().clear();
    }
  });
}
