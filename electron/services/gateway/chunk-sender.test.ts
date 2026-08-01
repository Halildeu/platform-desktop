import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChunkSender } from './chunk-sender';
import { loadGatewayConfig } from './gateway-client';

const cfg = loadGatewayConfig({ GATEWAY_BASE_URL: 'https://gw.example.com' });
const meetingId = '22222222-2222-4222-8222-222222222222';
const otherMeetingId = '33333333-3333-4333-8333-333333333333';

function mockFetch() {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith('/sessions')) {
      return { ok: true, json: async () => ({ sessionId: 'SES-1', sttProvider: 'internal' }) };
    }
    if (url.endsWith('/finish')) {
      return {
        ok: true,
        json: async () => ({
          sessionId: 'SES-1',
          correlationId: 'corr-1',
          finalState: 'FINISHED',
          finishedAtMs: 1781820000000,
          alreadyFinished: false,
        }),
      };
    }
    return { ok: true };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ChunkSender (seq state machine)', () => {
  let sender: ChunkSender;
  beforeEach(() => {
    sender = new ChunkSender(cfg, () => 'JWT');
  });

  it('start: idle → active + sessionId', async () => {
    mockFetch();
    expect(sender.getState()).toBe('idle');
    const id = await sender.start(meetingId, 'dev1');
    expect(id).toBe('SES-1');
    expect(sender.getState()).toBe('active');
    expect(sender.nextSeq()).toBe(0);
  });

  it('retries an ambiguous start timeout with the same idempotency key', async () => {
    const idempotencyKeys: string[] = [];
    const fetchMock = vi.fn(async (url: string, opts?: RequestInit) => {
      if (!url.endsWith('/sessions')) {
        return { ok: true };
      }
      idempotencyKeys.push((opts?.headers as Record<string, string>)['Idempotency-Key']);
      if (idempotencyKeys.length === 1) {
        throw Object.assign(new Error('startSession timed out after 15000ms'), {
          name: 'TimeoutError',
        });
      }
      return {
        ok: true,
        json: async () => ({ sessionId: 'SES-recovered', sttProvider: 'internal' }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(sender.start(meetingId, 'dev1')).resolves.toBe('SES-recovered');
    expect(idempotencyKeys).toHaveLength(2);
    expect(idempotencyKeys[0]).toBe(idempotencyKeys[1]);
    expect(sender.getState()).toBe('active');
  });

  it('does not retry a definite gateway start rejection', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 403,
      headers: { get: () => 'application/json' },
      text: async () => JSON.stringify({ code: 'AUDIO_GATEWAY_MEETING_FORBIDDEN' }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(sender.start(meetingId, 'dev1')).rejects.toMatchObject({
      name: 'GatewaySessionStartRejectedError',
      status: 403,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sender.getState()).toBe('idle');
  });

  it('retries gateway 5xx with the same key and keeps the outcome ambiguous', async () => {
    const idempotencyKeys: string[] = [];
    const fetchMock = vi.fn(async (_url: string, opts?: RequestInit) => {
      idempotencyKeys.push((opts?.headers as Record<string, string>)['Idempotency-Key']);
      return {
        ok: false,
        status: 503,
        headers: { get: () => 'application/json' },
        text: async () => JSON.stringify({ code: 'AUDIO_GATEWAY_UNAVAILABLE' }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(sender.start(meetingId, 'dev1')).rejects.toMatchObject({
      name: 'AmbiguousGatewaySessionStartError',
    });
    expect(idempotencyKeys).toHaveLength(2);
    expect(idempotencyKeys[0]).toBe(idempotencyKeys[1]);
    expect(sender.getState()).toBe('idle');
  });

  it('send: seq 0,1,2 strict-contiguous artar', async () => {
    mockFetch();
    await sender.start(meetingId, 'dev1');
    expect(await sender.send(new Uint8Array([1]), 10)).toBe(0);
    expect(await sender.send(new Uint8Array([2]), 20)).toBe(1);
    expect(await sender.send(new Uint8Array([3]), 30)).toBe(2);
    expect(sender.nextSeq()).toBe(3);
  });

  it('send: paralel çağrılar seq değerlerini seri ve benzersiz üretir', async () => {
    const seenSeq: string[] = [];
    const fetchMock = vi.fn(async (url: string, opts?: RequestInit) => {
      if (url.endsWith('/sessions')) {
        return { ok: true, json: async () => ({ sessionId: 'SES-1', sttProvider: 'internal' }) };
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 5);
      });
      const headers = opts?.headers as Record<string, string>;
      seenSeq.push(headers['X-Audio-Chunk-Seq']);
      return { ok: true };
    });
    vi.stubGlobal('fetch', fetchMock);

    await sender.start(meetingId, 'dev1');
    const result = await Promise.all([
      sender.send(new Uint8Array([1]), 10),
      sender.send(new Uint8Array([2]), 20),
    ]);

    expect(result).toEqual([0, 1]);
    expect(seenSeq).toEqual(['0', '1']);
    expect(sender.nextSeq()).toBe(2);
  });

  it('finish: active → finished', async () => {
    mockFetch();
    await sender.start(meetingId, 'dev1');
    await sender.finish();
    expect(sender.getState()).toBe('finished');
  });

  it('uses the caller-owned idempotency key for gateway finish', async () => {
    const finishKeys: string[] = [];
    const fetchMock = vi.fn(async (url: string, opts?: RequestInit) => {
      if (url.endsWith('/sessions')) {
        return { ok: true, json: async () => ({ sessionId: 'SES-1', sttProvider: 'internal' }) };
      }
      if (url.endsWith('/finish')) {
        finishKeys.push((opts?.headers as Record<string, string>)['Idempotency-Key']);
        return {
          ok: true,
          json: async () => ({
            sessionId: 'SES-1',
            correlationId: 'corr-1',
            finalState: 'FINISHED',
            finishedAtMs: 1781820000000,
            alreadyFinished: false,
          }),
        };
      }
      return { ok: true };
    });
    vi.stubGlobal('fetch', fetchMock);

    await sender.start(meetingId, 'dev1');
    await sender.finish('0123456789abcdef0123456789abcdef');

    expect(finishKeys).toEqual(['0123456789abcdef0123456789abcdef']);
  });

  it('send before start → throw', async () => {
    await expect(sender.send(new Uint8Array([1]), 0)).rejects.toThrow('no active session');
  });

  it('double start → throw', async () => {
    mockFetch();
    await sender.start(meetingId, 'dev1');
    await expect(sender.start(otherMeetingId, 'dev1')).rejects.toThrow('already active');
  });

  it('getJwt lazily çağrılır (login gelince gerçek token)', async () => {
    const getJwt = vi.fn(() => 'JWT');
    const s = new ChunkSender(cfg, getJwt);
    mockFetch();
    await s.start(meetingId, 'dev1');
    await s.send(new Uint8Array([1]), 0);
    expect(getJwt).toHaveBeenCalled();
  });
});
