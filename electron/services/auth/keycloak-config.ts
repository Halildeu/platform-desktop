/**
 * Keycloak OAuth2 config — env-parametrik (#1 PR-desktop-01).
 *
 * Gerçek değerler Halil'in #1 yorumundaki cevabıyla `.env`'e konur
 * (KEYCLOAK_BASE_URL / KEYCLOAK_CLIENT_ID / KEYCLOAK_REDIRECT_PORT). Kod yapısı
 * bu değerlere bağlı DEĞİL — config gelmeden iskelet + unit test yazılabilir.
 *
 * Desktop OAuth = RFC 8252 (system browser + loopback redirect). Realm `platform`
 * audio-gateway contract-v1'den biliniyor.
 */

export interface KeycloakConfig {
  /** Keycloak kök URL, örn. https://auth.example.com */
  baseUrl: string;
  /** Realm — Halil #1 config: test realm = `platform-test` */
  realm: string;
  /** Desktop public client id (PKCE) */
  clientId: string;
  /** Loopback redirect portu (127.0.0.1:<port>/callback). 0 = işletim sistemi seçsin */
  redirectPort: number;
  /** OAuth scope */
  scope: string;
}

/** Env'den (parametrik) config yükle. Test için env enjekte edilebilir. */
export function loadKeycloakConfig(env: NodeJS.ProcessEnv = process.env): KeycloakConfig {
  return {
    baseUrl: (env.KEYCLOAK_BASE_URL ?? '').replace(/\/+$/, ''),
    realm: env.KEYCLOAK_REALM ?? 'platform-test',
    clientId: env.KEYCLOAK_CLIENT_ID ?? 'platform-desktop',
    redirectPort: Number.parseInt(env.KEYCLOAK_REDIRECT_PORT ?? '8123', 10) || 8123,
    scope: env.KEYCLOAK_SCOPE ?? 'openid profile email',
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
    return `${missing.join(', ')} tanimli degil; .env icinde Keycloak test realm config'i gerekli.`;
  }

  try {
    const parsed = new URL(cfg.baseUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return 'KEYCLOAK_BASE_URL http/https mutlak URL olmali.';
    }
    if (parsed.protocol === 'http:' && !['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) {
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
