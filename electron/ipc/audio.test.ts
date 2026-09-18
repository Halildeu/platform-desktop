import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  class MockGatewaySessionStartRejectedError extends Error {
    status: number;

    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }

  class MockGatewaySessionFinishRejectedError extends Error {
    status: number;
    code: string | null;
    retryable: boolean | null;

    constructor(message: string, status: number, code: string | null, retryable: boolean | null) {
      super(message);
      this.status = status;
      this.code = code;
      this.retryable = retryable;
    }
  }

  class MockAmbiguousGatewaySessionStartError extends Error {}

  return {
    handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
    listeners: new Map<string, (...args: unknown[]) => unknown>(),
    loadGatewayConfig: vi.fn(() => ({ baseUrl: 'https://gw.example.com' })),
    loadMeetingConfig: vi.fn(() => ({ baseUrl: 'https://meeting.example.com' })),
    syncRecordingLifecycle: vi.fn(),
    recordConsent: vi.fn(),
    startSession: vi.fn(),
    finishSession: vi.fn(async () => undefined),
    newIdempotencyKey: vi.fn(() => 'IK-1'),
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
    gatewayLiveStreamCtor: vi.fn(),
    gatewayLiveStreamStart: vi.fn(async () => undefined),
    gatewayLiveStreamSend: vi.fn(() => true),
    gatewayLiveStreamSendRealtime: vi.fn(() => true),
    gatewayLiveStreamSourceStartedAtMs: vi.fn(() => 1781820000000),
    gatewayLiveStreamSourceTimingReliable: vi.fn(() => true),
    gatewayLiveStreamTransportEpoch: vi.fn(() => 3),
    gatewayLiveStreamStop: vi.fn(async () => ({
      state: 'drained',
      reason: 'eof-ack',
      acknowledged: true,
    })),
    gatewayLiveStreamClose: vi.fn(),
    loadRecorderRuntimeConfig: vi.fn(),
    pendingLifecycles: [] as Array<{
      meetingId: string;
      externalSessionId: string;
      startedAt: string;
      endedAt: string | null;
      gatewayFinishPending: boolean;
      gatewayFinishIdempotencyKey?: string | null;
    }>,
    outboxList: vi.fn(),
    outboxUpsert: vi.fn(),
    outboxMarkEnded: vi.fn(),
    outboxMarkGatewayFinished: vi.fn(),
    outboxMarkGatewaySessionNotFound: vi.fn(),
    outboxListUnreconcilable: vi.fn(),
    outboxRemove: vi.fn(),
    pendingUnreconcilable: [] as Array<{
      meetingId: string;
      externalSessionId: string;
    }>,
    pendingStarts: [] as Array<{
      meetingId: string;
      captureId: string;
      deviceId: string;
      language: string;
      startedAt: string;
      idempotencyKey: string;
      gatewayFinishIdempotencyKey: string;
    }>,
    startOutboxList: vi.fn(),
    startOutboxUpsert: vi.fn(),
    startOutboxRemove: vi.fn(),
    MockGatewaySessionStartRejectedError,
    MockGatewaySessionFinishRejectedError,
    MockAmbiguousGatewaySessionStartError,
  };
});

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
  GatewaySessionFinishRejectedError: mocks.MockGatewaySessionFinishRejectedError,
  GatewaySessionStartRejectedError: mocks.MockGatewaySessionStartRejectedError,
  finishSession: mocks.finishSession,
  loadGatewayConfig: mocks.loadGatewayConfig,
  newIdempotencyKey: mocks.newIdempotencyKey,
  recordConsent: mocks.recordConsent,
  startSession: mocks.startSession,
}));

vi.mock('../services/gateway/chunk-sender', () => ({
  AmbiguousGatewaySessionStartError: mocks.MockAmbiguousGatewaySessionStartError,
  ChunkSender: class MockChunkSender {
    getState = mocks.senderGetState;
    start = mocks.senderStart;
    send = mocks.senderSend;
    finish = mocks.senderFinish;
  },
}));

vi.mock('../services/meeting/meeting-client', () => ({
  loadMeetingConfig: mocks.loadMeetingConfig,
  syncRecordingLifecycle: mocks.syncRecordingLifecycle,
}));

vi.mock('../services/meeting/recording-lifecycle-outbox', () => ({
  RecordingLifecycleOutbox: class MockRecordingLifecycleOutbox {
    list = mocks.outboxList;
    listUnreconcilable = mocks.outboxListUnreconcilable;
    upsert = mocks.outboxUpsert;
    markEnded = mocks.outboxMarkEnded;
    markGatewayFinished = mocks.outboxMarkGatewayFinished;
    markGatewaySessionNotFound = mocks.outboxMarkGatewaySessionNotFound;
    remove = mocks.outboxRemove;
  },
}));

vi.mock('../services/meeting/recording-start-outbox', () => ({
  RecordingStartOutbox: class MockRecordingStartOutbox {
    list = mocks.startOutboxList;
    upsert = mocks.startOutboxUpsert;
    remove = mocks.startOutboxRemove;
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

vi.mock('../services/gateway/gateway-live-stream', () => ({
  GATEWAY_LIVE_SAMPLE_RATE_HZ: 16_000,
  REALTIME_MAX_PENDING_FRAME_COUNT: 600,
  REALTIME_CIRCUIT_COOLDOWN_LADDER_MS: [5_000, 15_000, 30_000, 60_000, 120_000, 300_000],
  REALTIME_REPLAY_FRAMES_PER_TICK: 4,
  normalizeGatewayLiveContextTerms: (value: unknown) =>
    Array.isArray(value) ? value.map(String) : [],
  GatewayLiveStream: class MockGatewayLiveStream {
    constructor(args: unknown) {
      mocks.gatewayLiveStreamCtor(args);
    }

    start = mocks.gatewayLiveStreamStart;
    sendAfterRestAccepted = mocks.gatewayLiveStreamSend;
    sendRealtimeFrame = mocks.gatewayLiveStreamSendRealtime;
    getSourceStartedAtMs = mocks.gatewayLiveStreamSourceStartedAtMs;
    hasReliableSourceTiming = mocks.gatewayLiveStreamSourceTimingReliable;
    getTransportEpoch = mocks.gatewayLiveStreamTransportEpoch;
    stop = mocks.gatewayLiveStreamStop;
    close = mocks.gatewayLiveStreamClose;
  },
}));

vi.mock('../services/display-media-lease', () => ({
  beginCapturePermissionLease: mocks.beginCapturePermissionLease,
  clearCapturePermissionLease: mocks.clearCapturePermissionLease,
  setRecordingActive: mocks.setRecordingActive,
}));

vi.mock('../services/recorder-runtime-config', () => ({
  loadRecorderRuntimeConfig: mocks.loadRecorderRuntimeConfig,
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
  mocks.loadMeetingConfig.mockClear();
  mocks.syncRecordingLifecycle.mockReset();
  mocks.syncRecordingLifecycle.mockImplementation(async (_cfg, _jwt, args) => ({
    meetingId: (args as { meetingId: string }).meetingId,
    sessionId: '33333333-3333-4333-8333-333333333333',
    externalSessionId: (args as { externalSessionId: string }).externalSessionId,
    meetingStatus: (args as { endedAt?: string | null }).endedAt ? 'COMPLETED' : 'IN_PROGRESS',
    transcriptStatus: (args as { endedAt?: string | null }).endedAt ? 'PROCESSING' : 'PENDING',
    startedAt: (args as { startedAt: string }).startedAt,
    endedAt: (args as { endedAt?: string | null }).endedAt ?? null,
  }));
  mocks.recordConsent.mockReset();
  mocks.recordConsent.mockImplementation(async (_cfg, _jwt, args) => ({
    ...(args as object),
    correlationId: 'corr-1',
    acceptedAtMs: 1781820000999,
  }));
  mocks.startSession.mockReset();
  mocks.startSession.mockResolvedValue({ sessionId: 'SES-recovered' });
  mocks.finishSession.mockReset();
  mocks.finishSession.mockResolvedValue(undefined);
  mocks.newIdempotencyKey.mockReset();
  mocks.newIdempotencyKey.mockReturnValue('IK-1');
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
  mocks.gatewayLiveStreamCtor.mockClear();
  mocks.gatewayLiveStreamStart.mockReset();
  mocks.gatewayLiveStreamStart.mockResolvedValue(undefined);
  mocks.gatewayLiveStreamSend.mockClear();
  mocks.gatewayLiveStreamStop.mockReset();
  mocks.gatewayLiveStreamStop.mockResolvedValue({
    state: 'drained',
    reason: 'eof-ack',
    acknowledged: true,
  });
  mocks.gatewayLiveStreamClose.mockClear();
  mocks.loadRecorderRuntimeConfig.mockReset();
  mocks.loadRecorderRuntimeConfig.mockReturnValue({
    meetingId: '22222222-2222-4222-8222-222222222222',
    deviceId: 'dev1',
    ready: true,
    reason: null,
    liveSttStreamUrl: null,
    liveSttStreamReason: null,
    gatewayLiveStreamEnabled: false,
  });
  mocks.pendingLifecycles = [];
  mocks.pendingUnreconcilable = [];
  mocks.outboxList.mockReset();
  mocks.outboxList.mockImplementation(() => [...mocks.pendingLifecycles]);
  mocks.outboxListUnreconcilable.mockReset();
  mocks.outboxListUnreconcilable.mockImplementation(() => [...mocks.pendingUnreconcilable]);
  mocks.outboxUpsert.mockReset();
  mocks.outboxUpsert.mockImplementation((record) => {
    const value = record as (typeof mocks.pendingLifecycles)[number];
    const index = mocks.pendingLifecycles.findIndex(
      (entry) =>
        entry.meetingId === value.meetingId && entry.externalSessionId === value.externalSessionId,
    );
    if (index >= 0) {
      const existing = mocks.pendingLifecycles[index];
      if (existing.startedAt !== value.startedAt) {
        throw new Error('pending recording lifecycle identity has conflicting startedAt');
      }
      if (existing.endedAt && value.endedAt && existing.endedAt !== value.endedAt) {
        throw new Error('pending recording lifecycle identity has conflicting endedAt');
      }
      if (
        existing.gatewayFinishIdempotencyKey &&
        value.gatewayFinishIdempotencyKey &&
        existing.gatewayFinishIdempotencyKey !== value.gatewayFinishIdempotencyKey
      ) {
        throw new Error(
          'pending recording lifecycle identity has conflicting gateway finish idempotency key',
        );
      }
      mocks.pendingLifecycles[index] = {
        ...mocks.pendingLifecycles[index],
        endedAt: mocks.pendingLifecycles[index].endedAt ?? value.endedAt,
        gatewayFinishPending:
          mocks.pendingLifecycles[index].gatewayFinishPending && value.gatewayFinishPending,
        gatewayFinishIdempotencyKey:
          mocks.pendingLifecycles[index].gatewayFinishIdempotencyKey ??
          value.gatewayFinishIdempotencyKey ??
          null,
      };
      return mocks.pendingLifecycles[index];
    }
    mocks.pendingLifecycles.push(value);
    return value;
  });
  mocks.outboxMarkEnded.mockReset();
  mocks.outboxMarkEnded.mockImplementation((identity, endedAt) =>
    mocks.outboxUpsert({ ...(identity as object), endedAt }),
  );
  mocks.outboxMarkGatewayFinished.mockReset();
  mocks.outboxMarkGatewayFinished.mockImplementation((identity) =>
    mocks.outboxUpsert({ ...(identity as object), gatewayFinishPending: false }),
  );
  mocks.outboxMarkGatewaySessionNotFound.mockReset();
  mocks.outboxMarkGatewaySessionNotFound.mockImplementation((identity) => {
    const value = identity as (typeof mocks.pendingLifecycles)[number];
    mocks.pendingUnreconcilable.push({
      meetingId: value.meetingId,
      externalSessionId: value.externalSessionId,
    });
    return mocks.outboxUpsert({ ...value, gatewayFinishPending: false });
  });
  mocks.outboxRemove.mockReset();
  mocks.outboxRemove.mockImplementation((identity) => {
    const value = identity as { meetingId: string; externalSessionId: string };
    mocks.pendingLifecycles = mocks.pendingLifecycles.filter(
      (entry) =>
        entry.meetingId !== value.meetingId || entry.externalSessionId !== value.externalSessionId,
    );
  });
  mocks.pendingStarts = [];
  mocks.startOutboxList.mockReset();
  mocks.startOutboxList.mockImplementation(() => [...mocks.pendingStarts]);
  mocks.startOutboxUpsert.mockReset();
  mocks.startOutboxUpsert.mockImplementation((record) => {
    const value = record as (typeof mocks.pendingStarts)[number];
    mocks.pendingStarts.push(value);
    return value;
  });
  mocks.startOutboxRemove.mockReset();
  mocks.startOutboxRemove.mockImplementation((captureId) => {
    mocks.pendingStarts = mocks.pendingStarts.filter((entry) => entry.captureId !== captureId);
  });

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

function liveFrameHandler(): (...args: unknown[]) => Promise<unknown> {
  const frame = mocks.handlers.get('audio:live-frame');
  if (!frame) throw new Error('audio:live-frame handler not registered');
  return frame;
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
      transcriptSessionId: string;
      captureId: string;
    };

    expect(result.sessionId).toBe('SES-1');
    expect(result.transcriptSessionId).toBe('33333333-3333-4333-8333-333333333333');
    expect(result.captureId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(mocks.recordConsent).toHaveBeenCalledTimes(1);
    expect(mocks.senderStart).toHaveBeenCalledTimes(1);
    expect(mocks.syncRecordingLifecycle).toHaveBeenCalledTimes(1);
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
    expect(mocks.senderStart).toHaveBeenCalledWith(
      meetingId,
      deviceId,
      'tr',
      'IK-1',
      'internal',
      'balanced',
      [],
    );
    expect(mocks.recordConsent.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.senderStart.mock.invocationCallOrder[0],
    );
    expect(mocks.senderStart.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.syncRecordingLifecycle.mock.invocationCallOrder[0],
    );
    expect(mocks.syncRecordingLifecycle).toHaveBeenCalledWith(
      { baseUrl: 'https://meeting.example.com' },
      'JWT',
      expect.objectContaining({
        meetingId,
        externalSessionId: 'SES-1',
        startedAt: expect.any(String),
        endedAt: null,
      }),
    );
    expect(mocks.setRecordingActive).toHaveBeenCalledWith(true);
  });

  it('surfaces canonical start failure without waiting for gateway cleanup', async () => {
    let resolveGatewayFinish: (() => void) | null = null;
    mocks.senderFinish.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveGatewayFinish = resolve;
        }),
    );
    mocks.syncRecordingLifecycle.mockRejectedValueOnce(
      new Error('syncRecordingLifecycle failed: 503 code=MEETING_UNAVAILABLE'),
    );
    await acceptConsent();

    await expect(startHandler()({}, meetingId, deviceId)).rejects.toThrow('MEETING_UNAVAILABLE');

    expect(mocks.senderFinish).toHaveBeenCalledTimes(1);
    expect(mocks.syncRecordingLifecycle).toHaveBeenCalledTimes(1);
    expect(mocks.pendingLifecycles).toEqual([
      expect.objectContaining({
        meetingId,
        externalSessionId: 'SES-1',
        endedAt: expect.any(String),
        gatewayFinishPending: true,
      }),
    ]);
    expect(mocks.transcriptSubscriptionStart).not.toHaveBeenCalled();
    expect(mocks.setRecordingActive).not.toHaveBeenCalledWith(true);

    resolveGatewayFinish?.();
    await vi.waitFor(() => {
      expect(mocks.pendingLifecycles).toEqual([
        expect.objectContaining({ gatewayFinishPending: false }),
      ]);
    });
  });

  it('keeps an ambiguous canonical start as a durable finished retry', async () => {
    mocks.syncRecordingLifecycle
      .mockRejectedValueOnce(new Error('syncRecordingLifecycle failed before response'))
      .mockRejectedValueOnce(new Error('syncRecordingLifecycle finish failed before response'));
    await acceptConsent();

    await expect(startHandler()({}, meetingId, deviceId)).rejects.toThrow('failed before response');

    expect(mocks.senderFinish).toHaveBeenCalledTimes(1);
    expect(mocks.syncRecordingLifecycle).toHaveBeenCalledTimes(1);
    expect(mocks.pendingLifecycles).toEqual([
      expect.objectContaining({
        meetingId,
        externalSessionId: 'SES-1',
        endedAt: expect.any(String),
        gatewayFinishPending: false,
      }),
    ]);
  });

  it('rejects promptly and closes a just-created gateway session when durable stores fail', async () => {
    let resolveGatewayFinish: (() => void) | null = null;
    mocks.outboxUpsert.mockImplementationOnce(() => {
      throw new Error('recording lifecycle could not be persisted');
    });
    mocks.senderFinish.mockRejectedValueOnce(new Error('sender finish response lost'));
    mocks.finishSession.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveGatewayFinish = resolve;
        }),
    );
    await acceptConsent();

    await expect(startHandler()({}, meetingId, deviceId)).rejects.toThrow(
      'recording lifecycle could not be persisted',
    );

    expect(mocks.senderFinish).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(mocks.finishSession).toHaveBeenCalledWith(
        { baseUrl: 'https://gw.example.com' },
        'JWT',
        'SES-1',
        'IK-1',
      );
    });
    resolveGatewayFinish?.();
    expect(mocks.syncRecordingLifecycle).not.toHaveBeenCalled();
  });

  it('does not start session when consent audit persistence fails', async () => {
    mocks.recordConsent.mockRejectedValueOnce(
      new Error('recordConsent failed: 503 code=AUDIO_GATEWAY_AUDIT_UNAVAILABLE retryable=true'),
    );
    await acceptConsent();

    await expect(startHandler()({}, meetingId, deviceId)).rejects.toThrow(
      'AUDIO_GATEWAY_CONSENT_UNCONFIRMED: recordConsent failed: 503 code=AUDIO_GATEWAY_AUDIT_UNAVAILABLE retryable=true',
    );

    expect(mocks.senderStart).not.toHaveBeenCalled();
    expect(mocks.setRecordingActive).not.toHaveBeenCalledWith(true);
    expect(mocks.clearCapturePermissionLease).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the consent access token cannot be refreshed', async () => {
    mocks.getValidAccessToken.mockRejectedValueOnce(new Error('fetch failed'));
    await acceptConsent();

    await expect(startHandler()({}, meetingId, deviceId)).rejects.toThrow(
      'AUDIO_GATEWAY_CONSENT_UNCONFIRMED: fetch failed',
    );

    expect(mocks.recordConsent).not.toHaveBeenCalled();
    expect(mocks.senderStart).not.toHaveBeenCalled();
    expect(mocks.syncRecordingLifecycle).not.toHaveBeenCalled();
    expect(mocks.setRecordingActive).not.toHaveBeenCalledWith(true);
    expect(mocks.clearCapturePermissionLease).toHaveBeenCalledTimes(1);
  });

  it('durably ends the gateway session when the lifecycle token refresh fails', async () => {
    mocks.getValidAccessToken
      .mockResolvedValueOnce('CONSENT-JWT')
      .mockRejectedValueOnce(new Error('lifecycle token refresh failed'));
    await acceptConsent();

    await expect(startHandler()({}, meetingId, deviceId)).rejects.toThrow(
      'lifecycle token refresh failed',
    );

    expect(mocks.recordConsent).toHaveBeenCalledTimes(1);
    expect(mocks.senderStart).toHaveBeenCalledTimes(1);
    expect(mocks.syncRecordingLifecycle).not.toHaveBeenCalled();
    expect(mocks.senderFinish).toHaveBeenCalledTimes(1);
    expect(mocks.pendingLifecycles).toEqual([
      expect.objectContaining({
        meetingId,
        externalSessionId: 'SES-1',
        endedAt: expect.any(String),
        gatewayFinishPending: false,
      }),
    ]);
    expect(mocks.setRecordingActive).not.toHaveBeenCalledWith(true);
    expect(mocks.clearCapturePermissionLease).toHaveBeenCalledTimes(1);
  });

  it('durably ends the gateway session when meeting config loading fails', async () => {
    mocks.loadMeetingConfig.mockImplementationOnce(() => {
      throw new Error('MEETING_BASE_URL is required');
    });
    await acceptConsent();

    await expect(startHandler()({}, meetingId, deviceId)).rejects.toThrow(
      'MEETING_BASE_URL is required',
    );

    expect(mocks.recordConsent).toHaveBeenCalledTimes(1);
    expect(mocks.senderStart).toHaveBeenCalledTimes(1);
    expect(mocks.syncRecordingLifecycle).not.toHaveBeenCalled();
    expect(mocks.senderFinish).toHaveBeenCalledTimes(1);
    expect(mocks.pendingLifecycles).toEqual([
      expect.objectContaining({
        meetingId,
        externalSessionId: 'SES-1',
        endedAt: expect.any(String),
        gatewayFinishPending: false,
      }),
    ]);
    expect(mocks.setRecordingActive).not.toHaveBeenCalledWith(true);
    expect(mocks.clearCapturePermissionLease).toHaveBeenCalledTimes(1);
  });

  it('marks an ambiguous gateway session start as unconfirmed', async () => {
    mocks.senderStart.mockRejectedValueOnce(
      new mocks.MockAmbiguousGatewaySessionStartError('startSession timed out after 15000ms'),
    );
    await acceptConsent();

    await expect(startHandler()({}, meetingId, deviceId)).rejects.toThrow(
      'AUDIO_GATEWAY_SESSION_START_UNCONFIRMED: startSession timed out after 15000ms',
    );

    expect(mocks.syncRecordingLifecycle).not.toHaveBeenCalled();
    expect(mocks.pendingStarts).toEqual([
      expect.objectContaining({ meetingId, deviceId, idempotencyKey: 'IK-1' }),
    ]);
    expect(mocks.setRecordingActive).not.toHaveBeenCalledWith(true);
    expect(mocks.clearCapturePermissionLease).toHaveBeenCalledTimes(1);
  });

  it('does not call the gateway when the durable start intent cannot be persisted', async () => {
    mocks.startOutboxUpsert.mockImplementationOnce(() => {
      throw new Error('pending recording start recovery could not be persisted');
    });
    await acceptConsent();

    await expect(startHandler()({}, meetingId, deviceId)).rejects.toThrow(
      'pending recording start recovery could not be persisted',
    );

    expect(mocks.senderStart).not.toHaveBeenCalled();
    expect(mocks.syncRecordingLifecycle).not.toHaveBeenCalled();
  });

  it('keeps a generic gateway 5xx start in the durable retry queue', async () => {
    mocks.senderStart.mockRejectedValueOnce(
      new mocks.MockGatewaySessionStartRejectedError('startSession failed: 503', 503),
    );
    await acceptConsent();

    await expect(startHandler()({}, meetingId, deviceId)).rejects.toThrow(
      'AUDIO_GATEWAY_SESSION_START_UNCONFIRMED: startSession failed: 503',
    );

    expect(mocks.pendingStarts).toEqual([
      expect.objectContaining({ meetingId, deviceId, idempotencyKey: 'IK-1' }),
    ]);
    expect(mocks.syncRecordingLifecycle).not.toHaveBeenCalled();
  });

  it('blocks fallback after a definite authorization rejection', async () => {
    mocks.senderStart.mockRejectedValueOnce(
      new mocks.MockGatewaySessionStartRejectedError('startSession failed: 403', 403),
    );
    await acceptConsent();

    await expect(startHandler()({}, meetingId, deviceId)).rejects.toThrow(
      'AUDIO_GATEWAY_SESSION_START_DENIED: startSession failed: 403',
    );

    expect(mocks.pendingStarts).toEqual([]);
    expect(mocks.syncRecordingLifecycle).not.toHaveBeenCalled();
  });

  it('waits for stale lifecycle cleanup before starting a replacement session', async () => {
    mocks.senderStart.mockResolvedValueOnce('SES-stale').mockResolvedValueOnce('SES-new');
    let resolveStaleFinish: () => void = () => undefined;
    mocks.senderFinish.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveStaleFinish = resolve;
        }),
    );
    await acceptConsent();
    await startHandler()({}, meetingId, deviceId);
    await acceptConsent();

    const replacement = startHandler()({}, meetingId, deviceId);
    await Promise.resolve();

    expect(mocks.senderStart).toHaveBeenCalledTimes(1);
    expect(mocks.pendingLifecycles).toEqual([
      expect.objectContaining({ externalSessionId: 'SES-stale', endedAt: expect.any(String) }),
    ]);

    resolveStaleFinish();
    await expect(replacement).resolves.toEqual({
      sessionId: 'SES-new',
      transcriptSessionId: '33333333-3333-4333-8333-333333333333',
      captureId: expect.any(String),
      sttProvider: 'internal',
      transcriptionMode: 'balanced',
    });

    expect(mocks.pendingLifecycles).toEqual([
      expect.objectContaining({ externalSessionId: 'SES-new', endedAt: null }),
    ]);
    expect(mocks.setRecordingActive).toHaveBeenLastCalledWith(true);
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

  it('opens the authenticated gateway live transport before capture and shares REST sequence ownership', async () => {
    mocks.loadRecorderRuntimeConfig.mockReturnValue({
      meetingId,
      deviceId,
      ready: true,
      reason: null,
      liveSttStreamUrl: null,
      liveSttStreamReason: null,
      gatewayLiveStreamEnabled: true,
    });
    const rendererSend = vi.fn();
    await acceptConsent();
    const started = (await startHandler()(
      { sender: { id: 7, send: rendererSend } },
      meetingId,
      deviceId,
      ['Zeynep Akkılıç', 'Faz 24'],
    )) as { captureId: string };

    expect(mocks.gatewayLiveStreamCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: { baseUrl: 'https://gw.example.com' },
        sessionId: 'SES-1',
        contextTerms: ['Zeynep Akkılıç', 'Faz 24'],
        getJwt: expect.any(Function),
        onEvent: expect.any(Function),
        onError: expect.any(Function),
      }),
    );
    expect(mocks.gatewayLiveStreamStart).toHaveBeenCalledTimes(1);

    const bytes = new Uint8Array([0, 0]);
    await chunkHandler()({}, { captureId: started.captureId, bytes, startedAtMs: 1781820000000 });
    expect(mocks.gatewayLiveStreamSend).toHaveBeenCalledWith(bytes, 0, 1781820000000);

    const callbacks = mocks.gatewayLiveStreamCtor.mock.calls[0][0] as {
      onEvent: (event: unknown) => void;
    };
    callbacks.onEvent({
      type: 'final',
      seq: 4,
      text: 'son kelimeler',
      elapsed_ms: 500,
      reason: 'speech_final',
      source_start_sample: 16_000,
      source_end_sample: 32_000,
    });
    expect(rendererSend).toHaveBeenCalledWith(
      'audio:transcript-event',
      expect.objectContaining({
        sessionId: 'SES-1',
        meetingId,
        status: 'FINAL',
        text: 'son kelimeler',
        correlationId: 'gateway-live',
        transportEpoch: 3,
        windowSeq: 4,
        audioDurationMs: 1000,
        flushReason: 'speech_final',
      }),
    );
    const livePayload = rendererSend.mock.calls.find(
      ([channel]) => channel === 'audio:transcript-event',
    )?.[1] as { windowStartedAtMs: number; windowEndedAtMs: number };
    expect(livePayload.windowEndedAtMs - livePayload.windowStartedAtMs).toBe(1000);
    expect(livePayload.windowStartedAtMs).toBe(1781820001000);

    mocks.gatewayLiveStreamSourceTimingReliable.mockReturnValueOnce(false);
    callbacks.onEvent({
      type: 'final',
      seq: 5,
      text: 'kesinti sonrası final',
      elapsed_ms: 400,
      reason: 'speech_final',
      source_start_sample: 32_000,
      source_end_sample: 40_000,
    });
    const degradedTimingPayload = rendererSend.mock.calls.find(
      ([channel, payload]) =>
        channel === 'audio:transcript-event' &&
        (payload as { text?: string }).text === 'kesinti sonrası final',
    )?.[1] as {
      windowStartedAtMs: number | null;
      windowEndedAtMs: number | null;
      audioDurationMs: number | null;
    };
    expect(degradedTimingPayload).toMatchObject({
      windowStartedAtMs: null,
      windowEndedAtMs: null,
      audioDurationMs: null,
    });

    await finishHandler()({}, started.captureId);
    expect(mocks.gatewayLiveStreamStop).toHaveBeenCalledTimes(1);
    expect(mocks.gatewayLiveStreamStop.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.senderFinish.mock.invocationCallOrder[0],
    );
    expect(mocks.gatewayLiveStreamClose).toHaveBeenCalledTimes(1);
  });

  it('forces Speechmatics sessions to realtime even when the caller asks for balanced', async () => {
    // gitops#3419 saha raporu: planlayıcı/bağlanan toplantıdan 'balanced'
    // sızınca canlı WS hiç kurulmuyor ve kullanıcı 5s REST pencerelerini
    // izliyordu. Speechmatics'te modun tek doğru değeri realtime'dır.
    mocks.loadRecorderRuntimeConfig.mockReturnValue({
      meetingId,
      deviceId,
      ready: true,
      reason: null,
      liveSttStreamUrl: null,
      liveSttStreamReason: null,
      gatewayLiveStreamEnabled: true,
    });
    await acceptConsent();

    const started = (await startHandler()(
      { sender: { id: 8, send: vi.fn() } },
      meetingId,
      deviceId,
      [],
      'speechmatics',
      'balanced',
    )) as { captureId: string; sttProvider: string; transcriptionMode?: string };

    expect(started.sttProvider).toBe('speechmatics');
    expect(started.transcriptionMode).toBe('realtime');
    expect(mocks.senderStart).toHaveBeenCalledWith(
      meetingId,
      deviceId,
      'tr',
      'IK-1',
      'speechmatics',
      'realtime',
      [],
    );
    expect(mocks.gatewayLiveStreamCtor).toHaveBeenCalledTimes(1);

    await finishHandler()({}, started.captureId);
  });

  it('opens Speechmatics live transport and sends realtime frames independently of REST', async () => {
    mocks.loadRecorderRuntimeConfig.mockReturnValue({
      meetingId,
      deviceId,
      ready: true,
      reason: null,
      liveSttStreamUrl: null,
      liveSttStreamReason: null,
      gatewayLiveStreamEnabled: true,
    });
    await acceptConsent();

    const rendererSendSpy = vi.fn();
    const started = (await startHandler()(
      { sender: { id: 9, send: rendererSendSpy } },
      meetingId,
      deviceId,
      [],
      'speechmatics',
      'realtime',
    )) as { captureId: string };
    expect(mocks.senderStart).toHaveBeenCalledWith(
      meetingId,
      deviceId,
      'tr',
      'IK-1',
      'speechmatics',
      'realtime',
      [],
    );
    // #138: realtime frames are 100ms, so the replay window is sized by duration.
    expect(mocks.gatewayLiveStreamCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        maxPendingFrames: 600,
        circuitCooldownLadderMs: expect.arrayContaining([5_000]),
        replayFramesPerTick: 4,
      }),
    );
    // Measured lag reaches the renderer tagged with the gateway session.
    const liveStreamOptions = mocks.gatewayLiveStreamCtor.mock.calls.at(-1)?.[0] as {
      onLagSnapshot?: (snapshot: { deliveryBacklogMs: number; engineLagMs: number | null }) => void;
    };
    liveStreamOptions.onLagSnapshot?.({ deliveryBacklogMs: 1_200, engineLagMs: 300 });
    expect(rendererSendSpy).toHaveBeenCalledWith(
      'audio:live-lag',
      expect.objectContaining({ deliveryBacklogMs: 1_200, engineLagMs: 300 }),
    );
    const restBytes = new Uint8Array([0, 0]);
    await chunkHandler()(
      {},
      { captureId: started.captureId, bytes: restBytes, startedAtMs: 1781820000000 },
    );
    expect(mocks.gatewayLiveStreamSend).not.toHaveBeenCalled();

    const liveBytes = new Uint8Array(3_200);
    await expect(
      liveFrameHandler()(
        {},
        { captureId: started.captureId, bytes: liveBytes, capturedAtMs: 1781820000100 },
      ),
    ).resolves.toEqual({ accepted: true });
    expect(mocks.gatewayLiveStreamSendRealtime).toHaveBeenCalledWith(liveBytes, 1781820000100);

    await finishHandler()({}, started.captureId);
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

    await expect(finishHandler()({}, started.captureId)).resolves.toEqual({
      ok: true,
      liveTranscript: null,
    });

    expect(mocks.senderFinish).toHaveBeenCalledTimes(1);
    expect(mocks.syncRecordingLifecycle).toHaveBeenCalledTimes(2);
    expect(mocks.syncRecordingLifecycle).toHaveBeenLastCalledWith(
      { baseUrl: 'https://meeting.example.com' },
      'JWT',
      expect.objectContaining({
        meetingId,
        externalSessionId: 'SES-1',
        startedAt: expect.any(String),
        endedAt: expect.any(String),
      }),
    );
    expect(mocks.transcriptSubscriptionStop).toHaveBeenCalledTimes(1);
    expect(mocks.setRecordingActive).toHaveBeenLastCalledWith(false);
  });

  it('does not report finish success when canonical lifecycle finish fails', async () => {
    await acceptConsent();
    const started = (await startHandler()({}, meetingId, deviceId)) as { captureId: string };
    mocks.syncRecordingLifecycle.mockRejectedValueOnce(
      new Error('syncRecordingLifecycle failed: 503 code=MEETING_UNAVAILABLE'),
    );

    await expect(finishHandler()({}, started.captureId)).rejects.toThrow('MEETING_UNAVAILABLE');

    expect(mocks.senderFinish).toHaveBeenCalledTimes(1);
    expect(mocks.setRecordingActive).toHaveBeenLastCalledWith(false);
    expect(mocks.pendingLifecycles).toEqual([
      expect.objectContaining({
        meetingId,
        externalSessionId: 'SES-1',
        endedAt: expect.any(String),
      }),
    ]);
  });

  it('does not mutate remote finish state when the durable terminal write fails', async () => {
    await acceptConsent();
    const started = (await startHandler()({}, meetingId, deviceId)) as { captureId: string };
    mocks.outboxMarkEnded.mockImplementationOnce(() => {
      throw new Error('recording lifecycle outbox write failed');
    });

    await expect(finishHandler()({}, started.captureId)).rejects.toThrow(
      'recording lifecycle outbox write failed',
    );

    expect(mocks.senderFinish).not.toHaveBeenCalled();
    expect(mocks.syncRecordingLifecycle).toHaveBeenCalledTimes(1);
    expect(mocks.outboxRemove).not.toHaveBeenCalled();
    expect(mocks.transcriptSubscriptionStop).toHaveBeenCalledTimes(1);
    expect(mocks.setRecordingActive).toHaveBeenLastCalledWith(false);
  });

  it('reports the first durable terminal error without attempting a tombstone write', async () => {
    await acceptConsent();
    const started = (await startHandler()({}, meetingId, deviceId)) as { captureId: string };
    mocks.outboxMarkEnded.mockImplementationOnce(() => {
      throw new Error('recording lifecycle outbox write failed');
    });
    mocks.outboxRemove.mockImplementationOnce(() => {
      throw new Error('recording lifecycle tombstone write failed');
    });

    await expect(finishHandler()({}, started.captureId)).rejects.toThrow(
      'recording lifecycle outbox write failed',
    );

    expect(mocks.syncRecordingLifecycle).toHaveBeenCalledTimes(1);
    expect(mocks.senderFinish).not.toHaveBeenCalled();
    expect(mocks.outboxRemove).not.toHaveBeenCalled();
    expect(mocks.setRecordingActive).toHaveBeenLastCalledWith(false);
  });

  it('retries an ambiguous gateway finish from the durable identity', async () => {
    await acceptConsent();
    const started = (await startHandler()({}, meetingId, deviceId)) as { captureId: string };
    mocks.senderFinish.mockRejectedValueOnce(new Error('finishSession response lost'));

    await expect(finishHandler()({}, started.captureId)).resolves.toEqual({
      ok: true,
      liveTranscript: null,
    });

    expect(mocks.syncRecordingLifecycle).toHaveBeenCalledTimes(2);
    expect(mocks.finishSession).toHaveBeenCalledWith(
      { baseUrl: 'https://gw.example.com' },
      'JWT',
      'SES-1',
      'IK-1',
    );
    expect(mocks.pendingLifecycles).toEqual([]);
    expect(mocks.setRecordingActive).toHaveBeenLastCalledWith(false);
  });

  it('keeps the durable gateway identity when every finish confirmation fails', async () => {
    mocks.newIdempotencyKey
      .mockReturnValueOnce('11111111111111111111111111111111')
      .mockReturnValue('22222222222222222222222222222222');
    await acceptConsent();
    const started = (await startHandler()({}, meetingId, deviceId)) as { captureId: string };
    mocks.senderFinish.mockRejectedValueOnce(new Error('finishSession response lost'));
    mocks.finishSession.mockRejectedValue(new Error('gateway still unavailable'));

    await expect(finishHandler()({}, started.captureId)).rejects.toThrow(
      'gateway still unavailable',
    );

    expect(mocks.finishSession).toHaveBeenCalledTimes(3);
    expect(mocks.senderFinish).toHaveBeenCalledWith('22222222222222222222222222222222');
    expect(mocks.finishSession).toHaveBeenLastCalledWith(
      { baseUrl: 'https://gw.example.com' },
      'JWT',
      'SES-1',
      '22222222222222222222222222222222',
    );
    expect(mocks.pendingLifecycles).toEqual([
      expect.objectContaining({
        meetingId,
        externalSessionId: 'SES-1',
        endedAt: expect.any(String),
        gatewayFinishPending: true,
      }),
    ]);
    expect(mocks.setRecordingActive).toHaveBeenLastCalledWith(false);
  });

  it('blocks a new capture lease until gateway finalization is reconciled', async () => {
    mocks.pendingLifecycles = [
      {
        meetingId,
        externalSessionId: 'SES-old',
        startedAt: '2026-07-17T08:43:20.000Z',
        endedAt: '2026-07-17T08:44:20.000Z',
        gatewayFinishPending: true,
      },
    ];
    await acceptConsent();
    const prepare = mocks.handlers.get('audio:prepare-capture');
    if (!prepare) throw new Error('audio:prepare-capture handler not registered');
    const reconcile = mocks.handlers.get('audio:reconcile-lifecycle');
    if (!reconcile) throw new Error('audio:reconcile-lifecycle handler not registered');

    await expect(prepare({})).rejects.toThrow(
      'pending recording lifecycle must be reconciled before a new recording',
    );
    expect(mocks.syncRecordingLifecycle).not.toHaveBeenCalled();

    await expect(reconcile({})).resolves.toEqual({
      ok: true,
      processed: 1,
      remaining: 0,
      terminalized: 0,
    });

    await expect(prepare({})).resolves.toEqual({ ok: true, expiresAtMs: 1781820000123 });

    expect(mocks.syncRecordingLifecycle).toHaveBeenCalledWith(
      { baseUrl: 'https://meeting.example.com' },
      'JWT',
      expect.objectContaining({ externalSessionId: 'SES-old' }),
    );
    expect(mocks.pendingLifecycles).toEqual([]);
  });

  it('terminalizes a verified missing gateway session before unblocking capture', async () => {
    mocks.pendingLifecycles = [
      {
        meetingId,
        externalSessionId: 'SES-expired',
        startedAt: '2026-07-17T08:43:20.000Z',
        endedAt: '2026-07-17T08:44:20.000Z',
        gatewayFinishPending: true,
        gatewayFinishIdempotencyKey: '0123456789abcdef0123456789abcdef',
      },
    ];
    mocks.finishSession.mockRejectedValueOnce(
      new mocks.MockGatewaySessionFinishRejectedError(
        'finishSession failed: 404 code=AUDIO_GATEWAY_SESSION_NOT_FOUND retryable=false',
        404,
        'AUDIO_GATEWAY_SESSION_NOT_FOUND',
        false,
      ),
    );
    const reconcile = mocks.handlers.get('audio:reconcile-lifecycle');
    if (!reconcile) throw new Error('audio:reconcile-lifecycle handler not registered');
    const prepare = mocks.handlers.get('audio:prepare-capture');
    if (!prepare) throw new Error('audio:prepare-capture handler not registered');
    await acceptConsent();

    await expect(reconcile({})).resolves.toEqual({
      ok: true,
      processed: 1,
      remaining: 0,
      terminalized: 1,
    });

    expect(mocks.finishSession).toHaveBeenCalledTimes(1);
    expect(mocks.outboxMarkGatewaySessionNotFound).toHaveBeenCalledTimes(1);
    expect(mocks.pendingUnreconcilable).toEqual([{ meetingId, externalSessionId: 'SES-expired' }]);
    expect(mocks.syncRecordingLifecycle).toHaveBeenCalledWith(
      { baseUrl: 'https://meeting.example.com' },
      'JWT',
      expect.objectContaining({
        externalSessionId: 'SES-expired',
        gatewayFinishPending: false,
      }),
    );
    expect(mocks.pendingLifecycles).toEqual([]);
    await expect(prepare({})).resolves.toEqual({ ok: true, expiresAtMs: 1781820000123 });
  });

  it('keeps authorization failures pending and fail-closed', async () => {
    mocks.pendingLifecycles = [
      {
        meetingId,
        externalSessionId: 'SES-forbidden',
        startedAt: '2026-07-17T08:43:20.000Z',
        endedAt: '2026-07-17T08:44:20.000Z',
        gatewayFinishPending: true,
        gatewayFinishIdempotencyKey: '0123456789abcdef0123456789abcdef',
      },
    ];
    mocks.finishSession.mockRejectedValueOnce(
      new mocks.MockGatewaySessionFinishRejectedError(
        'finishSession failed: 403 code=AUDIO_GATEWAY_MEETING_FORBIDDEN retryable=false',
        403,
        'AUDIO_GATEWAY_MEETING_FORBIDDEN',
        false,
      ),
    );
    const reconcile = mocks.handlers.get('audio:reconcile-lifecycle');
    if (!reconcile) throw new Error('audio:reconcile-lifecycle handler not registered');
    const prepare = mocks.handlers.get('audio:prepare-capture');
    if (!prepare) throw new Error('audio:prepare-capture handler not registered');
    await acceptConsent();

    await expect(reconcile({})).resolves.toEqual({
      ok: false,
      processed: 1,
      remaining: 1,
      terminalized: 0,
    });

    expect(mocks.finishSession).toHaveBeenCalledTimes(1);
    expect(mocks.outboxMarkGatewaySessionNotFound).not.toHaveBeenCalled();
    expect(mocks.pendingUnreconcilable).toEqual([]);
    await expect(prepare({})).rejects.toThrow(
      'pending recording lifecycle must be reconciled before a new recording',
    );
  });

  it('retries gateway finish even when canonical reconciliation is temporarily unavailable', async () => {
    mocks.pendingLifecycles = [
      {
        meetingId,
        externalSessionId: 'SES-independent',
        startedAt: '2026-07-17T08:43:20.000Z',
        endedAt: '2026-07-17T08:44:20.000Z',
        gatewayFinishPending: true,
      },
    ];
    mocks.syncRecordingLifecycle.mockRejectedValueOnce(
      new Error('syncRecordingLifecycle failed: 503 code=MEETING_UNAVAILABLE'),
    );
    const reconcile = mocks.handlers.get('audio:reconcile-lifecycle');
    if (!reconcile) throw new Error('audio:reconcile-lifecycle handler not registered');
    const prepare = mocks.handlers.get('audio:prepare-capture');
    if (!prepare) throw new Error('audio:prepare-capture handler not registered');
    await acceptConsent();

    await expect(reconcile({})).resolves.toEqual({
      ok: false,
      processed: 1,
      remaining: 1,
      terminalized: 0,
    });

    expect(mocks.finishSession).toHaveBeenCalledTimes(1);
    expect(mocks.pendingLifecycles).toEqual([
      expect.objectContaining({
        externalSessionId: 'SES-independent',
        gatewayFinishPending: false,
      }),
    ]);
    await expect(prepare({})).rejects.toThrow(
      'pending recording lifecycle must be reconciled before a new recording',
    );

    await expect(reconcile({})).resolves.toEqual({
      ok: true,
      processed: 1,
      remaining: 0,
      terminalized: 0,
    });
    expect(mocks.finishSession).toHaveBeenCalledTimes(1);
    expect(mocks.pendingLifecycles).toEqual([]);
    await expect(prepare({})).resolves.toEqual({ ok: true, expiresAtMs: 1781820000123 });
  });

  it('replays durable lifecycle metadata after login reconciliation', async () => {
    mocks.pendingLifecycles = [
      {
        meetingId,
        externalSessionId: 'SES-recovered',
        startedAt: '2026-07-17T08:43:20.000Z',
        endedAt: null,
        gatewayFinishPending: true,
      },
    ];
    const reconcile = mocks.handlers.get('audio:reconcile-lifecycle');
    if (!reconcile) throw new Error('audio:reconcile-lifecycle handler not registered');

    await expect(reconcile({})).resolves.toEqual({
      ok: true,
      processed: 1,
      remaining: 0,
      terminalized: 0,
    });

    expect(mocks.outboxMarkEnded).toHaveBeenCalledWith(
      expect.objectContaining({ externalSessionId: 'SES-recovered' }),
      expect.any(String),
    );
    expect(mocks.syncRecordingLifecycle).toHaveBeenCalledTimes(1);
    expect(mocks.pendingLifecycles).toEqual([]);
  });

  it('replays an ambiguous durable start with the original idempotency key', async () => {
    mocks.pendingStarts = [
      {
        meetingId,
        captureId: '33333333-3333-4333-8333-333333333333',
        deviceId,
        language: 'tr',
        startedAt: '2026-07-17T08:43:20.000Z',
        idempotencyKey: '0123456789abcdef0123456789abcdef',
        gatewayFinishIdempotencyKey: 'fedcba9876543210fedcba9876543210',
      },
    ];
    const reconcile = mocks.handlers.get('audio:reconcile-lifecycle');
    if (!reconcile) throw new Error('audio:reconcile-lifecycle handler not registered');

    await expect(reconcile({})).resolves.toEqual({
      ok: true,
      processed: 1,
      remaining: 0,
      terminalized: 0,
    });

    expect(mocks.startSession).toHaveBeenCalledWith(
      { baseUrl: 'https://gw.example.com' },
      'JWT',
      { meetingId, deviceId, language: 'tr' },
      '0123456789abcdef0123456789abcdef',
    );
    expect(mocks.finishSession).toHaveBeenCalledWith(
      { baseUrl: 'https://gw.example.com' },
      'JWT',
      'SES-recovered',
      'fedcba9876543210fedcba9876543210',
    );
    expect(mocks.pendingStarts).toEqual([]);
    expect(mocks.pendingLifecycles).toEqual([]);
  });

  it('reuses an already-persisted recovered lifecycle without changing terminal identity', async () => {
    mocks.pendingStarts = [
      {
        meetingId,
        captureId: '33333333-3333-4333-8333-333333333333',
        deviceId,
        language: 'tr',
        startedAt: '2026-07-17T08:43:20.000Z',
        idempotencyKey: '0123456789abcdef0123456789abcdef',
        gatewayFinishIdempotencyKey: 'fedcba9876543210fedcba9876543210',
      },
    ];
    mocks.pendingLifecycles = [
      {
        meetingId,
        externalSessionId: 'SES-recovered',
        startedAt: '2026-07-17T08:43:20.000Z',
        endedAt: '2026-07-17T08:44:20.000Z',
        gatewayFinishPending: true,
        gatewayFinishIdempotencyKey: 'fedcba9876543210fedcba9876543210',
      },
    ];
    const reconcile = mocks.handlers.get('audio:reconcile-lifecycle');
    if (!reconcile) throw new Error('audio:reconcile-lifecycle handler not registered');

    await expect(reconcile({})).resolves.toEqual({
      ok: true,
      processed: 1,
      remaining: 0,
      terminalized: 0,
    });

    expect(mocks.outboxMarkEnded).not.toHaveBeenCalled();
    expect(mocks.finishSession).toHaveBeenCalledWith(
      { baseUrl: 'https://gw.example.com' },
      'JWT',
      'SES-recovered',
      'fedcba9876543210fedcba9876543210',
    );
    expect(mocks.pendingStarts).toEqual([]);
    expect(mocks.pendingLifecycles).toEqual([]);
  });

  it('reconciles older lifecycle records while leaving the current recording active', async () => {
    await acceptConsent();
    await startHandler()({}, meetingId, deviceId);
    mocks.pendingLifecycles.unshift({
      meetingId: '44444444-4444-4444-8444-444444444444',
      externalSessionId: 'SES-older',
      startedAt: '2026-07-17T08:40:20.000Z',
      endedAt: '2026-07-17T08:41:20.000Z',
      gatewayFinishPending: false,
    });
    const reconcile = mocks.handlers.get('audio:reconcile-lifecycle');
    if (!reconcile) throw new Error('audio:reconcile-lifecycle handler not registered');

    await expect(reconcile({})).resolves.toEqual({
      ok: true,
      processed: 1,
      remaining: 0,
      terminalized: 0,
    });

    expect(mocks.syncRecordingLifecycle).toHaveBeenCalledWith(
      { baseUrl: 'https://meeting.example.com' },
      'JWT',
      expect.objectContaining({ externalSessionId: 'SES-older' }),
    );
    expect(mocks.pendingLifecycles).toEqual([
      expect.objectContaining({ externalSessionId: 'SES-1', endedAt: null }),
    ]);
    expect(mocks.senderFinish).not.toHaveBeenCalled();
    expect(mocks.setRecordingActive).not.toHaveBeenLastCalledWith(false);
  });

  it('drains all bounded historical records in one reconciliation call', async () => {
    mocks.pendingLifecycles = Array.from({ length: 5 }, (_, index) => ({
      meetingId: `44444444-4444-4444-8444-44444444444${index}`,
      externalSessionId: `SES-batch-${index}`,
      startedAt: '2026-07-17T08:40:20.000Z',
      endedAt: '2026-07-17T08:41:20.000Z',
      gatewayFinishPending: false,
    }));
    const reconcile = mocks.handlers.get('audio:reconcile-lifecycle');
    if (!reconcile) throw new Error('audio:reconcile-lifecycle handler not registered');

    await expect(reconcile({})).resolves.toEqual({
      ok: true,
      processed: 5,
      remaining: 0,
      terminalized: 0,
    });

    expect(mocks.syncRecordingLifecycle).toHaveBeenCalledTimes(5);
    expect(mocks.pendingLifecycles).toEqual([]);
  });

  it('continues past a poison lifecycle record before reporting its error', async () => {
    mocks.pendingLifecycles = [
      {
        meetingId,
        externalSessionId: 'SES-poison',
        startedAt: '2026-07-17T08:40:20.000Z',
        endedAt: '2026-07-17T08:41:20.000Z',
        gatewayFinishPending: false,
      },
      {
        meetingId: '44444444-4444-4444-8444-444444444444',
        externalSessionId: 'SES-healthy',
        startedAt: '2026-07-17T08:42:20.000Z',
        endedAt: '2026-07-17T08:43:20.000Z',
        gatewayFinishPending: false,
      },
    ];
    mocks.syncRecordingLifecycle
      .mockRejectedValueOnce(new Error('syncRecordingLifecycle failed: 403 code=MEETING_FORBIDDEN'))
      .mockResolvedValueOnce({});
    const reconcile = mocks.handlers.get('audio:reconcile-lifecycle');
    if (!reconcile) throw new Error('audio:reconcile-lifecycle handler not registered');

    await expect(reconcile({})).resolves.toEqual({
      ok: false,
      processed: 2,
      remaining: 1,
      terminalized: 0,
    });

    expect(mocks.syncRecordingLifecycle).toHaveBeenCalledTimes(2);
    expect(mocks.pendingLifecycles).toEqual([
      expect.objectContaining({ externalSessionId: 'SES-poison' }),
    ]);
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

  it('does not surface transcript long-poll timeouts as renderer errors', async () => {
    const send = vi.fn();
    await acceptConsent();
    await startHandler()({ sender: { id: 7, send } }, meetingId, deviceId);

    const args = mocks.transcriptSubscriptionCtor.mock.calls[0][0] as {
      onError: (error: Error) => void;
    };
    args.onError(new Error('readTranscriptEvents timed out after 15000ms'));
    args.onError(new Error('readTranscriptEvents timed out after 25000ms'));

    expect(send).not.toHaveBeenCalledWith('audio:transcript-error', expect.anything());
  });

  it('cleans the active recorder state when its renderer unloads', async () => {
    await acceptConsent();
    await startHandler()({ sender: { id: 7, send: vi.fn() } }, meetingId, deviceId);
    mocks.senderGetState.mockReturnValue('active');

    rendererUnloadedListener()({ sender: { id: 7 } });
    await vi.waitFor(() => {
      expect(mocks.senderFinish).toHaveBeenCalledTimes(1);
      expect(mocks.transcriptSubscriptionStop).toHaveBeenCalledTimes(1);
      expect(mocks.setRecordingActive).toHaveBeenLastCalledWith(false);
    });
  });

  it('finishes a gateway session when its renderer unloads during canonical start', async () => {
    let resolveCanonical: ((value: unknown) => void) | null = null;
    mocks.syncRecordingLifecycle.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCanonical = resolve;
        }),
    );
    await acceptConsent();

    const start = startHandler()({ sender: { id: 17, send: vi.fn() } }, meetingId, deviceId);
    await vi.waitFor(() => expect(mocks.syncRecordingLifecycle).toHaveBeenCalledTimes(1));
    rendererUnloadedListener()({ sender: { id: 17 } });
    resolveCanonical?.({
      meetingId,
      sessionId: '33333333-3333-4333-8333-333333333333',
      externalSessionId: 'SES-1',
      meetingStatus: 'IN_PROGRESS',
      transcriptStatus: 'PENDING',
      startedAt: expect.any(String),
      endedAt: null,
    });

    await expect(start).rejects.toThrow('renderer unloaded while recording session was starting');
    expect(mocks.finishSession).toHaveBeenCalledTimes(1);
    expect(mocks.transcriptSubscriptionStart).not.toHaveBeenCalled();
    expect(mocks.setRecordingActive).not.toHaveBeenCalledWith(true);
    expect(mocks.pendingLifecycles).toEqual([]);
  });

  it('stops before consent mutation when its renderer unloads during token refresh', async () => {
    let resolveToken: ((value: string) => void) | null = null;
    mocks.getValidAccessToken.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveToken = resolve;
        }),
    );
    await acceptConsent();

    const start = startHandler()({ sender: { id: 37, send: vi.fn() } }, meetingId, deviceId);
    await vi.waitFor(() => expect(mocks.getValidAccessToken).toHaveBeenCalledTimes(1));
    rendererUnloadedListener()({ sender: { id: 37 } });
    resolveToken?.('JWT');

    await expect(start).rejects.toThrow('renderer unloaded while recording session was starting');
    expect(mocks.recordConsent).not.toHaveBeenCalled();
    expect(mocks.senderStart).not.toHaveBeenCalled();
    expect(mocks.syncRecordingLifecycle).not.toHaveBeenCalled();
  });

  it('cancels and reconciles a gateway live stream when its renderer unloads during readiness', async () => {
    let rejectLiveStart: ((error: Error) => void) | null = null;
    mocks.loadRecorderRuntimeConfig.mockReturnValueOnce({
      meetingId: '22222222-2222-4222-8222-222222222222',
      deviceId: 'dev1',
      ready: true,
      reason: null,
      liveSttStreamUrl: null,
      liveSttStreamReason: null,
      gatewayLiveStreamEnabled: true,
    });
    mocks.gatewayLiveStreamStart.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectLiveStart = reject;
        }),
    );
    mocks.gatewayLiveStreamClose.mockImplementation(() => {
      rejectLiveStart?.(new Error('closed while waiting for readiness'));
    });
    await acceptConsent();

    const start = startHandler()({ sender: { id: 27, send: vi.fn() } }, meetingId, deviceId);
    await vi.waitFor(() => expect(mocks.gatewayLiveStreamStart).toHaveBeenCalledTimes(1));
    rendererUnloadedListener()({ sender: { id: 27 } });

    await expect(start).rejects.toThrow('renderer unloaded while gateway live stream was starting');
    expect(mocks.gatewayLiveStreamClose).toHaveBeenCalled();
    expect(mocks.finishSession).toHaveBeenCalledTimes(1);
    expect(mocks.transcriptSubscriptionStart).not.toHaveBeenCalled();
    expect(mocks.setRecordingActive).not.toHaveBeenCalledWith(true);
    expect(mocks.pendingLifecycles).toEqual([]);
  });

  it('single-flights unload and abort while rejecting concurrent reconciliation', async () => {
    let releaseFinish: (() => void) | null = null;
    mocks.senderFinish.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFinish = resolve;
        }),
    );
    await acceptConsent();
    const started = (await startHandler()(
      { sender: { id: 7, send: vi.fn() } },
      meetingId,
      deviceId,
    )) as {
      captureId: string;
    };
    const reconcile = mocks.handlers.get('audio:reconcile-lifecycle');
    if (!reconcile) throw new Error('audio:reconcile-lifecycle handler not registered');

    rendererUnloadedListener()({ sender: { id: 7 } });
    const abortPromise = abortHandler()({}, started.captureId);
    await expect(reconcile({})).rejects.toThrow('recording lifecycle reconciliation is busy');
    expect(mocks.senderFinish).toHaveBeenCalledTimes(1);

    releaseFinish?.();
    await expect(abortPromise).resolves.toEqual({ ok: true });
    expect(mocks.senderFinish).toHaveBeenCalledTimes(1);
    expect(mocks.syncRecordingLifecycle).toHaveBeenCalledTimes(2);
  });

  it('stops transcript polling when the recording is aborted', async () => {
    await acceptConsent();
    const started = (await startHandler()({}, meetingId, deviceId)) as { captureId: string };

    await expect(abortHandler()({}, started.captureId)).resolves.toEqual({ ok: true });

    expect(mocks.transcriptSubscriptionStop).toHaveBeenCalledTimes(1);
    expect(mocks.clearCapturePermissionLease).toHaveBeenCalledTimes(1);
  });
});
