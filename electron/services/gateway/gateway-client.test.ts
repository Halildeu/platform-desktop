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

describe('gateway-client (saf)', () => {
  it('loadGatewayConfig: sondaki slash temizlenir', () => {
    expect(cfg.baseUrl).toBe('https://gw.example.com');
  });

  it('URL kurucular: contract-v1 path', () => {
    const base = 'https://gw.example.com/api/v1/audio-gateway';
    expect(sessionsUrl(cfg)).toBe(`${base}/sessions`);
    expect(chunksUrl(cfg, 'SES-1')).toBe(`${base}/sessions/SES-1/chunks`);
    expect(finishUrl(cfg, 'SES-1')).toBe(`${base}/sessions/SES-1/finish`);
  });

  it('chunkHeaders: seq + started-at + byte-length + octet-stream', () => {
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

  it('newIdempotencyKey: 32 hex char, benzersiz', () => {
    const a = newIdempotencyKey();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(newIdempotencyKey());
  });
});

describe('gateway-client (HTTP — fetch mock)', () => {
  it('startSession: POST /sessions + JWT + PCM16/16k/mono body', async () => {
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

  it('sendChunk: POST /chunks + sıra header + byte body', async () => {
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

  it('finishSession: POST /finish', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    await finishSession(cfg, 'JWT', 'SES-9', 'IK');
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://gw.example.com/api/v1/audio-gateway/sessions/SES-9/finish',
    );
  });

  it('hata: res.ok false → throw', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 502 }));
    await expect(finishSession(cfg, 'JWT', 'SES-9', 'IK')).rejects.toThrow('502');
  });
});
