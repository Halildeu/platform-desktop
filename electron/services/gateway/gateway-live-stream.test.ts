import { afterEach, describe, expect, it, vi } from 'vitest';

import { GATEWAY_LIVE_AUDIO_FRAME_HEADER_BYTES, GatewayLiveStream } from './gateway-live-stream';

class FakeSocket {
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  readonly sent: Array<string | ArrayBuffer | ArrayBufferView> = [];

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  message(data: string): void {
    this.onmessage?.({ data });
  }

  failClose(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }
}

async function waitForSocket(sockets: FakeSocket[], count: number): Promise<void> {
  await vi.waitFor(() => expect(sockets).toHaveLength(count));
}

afterEach(() => {
  vi.useRealTimers();
});

describe('GatewayLiveStream', () => {
  it('keeps bearer in the main-process handshake and sends the backend v1 frame', async () => {
    const sockets: FakeSocket[] = [];
    const handshakes: Array<{ url: string; jwt: string }> = [];
    const stream = new GatewayLiveStream({
      cfg: { baseUrl: 'https://testai.acik.com' },
      sessionId: 'SES-1',
      getJwt: async () => 'JWT',
      onEvent: vi.fn(),
      onError: vi.fn(),
      socketFactory: (url, jwt) => {
        handshakes.push({ url, jwt });
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    const started = stream.start();
    await waitForSocket(sockets, 1);
    sockets[0].open();
    sockets[0].message(JSON.stringify({ type: 'ready' }));
    await started;

    expect(handshakes).toEqual([
      {
        url: 'wss://testai.acik.com/api/v1/audio-gateway/sessions/SES-1/stream',
        jwt: 'JWT',
      },
    ]);
    expect(stream.sendAfterRestAccepted(new Uint8Array([0x34, 0x12]), 0, 123)).toBe(true);
    const frame = sockets[0].sent[0] as ArrayBuffer;
    const view = new DataView(frame);
    expect(view.getUint8(0)).toBe(1);
    expect(view.getBigInt64(1, false)).toBe(0n);
    expect(view.getBigInt64(9, false)).toBe(123n);
    expect(view.getUint16(17, false)).toBe(2);
    expect(Array.from(new Uint8Array(frame, GATEWAY_LIVE_AUDIO_FRAME_HEADER_BYTES))).toEqual([
      0x34, 0x12,
    ]);
    stream.close();
  });

  it('sends EOF only after capability advertisement and drains only after terminal drained', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const stream = new GatewayLiveStream({
      cfg: { baseUrl: 'https://testai.acik.com' },
      sessionId: 'SES-1',
      getJwt: async () => 'JWT',
      onEvent: vi.fn(),
      onError: vi.fn(),
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    const started = stream.start();
    await vi.runAllTicks();
    sockets[0].open();
    sockets[0].message(JSON.stringify({ type: 'ready', supports_eof: true }));
    await started;
    stream.sendAfterRestAccepted(new Uint8Array([0, 0]), 0, 1);

    const stopped = stream.stop();
    expect(sockets[0].sent.at(-1)).toBe(JSON.stringify({ type: 'eof' }));
    sockets[0].message(JSON.stringify({ type: 'eof_ack' }));
    await vi.advanceTimersByTimeAsync(1_250);
    let settled = false;
    void stopped.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    sockets[0].message(JSON.stringify({ type: 'drained' }));
    await expect(stopped).resolves.toEqual({
      state: 'drained',
      reason: 'drained',
      acknowledged: true,
    });
  });

  it('does not treat eof_ack without drained as terminal success', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const stream = new GatewayLiveStream({
      cfg: { baseUrl: 'https://testai.acik.com' },
      sessionId: 'SES-1',
      getJwt: async () => 'JWT',
      onEvent: vi.fn(),
      onError: vi.fn(),
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    const started = stream.start();
    await vi.runAllTicks();
    sockets[0].open();
    sockets[0].message(JSON.stringify({ type: 'ready', supports_eof: true }));
    await started;
    stream.sendAfterRestAccepted(new Uint8Array([0, 0]), 0, 1);

    const stopped = stream.stop();
    sockets[0].message(JSON.stringify({ type: 'eof_ack' }));
    await vi.advanceTimersByTimeAsync(8_000);
    await expect(stopped).resolves.toEqual({
      state: 'degraded',
      reason: 'timeout',
      acknowledged: false,
    });
  });

  it('reconnects from the REST sequence baseline without replaying skipped chunks', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const stream = new GatewayLiveStream({
      cfg: { baseUrl: 'https://testai.acik.com' },
      sessionId: 'SES-1',
      getJwt: async () => 'JWT',
      onEvent: vi.fn(),
      onError: vi.fn(),
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    const started = stream.start();
    await vi.runAllTicks();
    sockets[0].open();
    sockets[0].message(JSON.stringify({ type: 'ready' }));
    await started;
    expect(stream.sendAfterRestAccepted(new Uint8Array([0, 0]), 0, 1)).toBe(true);

    sockets[0].failClose();
    expect(stream.sendAfterRestAccepted(new Uint8Array([0, 0]), 1, 2)).toBe(false);
    await vi.advanceTimersByTimeAsync(250);
    await vi.runAllTicks();
    expect(sockets).toHaveLength(2);
    sockets[1].open();
    sockets[1].message(JSON.stringify({ type: 'ready' }));
    await vi.runAllTicks();

    expect(stream.sendAfterRestAccepted(new Uint8Array([0, 0]), 2, 3)).toBe(true);
    const frame = sockets[1].sent[0] as ArrayBuffer;
    expect(new DataView(frame).getBigInt64(1, false)).toBe(2n);
    stream.close();
  });

  it('returns a bounded degraded result when an acknowledged stop never arrives', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const stream = new GatewayLiveStream({
      cfg: { baseUrl: 'https://testai.acik.com' },
      sessionId: 'SES-1',
      getJwt: async () => 'JWT',
      onEvent: vi.fn(),
      onError: vi.fn(),
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    const started = stream.start();
    await vi.runAllTicks();
    sockets[0].open();
    sockets[0].message(JSON.stringify({ type: 'ready', capabilities: ['eof'] }));
    await started;
    stream.sendAfterRestAccepted(new Uint8Array([0, 0]), 0, 1);

    const stopped = stream.stop();
    await vi.advanceTimersByTimeAsync(8_000);
    await expect(stopped).resolves.toEqual({
      state: 'degraded',
      reason: 'timeout',
      acknowledged: false,
    });
  });

  it('does not claim a drained stop when EOF capability is unavailable', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const stream = new GatewayLiveStream({
      cfg: { baseUrl: 'https://testai.acik.com' },
      sessionId: 'SES-1',
      getJwt: async () => 'JWT',
      onEvent: vi.fn(),
      onError: vi.fn(),
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    const started = stream.start();
    await vi.runAllTicks();
    sockets[0].open();
    sockets[0].message(JSON.stringify({ type: 'ready' }));
    await started;
    stream.sendAfterRestAccepted(new Uint8Array([0, 0]), 0, 1);

    const stopped = stream.stop();
    await vi.advanceTimersByTimeAsync(1_250);
    await expect(stopped).resolves.toEqual({
      state: 'degraded',
      reason: 'quiet',
      acknowledged: false,
    });
  });

  it('rejects malformed server events without invoking the transcript callback', async () => {
    const sockets: FakeSocket[] = [];
    const onEvent = vi.fn();
    const onError = vi.fn();
    const stream = new GatewayLiveStream({
      cfg: { baseUrl: 'https://testai.acik.com' },
      sessionId: 'SES-1',
      getJwt: async () => 'JWT',
      onEvent,
      onError,
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    const started = stream.start();
    await waitForSocket(sockets, 1);
    sockets[0].open();
    sockets[0].message(JSON.stringify({ type: 'partial', seq: 0, confirmed: 42 }));
    expect(onEvent).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'gateway live stream returned an invalid event' }),
    );

    sockets[0].message(JSON.stringify({ type: 'ready' }));
    await started;
    stream.close();
  });
});
