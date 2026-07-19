/** Keycloak OAuth2 public runtime config (RFC 8252 + PKCE). */

import {
  type PublicRuntimeConfigLoadOptions,
  resolvePublicRuntimeEnvironment,
} from '../public-runtime-config.js';

export interface KeycloakConfig {
  /** Keycloak kök URL, örn. https://auth.example.com */
  baseUrl: string;
  /** Realm — Halil #1 config: test realm = `platform-test` */
  realm: string;
  /** Desktop public client id (PKCE) */
  clientId: string;
  /** Sabit loopback redirect portu (127.0.0.1:<port>/callback). */
  redirectPort: number;
  /** OAuth scope */
  scope: string;
}

/** Env > managed user > managed system > packaged config onceligiyle yukle. */
export function loadKeycloakConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: PublicRuntimeConfigLoadOptions = {},
): KeycloakConfig {
  const resolvedEnv = resolvePublicRuntimeEnvironment(env, options).env;
  return {
    baseUrl: (resolvedEnv.KEYCLOAK_BASE_URL ?? '').replace(/\/+$/, ''),
    realm: resolvedEnv.KEYCLOAK_REALM ?? 'platform-test',
    clientId: resolvedEnv.KEYCLOAK_CLIENT_ID ?? 'platform-desktop',
    redirectPort: Number.parseInt(resolvedEnv.KEYCLOAK_REDIRECT_PORT ?? '8123', 10) || 8123,
    scope: resolvedEnv.KEYCLOAK_SCOPE ?? 'openid profile email',
  };
}

/** Login'i gerçekten başlatmak için zorunlu alanlar dolu mu? */
export function isConfigReady(cfg: KeycloakConfig): boolean {
  return keycloakConfigError(cfg) === null;
}

export function keycloakConfigError(cfg: KeycloakConfig): string | null {
  const missing = [
    ['KEYCLOAK_BASE_URL', cfg.baseUrl],
    ['KEYCLOAK_REALM', cfg.realm],
    ['KEYCLOAK_CLIENT_ID', cfg.clientId],
  ]
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missing.length > 0) {
    return `${missing.join(', ')} public runtime config icinde tanimli degil (env, managed user/system veya packaged config).`;
  }

  try {
    const parsed = new URL(cfg.baseUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return 'KEYCLOAK_BASE_URL http/https mutlak URL olmali.';
    }
    if (
      parsed.protocol === 'http:' &&
      !['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)
    ) {
      return 'KEYCLOAK_BASE_URL test/canli ortamda https kullanmali.';
    }
  } catch {
    return 'KEYCLOAK_BASE_URL mutlak URL olmali; ornek: https://testai.acik.com';
  }

  return null;
}

export function assertKeycloakConfigReady(cfg: KeycloakConfig): void {
  const error = keycloakConfigError(cfg);
  if (error) {
    throw new Error(error);
  }
}

/** OIDC authorization endpoint (login URL'inin tabanı). */
export function authorizationEndpoint(cfg: KeycloakConfig): string {
  return `${cfg.baseUrl}/realms/${cfg.realm}/protocol/openid-connect/auth`;
}

/** OIDC token endpoint (code → token exchange). */
export function tokenEndpoint(cfg: KeycloakConfig): string {
  return `${cfg.baseUrl}/realms/${cfg.realm}/protocol/openid-connect/token`;
}

/** OIDC logout endpoint. */
export function logoutEndpoint(cfg: KeycloakConfig): string {
  return `${cfg.baseUrl}/realms/${cfg.realm}/protocol/openid-connect/logout`;
}
