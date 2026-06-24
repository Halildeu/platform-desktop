import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  loadGatewayConfig: vi.fn(() => ({ baseUrl: 'https://gw.example.com' })),
  recordConsent: vi.fn(),
  getValidAccessToken: vi.fn(async () => 'JWT'),
  senderStart: vi.fn(async () => 'SES-1'),
  senderSend: vi.fn(async () => 0),
  senderFinish: vi.fn(async () => undefined),
  senderGetState: vi.fn(() => 'idle'),
  beginCapturePermissionLease: vi.fn(() => 1781820000123),
  clearCapturePermissionLease: vi.fn(),
  setRecordingActive: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      mocks.handlers.set(channel, handler);
    }),
  },
}));

vi.mock('../services/gateway/gateway-client', () => ({
  loadGatewayConfig: mocks.loadGatewayConfig,
  recordConsent: mocks.recordConsent,
}));

vi.mock('../services/gateway/chunk-sender', () => ({
  ChunkSender: class MockChunkSender {
    getState = mocks.senderGetState;
    start = mocks.senderStart;
    send = mocks.senderSend;
    finish = mocks.senderFinish;
  },
}));

vi.mock('../services/display-media-lease', () => ({
  beginCapturePermissionLease: mocks.beginCapturePermissionLease,
  clearCapturePermissionLease: mocks.clearCapturePermissionLease,
  setRecordingActive: mocks.setRecordingActive,
}));

vi.mock('../services/recorder-runtime-config', () => ({
  loadRecorderRuntimeConfig: vi.fn(() => ({
    meetingId: '22222222-2222-4222-8222-222222222222',
    deviceId: 'dev1',
    ready: true,
    reason: null,
  })),
}));

vi.mock('./auth', () => ({
  getValidAccessToken: mocks.getValidAccessToken,
}));

const meetingId = '22222222-2222-4222-8222-222222222222';
const deviceId = 'dev1';
const consentTextHash = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

async function registerFreshAudioIpc(): Promise<void> {
  vi.resetModules();
  mocks.handlers.clear();
  mocks.loadGatewayConfig.mockClear();
  mocks.recordConsent.mockReset();
  mocks.recordConsent.mockImplementation(async (_cfg, _jwt, args) => ({
    ...(args as object),
    correlationId: 'corr-1',
    acceptedAtMs: 1781820000999,
  }));
  mocks.getValidAccessToken.mockClear();
  mocks.senderStart.mockClear();
  mocks.senderStart.mockResolvedValue('SES-1');
  mocks.senderSend.mockClear();
  mocks.senderFinish.mockClear();
  mocks.senderGetState.mockClear();
  mocks.senderGetState.mockReturnValue('idle');
  mocks.beginCapturePermissionLease.mockClear();
  mocks.clearCapturePermissionLease.mockClear();
  mocks.setRecordingActive.mockClear();

  const audio = await import('./audio');
  audio.registerAudioIpc();
}

async function acceptConsent(): Promise<void> {
  const consent = mocks.handlers.get('audio:consent');
  if (!consent) throw new Error('audio:consent handler not registered');
  await consent({}, '1.0.0', consentTextHash, 'tr-TR');
}

function startHandler(): (...args: unknown[]) => Promise<unknown> {
  const start = mocks.handlers.get('audio:start');
  if (!start) throw new Error('audio:start handler not registered');
  return start;
}

beforeEach(async () => {
  await registerFreshAudioIpc();
});

describe('audio IPC recorder consent gate', () => {
  it('rejects invalid consent metadata before gateway calls', async () => {
    const consent = mocks.handlers.get('audio:consent');
    if (!consent) throw new Error('audio:consent handler not registered');

    await expect(consent({}, 'bad version with spaces', consentTextHash, 'tr-TR')).rejects.toThrow(
      'consentVersion',
    );
    await expect(consent({}, '1.0.0', consentTextHash, 'turkish')).rejects.toThrow('locale');

    expect(mocks.recordConsent).not.toHaveBeenCalled();
    expect(mocks.senderStart).not.toHaveBeenCalled();
  });

  it('persists consent audit before starting the gateway session', async () => {
    await acceptConsent();

    const result = (await startHandler()({}, meetingId, deviceId)) as {
      sessionId: string;
      captureId: string;
    };

    expect(result.sessionId).toBe('SES-1');
    expect(result.captureId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(mocks.recordConsent).toHaveBeenCalledTimes(1);
    expect(mocks.senderStart).toHaveBeenCalledTimes(1);

    const consentArgs = mocks.recordConsent.mock.calls[0][2] as {
      meetingId: string;
      captureId: string;
      consentVersion: string;
      consentTextHash: string;
      locale: string;
    };
    expect(consentArgs).toEqual({
      meetingId,
      captureId: result.captureId,
      consentVersion: '1.0.0',
      consentTextHash,
      locale: 'tr-TR',
    });
    expect(mocks.senderStart).toHaveBeenCalledWith(meetingId, deviceId);
    expect(mocks.recordConsent.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.senderStart.mock.invocationCallOrder[0],
    );
    expect(mocks.setRecordingActive).toHaveBeenCalledWith(true);
  });

  it('does not start session when consent audit persistence fails', async () => {
    mocks.recordConsent.mockRejectedValueOnce(
      new Error('recordConsent failed: 503 code=AUDIO_GATEWAY_AUDIT_UNAVAILABLE retryable=true'),
    );
    await acceptConsent();

    await expect(startHandler()({}, meetingId, deviceId)).rejects.toThrow(
      'AUDIO_GATEWAY_AUDIT_UNAVAILABLE',
    );

    expect(mocks.senderStart).not.toHaveBeenCalled();
    expect(mocks.setRecordingActive).not.toHaveBeenCalledWith(true);
    expect(mocks.clearCapturePermissionLease).toHaveBeenCalledTimes(1);
  });
});
