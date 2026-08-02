import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  GATEWAY_LIVE_AUDIO_FRAME_HEADER_BYTES,
  GATEWAY_LIVE_STREAM_OPEN_MAX_WAIT_MS,
  GatewayLiveStream,
  normalizeGatewayLiveContextTerms,
  type GatewayLiveDeliverySummary,
} from './gateway-live-stream';

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

/** Chunk sequence carried in the v1 binary frame header. */
function frameSeq(data: string | ArrayBuffer | ArrayBufferView): number {
  return Number(new DataView(data as ArrayBuffer).getBigInt64(1, false));
}

function liveDelivery(
  overrides: Partial<GatewayLiveDeliverySummary> = {},
): GatewayLiveDeliverySummary {
  return {
    scope: 'live-preview',
    coverage: 'complete',
    recovered: false,
    recoveryEpisodeCount: 0,
    recoveredEpisodeCount: 0,
    droppedFrameCount: 0,
    droppedAudioBytes: 0,
    firstDroppedSequence: null,
    lastDroppedSequence: null,
    causes: [],
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('GatewayLiveStream', () => {
  it('normalizes bounded context without retaining duplicates or unsafe terms', () => {
    expect(
      normalizeGatewayLiveContextTerms(['  Çağrı   Öztürk ', 'çağrı öztürk', 'Proje-24']),
    ).toEqual(['Çağrı Öztürk', 'Proje-24']);
    expect(() => normalizeGatewayLiveContextTerms(['unsafe/'])).toThrow(
      'gateway live context term is invalid',
    );
    expect(() => normalizeGatewayLiveContextTerms(['line\u0000feed'])).toThrow(
      'gateway live context term is invalid',
    );
  });

  it('keeps bearer in the main-process handshake and sends the backend v1 frame', async () => {
    const sockets: FakeSocket[] = [];
    const handshakes: Array<{ url: string; jwt: string }> = [];
    const stream = new GatewayLiveStream({
      cfg: { baseUrl: 'https://testai.acik.com' },
      sessionId: 'SES-1',
      contextTerms: ['  Çağrı   Öztürk ', 'Proje-24'],
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
    sockets[0].message(
      JSON.stringify({ type: 'ready', capabilities: ['eof', 'source-ranges-v1', 'context-v1'] }),
    );
    await started;

    expect(handshakes).toEqual([
      {
        url: 'wss://testai.acik.com/api/v1/audio-gateway/sessions/SES-1/stream',
        jwt: 'JWT',
      },
    ]);
    expect(stream.sendAfterRestAccepted(new Uint8Array([0x34, 0x12]), 0, 123)).toBe(true);
    expect(sockets[0].sent[0]).toBe('{"type":"context","terms":["Çağrı Öztürk","Proje-24"]}');
    const frame = sockets[0].sent[1] as ArrayBuffer;
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

  it('assigns contiguous gateway sequences to realtime frames independently of REST chunks', async () => {
    const sockets: FakeSocket[] = [];
    const stream = new GatewayLiveStream({
      cfg: { baseUrl: 'https://testai.acik.com' },
      sessionId: 'SES-REALTIME',
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
    await waitForSocket(sockets, 1);
    sockets[0].open();
    sockets[0].message(JSON.stringify({ type: 'ready', supports_eof: true }));
    await started;

    expect(stream.sendRealtimeFrame(new Uint8Array([0, 0]), 100)).toBe(true);
    expect(stream.sendRealtimeFrame(new Uint8Array([1, 0]), 200)).toBe(true);
    expect(sockets[0].sent.map(frameSeq)).toEqual([0, 1]);
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
    await vi.advanceTimersByTimeAsync(0);
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
      liveDelivery: liveDelivery(),
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
    await vi.advanceTimersByTimeAsync(0);
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
      liveDelivery: liveDelivery(),
    });
  });

  it('keeps the gateway socket open for the negotiated terminal budget', async () => {
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
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].open();
    sockets[0].message(
      JSON.stringify({
        type: 'ready',
        capabilities: ['eof'],
        terminal_timeout_ms: 60_000,
      }),
    );
    await started;
    stream.sendAfterRestAccepted(new Uint8Array([0, 0]), 0, 1);
    sockets[0].message(JSON.stringify({ type: 'audio_ack', chunk_seq: 0 }));

    const stopped = stream.stop();
    let settled = false;
    void stopped.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).toBe(false);
    expect(sockets[0].readyState).toBe(1);

    sockets[0].message(JSON.stringify({ type: 'eof_ack' }));
    sockets[0].message(JSON.stringify({ type: 'drained' }));
    await expect(stopped).resolves.toEqual({
      state: 'drained',
      reason: 'drained',
      acknowledged: true,
      liveDelivery: liveDelivery(),
    });
  });

  it('bounds an excessive gateway terminal timeout', async () => {
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
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].open();
    sockets[0].message(
      JSON.stringify({
        type: 'ready',
        capabilities: ['eof'],
        terminal_timeout_ms: 600_000,
      }),
    );
    await started;
    stream.sendAfterRestAccepted(new Uint8Array([0, 0]), 0, 1);
    sockets[0].message(JSON.stringify({ type: 'audio_ack', chunk_seq: 0 }));

    const stopped = stream.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(stopped).resolves.toEqual({
      state: 'degraded',
      reason: 'timeout',
      acknowledged: false,
      liveDelivery: liveDelivery(),
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
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].open();
    sockets[0].message(JSON.stringify({ type: 'ready' }));
    await started;
    expect(stream.sendAfterRestAccepted(new Uint8Array([0, 0]), 0, 1)).toBe(true);
    sockets[0].message(JSON.stringify({ type: 'audio_ack', chunk_seq: 0 }));

    const staleClose = sockets[0].onclose;
    sockets[0].failClose();
    expect(stream.sendAfterRestAccepted(new Uint8Array([0, 0]), 1, 2)).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(2);
    sockets[1].open();
    expect(stream.sendAfterRestAccepted(new Uint8Array([0, 0]), 2, 3)).toBe(false);
    sockets[1].message(JSON.stringify({ type: 'ready' }));
    await vi.advanceTimersByTimeAsync(0);

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
    await vi.advanceTimersByTimeAsync(0);
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

  it('reconnects and replays bounded pending frames when audio acknowledgements go silent', async () => {
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
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].open();
    sockets[0].message(JSON.stringify({ type: 'ready' }));
    await started;
    stream.sendAfterRestAccepted(new Uint8Array([0, 0]), 0, 1);
    stream.sendAfterRestAccepted(new Uint8Array([0, 0]), 1, 2);

    await vi.advanceTimersByTimeAsync(7_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(2);
    sockets[1].open();
    sockets[1].message(JSON.stringify({ type: 'ready' }));
    await vi.advanceTimersByTimeAsync(0);

    const replayedSequences = sockets[1].sent.map((frame) =>
      Number(new DataView(frame as ArrayBuffer).getBigInt64(1, false)),
    );
    expect(replayedSequences).toEqual([0, 1]);
    sockets[1].message(JSON.stringify({ type: 'audio_ack', chunk_seq: 0 }));
    sockets[1].message(JSON.stringify({ type: 'audio_ack', chunk_seq: 1 }));

    await vi.advanceTimersByTimeAsync(6_250);
    expect(sockets).toHaveLength(2);
    expect(onError).not.toHaveBeenCalled();
    stream.close();
  });

  it('opens a cooldown circuit after repeated acknowledgement timeouts, then recovers', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const sockets: FakeSocket[] = [];
    const onError = vi.fn();
    const statuses: Array<{ kind: string }> = [];
    const stream = new GatewayLiveStream({
      cfg: { baseUrl: 'https://testai.acik.com' },
      sessionId: 'SES-1',
      getJwt: async () => 'JWT',
      onEvent: vi.fn(),
      onError,
      onDeliveryStatus: (status) => statuses.push(status),
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    const started = stream.start();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].open();
    sockets[0].message(JSON.stringify({ type: 'ready' }));
    await started;
    stream.sendAfterRestAccepted(new Uint8Array([0, 0]), 0, 1);

    // Three immediate attempts: each socket completes its handshake and then
    // goes silent, which is the failure `ready` alone cannot detect.
    for (let recovery = 1; recovery <= 3; recovery += 1) {
      await vi.advanceTimersByTimeAsync(9_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(sockets).toHaveLength(recovery + 1);
      sockets[recovery].open();
      sockets[recovery].message(JSON.stringify({ type: 'ready' }));
      await vi.advanceTimersByTimeAsync(0);
    }

    // Fourth silence exhausts the immediate budget: the circuit opens. The pause
    // travels on the delivery-status channel, not as an error — see the
    // dedicated banner tests below.
    await vi.advanceTimersByTimeAsync(9_000);
    expect(statuses.map((s) => s.kind)).toEqual(['recovering', 'degraded']);

    // No storm while the circuit is open, however much audio arrives.
    for (let sequence = 1; sequence <= 100; sequence += 1) {
      stream.sendAfterRestAccepted(new Uint8Array([0, 0]), sequence, sequence + 1);
    }
    await vi.advanceTimersByTimeAsync(20_000);
    expect(sockets).toHaveLength(4);

    // Cooldown expires; the next frame buys exactly one half-open probe.
    await vi.advanceTimersByTimeAsync(15_000);
    stream.sendAfterRestAccepted(new Uint8Array([0, 0]), 101, 102);
    await vi.advanceTimersByTimeAsync(2_500);
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(5);

    sockets[4].open();
    sockets[4].message(JSON.stringify({ type: 'ready' }));
    await vi.advanceTimersByTimeAsync(0);
    const replayed = sockets[4].sent.filter((entry) => entry instanceof ArrayBuffer);
    expect(replayed.length).toBeGreaterThan(0);
    sockets[4].message(JSON.stringify({ type: 'audio_ack', chunk_seq: frameSeq(replayed[0]) }));
    await vi.advanceTimersByTimeAsync(0);

    // Recovered: live delivery is open again, not dead for the session.
    const before = sockets[4].sent.length;
    expect(stream.sendAfterRestAccepted(new Uint8Array([0, 0]), 102, 103)).toBe(true);
    expect(sockets[4].sent.length).toBeGreaterThan(before);
    stream.close();
  });

  it('keeps a long acknowledged recording below the replay bounds', async () => {
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
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].open();
    sockets[0].message(JSON.stringify({ type: 'ready' }));
    await started;

    for (let sequence = 0; sequence < 128; sequence += 1) {
      expect(stream.sendAfterRestAccepted(new Uint8Array([0, 0]), sequence, sequence + 1)).toBe(
        true,
      );
      sockets[0].message(JSON.stringify({ type: 'audio_ack', chunk_seq: sequence }));
      await vi.advanceTimersByTimeAsync(1_000);
    }

    expect(sockets).toHaveLength(1);
    expect(onError).not.toHaveBeenCalled();
    stream.close();
  });

  // The headline invariant of #87: a full replay buffer must cost the OLDEST
  // frames, never the lane itself. Before this, one overflow latched live
  // delivery off for the rest of the meeting — the user's "after a while it
  // stops transcribing" report.
  it('recovers live delivery after a replay-buffer overflow instead of dying', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
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
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].open();
    sockets[0].message(JSON.stringify({ type: 'ready' }));
    await started;

    for (let sequence = 0; sequence < 32; sequence += 1) {
      expect(stream.sendAfterRestAccepted(new Uint8Array([0, 0]), sequence, sequence + 1)).toBe(
        true,
      );
    }
    // Frame 32 overflows the 32-frame window.
    stream.sendAfterRestAccepted(new Uint8Array([0, 0]), 32, 33);

    // Overflow alone must NOT tear the socket down — it may simply be slower
    // than the speaker.
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(1);

    // This one really is stalled, so the acknowledgement watchdog reconnects.
    await vi.advanceTimersByTimeAsync(6_250);
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(2);

    sockets[1].open();
    sockets[1].message(JSON.stringify({ type: 'ready' }));
    await vi.advanceTimersByTimeAsync(0);

    // Recency wins: the replayed window starts past the evicted frame 0 and
    // still carries the newest frame.
    const replayed = sockets[1].sent.filter((entry) => entry instanceof ArrayBuffer).map(frameSeq);
    expect(replayed[0]).toBe(1);
    expect(replayed).toContain(32);
    expect(replayed.length).toBeLessThanOrEqual(32);

    sockets[1].message(JSON.stringify({ type: 'audio_ack', chunk_seq: 1 }));
    await vi.advanceTimersByTimeAsync(0);

    // The lane is alive again.
    const before = sockets[1].sent.length;
    expect(stream.sendAfterRestAccepted(new Uint8Array([0, 0]), 33, 34)).toBe(true);
    expect(sockets[1].sent.length).toBeGreaterThan(before);
    stream.close();
  });

  // Codex post-impl finding: tearing the socket down on every overflow is a
  // livelock. While speech continues the window can be full on EVERY frame, so
  // each fresh socket would die before it could collect an acknowledgement —
  // the original symptom, reintroduced through the fix.
  it('keeps one socket alive while the window stays full during continuous speech', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
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
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].open();
    sockets[0].message(JSON.stringify({ type: 'ready' }));
    await started;

    for (let sequence = 0; sequence <= 32; sequence += 1) {
      stream.sendAfterRestAccepted(new Uint8Array([0, 0]), sequence, sequence + 1);
    }

    // Speech continues on a full window: a frame every 2s, acknowledgement at
    // 4s — comfortably inside the 6s watchdog.
    await vi.advanceTimersByTimeAsync(2_000);
    stream.sendAfterRestAccepted(new Uint8Array([0, 0]), 33, 34);
    await vi.advanceTimersByTimeAsync(2_000);
    stream.sendAfterRestAccepted(new Uint8Array([0, 0]), 34, 35);
    await vi.advanceTimersByTimeAsync(0);

    // The socket was never torn down by the overflows themselves.
    expect(sockets).toHaveLength(1);

    const pending = sockets[0].sent.filter((entry) => entry instanceof ArrayBuffer).map(frameSeq);
    sockets[0].message(JSON.stringify({ type: 'audio_ack', chunk_seq: pending.at(-1) }));
    await vi.advanceTimersByTimeAsync(0);

    // Still one socket, still delivering.
    const before = sockets[0].sent.length;
    expect(stream.sendAfterRestAccepted(new Uint8Array([0, 0]), 35, 36)).toBe(true);
    expect(sockets[0].sent.length).toBeGreaterThan(before);
    expect(sockets).toHaveLength(1);
    stream.close();
  });

  // A banner that never clears is worse than no banner: the user saw a live
  // alarm for 26 minutes while the transcript was only 9 seconds behind.
  it('stays silent through transient recovery and takes the warning back', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const sockets: FakeSocket[] = [];
    const onError = vi.fn();
    const statuses: Array<{ kind: string; retryInMs?: number }> = [];
    const stream = new GatewayLiveStream({
      cfg: { baseUrl: 'https://testai.acik.com' },
      sessionId: 'SES-1',
      getJwt: async () => 'JWT',
      onEvent: vi.fn(),
      onError,
      onDeliveryStatus: (status) => statuses.push(status),
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    const started = stream.start();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].open();
    sockets[0].message(JSON.stringify({ type: 'ready' }));
    await started;
    stream.sendAfterRestAccepted(new Uint8Array([0, 0]), 0, 1);

    // A blip the circuit breaker heals in under a second must NOT alarm anyone.
    sockets[0].failClose();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).not.toHaveBeenCalled();
    expect(statuses.map((s) => s.kind)).toEqual(['recovering']);

    sockets[1].open();
    sockets[1].message(JSON.stringify({ type: 'ready' }));
    await vi.advanceTimersByTimeAsync(0);
    sockets[1].message(JSON.stringify({ type: 'audio_ack', chunk_seq: 0 }));
    await vi.advanceTimersByTimeAsync(0);

    // Recovery is proven by a real acknowledgement — the warning is retracted.
    expect(statuses.map((s) => s.kind)).toEqual(['recovering', 'healthy']);
    expect(onError).not.toHaveBeenCalled();
    stream.close();
  });

  it('announces a degraded pause only once the circuit actually opens', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const sockets: FakeSocket[] = [];
    const statuses: Array<{ kind: string; retryInMs?: number }> = [];
    const stream = new GatewayLiveStream({
      cfg: { baseUrl: 'https://testai.acik.com' },
      sessionId: 'SES-1',
      getJwt: async () => 'JWT',
      onEvent: vi.fn(),
      onError: vi.fn(),
      onDeliveryStatus: (status) => statuses.push(status),
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    });

    const started = stream.start();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].open();
    sockets[0].message(JSON.stringify({ type: 'ready' }));
    await started;
    stream.sendAfterRestAccepted(new Uint8Array([0, 0]), 0, 1);

    for (let recovery = 1; recovery <= 3; recovery += 1) {
      await vi.advanceTimersByTimeAsync(9_000);
      await vi.advanceTimersByTimeAsync(0);
      sockets[recovery].open();
      sockets[recovery].message(JSON.stringify({ type: 'ready' }));
      await vi.advanceTimersByTimeAsync(0);
    }
    await vi.advanceTimersByTimeAsync(9_000);

    // One `recovering` for the episode, then one `degraded` carrying the wait.
    expect(statuses.map((s) => s.kind)).toEqual(['recovering', 'degraded']);
    expect(statuses[1].retryInMs).toBe(30_000);
    stream.close();
  });

  it('announces a replay gap only when the gateway advertises the capability', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
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
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].open();
    sockets[0].message(JSON.stringify({ type: 'ready' }));
    await started;

    for (let sequence = 0; sequence <= 32; sequence += 1) {
      stream.sendAfterRestAccepted(new Uint8Array([0, 0]), sequence, sequence + 1);
    }
    await vi.advanceTimersByTimeAsync(6_750);
    await vi.advanceTimersByTimeAsync(0);

    // Peer without the capability: replay only, no invented control frame.
    sockets[1].open();
    sockets[1].message(JSON.stringify({ type: 'ready' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets[1].sent.some((entry) => typeof entry === 'string')).toBe(false);

    sockets[1].failClose();
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(0);

    // Peer that advertises it: the gap is declared before any replayed audio,
    // so the decoder closes the previous utterance instead of splicing.
    sockets[2].open();
    sockets[2].message(JSON.stringify({ type: 'ready', capabilities: ['audio_discontinuity_v1'] }));
    await vi.advanceTimersByTimeAsync(0);
    const firstSent = sockets[2].sent[0];
    expect(typeof firstSent).toBe('string');
    expect(JSON.parse(firstSent as string)).toEqual({
      type: 'audio_discontinuity',
      version: 1,
      next_chunk_seq: 1,
      dropped_frame_count: 1,
    });
    stream.close();
  });

  it('reports a recovered overflow as a drained stop with gapped live coverage', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
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
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].open();
    sockets[0].message(JSON.stringify({ type: 'ready', capabilities: ['eof'] }));
    await started;

    for (let sequence = 0; sequence <= 32; sequence += 1) {
      stream.sendAfterRestAccepted(new Uint8Array([0, 0]), sequence, sequence + 1);
    }
    await vi.advanceTimersByTimeAsync(6_750);
    await vi.advanceTimersByTimeAsync(0);
    sockets[1].open();
    sockets[1].message(JSON.stringify({ type: 'ready', capabilities: ['eof'] }));
    await vi.advanceTimersByTimeAsync(0);
    for (let sequence = 1; sequence <= 32; sequence += 1) {
      sockets[1].message(JSON.stringify({ type: 'audio_ack', chunk_seq: sequence }));
    }
    await vi.advanceTimersByTimeAsync(0);

    const stopped = stream.stop();
    await vi.advanceTimersByTimeAsync(0);
    sockets[1].message(JSON.stringify({ type: 'drained' }));

    // The terminal drain succeeded, so the recording is NOT reported as broken.
    // The lost live frames travel in `liveDelivery`, where the UI can say
    // "there was a gap in the live preview" without implying data loss.
    await expect(stopped).resolves.toEqual({
      state: 'drained',
      reason: 'drained',
      acknowledged: true,
      liveDelivery: liveDelivery({
        coverage: 'gapped',
        recovered: true,
        recoveryEpisodeCount: 1,
        recoveredEpisodeCount: 1,
        droppedFrameCount: 1,
        droppedAudioBytes: GATEWAY_LIVE_AUDIO_FRAME_HEADER_BYTES + 2,
        firstDroppedSequence: 0,
        lastDroppedSequence: 0,
        causes: ['buffer-overflow', 'ack-timeout'],
      }),
    });
  });

  it('keeps live delivery bounded but alive across a long silent-then-speaking session', async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
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
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].open();
    sockets[0].message(JSON.stringify({ type: 'ready' }));
    await started;

    let sequence = 0;
    // Three independent stall-then-recover cycles, as a long meeting produces.
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const socket = sockets[sockets.length - 1];
      for (let frame = 0; frame < 40; frame += 1, sequence += 1) {
        stream.sendAfterRestAccepted(new Uint8Array([0, 0]), sequence, sequence + 1);
      }
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(0);
      const next = sockets[sockets.length - 1];
      if (next !== socket) {
        next.open();
        next.message(JSON.stringify({ type: 'ready' }));
        await vi.advanceTimersByTimeAsync(0);
      }
      const pending = next.sent.filter((entry) => entry instanceof ArrayBuffer).map(frameSeq);
      // A full window must not churn the connection: overflow means "behind",
      // not "broken".
      expect(sockets).toHaveLength(1);
      for (const seq of pending) {
        next.message(JSON.stringify({ type: 'audio_ack', chunk_seq: seq }));
      }
      await vi.advanceTimersByTimeAsync(0);
    }

    // Still delivering after all of it — no accumulated debt, no dead lane.
    const live = sockets[sockets.length - 1];
    const before = live.sent.length;
    expect(stream.sendAfterRestAccepted(new Uint8Array([0, 0]), sequence, sequence + 1)).toBe(true);
    expect(live.sent.length).toBeGreaterThan(before);
    stream.close();
  });

  it('does not treat a buffer overflow as a terminal failure', async () => {
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
    await waitForSocket(sockets, 1);
    sockets[0].open();
    sockets[0].message(JSON.stringify({ type: 'ready' }));
    await started;

    for (let sequence = 0; sequence < 32; sequence += 1) {
      expect(stream.sendAfterRestAccepted(new Uint8Array([0, 0]), sequence, sequence + 1)).toBe(
        true,
      );
    }
    stream.sendAfterRestAccepted(new Uint8Array([0, 0]), 32, 33);

    // No terminal "buffer is full" error: overflow is a recoverable delivery
    // fault, and the user is not told the recording failed.
    expect(onError).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('replay buffer is full') }),
    );

    // The socket is untouched, so stop() runs the normal drain. The lost frames
    // are reported as live-preview coverage — not as a broken recording.
    const stopped = stream.stop();
    await vi.advanceTimersByTimeAsync(8_500);
    await expect(stopped).resolves.toEqual({
      state: 'degraded',
      reason: 'timeout',
      acknowledged: false,
      liveDelivery: liveDelivery({
        coverage: 'gapped',
        recoveryEpisodeCount: 1,
        droppedFrameCount: 1,
        droppedAudioBytes: GATEWAY_LIVE_AUDIO_FRAME_HEADER_BYTES + 2,
        firstDroppedSequence: 0,
        lastDroppedSequence: 0,
        causes: ['buffer-overflow'],
      }),
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
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].open();
    sockets[0].message(JSON.stringify({ type: 'ready' }));
    await started;
    sockets[0].message(JSON.stringify({ type: 'error', msg: 'upstream reset' }));

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(0);
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
    await vi.advanceTimersByTimeAsync(0);
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
      liveDelivery: liveDelivery(),
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
    await vi.advanceTimersByTimeAsync(0);
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
      liveDelivery: liveDelivery(),
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

  it('preserves validated final source sample ranges for the renderer bridge', async () => {
    const sockets: FakeSocket[] = [];
    const onEvent = vi.fn();
    const stream = new GatewayLiveStream({
      cfg: { baseUrl: 'https://testai.acik.com' },
      sessionId: 'SES-SOURCE-RANGE',
      getJwt: async () => 'JWT',
      onEvent,
      onError: vi.fn(),
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
    expect(stream.getSourceStartedAtMs()).toBeNull();
    stream.sendRealtimeFrame(new Uint8Array(3_200), 1_781_820_000_100);
    expect(stream.getSourceStartedAtMs()).toBe(1_781_820_000_000);
    onEvent.mockClear();

    sockets[0].message(
      JSON.stringify({
        type: 'final',
        seq: 7,
        text: 'Kaynak aralıklı final',
        reason: 'speech_final',
        elapsed_ms: 320,
        rms: 0.04,
        source_start_sample: 16_000,
        source_end_sample: 40_000,
      }),
    );

    expect(onEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'final',
        seq: 7,
        source_start_sample: 16_000,
        source_end_sample: 40_000,
      }),
    );
    stream.close();
  });

  it('preserves final text when optional timing metadata is absent or malformed', async () => {
    const sockets: FakeSocket[] = [];
    const onEvent = vi.fn();
    const stream = new GatewayLiveStream({
      cfg: { baseUrl: 'https://testai.acik.com' },
      sessionId: 'SES-FINAL-FALLBACK',
      getJwt: async () => 'JWT',
      onEvent,
      onError: vi.fn(),
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
    onEvent.mockClear();

    sockets[0].message(
      JSON.stringify({
        type: 'final',
        seq: 2,
        text: 'Metadata bozuk olsa da final metin korunur.',
        reason: 'invalid reason with spaces',
        source_start_sample: 8000,
        source_end_sample: 4000,
      }),
    );

    expect(onEvent).toHaveBeenCalledWith({
      type: 'final',
      seq: 2,
      text: 'Metadata bozuk olsa da final metin korunur.',
    });
    stream.close();
  });

  it('fails source timing closed after a reconnect', async () => {
    const sockets: FakeSocket[] = [];
    const stream = new GatewayLiveStream({
      cfg: { baseUrl: 'https://testai.acik.com' },
      sessionId: 'SES-TIMING-RECONNECT',
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
    await waitForSocket(sockets, 1);
    sockets[0].open();
    sockets[0].message(JSON.stringify({ type: 'ready' }));
    await started;
    stream.sendRealtimeFrame(new Uint8Array(3_200), 1_781_820_000_100);
    expect(stream.hasReliableSourceTiming()).toBe(true);

    sockets[0].failClose();

    expect(stream.hasReliableSourceTiming()).toBe(false);
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

  it('enforces the absolute startup deadline even when loading progress continues', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const stream = new GatewayLiveStream({
      cfg: { baseUrl: 'https://testai.acik.com' },
      sessionId: 'SES-deadline',
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
    const assertion = expect(started).rejects.toThrow(/did not become ready within 300000ms/);
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].open();
    for (let elapsed = 0; elapsed < GATEWAY_LIVE_STREAM_OPEN_MAX_WAIT_MS; elapsed += 8_000) {
      sockets[0].message(JSON.stringify({ type: 'loading', stage: 'model' }));
      await vi.advanceTimersByTimeAsync(
        Math.min(8_000, GATEWAY_LIVE_STREAM_OPEN_MAX_WAIT_MS - elapsed),
      );
    }

    await assertion;
    expect(sockets[0].readyState).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects an in-flight startup immediately when the lifecycle owner closes it', async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const stream = new GatewayLiveStream({
      cfg: { baseUrl: 'https://testai.acik.com' },
      sessionId: 'SES-close',
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
    const assertion = expect(started).rejects.toThrow(/closed while waiting for readiness/);
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].open();
    sockets[0].message(JSON.stringify({ type: 'loading', stage: 'model' }));

    stream.close();

    await assertion;
    expect(sockets[0].readyState).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not create a socket when lifecycle closes while token refresh is pending', async () => {
    let resolveJwt: (jwt: string) => void = () => undefined;
    const socketFactory = vi.fn(() => new FakeSocket());
    const stream = new GatewayLiveStream({
      cfg: { baseUrl: 'https://testai.acik.com' },
      sessionId: 'SES-token-close',
      getJwt: () =>
        new Promise((resolve) => {
          resolveJwt = resolve;
        }),
      onEvent: vi.fn(),
      onError: vi.fn(),
      socketFactory,
    });

    const started = stream.start();
    stream.close();
    resolveJwt('JWT');

    await expect(started).rejects.toThrow(/closed while waiting for token/);
    expect(socketFactory).not.toHaveBeenCalled();
  });
});
