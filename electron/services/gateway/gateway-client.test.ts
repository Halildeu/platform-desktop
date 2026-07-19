import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  chunkHeaders,
  chunksUrl,
  consentsUrl,
  finishSession,
  finishUrl,
  loadGatewayConfig,
  newIdempotencyKey,
  readTranscriptEvents,
  recordConsent,
  sendChunk,
  sessionsUrl,
  startSession,
  streamTranscriptEvents,
  transcriptEventsUrl,
  transcriptEventsStreamUrl,
} from './gateway-client';

const cfg = loadGatewayConfig({ GATEWAY_BASE_URL: 'https://gw.example.com/' });
const meetingId = '22222222-2222-4222-8222-222222222222';
const captureId = '33333333-3333-4333-8333-333333333333';
const consentTextHash = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('gateway-client pure helpers', () => {
  it('loadGatewayConfig: trims trailing slash', () => {
    expect(cfg.baseUrl).toBe('https://gw.example.com');
  });

  it('loadGatewayConfig rejects missing or relative base URLs', () => {
    expect(() => loadGatewayConfig({})).toThrow('GATEWAY_BASE_URL is required');
    expect(() => loadGatewayConfig({ GATEWAY_BASE_URL: '/audio-gateway' })).toThrow(
      'GATEWAY_BASE_URL must be an absolute URL',
    );
  });

  it('loadGatewayConfig requires https except local development URLs', () => {
    expect(() => loadGatewayConfig({ GATEWAY_BASE_URL: 'http://gw.example.com' })).toThrow(
      'GATEWAY_BASE_URL must use https',
    );
    expect(loadGatewayConfig({ GATEWAY_BASE_URL: 'http://127.0.0.1:8210' }).baseUrl).toBe(
      'http://127.0.0.1:8210',
    );
  });

  it('URL builders use contract-v1 paths', () => {
    const base = 'https://gw.example.com/api/v1/audio-gateway';
    expect(consentsUrl(cfg)).toBe(`${base}/consents`);
    expect(sessionsUrl(cfg)).toBe(`${base}/sessions`);
    expect(chunksUrl(cfg, 'SES-1')).toBe(`${base}/sessions/SES-1/chunks`);
    expect(finishUrl(cfg, 'SES-1')).toBe(`${base}/sessions/SES-1/finish`);
    expect(transcriptEventsUrl(cfg, 'SES-1')).toBe(`${base}/sessions/SES-1/transcript-events`);
    expect(transcriptEventsStreamUrl(cfg, 'SES-1')).toBe(
      `${base}/sessions/SES-1/transcript-events/stream`,
    );
    expect(transcriptEventsUrl(cfg, 'SES-1', { after: '1680000000000-0', limit: 25 })).toBe(
      `${base}/sessions/SES-1/transcript-events?after=1680000000000-0&limit=25`,
    );
    expect(transcriptEventsStreamUrl(cfg, 'SES-1', { after: '1680000000000-0' })).toBe(
      `${base}/sessions/SES-1/transcript-events/stream?after=1680000000000-0`,
    );
  });

  it('chunkHeaders include seq, started-at, byte-length, format/rate/channels and octet-stream', () => {
    const h = chunkHeaders({
      jwt: 'JWT',
      idempotencyKey: 'IK',
      seq: 3,
      startedAtMs: 123,
      byteLength: 640,
    });
    expect(h.Authorization).toBe('Bearer JWT');
    expect(h['Idempotency-Key']).toBe('IK');
    expect(h['X-Audio-Chunk-Seq']).toBe('3');
    expect(h['X-Audio-Chunk-Started-At-Ms']).toBe('123');
    expect(h['X-Audio-Byte-Length']).toBe('640');
    expect(h['X-Audio-Format']).toBe('PCM16');
    expect(h['X-Audio-Sample-Rate-Hz']).toBe('16000');
    expect(h['X-Audio-Channels']).toBe('1');
    expect(h['Content-Type']).toBe('application/octet-stream');
  });

  it('chunkHeaders accepts custom format/rate/channels', () => {
    const h = chunkHeaders({
      jwt: 'JWT',
      idempotencyKey: 'IK',
      seq: 0,
      startedAtMs: 0,
      byteLength: 100,
      audioFormat: 'WEBM_OPUS',
      sampleRateHz: 48000,
      channels: 2,
    });
    expect(h['X-Audio-Format']).toBe('WEBM_OPUS');
    expect(h['X-Audio-Sample-Rate-Hz']).toBe('48000');
    expect(h['X-Audio-Channels']).toBe('2');
  });

  it('newIdempotencyKey returns unique 32-char hex values', () => {
    const a = newIdempotencyKey();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(newIdempotencyKey());
  });
});

describe('gateway-client HTTP fetch wrapper', () => {
  it('recordConsent posts consent proof without client clock or raw text', async () => {
    const acceptedAtMs = Date.now();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        meetingId,
        captureId,
        consentVersion: '1.0.0',
        consentTextHash,
        locale: 'tr-TR',
        correlationId: 'corr-1',
        acceptedAtMs,
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const info = await recordConsent(cfg, 'JWT', {
      meetingId,
      captureId,
      consentVersion: '1.0.0',
      consentTextHash,
      locale: 'tr-TR',
    });

    expect(info.acceptedAtMs).toBe(acceptedAtMs);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://gw.example.com/api/v1/audio-gateway/consents');
    expect(opts.headers.Authorization).toBe('Bearer JWT');
    const body = JSON.parse(opts.body as string);
    expect(body).toEqual({
      meetingId,
      captureId,
      consentVersion: '1.0.0',
      consentTextHash,
      locale: 'tr-TR',
    });
    expect(body).not.toHaveProperty('acceptedAt');
    expect(body).not.toHaveProperty('acceptedAtMs');
    expect(body).not.toHaveProperty('consentText');
  });

  it('recordConsent rejects mismatched identity and implausible server time', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          meetingId,
          captureId: '44444444-4444-4444-8444-444444444444',
          consentVersion: '1.0.0',
          consentTextHash,
          locale: 'tr-TR',
          correlationId: 'corr-1',
          acceptedAtMs: Date.now(),
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          meetingId,
          captureId,
          consentVersion: '1.0.0',
          consentTextHash,
          locale: 'tr-TR',
          correlationId: 'corr-1',
          acceptedAtMs: Date.now() - 10 * 60_000,
        }),
      });
    vi.stubGlobal('fetch', fetchMock);
    const args = {
      meetingId,
      captureId,
      consentVersion: '1.0.0',
      consentTextHash,
      locale: 'tr-TR',
    };

    await expect(recordConsent(cfg, 'JWT', args)).rejects.toThrow(
      'recordConsent response captureId mismatch',
    );
    await expect(recordConsent(cfg, 'JWT', args)).rejects.toThrow(
      'recordConsent acceptedAtMs is invalid',
    );
  });

  it('startSession posts session metadata as PCM16/16k/mono', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ sessionId: 'SES-9', chunkUploadUrl: '/c', finishUrl: '/f' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const info = await startSession(
      cfg,
      'JWT',
      { meetingId, deviceId: 'dev1', language: 'tr' },
      'IK',
    );
    expect(info.sessionId).toBe('SES-9');

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://gw.example.com/api/v1/audio-gateway/sessions');
    expect(opts.headers.Authorization).toBe('Bearer JWT');
    const body = JSON.parse(opts.body as string);
    expect(body).toMatchObject({
      meetingId,
      audioFormat: 'PCM16',
      sampleRateHz: 16000,
      channels: 1,
    });
  });

  it('startSession rejects an invalid session identity from a successful response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ sessionId: '../foreign' }),
      }),
    );

    await expect(
      startSession(cfg, 'JWT', { meetingId, deviceId: 'dev1', language: 'tr' }, 'IK'),
    ).rejects.toThrow('startSession sessionId is invalid');
  });

  it('keeps the start deadline active while the response body is read', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | null = null;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        requestSignal = init?.signal as AbortSignal;
        return Promise.resolve({
          ok: true,
          json: () =>
            new Promise((_resolve, reject) => {
              requestSignal?.addEventListener(
                'abort',
                () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
                { once: true },
              );
            }),
        });
      }),
    );

    const pending = startSession(cfg, 'JWT', { meetingId, deviceId: 'dev1', language: 'tr' }, 'IK');
    const rejection = expect(pending).rejects.toThrow('startSession timed out after 15000ms');
    await vi.advanceTimersByTimeAsync(15_000);

    await rejection;
    expect(requestSignal?.aborted).toBe(true);
  });

  it('sendChunk posts byte body with strict sequence headers', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const bytes = new Uint8Array([1, 2, 3, 4]);
    await sendChunk(cfg, 'JWT', 'SES-9', { seq: 0, bytes, startedAtMs: 10 }, 'IK');

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://gw.example.com/api/v1/audio-gateway/sessions/SES-9/chunks');
    expect(opts.headers['X-Audio-Chunk-Seq']).toBe('0');
    expect(opts.headers['X-Audio-Byte-Length']).toBe('4');
    expect(opts.headers['X-Audio-Format']).toBe('PCM16');
    expect(opts.headers['X-Audio-Sample-Rate-Hz']).toBe('16000');
    expect(opts.headers['X-Audio-Channels']).toBe('1');
    expect(Array.from(new Uint8Array(opts.body as ArrayBuffer))).toEqual(Array.from(bytes));
  });

  it('finishSession posts finish request', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        sessionId: 'SES-9',
        correlationId: 'corr-1',
        finalState: 'FINISHED',
        finishedAtMs: 1781820000000,
        alreadyFinished: false,
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    await finishSession(cfg, 'JWT', 'SES-9', 'IK');
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://gw.example.com/api/v1/audio-gateway/sessions/SES-9/finish',
    );
  });

  it('rejects an unconfirmed finish response body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          sessionId: 'SES-other',
          correlationId: 'corr-1',
          finalState: 'FINISHED',
          finishedAtMs: 1781820000000,
          alreadyFinished: false,
        }),
      }),
    );

    await expect(finishSession(cfg, 'JWT', 'SES-9', 'IK')).rejects.toThrow('sessionId mismatch');
  });

  it('readTranscriptEvents sends bearer token and cursor params', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        sessionId: 'SES-9',
        correlationId: 'corr-1',
        events: [
          {
            eventId: '1680000000000-0',
            sessionId: 'SES-9',
            meetingId,
            chunkSeq: 1,
            chunkStartedAtMs: 1781820000000,
            text: 'merhaba',
            textLength: 7,
            status: 'DRAFT',
          },
        ],
        nextCursor: '1680000000000-0',
        hasMore: false,
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const page = await readTranscriptEvents(cfg, 'JWT', 'SES-9', {
      after: '1679999999999-0',
      limit: 10,
    });

    expect(page.events[0].text).toBe('merhaba');
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://gw.example.com/api/v1/audio-gateway/sessions/SES-9/transcript-events?after=1679999999999-0&limit=10',
    );
    expect(opts.headers.Authorization).toBe('Bearer JWT');
    expect(opts.headers.Accept).toBe('application/json');
  });

  it('uses a longer timeout for transcript long-poll reads', async () => {
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          sessionId: 'SES-9',
          correlationId: 'corr-1',
          events: [],
          nextCursor: null,
          hasMore: false,
        }),
      }),
    );

    await readTranscriptEvents(cfg, 'JWT', 'SES-9');

    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 25_000);
  });

  it('streamTranscriptEvents parses SSE transcript chunks and advances cursor', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            ': heartbeat\n\n' +
              'id: 1680000000000-0\n' +
              'event: transcript-chunk\n' +
              `data: ${JSON.stringify({
                eventId: '1680000000000-0',
                sessionId: 'SES-9',
                meetingId,
                chunkSeq: 2,
                chunkStartedAtMs: 1781820000200,
                text: 'merhaba dunya',
                textLength: 13,
                status: 'DRAFT',
              })}\n\n`,
          ),
        );
        controller.close();
      },
    });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, body });
    vi.stubGlobal('fetch', fetchMock);
    const onEvent = vi.fn();
    const onCursor = vi.fn();

    await streamTranscriptEvents(cfg, 'JWT', 'SES-9', {
      after: '1679999999999-0',
      onEvent,
      onCursor,
    });

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: '1680000000000-0', text: 'merhaba dunya' }),
    );
    expect(onCursor).toHaveBeenCalledWith('1680000000000-0');
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://gw.example.com/api/v1/audio-gateway/sessions/SES-9/transcript-events/stream?after=1679999999999-0',
    );
    expect(opts.headers.Authorization).toBe('Bearer JWT');
    expect(opts.headers.Accept).toBe('text/event-stream');
  });

  it('throws status on non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 502 }));
    await expect(finishSession(cfg, 'JWT', 'SES-9', 'IK')).rejects.toThrow('502');
  });

  it('sanitizes JSON error body and does not expose message or details', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        headers: { get: () => 'application/json' },
        text: async () =>
          JSON.stringify({
            code: 'AUDIO_GATEWAY_MEETING_FORBIDDEN',
            message: 'JWT missing required claim tenantId for user@example.com',
            correlationId: 'corr-123',
            retryable: false,
            details: { meetingId: 'sensitive-meeting-id' },
          }),
      }),
    );

    let message = '';
    try {
      await startSession(cfg, 'JWT', { meetingId, deviceId: 'dev1', language: 'tr' }, 'IK');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toBe(
      'startSession failed: 403 code=AUDIO_GATEWAY_MEETING_FORBIDDEN correlationId=corr-123 retryable=false',
    );
    expect(message).not.toContain('user@example.com');
    expect(message).not.toContain('sensitive-meeting-id');
  });

  it('redacts code/correlationId that do not match safe patterns', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        headers: { get: () => 'application/json' },
        text: async () =>
          JSON.stringify({
            code: 'some <script>alert(1)</script> injection',
            correlationId: 'x'.repeat(200),
          }),
      }),
    );

    let message = '';
    try {
      await startSession(cfg, 'JWT', { meetingId, deviceId: 'dev1', language: 'tr' }, 'IK');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toBe('startSession failed: 500');
    expect(message).not.toContain('script');
    expect(message).not.toContain('x'.repeat(200));
  });
});
