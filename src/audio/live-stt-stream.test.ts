// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { connectLiveSttStream, type LiveSttTranscriptEvent } from './live-stt-stream';

class FakeWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: unknown[] = [];

  constructor(readonly url: string) {
    super();
    FakeWebSocket.instances.push(this);
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(): void {
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
  FakeWebSocket.instances = [];
});

describe('connectLiveSttStream', () => {
  it('buffers audio until ready and emits same-id partial/final transcript updates', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const events: LiveSttTranscriptEvent[] = [];
    const onReady = vi.fn();

    const stream = connectLiveSttStream('ws://127.0.0.1:18220/ws/stream', {
      onReady,
      onTranscriptEvent: (event) => events.push(event),
    });
    const ws = FakeWebSocket.instances[0];
    expect(ws?.url).toBe('ws://127.0.0.1:18220/ws/stream');

    stream.send(new Float32Array([0.1, 0.2]));
    expect(ws?.sent).toHaveLength(0);

    ws?.open();
    ws?.message({ type: 'ready' });
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(ws?.sent).toHaveLength(1);

    ws?.message({
      type: 'partial',
      seq: 0,
      confirmed: '',
      tentative: 'Merhaba',
      elapsed_ms: 120,
      rms: 0.04,
      source: 'medium',
    });
    ws?.message({
      type: 'partial',
      seq: 0,
      confirmed: '',
      tentative: 'Merhaba nasılsın',
      elapsed_ms: 190,
      rms: 0.04,
      source: 'medium',
    });
    ws?.message({
      type: 'final',
      seq: 0,
      text: 'Merhaba nasılsın?',
      elapsed_ms: 380,
      rms: 0.04,
    });

    expect(events.map((event) => [event.id, event.status, event.text])).toEqual([
      ['stream:0', 'draft', 'Merhaba'],
      ['stream:0', 'draft', 'Merhaba nasılsın'],
      ['stream:0', 'final', 'Merhaba nasılsın?'],
    ]);

    stream.close();
  });

  it('reveals multi-word partial payloads word-by-word on the same segment id', () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const events: LiveSttTranscriptEvent[] = [];

    const stream = connectLiveSttStream('ws://127.0.0.1:18220/ws/stream', {
      onTranscriptEvent: (event) => events.push(event),
    });
    const ws = FakeWebSocket.instances[0];

    ws?.open();
    ws?.message({ type: 'ready' });
    ws?.message({
      type: 'partial',
      seq: 0,
      confirmed: '',
      tentative: 'Merhaba nasılsın bugün',
      elapsed_ms: 180,
      rms: 0.04,
      source: 'medium',
    });

    expect(events.map((event) => [event.id, event.status, event.text])).toEqual([
      ['stream:0', 'draft', 'Merhaba'],
    ]);

    vi.advanceTimersByTime(70);
    expect(events.map((event) => [event.id, event.status, event.text])).toEqual([
      ['stream:0', 'draft', 'Merhaba'],
      ['stream:0', 'draft', 'Merhaba nasılsın'],
    ]);

    vi.advanceTimersByTime(70);
    expect(events.map((event) => [event.id, event.status, event.text])).toEqual([
      ['stream:0', 'draft', 'Merhaba'],
      ['stream:0', 'draft', 'Merhaba nasılsın'],
      ['stream:0', 'draft', 'Merhaba nasılsın bugün'],
    ]);

    stream.close();
  });

  it('cancels pending word reveal when final transcript arrives', () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const events: LiveSttTranscriptEvent[] = [];

    const stream = connectLiveSttStream('ws://127.0.0.1:18220/ws/stream', {
      onTranscriptEvent: (event) => events.push(event),
    });
    const ws = FakeWebSocket.instances[0];

    ws?.open();
    ws?.message({ type: 'ready' });
    ws?.message({
      type: 'partial',
      seq: 0,
      confirmed: '',
      tentative: 'Merhaba nasılsın bugün',
      elapsed_ms: 180,
      rms: 0.04,
      source: 'medium',
    });
    ws?.message({
      type: 'final',
      seq: 0,
      text: 'Merhaba nasılsın bugün.',
      elapsed_ms: 320,
      rms: 0.04,
    });

    vi.advanceTimersByTime(500);

    expect(events.map((event) => [event.id, event.status, event.text])).toEqual([
      ['stream:0', 'draft', 'Merhaba'],
      ['stream:0', 'final', 'Merhaba nasılsın bugün.'],
    ]);

    stream.close();
  });

  it('reconnects after a transient close and flushes buffered audio frames', () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const onReady = vi.fn();

    const stream = connectLiveSttStream('ws://127.0.0.1:18220/ws/stream', { onReady });
    const first = FakeWebSocket.instances[0];

    first?.open();
    first?.message({ type: 'ready' });
    stream.send(new Float32Array([0.1, 0.2]));
    expect(first?.sent).toHaveLength(1);

    first?.close();
    stream.send(new Float32Array([0.3, 0.4]));
    expect(FakeWebSocket.instances).toHaveLength(1);

    vi.advanceTimersByTime(250);
    const second = FakeWebSocket.instances[1];
    expect(second?.url).toBe('ws://127.0.0.1:18220/ws/stream');
    expect(second?.sent).toHaveLength(0);

    second?.open();
    second?.message({ type: 'ready' });

    expect(onReady).toHaveBeenCalledTimes(2);
    expect(second?.sent).toHaveLength(1);

    stream.close();
  });
});
