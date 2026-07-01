import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  listeners: new Map<string, (...args: unknown[]) => unknown>(),
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
  transcriptSubscriptionCtor: vi.fn(),
  transcriptSubscriptionStart: vi.fn(),
  transcriptSubscriptionStop: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
      mocks.handlers.set(channel, handler);
    }),
    on: vi.fn((channel: string, listener: (...args: unknown[]) => unknown) => {
      mocks.listeners.set(channel, listener);
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

vi.mock('../services/gateway/transcript-event-subscription', () => ({
  TranscriptEventSubscription: class MockTranscriptEventSubscription {
    constructor(args: unknown) {
      mocks.transcriptSubscriptionCtor(args);
    }

    start = mocks.transcriptSubscriptionStart;
    stop = mocks.transcriptSubscriptionStop;
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
    liveSttStreamUrl: null,
    liveSttStreamReason: null,
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
  mocks.listeners.clear();
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
  mocks.transcriptSubscriptionCtor.mockClear();
  mocks.transcriptSubscriptionStart.mockClear();
  mocks.transcriptSubscriptionStop.mockClear();

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

function chunkHandler(): (...args: unknown[]) => Promise<unknown> {
  const chunk = mocks.handlers.get('audio:chunk');
  if (!chunk) throw new Error('audio:chunk handler not registered');
  return chunk;
}

function finishHandler(): (...args: unknown[]) => Promise<unknown> {
  const finish = mocks.handlers.get('audio:finish');
  if (!finish) throw new Error('audio:finish handler not registered');
  return finish;
}

function abortHandler(): (...args: unknown[]) => Promise<unknown> {
  const abort = mocks.handlers.get('audio:abort');
  if (!abort) throw new Error('audio:abort handler not registered');
  return abort;
}

function rendererUnloadedListener(): (...args: unknown[]) => unknown {
  const listener = mocks.listeners.get('audio:renderer-unloaded');
  if (!listener) throw new Error('audio:renderer-unloaded listener not registered');
  return listener;
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
    expect(mocks.transcriptSubscriptionStart).toHaveBeenCalledTimes(1);
    expect(mocks.transcriptSubscriptionCtor).toHaveBeenCalledWith(
      expect.objectContaining({ streamPreferred: false }),
    );

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

  it('accepts two-second PCM16 mono chunks from the renderer', async () => {
    await acceptConsent();
    const started = (await startHandler()({}, meetingId, deviceId)) as { captureId: string };
    const bytes = new Uint8Array(64_000);

    await expect(
      chunkHandler()({}, { captureId: started.captureId, bytes, startedAtMs: 1781820000000 }),
    ).resolves.toEqual({ seq: 0 });

    expect(mocks.senderSend).toHaveBeenCalledWith(bytes, 1781820000000);
  });

  it('rejects chunks larger than the bounded two-second PCM16 contract', async () => {
    await acceptConsent();
    const started = (await startHandler()({}, meetingId, deviceId)) as { captureId: string };

    await expect(
      chunkHandler()(
        {},
        {
          captureId: started.captureId,
          bytes: new Uint8Array(64_001),
          startedAtMs: 1781820000000,
        },
      ),
    ).rejects.toThrow('audio chunk byte length out of bounds: 64001');

    expect(mocks.senderSend).not.toHaveBeenCalled();
  });

  it('stops transcript polling when the recording is finished', async () => {
    await acceptConsent();
    const started = (await startHandler()({}, meetingId, deviceId)) as { captureId: string };

    await expect(finishHandler()({}, started.captureId)).resolves.toEqual({ ok: true });

    expect(mocks.senderFinish).toHaveBeenCalledTimes(1);
    expect(mocks.transcriptSubscriptionStop).toHaveBeenCalledTimes(1);
    expect(mocks.setRecordingActive).toHaveBeenLastCalledWith(false);
  });

  it('maps transcript endpoint 404 to an operator-readable renderer error', async () => {
    const send = vi.fn();
    await acceptConsent();
    await startHandler()({ sender: { id: 7, send } }, meetingId, deviceId);

    const args = mocks.transcriptSubscriptionCtor.mock.calls[0][0] as {
      onError: (error: Error) => void;
    };
    args.onError(new Error('readTranscriptEvents failed: 404'));

    expect(send).toHaveBeenCalledWith('audio:transcript-error', {
      sessionId: 'SES-1',
      message:
        'Transkript teslim endpointi bu audio-gateway imageinda yok; gateway rollout bekleniyor.',
    });
  });

  it('cleans the active recorder state when its renderer unloads', async () => {
    await acceptConsent();
    await startHandler()({ sender: { id: 7, send: vi.fn() } }, meetingId, deviceId);
    mocks.senderGetState.mockReturnValue('active');

    rendererUnloadedListener()({ sender: { id: 7 } });
    await Promise.resolve();
    await Promise.resolve();

    expect(mocks.senderFinish).toHaveBeenCalledTimes(1);
    expect(mocks.transcriptSubscriptionStop).toHaveBeenCalledTimes(1);
    expect(mocks.setRecordingActive).toHaveBeenLastCalledWith(false);
  });

  it('stops transcript polling when the recording is aborted', async () => {
    await acceptConsent();
    const started = (await startHandler()({}, meetingId, deviceId)) as { captureId: string };

    await expect(abortHandler()({}, started.captureId)).resolves.toEqual({ ok: true });

    expect(mocks.transcriptSubscriptionStop).toHaveBeenCalledTimes(1);
    expect(mocks.clearCapturePermissionLease).toHaveBeenCalledTimes(1);
  });
});
