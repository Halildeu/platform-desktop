import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  app: { isPackaged: false },
  autoUpdater: {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    checkForUpdatesAndNotify: vi.fn().mockResolvedValue(null),
    on: vi.fn(),
  },
}));

vi.mock('electron', () => ({ app: mocks.app }));
vi.mock('electron-updater', () => ({
  default: { autoUpdater: mocks.autoUpdater },
}));

describe('initAutoUpdate', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.app.isPackaged = false;
    mocks.autoUpdater.autoDownload = false;
    mocks.autoUpdater.autoInstallOnAppQuit = false;
    mocks.autoUpdater.checkForUpdatesAndNotify.mockClear();
    mocks.autoUpdater.on.mockClear();
  });

  it('keeps the updater disabled in development', async () => {
    const { initAutoUpdate } = await import('./auto-update.js');

    initAutoUpdate();

    expect(mocks.autoUpdater.checkForUpdatesAndNotify).not.toHaveBeenCalled();
    expect(mocks.autoUpdater.on).not.toHaveBeenCalled();
  });

  it('initializes the default-export updater once in packaged builds', async () => {
    mocks.app.isPackaged = true;
    const { initAutoUpdate } = await import('./auto-update.js');

    initAutoUpdate();
    initAutoUpdate();

    expect(mocks.autoUpdater.autoDownload).toBe(true);
    expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(true);
    expect(mocks.autoUpdater.on).toHaveBeenCalledOnce();
    expect(mocks.autoUpdater.on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(mocks.autoUpdater.checkForUpdatesAndNotify).toHaveBeenCalledOnce();
  });
});
