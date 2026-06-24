/**
 * Login orchestration (#1, RFC 8252 + Codex hardening) — main process.
 *
 * PKCE + state + OIDC nonce üret → system browser'da Keycloak login aç →
 * loopback callback'ten code al → token exchange. Bağımlılıklar (openExternal,
 * waitForCallback) enjekte edilir → unit-testable; gerçek çalıştırmada Electron
 * shell + loopback server bağlanır.
 *
 * Caller (IPC handler) dönen TokenSet'i TokenStore.setSession ile keychain'e yazar.
 */

import { type KeycloakConfig } from './keycloak-config';
import { buildAuthorizationUrl, exchangeCodeForTokens, loopbackRedirectUri } from './oauth-flow';
import { codeChallengeS256, generateCodeVerifier, generateState } from './pkce';
import { type CallbackResult, waitForCallback } from './loopback-server';
import { type TokenSet } from './token-utils';

export interface LoginDeps {
  /** System default browser'da URL aç (Electron shell.openExternal). */
  openExternal: (url: string) => Promise<void>;
  /** Loopback callback bekleyici (test için enjekte edilebilir). */
  waitForCallback?: (port: number, state: string) => Promise<CallbackResult>;
}

export async function performLogin(cfg: KeycloakConfig, deps: LoginDeps): Promise<TokenSet> {
  const verifier = generateCodeVerifier();
  const challenge = codeChallengeS256(verifier);
  const state = generateState();
  const nonce = generateState();
  const redirectUri = loopbackRedirectUri(cfg.redirectPort);

  const authUrl = buildAuthorizationUrl(cfg, {
    codeChallenge: challenge,
    state,
    redirectUri,
    nonce,
  });

  // Önce callback dinleyiciyi kur, sonra browser'ı aç (race yok).
  const waiter = deps.waitForCallback ?? waitForCallback;
  const callbackPromise = waiter(cfg.redirectPort, state);
  await deps.openExternal(authUrl);

  const { code } = await callbackPromise;
  return exchangeCodeForTokens(cfg, { code, codeVerifier: verifier, redirectUri });
}
