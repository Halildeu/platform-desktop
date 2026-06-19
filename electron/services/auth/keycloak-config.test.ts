import { describe, expect, it } from 'vitest';

import {
  authorizationEndpoint,
  isConfigReady,
  loadKeycloakConfig,
  logoutEndpoint,
  tokenEndpoint,
} from './keycloak-config';

describe('keycloak-config', () => {
  it('env boşken Halil #1 default config (platform-test, 8123)', () => {
    const cfg = loadKeycloakConfig({});
    expect(cfg.realm).toBe('platform-test');
    expect(cfg.baseUrl).toBe('');
    expect(cfg.clientId).toBe('platform-desktop');
    expect(cfg.redirectPort).toBe(8123);
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

  it('geçersiz port → 8123 default (sabit-port loopback)', () => {
    expect(loadKeycloakConfig({ KEYCLOAK_REDIRECT_PORT: 'abc' }).redirectPort).toBe(8123);
  });

  it('isConfigReady: baseUrl boşken false, dolunca true (realm+clientId default dolu)', () => {
    expect(isConfigReady(loadKeycloakConfig({}))).toBe(false); // baseUrl boş
    expect(isConfigReady(loadKeycloakConfig({ KEYCLOAK_BASE_URL: 'https://a' }))).toBe(true);
    // boş clientId açıkça verilirse yine false
    expect(
      isConfigReady(loadKeycloakConfig({ KEYCLOAK_BASE_URL: 'https://a', KEYCLOAK_CLIENT_ID: '' })),
    ).toBe(false);
  });

  it('OIDC endpoint URL’lerini doğru kurar', () => {
    const cfg = loadKeycloakConfig({ KEYCLOAK_BASE_URL: 'https://a', KEYCLOAK_CLIENT_ID: 'c' });
    const base = 'https://a/realms/platform-test/protocol/openid-connect';
    expect(authorizationEndpoint(cfg)).toBe(`${base}/auth`);
    expect(tokenEndpoint(cfg)).toBe(`${base}/token`);
    expect(logoutEndpoint(cfg)).toBe(`${base}/logout`);
  });
});
