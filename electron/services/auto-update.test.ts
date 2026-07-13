import { beforeEach, describe, expect, it, vi } from 'vitest';

// #44 regression: electron-updater is CommonJS, so under Electron 42 / Node ESM
// its `autoUpdater` is only reachable via the DEFAULT import. This mock exposes
// it solely as `default.autoUpdater` — if the source regresses to a named
// import (`import { autoUpdater }`), `autoUpdater` becomes undefined and the
// active-path test below throws, catching the regression.
const mocks = vi.hoisted(() => ({
  isPackaged: false,
  autoUpdater: {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    on: vi.fn(),
    checkForUpdatesAndNotify: vi.fn(async () => null),
  },
}));

vi.mock('electron', () => ({
  app: {
    get isPackaged(): boolean {
      return mocks.isPackaged;
    },
  },
}));

vi.mock('electron-updater', () => ({
  default: { autoUpdater: mocks.autoUpdater },
}));

beforeEach(() => {
  vi.resetModules();
  mocks.autoUpdater.on.mockClear();
  mocks.autoUpdater.checkForUpdatesAndNotify.mockClear();
  mocks.autoUpdater.autoDownload = false;
  mocks.autoUpdater.autoInstallOnAppQuit = false;
});

describe('initAutoUpdate (#44)', () => {
  it('resolves autoUpdater from the CJS default import without throwing', async () => {
    mocks.isPackaged = true;
    const { initAutoUpdate } = await import('./auto-update.js');

    expect(() => initAutoUpdate()).not.toThrow();
    expect(mocks.autoUpdater.autoDownload).toBe(true);
    expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(true);
    expect(mocks.autoUpdater.on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(mocks.autoUpdater.checkForUpdatesAndNotify).toHaveBeenCalledTimes(1);
  });

  it('is a no-op in development (isPackaged=false) and never hits the update network', async () => {
    mocks.isPackaged = false;
    const { initAutoUpdate } = await import('./auto-update.js');

    initAutoUpdate();

    expect(mocks.autoUpdater.checkForUpdatesAndNotify).not.toHaveBeenCalled();
    expect(mocks.autoUpdater.on).not.toHaveBeenCalled();
  });

  it('initializes only once per process', async () => {
    mocks.isPackaged = true;
    const { initAutoUpdate } = await import('./auto-update.js');

    initAutoUpdate();
    initAutoUpdate();

    expect(mocks.autoUpdater.checkForUpdatesAndNotify).toHaveBeenCalledTimes(1);
  });
});
