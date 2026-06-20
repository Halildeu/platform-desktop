import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadKeycloakConfig } from './keycloak-config';
import { performLogin } from './login-service';

const cfg = loadKeycloakConfig({
  KEYCLOAK_BASE_URL: 'https://testai.acik.com',
  KEYCLOAK_CLIENT_ID: 'platform-desktop',
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('performLogin (orchestration)', () => {
  it('PKCE+state+nonce authUrl → openExternal → callback code → token', async () => {
    const openExternal = vi.fn(async () => undefined);
    const waitForCallback = vi.fn(async (_port: number, state: string) => ({
      code: 'CODE-1',
      state,
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          access_token: 'AT',
          refresh_token: 'RT',
          token_type: 'Bearer',
          expires_in: 300,
        }),
      }),
    );

    const tokens = await performLogin(cfg, { openExternal, waitForCallback });

    expect(tokens.accessToken).toBe('AT');
    expect(tokens.refreshToken).toBe('RT');

    // browser'da açılan URL'de PKCE S256 + state + nonce var
    const url = new URL(openExternal.mock.calls[0][0] as string);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('nonce')).toBeTruthy();
    // loopback redirect 8123
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:8123/callback');

    // callback dinleyici, openExternal'dan ÖNCE state ile kuruldu
    expect(waitForCallback).toHaveBeenCalledWith(8123, url.searchParams.get('state'));
  });

  it('callback reject → performLogin reject', async () => {
    const openExternal = vi.fn(async () => undefined);
    const waitForCallback = vi.fn(async () => {
      throw new Error('state mismatch');
    });
    await expect(performLogin(cfg, { openExternal, waitForCallback })).rejects.toThrow(
      'state mismatch',
    );
  });
});
