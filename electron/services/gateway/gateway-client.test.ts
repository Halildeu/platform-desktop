import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  chunkHeaders,
  chunksUrl,
  finishSession,
  finishUrl,
  loadGatewayConfig,
  newIdempotencyKey,
  sendChunk,
  sessionsUrl,
  startSession,
} from './gateway-client';

const cfg = loadGatewayConfig({ GATEWAY_BASE_URL: 'https://gw.example.com/' });

afterEach(() => {
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
    expect(sessionsUrl(cfg)).toBe(`${base}/sessions`);
    expect(chunksUrl(cfg, 'SES-1')).toBe(`${base}/sessions/SES-1/chunks`);
    expect(finishUrl(cfg, 'SES-1')).toBe(`${base}/sessions/SES-1/finish`);
  });

  it('chunkHeaders include seq, started-at, byte-length and octet-stream', () => {
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
    expect(h['Content-Type']).toBe('application/octet-stream');
  });

  it('newIdempotencyKey returns unique 32-char hex values', () => {
    const a = newIdempotencyKey();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(newIdempotencyKey());
  });
});

describe('gateway-client HTTP fetch wrapper', () => {
  it('startSession posts session metadata as PCM16/16k/mono', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ sessionId: 'SES-9', chunkUploadUrl: '/c', finishUrl: '/f' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const info = await startSession(
      cfg,
      'JWT',
      { meetingId: 'MTG-2026-0042', deviceId: 'dev1', language: 'tr' },
      'IK',
    );
    expect(info.sessionId).toBe('SES-9');

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://gw.example.com/api/v1/audio-gateway/sessions');
    expect(opts.headers.Authorization).toBe('Bearer JWT');
    const body = JSON.parse(opts.body as string);
    expect(body).toMatchObject({
      meetingId: 'MTG-2026-0042',
      audioFormat: 'PCM16',
      sampleRateHz: 16000,
      channels: 1,
    });
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
    expect(opts.body).toBe(bytes);
  });

  it('finishSession posts finish request', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    await finishSession(cfg, 'JWT', 'SES-9', 'IK');
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://gw.example.com/api/v1/audio-gateway/sessions/SES-9/finish',
    );
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
            details: { meetingId: 'MTG-SECRET' },
          }),
      }),
    );

    let message = '';
    try {
      await startSession(
        cfg,
        'JWT',
        { meetingId: 'MTG-2026-0042', deviceId: 'dev1', language: 'tr' },
        'IK',
      );
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }

    expect(message).toBe(
      'startSession failed: 403 code=AUDIO_GATEWAY_MEETING_FORBIDDEN correlationId=corr-123 retryable=false',
    );
    expect(message).not.toContain('user@example.com');
    expect(message).not.toContain('MTG-SECRET');
  });
});
