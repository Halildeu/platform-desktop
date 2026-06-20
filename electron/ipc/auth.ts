/**
 * Auth IPC handlers (#1) — main process köprüsü.
 *
 * Renderer login'i tetikler; gerçek OAuth akışı + token main-process'te kalır.
 * **Token RENDERER'a verilmez** (KVKK/Codex): yalnız `loggedIn` / `expiresAt` döner.
 */

import { ipcMain, shell } from 'electron';

import { loadKeycloakConfig } from '../services/auth/keycloak-config';
import { performLogin } from '../services/auth/login-service';
import { TokenStore } from '../services/auth/token-store';

export interface AuthStatus {
  loggedIn: boolean;
  expiresAt?: number;
}

let tokenStore: TokenStore | null = null;

function store(): TokenStore {
  tokenStore ??= new TokenStore();
  return tokenStore;
}

export function registerAuthIpc(): void {
  ipcMain.handle('auth:login', async (): Promise<AuthStatus> => {
    const cfg = loadKeycloakConfig();
    const tokens = await performLogin(cfg, {
      openExternal: (url) => shell.openExternal(url),
    });
    store().setSession(tokens);
    return { loggedIn: true, expiresAt: tokens.expiresAt };
  });

  ipcMain.handle('auth:status', (): AuthStatus => {
    const t = store().getAccess();
    return { loggedIn: store().hasValidAccess(), expiresAt: t?.expiresAt };
  });

  ipcMain.handle('auth:logout', (): AuthStatus => {
    store().clear();
    return { loggedIn: false };
  });
}
