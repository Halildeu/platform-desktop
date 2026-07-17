import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  app: { isPackaged: false },
  autoUpdater: {
    logger: console as unknown,
    autoDownload: false,
    autoInstallOnAppQuit: false,
    checkForUpdates: vi.fn().mockResolvedValue(null),
    on: vi.fn(),
  },
  notification: {
    isSupported: vi.fn().mockReturnValue(true),
    show: vi.fn(),
  },
}));

vi.mock('electron', () => ({
  app: mocks.app,
  Notification: class Notification {
    static isSupported = mocks.notification.isSupported;

    show = mocks.notification.show;
  },
}));
vi.mock('electron-updater', () => ({
  default: { autoUpdater: mocks.autoUpdater },
}));

describe('initAutoUpdate', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.app.isPackaged = false;
    mocks.autoUpdater.logger = console;
    mocks.autoUpdater.autoDownload = false;
    mocks.autoUpdater.autoInstallOnAppQuit = false;
    mocks.autoUpdater.checkForUpdates.mockReset().mockResolvedValue(null);
    mocks.autoUpdater.on.mockClear();
    mocks.notification.isSupported.mockReset().mockReturnValue(true);
    mocks.notification.show.mockClear();
  });

  it('keeps the updater disabled in development', async () => {
    const { initAutoUpdate } = await import('./auto-update.js');

    initAutoUpdate();

    expect(mocks.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(mocks.autoUpdater.on).not.toHaveBeenCalled();
  });

  it('initializes the default-export updater once in packaged builds', async () => {
    mocks.app.isPackaged = true;
    const { initAutoUpdate } = await import('./auto-update.js');

    initAutoUpdate();
    initAutoUpdate();

    expect(mocks.autoUpdater.logger).toBeNull();
    expect(mocks.autoUpdater.autoDownload).toBe(true);
    expect(mocks.autoUpdater.autoInstallOnAppQuit).toBe(true);
    expect(mocks.autoUpdater.on).toHaveBeenCalledOnce();
    expect(mocks.autoUpdater.on).toHaveBeenCalledWith('error', expect.any(Function));
    expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledOnce();
  });

  it('suppresses the upstream logger and redacts update-check failures', async () => {
    const sensitiveMessage = 'request failed with set-cookie and signed URL';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.app.isPackaged = true;
    mocks.autoUpdater.checkForUpdates.mockRejectedValueOnce(new Error(sensitiveMessage));
    const { initAutoUpdate } = await import('./auto-update.js');

    initAutoUpdate();
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith('Auto-update check failed');
    });

    const errorHandler = mocks.autoUpdater.on.mock.calls[0]?.[1] as
      | ((error: Error) => void)
      | undefined;
    expect(errorHandler).toBeTypeOf('function');
    errorHandler?.(new Error(sensitiveMessage));
    expect(warn.mock.calls).toEqual([['Auto-update check failed'], ['Auto-update error']]);
    expect(mocks.autoUpdater.logger).toBeNull();
    expect(warn.mock.calls.flat().map(String).join(' ')).not.toContain(sensitiveMessage);
    expect(warn.mock.calls.flat().some((value) => value instanceof Error)).toBe(false);
    expect(error).not.toHaveBeenCalled();
    warn.mockRestore();
    error.mockRestore();
  });

  it('owns download rejection without leaking response details', async () => {
    const sensitiveMessage = 'download failed with authorization response';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let rejectDownload: (reason: Error) => void = () => undefined;
    const downloadPromise = new Promise<string[]>((_, reject) => {
      rejectDownload = reject;
    });
    mocks.app.isPackaged = true;
    mocks.autoUpdater.checkForUpdates.mockResolvedValueOnce({
      downloadPromise,
    });
    const { initAutoUpdate } = await import('./auto-update.js');

    initAutoUpdate();
    await vi.waitFor(() => {
      expect(mocks.autoUpdater.checkForUpdates).toHaveBeenCalledOnce();
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    rejectDownload(new Error(sensitiveMessage));
    await vi.waitFor(() => {
      expect(warn).toHaveBeenCalledWith('Auto-update download failed');
    });

    expect(warn.mock.calls).toEqual([['Auto-update download failed']]);
    expect(warn.mock.calls.flat().map(String).join(' ')).not.toContain(sensitiveMessage);
    expect(warn.mock.calls.flat().some((value) => value instanceof Error)).toBe(false);
    warn.mockRestore();
  });

  it('notifies after a downloaded update is ready', async () => {
    mocks.app.isPackaged = true;
    mocks.autoUpdater.checkForUpdates.mockResolvedValueOnce({
      downloadPromise: Promise.resolve([]),
    });
    const { initAutoUpdate } = await import('./auto-update.js');

    initAutoUpdate();
    await vi.waitFor(() => {
      expect(mocks.notification.show).toHaveBeenCalledOnce();
    });
  });
});
