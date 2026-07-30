// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  connectLiveSttStream,
  type LiveSttStreamStatusEvent,
  type LiveSttTranscriptEvent,
} from './live-stt-stream';

class FakeWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  sent: unknown[] = [];
  closeCalls = 0;

  constructor(readonly url: string) {
    super();
    FakeWebSocket.instances.push(this);
  }

  send(data: unknown): void {
    this.sent.push(data);
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

  fail(): void {
    this.dispatchEvent(new Event('error'));
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakeWebSocket.instances = [];
});

describe('connectLiveSttStream', () => {
  it('reports constructor failures without throwing so microphone recording can continue', () => {
    class ThrowingWebSocket {
      constructor() {
        throw new Error('invalid direct STT URL');
      }
    }
    vi.stubGlobal('WebSocket', ThrowingWebSocket);
    const statuses: LiveSttStreamStatusEvent[] = [];
    const errors: string[] = [];

    const stream = connectLiveSttStream('ws://127.0.0.1:18220/ws/stream', {
      onStatus: (event) => statuses.push(event),
      onError: (error) => errors.push(error.message),
    });

    expect(statuses.map((event) => event.status)).toEqual(['connecting', 'error']);
    expect(statuses[1]?.reason).toBe('invalid direct STT URL');
    expect(errors).toEqual(['Live STT stream kurulamadı: invalid direct STT URL']);

    expect(() => stream.send(new Float32Array([0.1]))).not.toThrow();
    expect(() => stream.close()).not.toThrow();
  });

  it('buffers audio until ready and emits same-id partial/final transcript updates', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const events: LiveSttTranscriptEvent[] = [];
    const statuses: LiveSttStreamStatusEvent[] = [];
    const onReady = vi.fn();

    const stream = connectLiveSttStream('ws://127.0.0.1:18220/ws/stream', {
      onReady,
      onStatus: (event) => statuses.push(event),
      onTranscriptEvent: (event) => events.push(event),
    });
    const ws = FakeWebSocket.instances[0];
    expect(ws?.url).toBe('ws://127.0.0.1:18220/ws/stream');

    stream.send(new Float32Array([0.1, 0.2]));
    expect(ws?.sent).toHaveLength(0);

    ws?.open();
    ws?.message({ type: 'loading', stage: 'live_model' });
    ws?.message({ type: 'ready' });
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(ws?.sent).toHaveLength(1);
    expect(statuses.map((event) => event.status)).toEqual(['connecting', 'loading', 'ready']);
    expect(statuses[1]?.stage).toBe('live_model');

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

  it('keeps one minute of direct audio buffered while stream models are loading', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);

    const stream = connectLiveSttStream('ws://127.0.0.1:18220/ws/stream');
    const ws = FakeWebSocket.instances[0];

    ws?.open();
    ws?.message({ type: 'loading', stage: 'live_model' });

    for (let index = 0; index < 70; index += 1) {
      stream.send(new Float32Array(16_000).fill(index));
    }
    expect(ws?.sent).toHaveLength(0);

    ws?.message({ type: 'ready' });

    expect(ws?.sent).toHaveLength(60);
    expect((ws?.sent[0] as ArrayBuffer).byteLength).toBe(64_000);
    expect(new Float32Array(ws?.sent[0] as ArrayBuffer)[0]).toBe(10);
    expect(new Float32Array(ws?.sent.at(-1) as ArrayBuffer)[0]).toBe(69);

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

  it('merges rolling-window partials without dropping earlier words', () => {
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
      tentative: 'Bugün toplantıda hızlı şekilde',
      elapsed_ms: 180,
      rms: 0.04,
      source: 'medium',
    });
    ws?.message({
      type: 'partial',
      seq: 0,
      confirmed: '',
      tentative: 'hızlı şekilde yazıya dönüşüyor',
      elapsed_ms: 210,
      rms: 0.04,
      source: 'medium',
    });

    vi.advanceTimersByTime(280);

    expect(events.map((event) => event.text)).toEqual([
      'Bugün',
      'Bugün toplantıda',
      'Bugün toplantıda hızlı',
      'Bugün toplantıda hızlı şekilde',
      'Bugün toplantıda hızlı şekilde yazıya',
      'Bugün toplantıda hızlı şekilde yazıya dönüşüyor',
    ]);

    stream.close();
  });

  it('keeps the longer draft when a later rolling partial is only a suffix', () => {
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
      tentative: 'Merhaba nasılsın bugün toplantıdayız',
      elapsed_ms: 180,
      rms: 0.04,
      source: 'medium',
    });
    vi.advanceTimersByTime(280);
    ws?.message({
      type: 'partial',
      seq: 0,
      confirmed: '',
      tentative: 'bugün toplantıdayız',
      elapsed_ms: 210,
      rms: 0.04,
      source: 'medium',
    });

    expect(events.at(-1)?.text).toBe('Merhaba nasılsın bugün toplantıdayız');
    expect(events).toHaveLength(4);

    stream.close();
  });

  it('appends growing no-overlap rolling partials instead of erasing earlier words', () => {
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
      tentative: 'Merhaba sesim geliyor mu',
      elapsed_ms: 180,
      rms: 0.04,
      source: 'medium',
    });
    vi.advanceTimersByTime(210);
    ws?.message({
      type: 'partial',
      seq: 0,
      confirmed: '',
      tentative: 'bir sürü eksik var yine',
      elapsed_ms: 210,
      rms: 0.04,
      source: 'medium',
    });
    vi.advanceTimersByTime(280);

    expect(events.at(-1)?.text).toBe('Merhaba sesim geliyor mu bir sürü eksik var yine');

    stream.close();
  });

  it('appends shorter no-overlap rolling continuations after a stable draft', () => {
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
      tentative: 'Uzun konuşuyorum burada şimdi',
      elapsed_ms: 180,
      rms: 0.04,
      source: 'medium',
    });
    vi.advanceTimersByTime(280);
    ws?.message({
      type: 'partial',
      seq: 0,
      confirmed: '',
      tentative: 'kelimeler düşüyor',
      elapsed_ms: 210,
      rms: 0.04,
      source: 'medium',
    });
    vi.advanceTimersByTime(70);

    expect(events.at(-1)?.text).toBe('Uzun konuşuyorum burada şimdi kelimeler düşüyor');

    stream.close();
  });

  it('appends one-word no-overlap rolling continuations after a stable draft', () => {
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
      tentative: 'Konuşulanların çok büyük kısmı yazılmıyor',
      elapsed_ms: 180,
      rms: 0.04,
      source: 'medium',
    });
    vi.advanceTimersByTime(350);
    ws?.message({
      type: 'partial',
      seq: 0,
      confirmed: '',
      tentative: 'düşüyor',
      elapsed_ms: 210,
      rms: 0.04,
      source: 'medium',
    });

    expect(events.at(-1)?.text).toBe('Konuşulanların çok büyük kısmı yazılmıyor düşüyor');

    stream.close();
  });

  it('trusts stable-v1 partial corrections without fabricating a same-opener sentence', () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const events: LiveSttTranscriptEvent[] = [];

    const stream = connectLiveSttStream('ws://127.0.0.1:18220/ws/stream', {
      onTranscriptEvent: (event) => events.push(event),
    });
    const ws = FakeWebSocket.instances[0];

    ws?.open();
    ws?.message({ type: 'ready', partial_mode: 'stable-v1' });
    ws?.message({
      type: 'partial',
      seq: 0,
      confirmed: '',
      tentative: 'Merhaba sesim geliyor mu beni duyuyor musun',
      elapsed_ms: 180,
      rms: 0.04,
      source: 'medium',
    });
    vi.advanceTimersByTime(420);
    ws?.message({
      type: 'partial',
      seq: 0,
      confirmed: 'Merhaba',
      tentative: 'burada hava çok',
      elapsed_ms: 240,
      rms: 0.04,
      source: 'medium',
    });
    vi.advanceTimersByTime(210);

    expect(events.at(-1)?.text).toBe('Merhaba burada hava çok');

    stream.close();
  });

  it('extends a same-opener appended tail without duplicating the tail', () => {
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
      tentative: 'Merhaba sesim geliyor mu beni duyuyor musun',
      elapsed_ms: 180,
      rms: 0.04,
      source: 'medium',
    });
    vi.advanceTimersByTime(210);
    ws?.message({
      type: 'partial',
      seq: 0,
      confirmed: '',
      tentative: 'Merhaba burada hava çok',
      elapsed_ms: 240,
      rms: 0.04,
      source: 'medium',
    });
    vi.advanceTimersByTime(210);
    ws?.message({
      type: 'partial',
      seq: 0,
      confirmed: '',
      tentative: 'Merhaba burada hava çok güzel',
      elapsed_ms: 310,
      rms: 0.04,
      source: 'medium',
    });
    vi.advanceTimersByTime(210);

    expect(events.at(-1)?.text).toBe(
      'Merhaba sesim geliyor mu beni duyuyor musun burada hava çok güzel',
    );

    stream.close();
  });

  it('does not keep appending unrelated same-opener text after a long draft', () => {
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
      tentative:
        'Merhaba sesim geliyor mu beni duyuyor musun burada uzun bir deneme yapıyorum şimdi devam ediyor',
      elapsed_ms: 180,
      rms: 0.04,
      source: 'medium',
    });
    vi.advanceTimersByTime(2_000);
    ws?.message({
      type: 'partial',
      seq: 0,
      confirmed: '',
      tentative: 'Merhaba yeni konu başlıyor',
      elapsed_ms: 260,
      rms: 0.04,
      source: 'medium',
    });
    vi.advanceTimersByTime(210);

    expect(events.at(-1)?.text).toBe('Merhaba yeni konu başlıyor');

    stream.close();
  });

  it('still applies same-opener rolling corrections when the new text overlaps the draft', () => {
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
      tentative: 'Merhaba sesim geliyor',
      elapsed_ms: 180,
      rms: 0.04,
      source: 'medium',
    });
    vi.advanceTimersByTime(210);
    ws?.message({
      type: 'partial',
      seq: 0,
      confirmed: '',
      tentative: 'Merhaba sesim geliyor mu',
      elapsed_ms: 240,
      rms: 0.04,
      source: 'medium',
    });

    expect(events.at(-1)?.text).toBe('Merhaba sesim geliyor mu');

    stream.close();
  });

  it('replaces unrelated rolling partial alternatives instead of appending variants', () => {
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
      tentative: 'Akşama aktif diyorsun',
      elapsed_ms: 180,
      rms: 0.04,
      source: 'medium',
    });
    vi.advanceTimersByTime(210);
    ws?.message({
      type: 'partial',
      seq: 0,
      confirmed: '',
      tentative: 'Kelime akışı aktif',
      elapsed_ms: 210,
      rms: 0.04,
      source: 'medium',
    });

    expect(events.at(-1)?.text).toBe('Kelime akışı aktif');

    stream.close();
  });

  it('keeps a short stable draft when an unrelated short final correction arrives', () => {
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
      tentative: 'Merhaba',
      elapsed_ms: 180,
      rms: 0.04,
      source: 'medium',
    });
    ws?.message({
      type: 'final',
      seq: 0,
      text: 'Neroba',
      elapsed_ms: 700,
      rms: 0.04,
    });

    expect(events.at(-1)).toMatchObject({
      id: 'stream:0',
      status: 'final',
      text: 'Merhaba',
    });

    stream.close();
  });

  it('drops a known single-word final artifact when no stable draft exists', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const events: LiveSttTranscriptEvent[] = [];

    const stream = connectLiveSttStream('ws://127.0.0.1:18220/ws/stream', {
      onTranscriptEvent: (event) => events.push(event),
    });
    const ws = FakeWebSocket.instances[0];

    ws?.open();
    ws?.message({ type: 'ready' });
    ws?.message({
      type: 'final',
      seq: 0,
      text: 'Neroba',
      elapsed_ms: 700,
      rms: 0.04,
    });

    expect(events).toEqual([]);

    stream.close();
  });

  it('keeps a legitimate common final phrase when no stable draft exists', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const events: LiveSttTranscriptEvent[] = [];

    const stream = connectLiveSttStream('ws://127.0.0.1:18220/ws/stream', {
      onTranscriptEvent: (event) => events.push(event),
    });
    const ws = FakeWebSocket.instances[0];

    ws?.open();
    ws?.message({ type: 'ready' });
    ws?.message({
      type: 'final',
      seq: 0,
      text: 'İstediğiniz için teşekkür ederim.',
      elapsed_ms: 700,
      rms: 0.04,
    });

    expect(events).toEqual([
      expect.objectContaining({
        id: 'stream:0',
        status: 'final',
        text: 'İstediğiniz için teşekkür ederim.',
      }),
    ]);

    stream.close();
  });

  it('drops repetitive final decode loops when no stable draft exists', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const events: LiveSttTranscriptEvent[] = [];

    const stream = connectLiveSttStream('ws://127.0.0.1:18220/ws/stream', {
      onTranscriptEvent: (event) => events.push(event),
    });
    const ws = FakeWebSocket.instances[0];

    ws?.open();
    ws?.message({ type: 'ready' });
    ws?.message({
      type: 'final',
      seq: 0,
      text: 'Akşama aktif diyorsun Akşam aktif diyorsun ya Akşama aktif diyorsun yani Akışa aktif diyorsun yani.',
      elapsed_ms: 760,
      rms: 0.04,
    });

    expect(events).toEqual([]);

    stream.close();
  });

  it('drops repeated final alternative chains with extra suffix variants', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const events: LiveSttTranscriptEvent[] = [];

    const stream = connectLiveSttStream('ws://127.0.0.1:18220/ws/stream', {
      onTranscriptEvent: (event) => events.push(event),
    });
    const ws = FakeWebSocket.instances[0];

    ws?.open();
    ws?.message({ type: 'ready' });
    ws?.message({
      type: 'final',
      seq: 0,
      text: 'Akşama aktif diyorsun Akşam aktif diyorsun ya Akşama aktif diyorsun yani Akışa aktif diyorsun yani bakışı aktif diyorsun yani.',
      elapsed_ms: 760,
      rms: 0.04,
    });

    expect(events).toEqual([]);

    stream.close();
  });

  it('drops live final alternative chains observed from rolling Turkish word-flow smoke', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const events: LiveSttTranscriptEvent[] = [];

    const stream = connectLiveSttStream('ws://127.0.0.1:18220/ws/stream', {
      onTranscriptEvent: (event) => events.push(event),
    });
    const ws = FakeWebSocket.instances[0];

    ws?.open();
    ws?.message({ type: 'ready' });
    ws?.message({
      type: 'final',
      seq: 0,
      text: 'Akşama aktif diyorsun Akşam aktif diyorsun ya Akşama aktif diyorsun yani Akışa aktif diyorsun yani. bakışı aktif diyorsun yani.',
      elapsed_ms: 760,
      rms: 0.04,
    });

    expect(events).toEqual([]);

    stream.close();
  });

  it('drops short repeated live alternatives before they become final text', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const events: LiveSttTranscriptEvent[] = [];

    const stream = connectLiveSttStream('ws://127.0.0.1:18220/ws/stream', {
      onTranscriptEvent: (event) => events.push(event),
    });
    const ws = FakeWebSocket.instances[0];

    ws?.open();
    ws?.message({ type: 'ready' });
    ws?.message({
      type: 'final',
      seq: 0,
      text: 'Merhabalar. sesim... gel... Merhabalar sesim geliyor mu?',
      elapsed_ms: 760,
      rms: 0.04,
    });

    expect(events).toEqual([]);

    stream.close();
  });

  it('drops inflected near-duplicate final alternatives when no stable draft exists', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const events: LiveSttTranscriptEvent[] = [];

    const stream = connectLiveSttStream('ws://127.0.0.1:18220/ws/stream', {
      onTranscriptEvent: (event) => events.push(event),
    });
    const ws = FakeWebSocket.instances[0];

    ws?.open();
    ws?.message({ type: 'ready' });
    ws?.message({
      type: 'final',
      seq: 0,
      text: 'Benim akışa aktiftim. Benim akışa aktif diyorsun. Elime akışı aktif diyorsunuz.',
      elapsed_ms: 760,
      rms: 0.04,
    });

    expect(events).toEqual([]);

    stream.close();
  });

  it('drops repeated final correction fragments from rolling STT alternatives', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const events: LiveSttTranscriptEvent[] = [];

    const stream = connectLiveSttStream('ws://127.0.0.1:18220/ws/stream', {
      onTranscriptEvent: (event) => events.push(event),
    });
    const ws = FakeWebSocket.instances[0];

    ws?.open();
    ws?.message({ type: 'ready' });
    ws?.message({
      type: 'final',
      seq: 0,
      text: 'Kendime Kendimi al. Kendime akışa. Kendime akış al. Kendime akışa akışa Kendimi akışa aktif. Kelime akışı aktif.',
      elapsed_ms: 760,
      rms: 0.04,
    });

    expect(events).toEqual([]);

    stream.close();
  });

  it('keeps a stable draft when the final correction chain repeats alternatives', () => {
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
      tentative: 'Kelime akışı aktif görünüyor',
      elapsed_ms: 180,
      rms: 0.04,
      source: 'medium',
    });
    vi.advanceTimersByTime(140);
    ws?.message({
      type: 'final',
      seq: 0,
      text: 'Kendime Kendimi al. Kendime akışa. Kendime akış al. Kendime akışa akışa Kendimi akışa aktif. Kelime akışı aktif.',
      elapsed_ms: 760,
      rms: 0.04,
    });

    expect(events.at(-1)).toMatchObject({
      id: 'stream:0',
      status: 'final',
      text: 'Kelime akışı aktif görünüyor',
    });

    stream.close();
  });

  it('keeps normal final speech that mentions the live word flow once', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const events: LiveSttTranscriptEvent[] = [];

    const stream = connectLiveSttStream('ws://127.0.0.1:18220/ws/stream', {
      onTranscriptEvent: (event) => events.push(event),
    });
    const ws = FakeWebSocket.instances[0];

    ws?.open();
    ws?.message({ type: 'ready' });
    ws?.message({
      type: 'final',
      seq: 0,
      text: 'Kelime akışı aktif ve doğruluk oranı gayet iyi.',
      elapsed_ms: 620,
      rms: 0.04,
    });

    expect(events.at(-1)).toMatchObject({
      id: 'stream:0',
      status: 'final',
      text: 'Kelime akışı aktif ve doğruluk oranı gayet iyi.',
    });

    stream.close();
  });

  it('finalizes the stable draft when the final payload is a repetitive decode loop', () => {
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
      tentative: 'Kelime akışı aktif görünüyor',
      elapsed_ms: 180,
      rms: 0.04,
      source: 'medium',
    });
    vi.advanceTimersByTime(140);
    ws?.message({
      type: 'final',
      seq: 0,
      text: 'Akşama aktif diyorsun Akşam aktif diyorsun ya Akşama aktif diyorsun yani Akışa aktif diyorsun yani.',
      elapsed_ms: 760,
      rms: 0.04,
    });

    expect(events.at(-1)).toMatchObject({
      id: 'stream:0',
      status: 'final',
      text: 'Kelime akışı aktif görünüyor',
    });

    stream.close();
  });

  it('falls back to the stable draft when the final payload is a known short artifact', () => {
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
      tentative: 'Konuşulanların büyük kısmı yazılmıyor',
      elapsed_ms: 180,
      rms: 0.04,
      source: 'medium',
    });
    vi.advanceTimersByTime(140);
    ws?.message({
      type: 'final',
      seq: 0,
      text: 'Neroba',
      elapsed_ms: 760,
      rms: 0.04,
    });

    expect(events.at(-1)).toMatchObject({
      id: 'stream:0',
      status: 'final',
      text: 'Konuşulanların büyük kısmı yazılmıyor',
    });

    stream.close();
  });

  it('does not finalize a short draft when the final payload is a repetitive decode loop', () => {
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
      tentative: 'Böyle...',
      elapsed_ms: 180,
      rms: 0.04,
      source: 'medium',
    });
    vi.advanceTimersByTime(140);
    ws?.message({
      type: 'final',
      seq: 0,
      text: 'Akşama aktif diyorsun Akşam aktif diyorsun ya Akşama aktif diyorsun yani Akışa aktif diyorsun yani.',
      elapsed_ms: 760,
      rms: 0.04,
    });

    expect(events).toEqual([
      expect.objectContaining({
        id: 'stream:0',
        status: 'draft',
        text: 'Böyle...',
      }),
    ]);

    stream.close();
  });

  it('finalizes a clean two-word draft when the final payload is a repetitive decode loop', () => {
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
      tentative: 'devam edelim',
      elapsed_ms: 180,
      rms: 0.04,
      source: 'medium',
    });
    vi.advanceTimersByTime(140);
    ws?.message({
      type: 'final',
      seq: 0,
      text: 'Akşama aktif diyorsun Akşam aktif diyorsun ya Akşama aktif diyorsun yani Akışa aktif diyorsun yani.',
      elapsed_ms: 760,
      rms: 0.04,
    });

    expect(events.at(-1)).toMatchObject({
      id: 'stream:0',
      status: 'final',
      text: 'devam edelim',
    });

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

  it('keeps already displayed rolling-window words when final payload is shorter', () => {
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
      tentative: 'Merhaba nasılsın bugün toplantıdayız',
      elapsed_ms: 180,
      rms: 0.04,
      source: 'medium',
    });
    vi.advanceTimersByTime(280);
    ws?.message({
      type: 'final',
      seq: 0,
      text: 'bugün toplantıdayız.',
      elapsed_ms: 320,
      rms: 0.04,
    });

    expect(events.at(-1)).toMatchObject({
      id: 'stream:0',
      status: 'final',
      text: 'Merhaba nasılsın bugün toplantıdayız.',
    });

    stream.close();
  });

  it('applies final suffix punctuation without dropping displayed prefix words', () => {
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
      tentative: 'Bu cümle doğru şekilde yazılıyor',
      elapsed_ms: 180,
      rms: 0.04,
      source: 'medium',
    });
    vi.advanceTimersByTime(280);
    ws?.message({
      type: 'final',
      seq: 0,
      text: 'doğru şekilde yazılıyor.',
      elapsed_ms: 320,
      rms: 0.04,
    });

    expect(events.at(-1)).toMatchObject({
      id: 'stream:0',
      status: 'final',
      text: 'Bu cümle doğru şekilde yazılıyor.',
    });

    stream.close();
  });

  it('keeps a medium draft and appends final-only tail words from a short correction fragment', () => {
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
      tentative: 'Söylediklerimin yarısını ne söylediklerimin yarısını neden',
      elapsed_ms: 180,
      rms: 0.04,
      source: 'medium',
    });
    vi.advanceTimersByTime(500);
    ws?.message({
      type: 'final',
      seq: 0,
      text: 'Kısmın yarısının neden yok?',
      elapsed_ms: 760,
      rms: 0.04,
    });

    expect(events.at(-1)).toMatchObject({
      id: 'stream:0',
      status: 'final',
      text: 'Söylediklerimin yarısını ne söylediklerimin yarısını neden yok?',
    });

    stream.close();
  });

  it('keeps a longer stable draft when a short final has little speech overlap', () => {
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
      tentative: 'Konuşulanların çok büyük kısmı yazılmıyor üstüne yazıyor gibi sürekli',
      elapsed_ms: 180,
      rms: 0.04,
      source: 'medium',
    });
    vi.advanceTimersByTime(700);
    ws?.message({
      type: 'final',
      seq: 0,
      text: 'Görüşmek üzere.',
      elapsed_ms: 760,
      rms: 0.04,
    });

    expect(events.at(-1)).toMatchObject({
      id: 'stream:0',
      status: 'final',
      text: 'Konuşulanların çok büyük kısmı yazılmıyor üstüne yazıyor gibi sürekli',
    });

    stream.close();
  });

  it('opens a new local segment when the server reuses a finalized sequence', () => {
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
      tentative: 'İlk konu tamam',
      elapsed_ms: 140,
      rms: 0.04,
      source: 'medium',
    });
    ws?.message({
      type: 'final',
      seq: 0,
      text: 'İlk konu tamam.',
      elapsed_ms: 260,
      rms: 0.04,
    });
    ws?.message({
      type: 'partial',
      seq: 0,
      confirmed: '',
      tentative: 'İkinci konu başladı',
      elapsed_ms: 400,
      rms: 0.04,
      source: 'medium',
    });
    ws?.message({
      type: 'final',
      seq: 0,
      text: 'İkinci konu başladı.',
      elapsed_ms: 520,
      rms: 0.04,
    });

    expect(events.map((event) => [event.id, event.status, event.text])).toEqual([
      ['stream:0', 'draft', 'İlk'],
      ['stream:0', 'final', 'İlk konu tamam.'],
      ['stream:0:1', 'draft', 'İkinci'],
      ['stream:0:1', 'final', 'İkinci konu başladı.'],
    ]);

    stream.close();
  });

  it('opens a new local segment when the server reuses a finalized sequence with a final-only event', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const events: LiveSttTranscriptEvent[] = [];

    const stream = connectLiveSttStream('ws://127.0.0.1:18220/ws/stream', {
      onTranscriptEvent: (event) => events.push(event),
    });
    const ws = FakeWebSocket.instances[0];

    ws?.open();
    ws?.message({ type: 'ready' });
    ws?.message({
      type: 'final',
      seq: 0,
      text: 'İlk konu tamam.',
      elapsed_ms: 260,
      rms: 0.04,
    });
    ws?.message({
      type: 'final',
      seq: 0,
      text: 'İkinci konu başladı.',
      elapsed_ms: 520,
      rms: 0.04,
    });

    expect(events.map((event) => [event.id, event.status, event.text])).toEqual([
      ['stream:0', 'final', 'İlk konu tamam.'],
      ['stream:0:1', 'final', 'İkinci konu başladı.'],
    ]);

    stream.close();
  });

  it('drops leading text carried over from the previous final segment', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const events: LiveSttTranscriptEvent[] = [];

    const stream = connectLiveSttStream('ws://127.0.0.1:18220/ws/stream', {
      onTranscriptEvent: (event) => events.push(event),
    });
    const ws = FakeWebSocket.instances[0];

    ws?.open();
    ws?.message({ type: 'ready' });
    ws?.message({
      type: 'final',
      seq: 0,
      text: 'Merhaba.',
      elapsed_ms: 260,
      rms: 0.04,
    });
    ws?.message({
      type: 'final',
      seq: 1,
      text: 'Merhaba burada hava çok.',
      elapsed_ms: 520,
      rms: 0.04,
    });

    expect(events.map((event) => [event.id, event.status, event.text])).toEqual([
      ['stream:0', 'final', 'Merhaba.'],
      ['stream:1', 'final', 'burada hava çok.'],
    ]);

    stream.close();
  });

  it('drops a single repeated carry-over word when the next segment has new text', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const events: LiveSttTranscriptEvent[] = [];

    const stream = connectLiveSttStream('ws://127.0.0.1:18220/ws/stream', {
      onTranscriptEvent: (event) => events.push(event),
    });
    const ws = FakeWebSocket.instances[0];

    ws?.open();
    ws?.message({ type: 'ready' });
    ws?.message({
      type: 'final',
      seq: 0,
      text: 'Ben sana bir kelime merhaba dedim. Sen uc tane ayri merhaba.',
      elapsed_ms: 260,
      rms: 0.04,
    });
    ws?.message({
      type: 'final',
      seq: 1,
      text: 'Merhaba enteresan seyler yapabiliyor musun?',
      elapsed_ms: 520,
      rms: 0.04,
    });

    expect(events.at(-1)).toMatchObject({
      id: 'stream:1',
      status: 'final',
      text: 'enteresan seyler yapabiliyor musun?',
    });

    stream.close();
  });

  it('keeps short Turkish inflected repeats when dropping them would remove the subject', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const events: LiveSttTranscriptEvent[] = [];

    const stream = connectLiveSttStream('ws://127.0.0.1:18220/ws/stream', {
      onTranscriptEvent: (event) => events.push(event),
    });
    const ws = FakeWebSocket.instances[0];

    ws?.open();
    ws?.message({ type: 'ready' });
    ws?.message({
      type: 'final',
      seq: 0,
      text: 'Beni anlıyor musun? Söylediklerimin yarısı.',
      elapsed_ms: 260,
      rms: 0.04,
    });
    ws?.message({
      type: 'final',
      seq: 1,
      text: 'Söylediklerimin yarısını neden yok?',
      elapsed_ms: 520,
      rms: 0.04,
    });

    expect(events.at(-1)).toMatchObject({
      id: 'stream:1',
      status: 'final',
      text: 'Söylediklerimin yarısını neden yok?',
    });

    stream.close();
  });

  it('keeps single-word inflected repeats when they are not exact carry-over', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const events: LiveSttTranscriptEvent[] = [];

    const stream = connectLiveSttStream('ws://127.0.0.1:18220/ws/stream', {
      onTranscriptEvent: (event) => events.push(event),
    });
    const ws = FakeWebSocket.instances[0];

    ws?.open();
    ws?.message({ type: 'ready' });
    ws?.message({
      type: 'final',
      seq: 0,
      text: 'Ben bir kelime merhaba dedim.',
      elapsed_ms: 260,
      rms: 0.04,
    });
    ws?.message({
      type: 'final',
      seq: 1,
      text: 'Merhabayı başa tekrar yazma.',
      elapsed_ms: 520,
      rms: 0.04,
    });

    expect(events.at(-1)).toMatchObject({
      id: 'stream:1',
      status: 'final',
      text: 'Merhabayı başa tekrar yazma.',
    });

    stream.close();
  });

  it('drops cumulative carried-over final text across consecutive segments', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const events: LiveSttTranscriptEvent[] = [];

    const stream = connectLiveSttStream('ws://127.0.0.1:18220/ws/stream', {
      onTranscriptEvent: (event) => events.push(event),
    });
    const ws = FakeWebSocket.instances[0];

    ws?.open();
    ws?.message({ type: 'ready' });
    ws?.message({
      type: 'final',
      seq: 0,
      text: 'Merhaba.',
      elapsed_ms: 260,
      rms: 0.04,
    });
    ws?.message({
      type: 'final',
      seq: 1,
      text: 'Merhaba burada hava cok.',
      elapsed_ms: 520,
      rms: 0.04,
    });
    ws?.message({
      type: 'final',
      seq: 2,
      text: 'Merhaba burada hava cok degisik seyler oluyor.',
      elapsed_ms: 620,
      rms: 0.04,
    });

    expect(events.map((event) => [event.id, event.status, event.text])).toEqual([
      ['stream:0', 'final', 'Merhaba.'],
      ['stream:1', 'final', 'burada hava cok.'],
      ['stream:2', 'final', 'degisik seyler oluyor.'],
    ]);

    stream.close();
  });

  it('keeps unrelated new final segments after a previous final segment', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const events: LiveSttTranscriptEvent[] = [];

    const stream = connectLiveSttStream('ws://127.0.0.1:18220/ws/stream', {
      onTranscriptEvent: (event) => events.push(event),
    });
    const ws = FakeWebSocket.instances[0];

    ws?.open();
    ws?.message({ type: 'ready' });
    ws?.message({
      type: 'final',
      seq: 0,
      text: 'İlk konu tamam.',
      elapsed_ms: 260,
      rms: 0.04,
    });
    ws?.message({
      type: 'final',
      seq: 1,
      text: 'İkinci konu başladı.',
      elapsed_ms: 520,
      rms: 0.04,
    });

    expect(events.map((event) => [event.id, event.status, event.text])).toEqual([
      ['stream:0', 'final', 'İlk konu tamam.'],
      ['stream:1', 'final', 'İkinci konu başladı.'],
    ]);

    stream.close();
  });

  it('ignores duplicate final replays for the same finalized sequence', () => {
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const events: LiveSttTranscriptEvent[] = [];

    const stream = connectLiveSttStream('ws://127.0.0.1:18220/ws/stream', {
      onTranscriptEvent: (event) => events.push(event),
    });
    const ws = FakeWebSocket.instances[0];

    ws?.open();
    ws?.message({ type: 'ready' });
    ws?.message({
      type: 'final',
      seq: 0,
      text: 'İlk konu tamam.',
      elapsed_ms: 260,
      rms: 0.04,
    });
    ws?.message({
      type: 'final',
      seq: 0,
      text: 'İlk konu tamam',
      elapsed_ms: 280,
      rms: 0.04,
    });

    expect(events.map((event) => [event.id, event.status, event.text])).toEqual([
      ['stream:0', 'final', 'İlk konu tamam.'],
    ]);

    stream.close();
  });

  it('keeps late final and revised segment events but reports degraded without terminal drained', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const events: LiveSttTranscriptEvent[] = [];
    const statuses: LiveSttStreamStatusEvent[] = [];

    const stream = connectLiveSttStream('ws://127.0.0.1:18220/ws/stream', {
      onStatus: (event) => statuses.push(event),
      onTranscriptEvent: (event) => events.push(event),
    });
    const ws = FakeWebSocket.instances[0];
    ws?.open();
    ws?.message({ type: 'ready' });
    stream.send(new Float32Array([0.01, 0.01]));

    const stopPromise = stream.stop();
    let settled = false;
    void stopPromise.then(() => {
      settled = true;
    });
    expect(ws?.readyState).toBe(FakeWebSocket.OPEN);
    expect(statuses.at(-1)).toEqual({ status: 'draining' });

    ws?.message({
      type: 'final',
      seq: 0,
      text: 'İlk final metin.',
      elapsed_ms: 300,
      rms: 0.04,
    });
    vi.advanceTimersByTime(1_000);
    ws?.message({
      type: 'final',
      seq: 0,
      text: 'Düzeltilmiş geç final metin.',
      elapsed_ms: 450,
      rms: 0.04,
    });

    vi.advanceTimersByTime(1_249);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(events.map((event) => [event.id, event.status, event.text])).toEqual([
      ['stream:0', 'final', 'İlk final metin.'],
      ['stream:0:1', 'final', 'Düzeltilmiş geç final metin.'],
    ]);

    await vi.advanceTimersByTimeAsync(1);
    await expect(stopPromise).resolves.toEqual({
      state: 'degraded',
      reason: 'quiet',
      acknowledged: false,
    });
    expect(ws?.readyState).toBe(FakeWebSocket.CLOSED);
    expect(ws?.closeCalls).toBe(1);
    expect(statuses.at(-1)).toEqual({ status: 'closed', reason: 'quiet' });
  });

  it('requests EOF only when the server advertises support and waits for terminal drained', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);

    const stream = connectLiveSttStream('ws://127.0.0.1:18220/ws/stream');
    const ws = FakeWebSocket.instances[0];
    ws?.open();
    ws?.message({ type: 'ready', capabilities: ['eof'] });
    stream.send(new Float32Array([0.01]));

    const stopPromise = stream.stop();

    expect(ws?.sent).toHaveLength(2);
    expect(ws?.sent[1]).toBe(JSON.stringify({ type: 'eof' }));
    ws?.message({ type: 'eof_ack' });
    await vi.advanceTimersByTimeAsync(1_250);
    let settled = false;
    void stopPromise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    ws?.message({ type: 'drained' });

    await expect(stopPromise).resolves.toEqual({
      state: 'drained',
      reason: 'drained',
      acknowledged: true,
    });
  });

  it('honors the negotiated terminal budget instead of closing after the legacy timeout', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);

    const stream = connectLiveSttStream('ws://127.0.0.1:18220/ws/stream');
    const ws = FakeWebSocket.instances[0];
    ws?.open();
    ws?.message({
      type: 'ready',
      capabilities: ['eof'],
      terminal_timeout_ms: 60_000,
    });
    stream.send(new Float32Array([0.01]));

    const stopPromise = stream.stop();
    let settled = false;
    void stopPromise.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).toBe(false);
    expect(ws?.readyState).toBe(FakeWebSocket.OPEN);

    ws?.message({ type: 'eof_ack' });
    ws?.message({ type: 'drained' });
    await expect(stopPromise).resolves.toEqual({
      state: 'drained',
      reason: 'drained',
      acknowledged: true,
    });
  });

  it('bounds an excessive negotiated terminal timeout', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);

    const stream = connectLiveSttStream('ws://127.0.0.1:18220/ws/stream');
    const ws = FakeWebSocket.instances[0];
    ws?.open();
    ws?.message({
      type: 'ready',
      capabilities: ['eof'],
      terminal_timeout_ms: 600_000,
    });
    stream.send(new Float32Array([0.01]));

    const stopPromise = stream.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(stopPromise).resolves.toEqual({
      state: 'degraded',
      reason: 'timeout',
      acknowledged: false,
    });
  });

  it('keeps draining status when a connecting socket becomes ready after stop', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const statuses: LiveSttStreamStatusEvent[] = [];
    const onReady = vi.fn();

    const stream = connectLiveSttStream('ws://127.0.0.1:18220/ws/stream', {
      onReady,
      onStatus: (event) => statuses.push(event),
    });
    const ws = FakeWebSocket.instances[0];
    stream.send(new Float32Array([0.01]));
    const stopPromise = stream.stop();

    ws?.open();
    ws?.message({ type: 'ready' });
    expect(statuses.map((event) => event.status)).toEqual(['connecting', 'draining']);
    expect(onReady).not.toHaveBeenCalled();
    expect(ws?.sent).toHaveLength(1);

    ws?.message({
      type: 'final',
      seq: 0,
      text: 'Bağlantı sonrası final.',
      elapsed_ms: 300,
      rms: 0.04,
    });
    await vi.advanceTimersByTimeAsync(1_250);
    await expect(stopPromise).resolves.toEqual({
      state: 'degraded',
      reason: 'quiet',
      acknowledged: false,
    });
  });

  it('returns a degraded timeout without hanging and removes listeners and timers', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const events: LiveSttTranscriptEvent[] = [];
    const statuses: LiveSttStreamStatusEvent[] = [];
    const errors: string[] = [];

    const stream = connectLiveSttStream('ws://127.0.0.1:18220/ws/stream', {
      onStatus: (event) => statuses.push(event),
      onTranscriptEvent: (event) => events.push(event),
      onError: (error) => errors.push(error.message),
    });
    const ws = FakeWebSocket.instances[0];
    ws?.open();
    ws?.message({ type: 'ready' });
    stream.send(new Float32Array([0.01]));

    const stopPromise = stream.stop();
    await vi.advanceTimersByTimeAsync(8_000);

    await expect(stopPromise).resolves.toEqual({
      state: 'degraded',
      reason: 'timeout',
      acknowledged: false,
    });
    expect(statuses).toContainEqual({
      status: 'degraded',
      reason: 'Direct STT stop drain zaman aşımına uğradı; geç final doğrulanamadı.',
    });
    expect(errors).toEqual([
      'Direct STT stop drain zaman aşımına uğradı; geç final doğrulanamadı.',
    ]);
    expect(vi.getTimerCount()).toBe(0);

    ws?.message({
      type: 'final',
      seq: 0,
      text: 'Listener temizliğinden sonra gelmemeli.',
      elapsed_ms: 500,
      rms: 0.04,
    });
    expect(events).toEqual([]);
  });

  it.each([
    ['close', 'socket-close'],
    ['error', 'socket-error'],
  ] as const)('settles stop on socket %s without reconnecting', async (event, reason) => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);

    const stream = connectLiveSttStream('ws://127.0.0.1:18220/ws/stream');
    const ws = FakeWebSocket.instances[0];
    ws?.open();
    ws?.message({ type: 'ready' });
    stream.send(new Float32Array([0.01]));
    const stopPromise = stream.stop();

    if (event === 'close') {
      ws?.close();
    } else {
      ws?.fail();
    }

    await expect(stopPromise).resolves.toEqual({
      state: 'degraded',
      reason,
      acknowledged: false,
    });
    await vi.runAllTimersAsync();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns the same stop promise and tears down exactly once', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const statuses: LiveSttStreamStatusEvent[] = [];

    const stream = connectLiveSttStream('ws://127.0.0.1:18220/ws/stream', {
      onStatus: (event) => statuses.push(event),
    });
    const ws = FakeWebSocket.instances[0];
    ws?.open();
    ws?.message({ type: 'ready' });
    stream.send(new Float32Array([0.01]));

    const first = stream.stop();
    const second = stream.stop();
    expect(second).toBe(first);

    ws?.message({
      type: 'final',
      seq: 0,
      text: 'Tek final.',
      elapsed_ms: 300,
      rms: 0.04,
    });
    await vi.advanceTimersByTimeAsync(1_250);

    await expect(first).resolves.toEqual(await second);
    expect(ws?.closeCalls).toBe(1);
    expect(statuses.filter((event) => event.status === 'draining')).toHaveLength(1);
    expect(statuses.filter((event) => event.status === 'closed')).toHaveLength(1);
  });

  it('reconnects after a transient close and flushes buffered audio frames', () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const onReady = vi.fn();
    const statuses: LiveSttStreamStatusEvent[] = [];

    const stream = connectLiveSttStream('ws://127.0.0.1:18220/ws/stream', {
      onReady,
      onStatus: (event) => statuses.push(event),
    });
    const first = FakeWebSocket.instances[0];

    first?.open();
    first?.message({ type: 'ready' });
    stream.send(new Float32Array([0.1, 0.2]));
    expect(first?.sent).toHaveLength(1);

    first?.close();
    stream.send(new Float32Array([0.3, 0.4]));
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(statuses).toContainEqual({
      status: 'reconnecting',
      attempt: 1,
      maxAttempts: 60,
      retryDelayMs: 250,
      reason: 'bağlantı kapandı',
    });

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

  it('keeps retrying long enough for a restarted local STT tunnel', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const errors: string[] = [];
    const statuses: LiveSttStreamStatusEvent[] = [];

    const stream = connectLiveSttStream('ws://127.0.0.1:18220/ws/stream', {
      onStatus: (event) => statuses.push(event),
      onError: (error) => errors.push(error.message),
    });

    FakeWebSocket.instances[0]?.close();
    for (let attempt = 1; attempt < 10; attempt += 1) {
      vi.advanceTimersByTime(2_000);
      FakeWebSocket.instances[attempt]?.close();
    }

    expect(errors).toEqual([]);
    expect(statuses).toContainEqual(
      expect.objectContaining({
        status: 'reconnecting',
        attempt: 10,
        maxAttempts: 60,
        reason: 'bağlantı kapandı',
      }),
    );

    stream.close();
  });

  it('reconnects when active audio stalls without usable transcript events', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const statuses: LiveSttStreamStatusEvent[] = [];

    const stream = connectLiveSttStream('ws://127.0.0.1:18220/ws/stream', {
      onStatus: (event) => statuses.push(event),
    });
    const first = FakeWebSocket.instances[0];
    first?.open();
    first?.message({ type: 'ready' });

    stream.send(new Float32Array([0.002, 0.002]));
    expect(first?.sent).toHaveLength(1);

    vi.advanceTimersByTime(11_999);
    stream.send(new Float32Array([0.002, 0.002]));
    expect(first?.readyState).toBe(FakeWebSocket.OPEN);

    vi.advanceTimersByTime(1);
    stream.send(new Float32Array([0.002, 0.002]));

    expect(first?.readyState).toBe(FakeWebSocket.CLOSED);
    expect(statuses).toContainEqual(
      expect.objectContaining({
        status: 'reconnecting',
        attempt: 1,
        maxAttempts: 60,
        reason: 'transcript akışı gecikti',
      }),
    );

    vi.advanceTimersByTime(250);
    const second = FakeWebSocket.instances[1];
    second?.open();
    second?.message({ type: 'ready' });
    expect(second?.sent).toHaveLength(1);

    stream.close();
  });

  it('reconnects when active audio only receives duplicate partials without transcript growth', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const statuses: LiveSttStreamStatusEvent[] = [];
    const events: LiveSttTranscriptEvent[] = [];

    const stream = connectLiveSttStream('ws://127.0.0.1:18220/ws/stream', {
      onStatus: (event) => statuses.push(event),
      onTranscriptEvent: (event) => events.push(event),
    });
    const first = FakeWebSocket.instances[0];
    first?.open();
    first?.message({ type: 'ready' });
    first?.message({
      type: 'partial',
      seq: 0,
      confirmed: '',
      tentative: 'Merhaba',
      elapsed_ms: 120,
      rms: 0.04,
      source: 'medium',
    });
    expect(events.map((event) => event.text)).toEqual(['Merhaba']);

    vi.advanceTimersByTime(11_999);
    first?.message({
      type: 'partial',
      seq: 0,
      confirmed: '',
      tentative: 'Merhaba',
      elapsed_ms: 12_119,
      rms: 0.04,
      source: 'medium',
    });
    expect(events.map((event) => event.text)).toEqual(['Merhaba']);

    vi.advanceTimersByTime(1);
    stream.send(new Float32Array([0.002, 0.002]));

    expect(first?.readyState).toBe(FakeWebSocket.CLOSED);
    expect(statuses).toContainEqual(
      expect.objectContaining({
        status: 'reconnecting',
        attempt: 1,
        maxAttempts: 60,
        reason: 'transcript akışı gecikti',
      }),
    );

    stream.close();
  });
});
