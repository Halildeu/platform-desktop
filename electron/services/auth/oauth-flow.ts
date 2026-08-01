/**
 * OAuth2 Authorization Code + PKCE akışı (RFC 8252 desktop).
 *
 * - URL kurucular saf + test-edilebilir (A config'e bağlı DEĞİL).
 * - Token exchange/refresh gerçek HTTP — Halil'in #1 config cevabı `.env`'e
 *   girince loopback e2e ile doğrulanır.
 */

import {
  authorizationEndpoint,
  logoutEndpoint,
  type KeycloakConfig,
  tokenEndpoint,
} from './keycloak-config.js';
import { expiresAtFromExpiresIn, type TokenSet } from './token-utils.js';
import { desktopFetch } from '../net/desktop-fetch.js';

const TOKEN_HTTP_TIMEOUT_MS = 10_000;

export class TokenRefreshError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`token refresh failed: ${status}`);
    this.name = 'TokenRefreshError';
    this.status = status;
  }

  get reauthenticationRequired(): boolean {
    return this.status === 400 || this.status === 401;
  }
}

export function isReauthenticationRequired(error: unknown): boolean {
  return error instanceof TokenRefreshError && error.reauthenticationRequired;
}

/** Loopback redirect URI (RFC 8252): http://127.0.0.1:<port>/callback */
export function loopbackRedirectUri(port: number): string {
  return `http://127.0.0.1:${port}/callback`;
}

export interface AuthUrlParams {
  codeChallenge: string;
  state: string;
  redirectUri: string;
  /** OIDC nonce (Codex hardening — id_token replay koruması). */
  nonce: string;
}

/** Authorization endpoint + query (system browser'da açılacak login URL'i). */
export function buildAuthorizationUrl(cfg: KeycloakConfig, p: AuthUrlParams): string {
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: 'code',
    scope: cfg.scope,
    redirect_uri: p.redirectUri,
    code_challenge: p.codeChallenge,
    code_challenge_method: 'S256',
    state: p.state,
    nonce: p.nonce,
  });
  return `${authorizationEndpoint(cfg)}?${params.toString()}`;
}

interface OidcTokenResponse {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  token_type: string;
  expires_in: number;
}

/** OIDC token cevabını iç TokenSet'e çevir (saf, test-edilebilir). */
export function toTokenSet(res: OidcTokenResponse, nowMs: number = Date.now()): TokenSet {
  return {
    accessToken: res.access_token,
    refreshToken: res.refresh_token,
    idToken: res.id_token,
    tokenType: res.token_type,
    expiresAt: expiresAtFromExpiresIn(res.expires_in, nowMs),
  };
}

/** authorization code → token (PKCE). HTTP — gerçek Keycloak gerekir. */
export async function exchangeCodeForTokens(
  cfg: KeycloakConfig,
  args: { code: string; codeVerifier: string; redirectUri: string },
): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: cfg.clientId,
    code: args.code,
    code_verifier: args.codeVerifier,
    redirect_uri: args.redirectUri,
  });
  const res = await desktopFetch(tokenEndpoint(cfg), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(TOKEN_HTTP_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`token exchange failed: ${res.status}`);
  }
  return toTokenSet((await res.json()) as OidcTokenResponse);
}

/** refresh_token → yeni token. HTTP — gerçek Keycloak gerekir. */
export async function refreshAccessToken(
  cfg: KeycloakConfig,
  refreshToken: string,
): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: cfg.clientId,
    refresh_token: refreshToken,
  });
  const res = await desktopFetch(tokenEndpoint(cfg), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(TOKEN_HTTP_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new TokenRefreshError(res.status);
  }
  return toTokenSet((await res.json()) as OidcTokenResponse);
}

/** refresh_token revoke/logout. Token degeri loglanmaz veya renderer'a donmez. */
export async function revokeRefreshToken(cfg: KeycloakConfig, refreshToken: string): Promise<void> {
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    refresh_token: refreshToken,
  });
  const res = await desktopFetch(logoutEndpoint(cfg), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(TOKEN_HTTP_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`token revoke failed: ${res.status}`);
  }
}
