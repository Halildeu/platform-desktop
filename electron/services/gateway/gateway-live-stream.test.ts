import { afterEach, describe, expect, it, vi } from 'vitest';

import { GATEWAY_LIVE_AUDIO_FRAME_HEADER_BYTES, GatewayLiveStream } from './gateway-live-stream';

class FakeSocket {
  readyState = 0;
  bufferedAmount = 0;
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
    sockets[0].message(JSON.stringify({ type: 'audio_ack', chunk_seq: 0 }));

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
    sockets[0].message(JSON.stringify({ type: 'audio_ack', chunk_seq: 0 }));

    const stopped = stream.stop();
    sockets[0].message(JSON.stringify({ type: 'eof_ack' }));
    await vi.advanceTimersByTimeAsync(8_000);
    await expect(stopped).resolves.toEqual({
      state: 'degraded',
      reason: 'timeout',
      acknowledged: false,
    });
  });

  it('replays unacknowledged REST-accepted frames after reconnect, including handshake audio', async () => {
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
    sockets[0].message(JSON.stringify({ type: 'audio_ack', chunk_seq: 0 }));

    const staleClose = sockets[0].onclose;
    sockets[0].failClose();
    expect(stream.sendAfterRestAccepted(new Uint8Array([0, 0]), 1, 2)).toBe(false);
    await vi.advanceTimersByTimeAsync(250);
    await vi.runAllTicks();
    expect(sockets).toHaveLength(2);
    sockets[1].open();
    expect(stream.sendAfterRestAccepted(new Uint8Array([0, 0]), 2, 3)).toBe(false);
    sockets[1].message(JSON.stringify({ type: 'ready' }));
    await vi.runAllTicks();

    const replayedSequences = sockets[1].sent.map((frame) =>
      Number(new DataView(frame as ArrayBuffer).getBigInt64(1, false)),
    );
    expect(replayedSequences).toEqual([1, 2]);
    sockets[1].message(JSON.stringify({ type: 'audio_ack', chunk_seq: 1 }));
    sockets[1].message(JSON.stringify({ type: 'audio_ack', chunk_seq: 2 }));

    staleClose?.();
    expect(stream.sendAfterRestAccepted(new Uint8Array([0, 0]), 3, 4)).toBe(true);
    expect(new DataView(sockets[1].sent[2] as ArrayBuffer).getBigInt64(1, false)).toBe(3n);
    stream.close();
  });

  it('holds frames while the socket is backpressured and flushes below the low watermark', async () => {
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
    sockets[0].bufferedAmount = 512 * 1024;

    expect(stream.sendAfterRestAccepted(new Uint8Array([0, 0]), 0, 1)).toBe(false);
    expect(sockets[0].sent).toEqual([]);
    sockets[0].bufferedAmount = 128 * 1024;
    await vi.advanceTimersByTimeAsync(25);
    expect(sockets[0].sent).toHaveLength(1);
    stream.close();
  });

  it('fails live delivery visibly when the bounded replay buffer is exhausted', async () => {
    const sockets: FakeSocket[] = [];
    const onError = vi.fn();
    const stream = new GatewayLiveStream({
      cfg: { baseUrl: 'https://testai.acik.com' },
      sessionId: 'SES-1',
      getJwt: async () => 'JWT',
      onEvent: vi.fn(),
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
    sockets[0].message(JSON.stringify({ type: 'ready' }));
    await started;

    for (let sequence = 0; sequence < 32; sequence += 1) {
      expect(stream.sendAfterRestAccepted(new Uint8Array([0, 0]), sequence, sequence + 1)).toBe(
        true,
      );
    }
    expect(stream.sendAfterRestAccepted(new Uint8Array([0, 0]), 32, 33)).toBe(false);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('replay buffer is full') }),
    );
    await expect(stream.stop()).resolves.toEqual({
      state: 'degraded',
      reason: 'buffer-overflow',
      acknowledged: false,
    });
  });

  it('treats an upstream error event as a reconnectable socket failure', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const onError = vi.fn();
    const stream = new GatewayLiveStream({
      cfg: { baseUrl: 'https://testai.acik.com' },
      sessionId: 'SES-1',
      getJwt: async () => 'JWT',
      onEvent: vi.fn(),
      onError,
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
    sockets[0].message(JSON.stringify({ type: 'error', msg: 'upstream reset' }));

    await vi.advanceTimersByTimeAsync(250);
    await vi.runAllTicks();
    expect(sockets).toHaveLength(2);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'gateway live STT error: upstream reset' }),
    );
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
    sockets[0].message(JSON.stringify({ type: 'audio_ack', chunk_seq: 0 }));

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

  it('waits through model loading instead of cancelling it at the silence budget', async () => {
    // Faz 24 Bulgu 3-F: a cold STT model load takes minutes and is driven by
    // this very connection. A flat 10s budget cancelled it mid-flight, so the
    // load could never finish and no session could ever start. `loading`
    // frames are progress and must restart the silence window.
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const stream = new GatewayLiveStream({
      cfg: { baseUrl: 'https://testai.acik.com' },
      sessionId: 'SES-loading',
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
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0].open();

    // Well past the 10s silence budget, but progress keeps arriving.
    for (let elapsed = 0; elapsed < 40_000; elapsed += 8_000) {
      sockets[0].message(JSON.stringify({ type: 'loading', stage: 'live_model' }));
      await vi.advanceTimersByTimeAsync(8_000);
    }

    sockets[0].message(JSON.stringify({ type: 'ready' }));
    await expect(started).resolves.toBeUndefined();
    stream.close();
  });

  it('still fails when the upstream goes silent, even after loading progress', async () => {
    // Patience is bounded by silence, not removed: once frames stop, the
    // recorder must fail closed rather than hang.
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const stream = new GatewayLiveStream({
      cfg: { baseUrl: 'https://testai.acik.com' },
      sessionId: 'SES-silent',
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
    const assertion = expect(started).rejects.toThrow(/without progress/);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    sockets[0].open();
    sockets[0].message(JSON.stringify({ type: 'loading', stage: 'live_model' }));

    await vi.advanceTimersByTimeAsync(11_000);
    await assertion;
    stream.close();
  });
});
