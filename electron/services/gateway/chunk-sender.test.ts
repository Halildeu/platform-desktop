import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChunkSender } from './chunk-sender';
import { loadGatewayConfig } from './gateway-client';

const cfg = loadGatewayConfig({ GATEWAY_BASE_URL: 'https://gw.example.com' });

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
    const id = await sender.start('MTG-2026-0001', 'dev1');
    expect(id).toBe('SES-1');
    expect(sender.getState()).toBe('active');
    expect(sender.nextSeq()).toBe(0);
  });

  it('send: seq 0,1,2 strict-contiguous artar', async () => {
    mockFetch();
    await sender.start('MTG-2026-0001', 'dev1');
    expect(await sender.send(new Uint8Array([1]), 10)).toBe(0);
    expect(await sender.send(new Uint8Array([2]), 20)).toBe(1);
    expect(await sender.send(new Uint8Array([3]), 30)).toBe(2);
    expect(sender.nextSeq()).toBe(3);
  });

  it('finish: active → finished', async () => {
    mockFetch();
    await sender.start('MTG-2026-0001', 'dev1');
    await sender.finish();
    expect(sender.getState()).toBe('finished');
  });

  it('send before start → throw', async () => {
    await expect(sender.send(new Uint8Array([1]), 0)).rejects.toThrow('no active session');
  });

  it('double start → throw', async () => {
    mockFetch();
    await sender.start('MTG-2026-0001', 'dev1');
    await expect(sender.start('MTG-2026-0002', 'dev1')).rejects.toThrow('already active');
  });

  it('getJwt lazily çağrılır (login gelince gerçek token)', async () => {
    const getJwt = vi.fn(() => 'JWT');
    const s = new ChunkSender(cfg, getJwt);
    mockFetch();
    await s.start('MTG-2026-0001', 'dev1');
    await s.send(new Uint8Array([1]), 0);
    expect(getJwt).toHaveBeenCalled();
  });
});
