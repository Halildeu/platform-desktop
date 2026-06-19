import { describe, expect, it } from 'vitest';

import {
  authorizationEndpoint,
  isConfigReady,
  loadKeycloakConfig,
  logoutEndpoint,
  tokenEndpoint,
} from './keycloak-config';

describe('keycloak-config', () => {
  it('env boşken güvenli varsayılanlar (realm=platform)', () => {
    const cfg = loadKeycloakConfig({});
    expect(cfg.realm).toBe('platform');
    expect(cfg.baseUrl).toBe('');
    expect(cfg.clientId).toBe('');
    expect(cfg.redirectPort).toBe(0);
    expect(cfg.scope).toBe('openid profile email');
  });

  it('env parametrelerini okur + sondaki slash temizlenir', () => {
    const cfg = loadKeycloakConfig({
      KEYCLOAK_BASE_URL: 'https://auth.example.com/',
      KEYCLOAK_CLIENT_ID: 'platform-desktop',
      KEYCLOAK_REDIRECT_PORT: '8123',
      KEYCLOAK_SCOPE: 'openid',
    });
    expect(cfg.baseUrl).toBe('https://auth.example.com');
    expect(cfg.clientId).toBe('platform-desktop');
    expect(cfg.redirectPort).toBe(8123);
    expect(cfg.scope).toBe('openid');
  });

  it('geçersiz port → 0 (OS seçsin)', () => {
    expect(loadKeycloakConfig({ KEYCLOAK_REDIRECT_PORT: 'abc' }).redirectPort).toBe(0);
  });

  it('isConfigReady: baseUrl + clientId dolana dek false', () => {
    expect(isConfigReady(loadKeycloakConfig({}))).toBe(false);
    expect(isConfigReady(loadKeycloakConfig({ KEYCLOAK_BASE_URL: 'https://a' }))).toBe(false);
    expect(
      isConfigReady(
        loadKeycloakConfig({ KEYCLOAK_BASE_URL: 'https://a', KEYCLOAK_CLIENT_ID: 'c' }),
      ),
    ).toBe(true);
  });

  it('OIDC endpoint URL’lerini doğru kurar', () => {
    const cfg = loadKeycloakConfig({ KEYCLOAK_BASE_URL: 'https://a', KEYCLOAK_CLIENT_ID: 'c' });
    const base = 'https://a/realms/platform/protocol/openid-connect';
    expect(authorizationEndpoint(cfg)).toBe(`${base}/auth`);
    expect(tokenEndpoint(cfg)).toBe(`${base}/token`);
    expect(logoutEndpoint(cfg)).toBe(`${base}/logout`);
  });
});
