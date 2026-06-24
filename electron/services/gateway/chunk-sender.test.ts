import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChunkSender } from './chunk-sender';
import { loadGatewayConfig } from './gateway-client';

const cfg = loadGatewayConfig({ GATEWAY_BASE_URL: 'https://gw.example.com' });
const meetingId = '22222222-2222-4222-8222-222222222222';
const otherMeetingId = '33333333-3333-4333-8333-333333333333';

function mockFetch() {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.endsWith('/sessions')) {
      return { ok: true, json: async () => ({ sessionId: 'SES-1' }) };
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
        return { ok: true, json: async () => ({ sessionId: 'SES-1' }) };
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
