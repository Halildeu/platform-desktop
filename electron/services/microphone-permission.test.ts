import { describe, expect, it, vi } from 'vitest';

import {
  MicrophonePermissionBroker,
  type MicrophonePermissionStatus,
} from './microphone-permission';

describe('MicrophonePermissionBroker', () => {
  it('coalesces concurrent macOS permission requests into one native prompt', async () => {
    let status: MicrophonePermissionStatus = 'not-determined';
    let resolveRequest: ((granted: boolean) => void) | null = null;
    const requestPermission = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveRequest = resolve;
        }),
    );
    const broker = new MicrophonePermissionBroker('darwin', () => status, requestPermission);

    const first = broker.request();
    const second = broker.request();

    expect(requestPermission).toHaveBeenCalledTimes(1);
    status = 'granted';
    resolveRequest?.(true);

    await expect(first).resolves.toEqual({
      status: 'granted',
      granted: true,
      canRequest: false,
    });
    await expect(second).resolves.toEqual({
      status: 'granted',
      granted: true,
      canRequest: false,
    });
  });

  it('does not open a native prompt after permission is decided', async () => {
    const requestPermission = vi.fn();
    const broker = new MicrophonePermissionBroker('darwin', () => 'denied', requestPermission);

    await expect(broker.request()).resolves.toEqual({
      status: 'denied',
      granted: false,
      canRequest: false,
    });
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('caches a native grant when macOS TCC status remains not-determined', async () => {
    const requestPermission = vi.fn().mockResolvedValue(true);
    const broker = new MicrophonePermissionBroker(
      'darwin',
      () => 'not-determined',
      requestPermission,
    );

    await expect(broker.request()).resolves.toEqual({
      status: 'granted',
      granted: true,
      canRequest: false,
    });
    await expect(broker.request()).resolves.toEqual({
      status: 'granted',
      granted: true,
      canRequest: false,
    });
    expect(broker.status()).toEqual({
      status: 'granted',
      granted: true,
      canRequest: false,
    });
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it('fails closed after a native denial when macOS TCC status remains not-determined', async () => {
    const requestPermission = vi.fn().mockResolvedValue(false);
    const broker = new MicrophonePermissionBroker(
      'darwin',
      () => 'not-determined',
      requestPermission,
    );

    await expect(broker.request()).resolves.toEqual({
      status: 'denied',
      granted: false,
      canRequest: false,
    });
    await expect(broker.request()).resolves.toEqual({
      status: 'denied',
      granted: false,
      canRequest: false,
    });
    expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it('prefers a later terminal TCC status over the process-local decision', async () => {
    let status: MicrophonePermissionStatus = 'not-determined';
    const requestPermission = vi.fn().mockResolvedValue(true);
    const broker = new MicrophonePermissionBroker('darwin', () => status, requestPermission);

    await expect(broker.request()).resolves.toMatchObject({ status: 'granted' });
    status = 'denied';

    expect(broker.status()).toEqual({
      status: 'denied',
      granted: false,
      canRequest: false,
    });
  });

  it('uses Chromium permission flow outside macOS', async () => {
    const readPermissionStatus = vi.fn();
    const requestPermission = vi.fn();
    const broker = new MicrophonePermissionBroker('win32', readPermissionStatus, requestPermission);

    await expect(broker.request()).resolves.toEqual({
      status: 'unknown',
      granted: false,
      canRequest: true,
    });
    expect(readPermissionStatus).not.toHaveBeenCalled();
    expect(requestPermission).not.toHaveBeenCalled();
  });
});
