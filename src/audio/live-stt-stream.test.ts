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
  vi.unstubAllGlobals();
  FakeWebSocket.instances = [];
});

describe('connectLiveSttStream', () => {
  it('buffers audio until ready and emits same-id partial/final transcript updates', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const events: LiveSttTranscriptEvent[] = [];

    const stream = connectLiveSttStream('ws://127.0.0.1:18220/ws/stream', {
      onTranscriptEvent: (event) => events.push(event),
    });
    const ws = FakeWebSocket.instances[0];
    expect(ws?.url).toBe('ws://127.0.0.1:18220/ws/stream');

    stream.send(new Float32Array([0.1, 0.2]));
    expect(ws?.sent).toHaveLength(0);

    ws?.open();
    ws?.message({ type: 'ready' });
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
});
