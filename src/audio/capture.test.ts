// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolvePcmWorkletModuleUrl, startRecording, testAudioCaptureWorklet } from './capture';

class FakeTrack {
  stop = vi.fn();
}

class FakeMediaStream {
  constructor(private readonly tracks: FakeTrack[] = []) {}

  getTracks(): FakeTrack[] {
    return this.tracks;
  }

  getAudioTracks(): FakeTrack[] {
    return this.tracks;
  }

  getVideoTracks(): FakeTrack[] {
    return [];
  }
}

class FakeAudioNode {
  connect(): FakeAudioNode {
    return this;
  }

  disconnect(): void {
    return undefined;
  }
}

class FakeAudioContext {
  static addModule = vi.fn().mockResolvedValue(undefined);

  sampleRate = 48_000;
  destination = new FakeAudioNode();
  audioWorklet = {
    addModule: FakeAudioContext.addModule,
  };
  close = vi.fn().mockResolvedValue(undefined);

  createMediaStreamSource(): FakeAudioNode {
    return new FakeAudioNode();
  }

  createGain(): FakeAudioNode & { gain: { value: number } } {
    return Object.assign(new FakeAudioNode(), { gain: { value: 1 } });
  }

  createChannelMerger(): FakeAudioNode {
    return new FakeAudioNode();
  }
}

class FakeAudioWorkletNode extends FakeAudioNode {
  static lastInstance: FakeAudioWorkletNode | null = null;

  port: { onmessage: ((ev: MessageEvent<Float32Array>) => void) | null } = {
    onmessage: null,
  };

  constructor() {
    super();
    FakeAudioWorkletNode.lastInstance = this;
  }
}

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

function installBrowserAudioMocks(): {
  micTrack: FakeTrack;
  getDisplayMedia: ReturnType<typeof vi.fn>;
} {
  const micTrack = new FakeTrack();
  const getDisplayMedia = vi.fn().mockRejectedValue(new Error('Failed to get sources'));
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi.fn().mockResolvedValue(new FakeMediaStream([micTrack])),
      getDisplayMedia,
    },
  });
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
  vi.stubGlobal('MediaStream', FakeMediaStream);
  return { micTrack, getDisplayMedia };
}

function setUserAgent(userAgent: string): void {
  Object.defineProperty(navigator, 'userAgent', {
    configurable: true,
    value: userAgent,
  });
}

function installElectronApiMock(): void {
  window.electronAPI = {
    app: {
      getVersion: vi.fn(),
      getAutoLaunch: vi.fn(),
      setAutoLaunch: vi.fn(),
    },
    tray: {
      setRecordingActive: vi.fn(),
      setPaused: vi.fn(),
      onStopRequested: vi.fn(() => vi.fn()),
      onPauseRequested: vi.fn(() => vi.fn()),
      onResumeRequested: vi.fn(() => vi.fn()),
    },
    auth: {
      login: vi.fn(),
      logout: vi.fn(),
      status: vi.fn(),
    },
    meeting: {
      listRecent: vi.fn().mockResolvedValue({
        meetings: [],
        page: 0,
        size: 20,
        totalElements: 0,
        totalPages: 0,
      }),
      createContract: vi.fn(),
      analyze: vi.fn(),
      getIntelligenceResult: vi.fn(),
      getCanonicalTranscript: vi.fn(),
      startLiveAnalysis: vi.fn().mockResolvedValue({ started: true }),
      stopLiveAnalysis: vi.fn().mockResolvedValue({ stopped: true }),
      onLiveAnalysisFrame: vi.fn(() => (): void => {}),
      onLiveAnalysisStatus: vi.fn(() => (): void => {}),
      createAction: vi.fn(async () => ({
        id: 'stub-action',
        meetingId: 'stub',
        description: 'stub',
        assigneeSubject: null,
        status: 'OPEN',
        dueAt: null,
        version: 0,
      })),
      searchAssignees: vi.fn(async () => []),
    },
    audio: {
      recorderConfig: vi.fn(),
      reconcileLifecycle: vi.fn(),
      permissionStatus: vi.fn(),
      requestPermission: vi.fn(),
      prepareCapture: vi.fn().mockResolvedValue({ ok: true, expiresAtMs: Date.now() + 1000 }),
      cancelCapture: vi.fn().mockResolvedValue({ ok: true }),
      consent: vi.fn(),
      start: vi.fn().mockResolvedValue({
        sessionId: 'SES-1',
        transcriptSessionId: '33333333-3333-4333-8333-333333333333',
        captureId: 'CAP-1',
      }),
      sendChunk: vi.fn(),
      sendLiveFrame: vi.fn().mockResolvedValue({ accepted: true }),
      finish: vi.fn().mockResolvedValue({ ok: true, liveTranscript: null }),
      abort: vi.fn().mockResolvedValue({ ok: true }),
      rendererUnloaded: vi.fn(),
      onTranscriptEvent: vi.fn(() => vi.fn()),
      onTranscriptError: vi.fn(() => vi.fn()),
      onTranscriptRecovered: vi.fn(() => () => {}),
    },
  };
}

afterEach(() => {
  FakeAudioWorkletNode.lastInstance = null;
  FakeAudioContext.addModule.mockReset();
  FakeAudioContext.addModule.mockResolvedValue(undefined);
  FakeWebSocket.instances = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete window.electronAPI;
});

describe('startRecording', () => {
  it('resolves the worklet next to the rendered document for file-backed Electron builds', () => {
    expect(resolvePcmWorkletModuleUrl('file:///Applications/Meeting/dist/index.html')).toBe(
      'file:///Applications/Meeting/dist/pcm-worklet.js',
    );
    expect(resolvePcmWorkletModuleUrl('http://localhost:5173/')).toBe(
      'http://localhost:5173/pcm-worklet.js',
    );
  });

  it('preflights the capture worklet without opening the microphone', async () => {
    installElectronApiMock();
    installBrowserAudioMocks();

    const result = await testAudioCaptureWorklet(
      500,
      'file:///Applications/Meeting/dist/index.html',
    );

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        message: 'Ses işleyici hazır.',
        moduleUrl: 'file:///Applications/Meeting/dist/pcm-worklet.js',
      }),
    );
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it('reports capture worklet preload failures as preflight errors', async () => {
    installElectronApiMock();
    installBrowserAudioMocks();
    FakeAudioContext.addModule.mockRejectedValueOnce(new Error('Unable to load a worklet module'));

    const result = await testAudioCaptureWorklet(
      500,
      'file:///Applications/Meeting/dist/index.html',
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain('Unable to load a worklet module');
    expect(result.moduleUrl).toBe('file:///Applications/Meeting/dist/pcm-worklet.js');
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it('skips loopback capture on macOS and starts mic-only recording', async () => {
    installElectronApiMock();
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 15_5)');
    const { micTrack, getDisplayMedia } = installBrowserAudioMocks();

    const recorder = await startRecording('meeting-1', 'desktop-1', {
      liveSttContextTerms: ['Zeynep Akkılıç', 'Faz 24'],
    });

    expect(getDisplayMedia).not.toHaveBeenCalled();
    expect(window.electronAPI?.audio.start).toHaveBeenCalledWith('meeting-1', 'desktop-1', [
      'Zeynep Akkılıç',
      'Faz 24',
    ]);
    expect(recorder.hasLoopback).toBe(false);
    expect(window.electronAPI?.audio.cancelCapture).not.toHaveBeenCalled();

    await recorder.stop();

    expect(micTrack.stop).toHaveBeenCalled();
    expect(window.electronAPI?.audio.finish).toHaveBeenCalledWith('CAP-1');
  });

  it('continues mic-only on Windows when system audio source capture fails', async () => {
    installElectronApiMock();
    setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
    const { getDisplayMedia } = installBrowserAudioMocks();

    const recorder = await startRecording('meeting-1', 'desktop-1');

    expect(getDisplayMedia).toHaveBeenCalledWith({ audio: true, video: true });
    expect(window.electronAPI?.audio.start).toHaveBeenCalledWith('meeting-1', 'desktop-1');
    expect(recorder.hasLoopback).toBe(false);

    await recorder.stop();
  });

  it('uploads two-second PCM16 chunks for a balanced latency/accuracy window', async () => {
    installElectronApiMock();
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 15_5)');
    installBrowserAudioMocks();

    await startRecording('meeting-1', 'desktop-1');
    const captureNode = FakeAudioWorkletNode.lastInstance;
    expect(captureNode?.port.onmessage).toBeTypeOf('function');

    captureNode?.port.onmessage?.({
      data: new Float32Array(96_000),
    } as MessageEvent<Float32Array>);

    await Promise.resolve();
    await Promise.resolve();

    expect(window.electronAPI?.audio.sendChunk).toHaveBeenCalledTimes(1);
    expect(window.electronAPI?.audio.sendChunk).toHaveBeenCalledWith({
      captureId: 'CAP-1',
      bytes: expect.objectContaining({ byteLength: 64_000 }),
      startedAtMs: expect.any(Number),
    });
  });

  it('sends no gateway chunk while paused and resumes a contiguous sequence (#37)', async () => {
    installElectronApiMock();
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 15_5)');
    installBrowserAudioMocks();

    const recorder = await startRecording('meeting-1', 'desktop-1');
    const captureNode = FakeAudioWorkletNode.lastInstance;
    const feedOneChunk = (): void => {
      captureNode?.port.onmessage?.({
        data: new Float32Array(96_000),
      } as MessageEvent<Float32Array>);
    };

    // Paused: a full 2s window is dropped — no chunk reaches the gateway, so
    // the sequence tracker never advances during the pause.
    recorder.pause();
    expect(recorder.isPaused()).toBe(true);
    feedOneChunk();
    await Promise.resolve();
    await Promise.resolve();
    expect(window.electronAPI?.audio.sendChunk).not.toHaveBeenCalled();

    // Resumed: chunks flow again, and this is the FIRST send — the pause did
    // not leave a buffered pause-gap chunk queued ahead of it.
    recorder.resume();
    expect(recorder.isPaused()).toBe(false);
    feedOneChunk();
    await Promise.resolve();
    await Promise.resolve();
    expect(window.electronAPI?.audio.sendChunk).toHaveBeenCalledTimes(1);

    await recorder.stop();
  });

  it('pause/resume are no-ops after the recorder has stopped (#37)', async () => {
    installElectronApiMock();
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 15_5)');
    installBrowserAudioMocks();

    const recorder = await startRecording('meeting-1', 'desktop-1');
    await recorder.stop();

    recorder.pause();
    expect(recorder.isPaused()).toBe(false);
    recorder.resume();
    expect(recorder.isPaused()).toBe(false);
  });

  it('streams 100ms Float32 frames to Direct-STT while keeping REST chunks at two seconds', async () => {
    installElectronApiMock();
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 15_5)');
    installBrowserAudioMocks();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const onLiveStreamReady = vi.fn();
    const onAudioActivity = vi.fn();

    const recorder = await startRecording('meeting-1', 'desktop-1', {
      liveSttStreamUrl: 'ws://127.0.0.1:18220/ws/stream',
      onLiveStreamReady,
      onAudioActivity,
    });
    const captureNode = FakeAudioWorkletNode.lastInstance;
    const ws = FakeWebSocket.instances[0];

    expect(ws?.url).toBe('ws://127.0.0.1:18220/ws/stream');
    ws?.open();
    ws?.message({ type: 'ready' });
    expect(onLiveStreamReady).toHaveBeenCalledTimes(1);

    captureNode?.port.onmessage?.({
      data: new Float32Array(48_000),
    } as MessageEvent<Float32Array>);

    expect(onAudioActivity).toHaveBeenCalledWith({
      rms: 0,
      capturedAtMs: expect.any(Number),
    });
    expect(ws?.sent).toHaveLength(10);
    for (const frame of ws?.sent ?? []) {
      expect(frame).toBeInstanceOf(ArrayBuffer);
      expect((frame as ArrayBuffer).byteLength).toBe(6_400);
    }
    expect(window.electronAPI?.audio.sendChunk).not.toHaveBeenCalled();

    await recorder.stop();
  });

  it('streams 100ms PCM16 frames to the gateway in realtime mode without waiting for REST', async () => {
    installElectronApiMock();
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 15_5)');
    installBrowserAudioMocks();

    const recorder = await startRecording('meeting-1', 'desktop-1', {
      sttProvider: 'speechmatics',
      transcriptionMode: 'realtime',
    });
    const captureNode = FakeAudioWorkletNode.lastInstance;

    captureNode?.port.onmessage?.({
      data: new Float32Array(48_000).fill(0.1),
    } as MessageEvent<Float32Array>);
    await Promise.resolve();

    expect(window.electronAPI?.audio.start).toHaveBeenCalledWith(
      'meeting-1',
      'desktop-1',
      undefined,
      'speechmatics',
      'realtime',
    );
    expect(window.electronAPI?.audio.sendLiveFrame).toHaveBeenCalledTimes(10);
    for (const [frame] of vi.mocked(window.electronAPI!.audio.sendLiveFrame).mock.calls) {
      expect(frame).toEqual({
        captureId: 'CAP-1',
        bytes: expect.any(Uint8Array),
        capturedAtMs: expect.any(Number),
      });
      expect(frame.bytes).toHaveLength(3_200);
    }
    expect(window.electronAPI?.audio.sendChunk).not.toHaveBeenCalled();

    await recorder.stop();
  });

  it('preserves a late Direct-STT final but reports degraded without terminal drained', async () => {
    installElectronApiMock();
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 15_5)');
    const { micTrack } = installBrowserAudioMocks();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const events = vi.fn();

    const recorder = await startRecording('meeting-1', 'desktop-1', {
      liveSttStreamUrl: 'ws://127.0.0.1:18220/ws/stream',
      onLiveTranscriptEvent: events,
    });
    const captureNode = FakeAudioWorkletNode.lastInstance;
    const ws = FakeWebSocket.instances[0];
    ws?.open();
    ws?.message({ type: 'ready' });
    captureNode?.port.onmessage?.({
      data: new Float32Array(48_000).fill(0.01),
    } as MessageEvent<Float32Array>);
    vi.useFakeTimers();

    const firstStop = recorder.stop();
    const secondStop = recorder.stop();
    expect(secondStop).toBe(firstStop);
    expect(micTrack.stop).toHaveBeenCalledTimes(1);
    expect(ws?.readyState).toBe(FakeWebSocket.OPEN);

    ws?.message({
      type: 'final',
      seq: 0,
      text: 'Stop sonrası korunan final.',
      elapsed_ms: 400,
      rms: 0.04,
    });
    await vi.advanceTimersByTimeAsync(1_250);

    await expect(firstStop).resolves.toBeUndefined();
    expect(recorder.getStopResult?.()).toEqual({
      gatewayLive: null,
      liveStt: {
        state: 'degraded',
        reason: 'quiet',
        acknowledged: false,
      },
    });
    expect(events).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'stream:0',
        status: 'final',
        text: 'Stop sonrası korunan final.',
      }),
    );
    expect(window.electronAPI?.audio.finish).toHaveBeenCalledTimes(1);
  });

  it('reports a bounded Direct-STT stop timeout as degraded while gateway finish succeeds', async () => {
    installElectronApiMock();
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 15_5)');
    const { micTrack } = installBrowserAudioMocks();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const statuses = vi.fn();
    const errors = vi.fn();

    const recorder = await startRecording('meeting-1', 'desktop-1', {
      liveSttStreamUrl: 'ws://127.0.0.1:18220/ws/stream',
      onLiveStreamStatus: statuses,
      onLiveTranscriptError: errors,
    });
    const captureNode = FakeAudioWorkletNode.lastInstance;
    const ws = FakeWebSocket.instances[0];
    ws?.open();
    ws?.message({ type: 'ready' });
    captureNode?.port.onmessage?.({
      data: new Float32Array(48_000).fill(0.01),
    } as MessageEvent<Float32Array>);
    vi.useFakeTimers();

    const stopPromise = recorder.stop();
    expect(micTrack.stop).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(8_000);

    await expect(stopPromise).resolves.toBeUndefined();
    expect(recorder.getStopResult?.()).toEqual({
      gatewayLive: null,
      liveStt: {
        state: 'degraded',
        reason: 'timeout',
        acknowledged: false,
      },
    });
    expect(window.electronAPI?.audio.finish).toHaveBeenCalledTimes(1);
    expect(statuses).toHaveBeenCalledWith({
      status: 'degraded',
      reason: 'Direct STT stop drain zaman aşımına uğradı; geç final doğrulanamadı.',
    });
    expect(errors).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Direct STT stop drain zaman aşımına uğradı; geç final doğrulanamadı.',
      }),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('finishes the gateway when the Direct-STT socket closes during stop drain', async () => {
    installElectronApiMock();
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 15_5)');
    installBrowserAudioMocks();
    vi.stubGlobal('WebSocket', FakeWebSocket);

    const recorder = await startRecording('meeting-1', 'desktop-1', {
      liveSttStreamUrl: 'ws://127.0.0.1:18220/ws/stream',
    });
    const captureNode = FakeAudioWorkletNode.lastInstance;
    const ws = FakeWebSocket.instances[0];
    ws?.open();
    ws?.message({ type: 'ready' });
    captureNode?.port.onmessage?.({
      data: new Float32Array(48_000).fill(0.01),
    } as MessageEvent<Float32Array>);
    vi.useFakeTimers();

    const stopPromise = recorder.stop();
    ws?.close();

    await expect(stopPromise).resolves.toBeUndefined();
    expect(recorder.getStopResult?.()).toEqual({
      gatewayLive: null,
      liveStt: {
        state: 'degraded',
        reason: 'socket-close',
        acknowledged: false,
      },
    });
    expect(window.electronAPI?.audio.finish).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps microphone recording alive when Direct-STT stream construction fails', async () => {
    installElectronApiMock();
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 15_5)');
    installBrowserAudioMocks();
    class ThrowingWebSocket {
      constructor() {
        throw new Error('invalid direct STT URL');
      }
    }
    vi.stubGlobal('WebSocket', ThrowingWebSocket);
    const onLiveStreamStatus = vi.fn();
    const onLiveTranscriptError = vi.fn();

    const recorder = await startRecording('meeting-1', 'desktop-1', {
      liveSttStreamUrl: 'ws://127.0.0.1:18220/ws/stream',
      onLiveStreamStatus,
      onLiveTranscriptError,
    });

    expect(recorder.sessionId).toBe('SES-1');
    expect(recorder.hasLoopback).toBe(false);
    expect(window.electronAPI?.audio.start).toHaveBeenCalledWith('meeting-1', 'desktop-1');
    expect(onLiveStreamStatus).toHaveBeenCalledWith({ status: 'connecting' });
    expect(onLiveStreamStatus).toHaveBeenCalledWith({
      status: 'error',
      reason: 'invalid direct STT URL',
    });
    expect(onLiveTranscriptError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Live STT stream kurulamadı: invalid direct STT URL',
      }),
    );

    await recorder.stop();

    expect(window.electronAPI?.audio.finish).toHaveBeenCalledWith('CAP-1');
  });

  it('falls back to direct-only capture when gateway start fails and Direct-STT is configured', async () => {
    installElectronApiMock();
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 15_5)');
    const { micTrack } = installBrowserAudioMocks();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.mocked(window.electronAPI!.audio.start).mockRejectedValueOnce(
      new Error('Direct STT baglanti hatasi'),
    );

    const recorder = await startRecording('meeting-1', 'desktop-1', {
      liveSttStreamUrl: 'ws://127.0.0.1:18220/ws/stream',
    });
    const captureNode = FakeAudioWorkletNode.lastInstance;
    const ws = FakeWebSocket.instances[0];

    expect(recorder.sessionId).toMatch(/^LOCAL-/);
    expect(recorder.gatewayActive).toBe(false);
    expect(recorder.gatewayError).toBe('Direct STT baglanti hatasi');
    expect(window.electronAPI?.audio.start).toHaveBeenCalledWith('meeting-1', 'desktop-1');
    expect(ws?.url).toBe('ws://127.0.0.1:18220/ws/stream');

    ws?.open();
    ws?.message({ type: 'ready' });
    captureNode?.port.onmessage?.({
      data: new Float32Array(48_000),
    } as MessageEvent<Float32Array>);

    expect(ws?.sent).toHaveLength(10);
    expect(window.electronAPI?.audio.sendChunk).not.toHaveBeenCalled();

    await recorder.stop();

    expect(micTrack.stop).toHaveBeenCalled();
    expect(window.electronAPI?.audio.finish).not.toHaveBeenCalled();
    expect(window.electronAPI?.audio.abort).not.toHaveBeenCalled();
  });

  it('falls back to direct-only capture for Electron-wrapped Direct-STT startup failures', async () => {
    installElectronApiMock();
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 15_5)');
    const { micTrack } = installBrowserAudioMocks();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.mocked(window.electronAPI!.audio.start).mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'audio:start': Error: Direct STT bağlantı hatası. Kayıt başlatılmadı; mikrofon açılmadı.",
      ),
    );

    const recorder = await startRecording('meeting-1', 'desktop-1', {
      liveSttStreamUrl: 'ws://127.0.0.1:18220/ws/stream',
    });
    const ws = FakeWebSocket.instances[0];

    expect(recorder.sessionId).toMatch(/^LOCAL-/);
    expect(recorder.gatewayActive).toBe(false);
    expect(recorder.gatewayError).toContain('Direct STT bağlantı hatası');
    expect(window.electronAPI?.audio.start).toHaveBeenCalledWith('meeting-1', 'desktop-1');
    expect(ws?.url).toBe('ws://127.0.0.1:18220/ws/stream');

    await recorder.stop();

    expect(micTrack.stop).toHaveBeenCalled();
    expect(window.electronAPI?.audio.finish).not.toHaveBeenCalled();
    expect(window.electronAPI?.audio.abort).not.toHaveBeenCalled();
  });

  it('falls back to direct-only capture when recorder preparation fails before microphone opens', async () => {
    installElectronApiMock();
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 15_5)');
    const { micTrack } = installBrowserAudioMocks();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.mocked(window.electronAPI!.audio.prepareCapture).mockRejectedValueOnce(
      new Error('Direct STT bağlantı hatası. Kayıt başlatılmadı; mikrofon açılmadı.'),
    );

    const recorder = await startRecording('meeting-1', 'desktop-1', {
      liveSttStreamUrl: 'ws://127.0.0.1:18220/ws/stream',
    });
    const captureNode = FakeAudioWorkletNode.lastInstance;
    const ws = FakeWebSocket.instances[0];

    expect(recorder.sessionId).toMatch(/^LOCAL-/);
    expect(recorder.gatewayActive).toBe(false);
    expect(recorder.gatewayError).toBe(
      'Direct STT bağlantı hatası. Kayıt başlatılmadı; mikrofon açılmadı.',
    );
    expect(window.electronAPI?.audio.start).not.toHaveBeenCalled();
    expect(ws?.url).toBe('ws://127.0.0.1:18220/ws/stream');

    ws?.open();
    ws?.message({ type: 'ready' });
    captureNode?.port.onmessage?.({
      data: new Float32Array(48_000),
    } as MessageEvent<Float32Array>);

    expect(ws?.sent).toHaveLength(10);
    expect(window.electronAPI?.audio.sendChunk).not.toHaveBeenCalled();

    await recorder.stop();

    expect(micTrack.stop).toHaveBeenCalled();
    expect(window.electronAPI?.audio.finish).not.toHaveBeenCalled();
    expect(window.electronAPI?.audio.abort).not.toHaveBeenCalled();
  });

  it('does not mask a preparation timeout with Direct-STT fallback', async () => {
    installElectronApiMock();
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 15_5)');
    installBrowserAudioMocks();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.mocked(window.electronAPI!.audio.prepareCapture).mockRejectedValueOnce(
      new Error('Recorder izin hazırlığı zaman aşımına uğradı.'),
    );

    await expect(
      startRecording('meeting-1', 'desktop-1', {
        liveSttStreamUrl: 'ws://127.0.0.1:18220/ws/stream',
      }),
    ).rejects.toThrow('Recorder izin hazırlığı zaman aşımına uğradı.');

    expect(window.electronAPI?.audio.start).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('does not use direct-only fallback for recorder contract errors', async () => {
    installElectronApiMock();
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 15_5)');
    const { micTrack } = installBrowserAudioMocks();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.mocked(window.electronAPI!.audio.start).mockRejectedValueOnce(
      new Error('consent required before recording'),
    );

    await expect(
      startRecording('meeting-1', 'desktop-1', {
        liveSttStreamUrl: 'ws://127.0.0.1:18220/ws/stream',
      }),
    ).rejects.toThrow('consent required before recording');

    expect(micTrack.stop).toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(window.electronAPI?.audio.cancelCapture).toHaveBeenCalledTimes(1);
  });

  it('does not mask canonical lifecycle failure with Direct-STT fallback', async () => {
    installElectronApiMock();
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 15_5)');
    const { micTrack } = installBrowserAudioMocks();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.mocked(window.electronAPI!.audio.start).mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'audio:start': Error: syncRecordingLifecycle failed: 503 code=MEETING_UNAVAILABLE",
      ),
    );

    await expect(
      startRecording('meeting-1', 'desktop-1', {
        liveSttStreamUrl: 'wss://stt.example.com/stream',
      }),
    ).rejects.toThrow('syncRecordingLifecycle failed');

    expect(micTrack.stop).toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(window.electronAPI?.audio.cancelCapture).toHaveBeenCalledTimes(1);
  });

  it('fails closed when consent persistence is unconfirmed', async () => {
    installElectronApiMock();
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 15_5)');
    const { micTrack } = installBrowserAudioMocks();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.mocked(window.electronAPI!.audio.start).mockRejectedValueOnce(
      new Error('AUDIO_GATEWAY_CONSENT_UNCONFIRMED: recordConsent failed: 503 retryable=true'),
    );

    await expect(
      startRecording('meeting-1', 'desktop-1', {
        liveSttStreamUrl: 'wss://stt.example.com/stream',
      }),
    ).rejects.toThrow('AUDIO_GATEWAY_CONSENT_UNCONFIRMED');

    expect(micTrack.stop).toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(window.electronAPI?.audio.cancelCapture).toHaveBeenCalledTimes(1);
  });

  it('fails closed when gateway session creation is unconfirmed', async () => {
    installElectronApiMock();
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 15_5)');
    const { micTrack } = installBrowserAudioMocks();
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.mocked(window.electronAPI!.audio.start).mockRejectedValueOnce(
      new Error('AUDIO_GATEWAY_SESSION_START_UNCONFIRMED: startSession timed out after 15000ms'),
    );

    await expect(
      startRecording('meeting-1', 'desktop-1', {
        liveSttStreamUrl: 'wss://stt.example.com/stream',
      }),
    ).rejects.toThrow('AUDIO_GATEWAY_SESSION_START_UNCONFIRMED');

    expect(micTrack.stop).toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(window.electronAPI?.audio.cancelCapture).toHaveBeenCalledTimes(1);
  });

  it('fails closed when audio:start times out after a potentially ambiguous mutation', async () => {
    vi.useFakeTimers();
    try {
      installElectronApiMock();
      setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 15_5)');
      const { micTrack } = installBrowserAudioMocks();
      vi.stubGlobal('WebSocket', FakeWebSocket);
      let resolveStart: (session: {
        sessionId: string;
        transcriptSessionId: string;
        captureId: string;
      }) => void = () => undefined;
      vi.mocked(window.electronAPI!.audio.start).mockReturnValueOnce(
        new Promise((resolve) => {
          resolveStart = resolve;
        }),
      );

      const recording = startRecording('meeting-1', 'desktop-1', {
        liveSttStreamUrl: 'wss://stt.example.com/stream',
      });
      const rejection = expect(recording).rejects.toThrow(
        'Audio gateway oturumu zaman aşımına uğradı.',
      );
      await vi.advanceTimersByTimeAsync(420_000);

      await rejection;
      expect(micTrack.stop).toHaveBeenCalled();
      expect(FakeWebSocket.instances).toHaveLength(0);
      expect(window.electronAPI?.audio.cancelCapture).toHaveBeenCalledTimes(1);

      resolveStart({
        sessionId: 'SES-LATE',
        transcriptSessionId: '33333333-3333-4333-8333-333333333333',
        captureId: 'CAP-LATE',
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(window.electronAPI?.audio.abort).toHaveBeenCalledWith('CAP-LATE');
    } finally {
      vi.useRealTimers();
    }
  });
});
