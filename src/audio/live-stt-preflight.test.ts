// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { testLiveSttStreamConnection } from './live-stt-preflight';

class FakeWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  closeCalls = 0;

  constructor(readonly url: string) {
    super();
    FakeWebSocket.instances.push(this);
  }

  send(): void {
    // Preflight never sends audio or transcript content.
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new Event('close'));
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
  }

  message(payload: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(payload) }));
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  FakeWebSocket.instances = [];
});

describe('testLiveSttStreamConnection', () => {
  it('resolves ready when the stream emits ready', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.setSystemTime(1_000);

    const resultPromise = testLiveSttStreamConnection('ws://127.0.0.1:18220/ws/stream');
    const ws = FakeWebSocket.instances[0];
    expect(ws?.url).toBe('ws://127.0.0.1:18220/ws/stream');

    ws?.open();
    ws?.message({ type: 'loading', stage: 'live_model' });
    vi.setSystemTime(1_240);
    ws?.message({ type: 'ready' });

    await expect(resultPromise).resolves.toEqual({
      ok: true,
      message: 'Direct STT stream hazir.',
      elapsedMs: 240,
      stage: 'live_model',
    });
    expect(ws?.closeCalls).toBe(1);
  });

  it('reports server error without throwing', async () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);

    const resultPromise = testLiveSttStreamConnection('ws://127.0.0.1:18220/ws/stream');
    const ws = FakeWebSocket.instances[0];

    ws?.open();
    ws?.message({ type: 'error', msg: 'model unavailable' });

    await expect(resultPromise).resolves.toMatchObject({
      ok: false,
      message: 'Direct STT server hatasi: model unavailable',
    });
  });

  it('reports timeout when ready never arrives', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);

    const resultPromise = testLiveSttStreamConnection('ws://127.0.0.1:18220/ws/stream', 500);
    const ws = FakeWebSocket.instances[0];

    ws?.open();
    ws?.message({ type: 'loading', stage: 'final_model' });
    vi.advanceTimersByTime(500);

    await expect(resultPromise).resolves.toMatchObject({
      ok: false,
      message: 'final model 500 ms icinde hazir olmadi.',
      stage: 'final_model',
    });
  });
});
