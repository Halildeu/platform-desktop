import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CHUNK_OUTAGE_BUDGET_MS, type ChunkDeliveryStatus, ChunkSender } from './chunk-sender';
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

describe('ChunkSender outage recovery (#138)', () => {
  type ChunkReply = 'ok' | 'timeout' | 'network' | number;

  function outageHarness(replies: ChunkReply[], jwts: string[] = ['JWT']) {
    const chunkCalls: Array<{ seq: string; key: string; auth: string; body: number[] }> = [];
    const statuses: ChunkDeliveryStatus[] = [];
    let clock = 0;
    const fetchMock = vi.fn(async (url: string, opts?: RequestInit) => {
      if (url.endsWith('/sessions')) {
        return { ok: true, json: async () => ({ sessionId: 'SES-1', sttProvider: 'internal' }) };
      }
      const headers = opts?.headers as Record<string, string>;
      chunkCalls.push({
        seq: headers['X-Audio-Chunk-Seq'],
        key: headers['Idempotency-Key'],
        auth: headers.Authorization,
        body: Array.from(new Uint8Array(opts?.body as ArrayBuffer)),
      });
      const reply = replies.shift() ?? 'ok';
      if (reply === 'timeout') {
        throw Object.assign(new Error('sendChunk timed out after 15000ms'), {
          name: 'TimeoutError',
        });
      }
      if (reply === 'network') {
        throw new TypeError('fetch failed');
      }
      if (typeof reply === 'number') {
        return {
          ok: false,
          status: reply,
          headers: { get: () => 'application/json' },
          text: async () => JSON.stringify({ code: 'AUDIO_GATEWAY_TEST' }),
        };
      }
      return { ok: true };
    });
    vi.stubGlobal('fetch', fetchMock);
    let jwtIndex = 0;
    const sender = new ChunkSender(cfg, () => jwts[Math.min(jwtIndex++, jwts.length - 1)], {
      onDeliveryStatus: (status) => statuses.push(status),
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    return { sender, chunkCalls, statuses };
  }

  it('replays a timed-out chunk with the same seq, key and bytes, then continues', async () => {
    const { sender, chunkCalls, statuses } = outageHarness(['timeout', 'timeout', 'ok']);
    await sender.start(meetingId, 'dev1');

    await expect(sender.send(new Uint8Array([7, 7]), 10)).resolves.toBe(0);
    await expect(sender.send(new Uint8Array([8, 8]), 20)).resolves.toBe(1);

    expect(chunkCalls.map((call) => call.seq)).toEqual(['0', '0', '0', '1']);
    expect(new Set(chunkCalls.slice(0, 3).map((call) => call.key)).size).toBe(1);
    expect(chunkCalls[3].key).not.toBe(chunkCalls[0].key);
    expect(chunkCalls.slice(0, 3).every((call) => call.body.join() === '7,7')).toBe(true);
    expect(statuses.map((status) => status.state)).toEqual(['retrying', 'retrying', 'recovered']);
    expect(statuses[2]).toMatchObject({ sessionId: 'SES-1', seq: 0, attempts: 3 });
  });

  it('rides out a DNS/connection outage and a transient 503', async () => {
    const { sender, chunkCalls } = outageHarness(['network', 'network', 503, 'ok']);
    await sender.start(meetingId, 'dev1');

    await expect(sender.send(new Uint8Array([1]), 10)).resolves.toBe(0);
    expect(chunkCalls.every((call) => call.seq === '0')).toBe(true);
  });

  it('does not replay a definite rejection such as an out-of-order 409', async () => {
    const { sender, chunkCalls, statuses } = outageHarness([409]);
    await sender.start(meetingId, 'dev1');

    await expect(sender.send(new Uint8Array([1]), 10)).rejects.toMatchObject({
      name: 'GatewayChunkRejectedError',
      status: 409,
    });
    expect(chunkCalls).toHaveLength(1);
    expect(statuses).toEqual([]);
    await expect(sender.send(new Uint8Array([2]), 20)).rejects.toMatchObject({ status: 409 });
    expect(chunkCalls).toHaveLength(1);
  });

  it('gives up once the outage budget is spent and stays failed', async () => {
    const { sender, chunkCalls } = outageHarness(Array<ChunkReply>(200).fill('timeout'));
    await sender.start(meetingId, 'dev1');

    await expect(sender.send(new Uint8Array([1]), 10)).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    const attempts = chunkCalls.length;
    // 1s + 2s + 4s, then 5s steps: bounded by CHUNK_OUTAGE_BUDGET_MS.
    expect(attempts).toBe(Math.floor((CHUNK_OUTAGE_BUDGET_MS - 7_000) / 5_000) + 4);
    await expect(sender.send(new Uint8Array([2]), 20)).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    expect(chunkCalls).toHaveLength(attempts);
  });

  it('refreshes the token once on 401 but does not loop on repeated 401', async () => {
    // The first token is consumed by session start.
    const recovered = outageHarness([401, 'ok'], ['START', 'OLD', 'NEW']);
    await recovered.sender.start(meetingId, 'dev1');
    await expect(recovered.sender.send(new Uint8Array([1]), 10)).resolves.toBe(0);
    expect(recovered.chunkCalls.map((call) => call.auth)).toEqual(['Bearer OLD', 'Bearer NEW']);

    const denied = outageHarness([401, 401, 'ok']);
    await denied.sender.start(meetingId, 'dev1');
    await expect(denied.sender.send(new Uint8Array([1]), 10)).rejects.toMatchObject({
      status: 401,
    });
    expect(denied.chunkCalls).toHaveLength(2);
  });
});

describe('session-start dictionary (Faz 24 gitops#3435 dilim-3)', () => {
  it('sends contextTerms in the session-start body so Speechmatics can bias', async () => {
    const bodies: unknown[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({
          sessionId: 's-1',
          sttProvider: 'speechmatics',
          transcriptionMode: 'realtime',
        }),
        {
          status: 201,
          headers: { 'content-type': 'application/json' },
        },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const sender = new ChunkSender({ baseUrl: 'https://gw.example.com' }, async () => 'jwt');
    await sender.start('m-1', 'd-1', 'tr', 'idem-1', 'speechmatics', 'realtime', [
      'Sevil Karakaş',
      'Sergen Bediroğlu',
    ]);

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      sttProvider: 'speechmatics',
      contextTerms: ['Sevil Karakaş', 'Sergen Bediroğlu'],
    });
  });

  it('omits contextTerms entirely when the user has no dictionary', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({
          sessionId: 's-2',
          sttProvider: 'internal',
          transcriptionMode: 'balanced',
        }),
        {
          status: 201,
          headers: { 'content-type': 'application/json' },
        },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const sender = new ChunkSender({ baseUrl: 'https://gw.example.com' }, async () => 'jwt');
    await sender.start('m-1', 'd-1', 'tr', 'idem-2');

    // Boş sözlükte istek şekli birebir eski hâlinde kalmalı — sunucuya
    // anlamsız bir `contextTerms: []` göndermiyoruz.
    expect(bodies[0]).not.toHaveProperty('contextTerms');
  });
});
