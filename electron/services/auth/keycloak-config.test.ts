import { describe, expect, it } from 'vitest';

import {
  assertKeycloakConfigReady,
  authorizationEndpoint,
  isConfigReady,
  keycloakConfigError,
  loadKeycloakConfig,
  logoutEndpoint,
  tokenEndpoint,
} from './keycloak-config';

const NO_PUBLIC_CONFIG = {
  paths: { packaged: null, system: null, user: null },
} as const;
const PACKAGED_ONLY_CONFIG = {
  paths: { system: null, user: null },
} as const;

describe('keycloak-config', () => {
  it('env boşken packaged test config ile normal launch değerlerini yükler', () => {
    const cfg = loadKeycloakConfig({}, PACKAGED_ONLY_CONFIG);
    expect(cfg.realm).toBe('platform-test');
    expect(cfg.baseUrl).toBe('https://testai.acik.com');
    expect(cfg.clientId).toBe('platform-desktop');
    expect(cfg.redirectPort).toBe(8123);
    expect(cfg.scope).toBe('openid profile email');
  });

  it('env parametrelerini okur + sondaki slash temizlenir', () => {
    const cfg = loadKeycloakConfig(
      {
        KEYCLOAK_BASE_URL: 'https://auth.example.com/',
        KEYCLOAK_CLIENT_ID: 'platform-desktop',
        KEYCLOAK_REDIRECT_PORT: '8123',
        KEYCLOAK_SCOPE: 'openid',
      },
      PACKAGED_ONLY_CONFIG,
    );
    expect(cfg.baseUrl).toBe('https://auth.example.com');
    expect(cfg.clientId).toBe('platform-desktop');
    expect(cfg.redirectPort).toBe(8123);
    expect(cfg.scope).toBe('openid');
  });

  it('geçersiz port → 8123 default (sabit-port loopback)', () => {
    expect(
      loadKeycloakConfig({ KEYCLOAK_REDIRECT_PORT: 'abc' }, PACKAGED_ONLY_CONFIG).redirectPort,
    ).toBe(8123);
  });

  it('isConfigReady: baseUrl boşken false, dolunca true (realm+clientId default dolu)', () => {
    expect(isConfigReady(loadKeycloakConfig({}, NO_PUBLIC_CONFIG))).toBe(false);
    expect(
      isConfigReady(loadKeycloakConfig({ KEYCLOAK_BASE_URL: 'https://a' }, PACKAGED_ONLY_CONFIG)),
    ).toBe(true);
    // boş clientId açıkça verilirse yine false
    expect(
      isConfigReady(
        loadKeycloakConfig(
          { KEYCLOAK_BASE_URL: 'https://a', KEYCLOAK_CLIENT_ID: '' },
          PACKAGED_ONLY_CONFIG,
        ),
      ),
    ).toBe(false);
  });

  it('config hatasını browser açmadan önce açıklar', () => {
    const missing = loadKeycloakConfig({}, NO_PUBLIC_CONFIG);
    expect(keycloakConfigError(missing)).toContain('KEYCLOAK_BASE_URL');
    expect(() => assertKeycloakConfigReady(missing)).toThrow('KEYCLOAK_BASE_URL');

    const invalid = loadKeycloakConfig(
      { KEYCLOAK_BASE_URL: 'testai.acik.com' },
      PACKAGED_ONLY_CONFIG,
    );
    expect(keycloakConfigError(invalid)).toBe(
      'KEYCLOAK_BASE_URL mutlak URL olmali; ornek: https://testai.acik.com',
    );
  });

  it('OIDC endpoint URL’lerini doğru kurar', () => {
    const cfg = loadKeycloakConfig(
      { KEYCLOAK_BASE_URL: 'https://a', KEYCLOAK_CLIENT_ID: 'c' },
      PACKAGED_ONLY_CONFIG,
    );
    const base = 'https://a/realms/platform-test/protocol/openid-connect';
    expect(authorizationEndpoint(cfg)).toBe(`${base}/auth`);
    expect(tokenEndpoint(cfg)).toBe(`${base}/token`);
    expect(logoutEndpoint(cfg)).toBe(`${base}/logout`);
  });
});
