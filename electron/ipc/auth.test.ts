import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  class MockTokenRefreshError extends Error {
    constructor(readonly terminal: boolean) {
      super('refresh rejected');
    }
  }

  const tokenStore = {
    clear: vi.fn(),
    getAccess: vi.fn(),
    getRefreshToken: vi.fn(),
    hasValidAccess: vi.fn(),
    setSession: vi.fn(),
  };

  return {
    handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
    tokenStore,
    refreshAccessToken: vi.fn(),
    MockTokenRefreshError,
  };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      mocks.handlers.set(channel, handler);
    }),
  },
  shell: { openExternal: vi.fn() },
}));

vi.mock('../services/auth/keycloak-config', () => ({
  assertKeycloakConfigReady: vi.fn(),
  loadKeycloakConfig: vi.fn(() => ({
    baseUrl: 'https://auth.example.com',
    realm: 'platform-test',
    clientId: 'platform-desktop',
  })),
}));

vi.mock('../services/auth/login-service', () => ({ performLogin: vi.fn() }));
vi.mock('../services/auth/jwt-claims', () => ({ safeJwtClaims: vi.fn(() => null) }));
vi.mock('../services/auth/oauth-flow', () => ({
  isReauthenticationRequired: vi.fn(
    (error: unknown) => error instanceof mocks.MockTokenRefreshError && Boolean(error.terminal),
  ),
  refreshAccessToken: mocks.refreshAccessToken,
  revokeRefreshToken: vi.fn(),
}));
vi.mock('../services/auth/token-store', () => ({
  TokenStore: vi.fn(function MockTokenStore() {
    return mocks.tokenStore;
  }),
}));

async function loadFreshAuth(): Promise<typeof import('./auth')> {
  vi.resetModules();
  return import('./auth');
}

describe('auth token refresh coordination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handlers.clear();
    mocks.tokenStore.getAccess.mockReturnValue(null);
    mocks.tokenStore.hasValidAccess.mockReturnValue(false);
    mocks.tokenStore.getRefreshToken.mockReturnValue('ROTATING-REFRESH');
  });

  it('shares one refresh request across concurrent callers', async () => {
    let resolveRefresh:
      | ((value: {
          accessToken: string;
          refreshToken: string;
          tokenType: string;
          expiresAt: number;
        }) => void)
      | null = null;
    mocks.refreshAccessToken.mockReturnValue(
      new Promise((resolve) => {
        resolveRefresh = resolve;
      }),
    );
    const auth = await loadFreshAuth();

    const first = auth.getValidAccessToken();
    const second = auth.getValidAccessToken();
    resolveRefresh?.({
      accessToken: 'ACCESS-2',
      refreshToken: 'REFRESH-2',
      tokenType: 'Bearer',
      expiresAt: Date.now() + 60_000,
    });

    await expect(Promise.all([first, second])).resolves.toEqual(['ACCESS-2', 'ACCESS-2']);
    expect(mocks.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(mocks.tokenStore.setSession).toHaveBeenCalledTimes(1);
  });

  it('clears a terminally rejected refresh token and requests re-login', async () => {
    mocks.refreshAccessToken.mockRejectedValue(new mocks.MockTokenRefreshError(true));
    const auth = await loadFreshAuth();

    await expect(auth.getValidAccessToken()).rejects.toThrow(
      'authentication expired; sign in again',
    );
    expect(mocks.tokenStore.clear).toHaveBeenCalledTimes(1);
  });

  it('keeps the refresh token on transient provider failures', async () => {
    mocks.refreshAccessToken.mockRejectedValue(new mocks.MockTokenRefreshError(false));
    const auth = await loadFreshAuth();

    await expect(auth.getValidAccessToken()).rejects.toThrow('refresh rejected');
    expect(mocks.tokenStore.clear).not.toHaveBeenCalled();
  });

  it('restores an OS-backed session after an application restart', async () => {
    mocks.refreshAccessToken.mockResolvedValue({
      accessToken: 'RESTORED-ACCESS',
      refreshToken: 'RESTORED-REFRESH',
      tokenType: 'Bearer',
      expiresAt: Date.now() + 60_000,
    });
    const auth = await loadFreshAuth();
    auth.registerAuthIpc();

    const status = mocks.handlers.get('auth:status');
    await expect(status?.()).resolves.toMatchObject({
      loggedIn: true,
      expiresAt: expect.any(Number),
    });
    expect(mocks.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(mocks.tokenStore.setSession).toHaveBeenCalledTimes(1);
  });
});
