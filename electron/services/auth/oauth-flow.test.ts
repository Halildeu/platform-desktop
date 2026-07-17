import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadKeycloakConfig } from './keycloak-config';
import {
  buildAuthorizationUrl,
  loopbackRedirectUri,
  revokeRefreshToken,
  toTokenSet,
} from './oauth-flow';

const cfg = loadKeycloakConfig({
  KEYCLOAK_BASE_URL: 'https://auth.example.com',
  KEYCLOAK_CLIENT_ID: 'platform-desktop',
  KEYCLOAK_SCOPE: 'openid profile',
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('oauth-flow (saf)', () => {
  it('loopbackRedirectUri: RFC 8252 formatı', () => {
    expect(loopbackRedirectUri(8123)).toBe('http://127.0.0.1:8123/callback');
  });

  it('buildAuthorizationUrl: PKCE S256 + state + redirect query', () => {
    const url = new URL(
      buildAuthorizationUrl(cfg, {
        codeChallenge: 'CHAL',
        state: 'ST',
        redirectUri: 'http://127.0.0.1:8123/callback',
        nonce: 'NON',
      }),
    );
    expect(url.origin + url.pathname).toBe(
      'https://auth.example.com/realms/platform-test/protocol/openid-connect/auth',
    );
    expect(url.searchParams.get('client_id')).toBe('platform-desktop');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge')).toBe('CHAL');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('ST');
    expect(url.searchParams.get('nonce')).toBe('NON');
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:8123/callback');
    expect(url.searchParams.get('scope')).toBe('openid profile');
  });

  it('toTokenSet: OIDC cevabı → expiresAt hesabı', () => {
    const ts = toTokenSet(
      {
        access_token: 'AT',
        refresh_token: 'RT',
        id_token: 'IT',
        token_type: 'Bearer',
        expires_in: 300,
      },
      1_000,
    );
    expect(ts.accessToken).toBe('AT');
    expect(ts.refreshToken).toBe('RT');
    expect(ts.expiresAt).toBe(1_000 + 300_000);
  });
  it('revokeRefreshToken: calls Keycloak logout endpoint with refresh token', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    await revokeRefreshToken(cfg, 'REFRESH-TOKEN');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://auth.example.com/realms/platform-test/protocol/openid-connect/logout',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: expect.any(AbortSignal),
      }),
    );

    const body = new URLSearchParams(fetchMock.mock.calls[0][1].body);
    expect(body.get('client_id')).toBe('platform-desktop');
    expect(body.get('refresh_token')).toBe('REFRESH-TOKEN');
  });
});
