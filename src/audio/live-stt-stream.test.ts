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

  it('replaces the draft when a shorter final is an unrelated correction fragment', () => {
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
      text: 'Kısmın yarısının neden yok?',
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

    stream.send(new Float32Array([0.1, 0.1]));
    expect(first?.sent).toHaveLength(1);

    vi.advanceTimersByTime(12_000);
    stream.send(new Float32Array([0.2, 0.2]));

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
});
