// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import { startRecording } from './capture';

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
  sampleRate = 48_000;
  destination = new FakeAudioNode();
  audioWorklet = {
    addModule: vi.fn().mockResolvedValue(undefined),
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
    },
    auth: {
      login: vi.fn(),
      logout: vi.fn(),
      status: vi.fn(),
    },
    meeting: {
      createContract: vi.fn(),
    },
    audio: {
      recorderConfig: vi.fn(),
      permissionStatus: vi.fn(),
      prepareCapture: vi.fn().mockResolvedValue({ ok: true, expiresAtMs: Date.now() + 1000 }),
      cancelCapture: vi.fn().mockResolvedValue({ ok: true }),
      consent: vi.fn(),
      start: vi.fn().mockResolvedValue({ sessionId: 'SES-1', captureId: 'CAP-1' }),
      sendChunk: vi.fn(),
      finish: vi.fn().mockResolvedValue({ ok: true }),
      abort: vi.fn().mockResolvedValue({ ok: true }),
      rendererUnloaded: vi.fn(),
      onTranscriptEvent: vi.fn(() => vi.fn()),
      onTranscriptError: vi.fn(() => vi.fn()),
    },
  };
}

afterEach(() => {
  FakeAudioWorkletNode.lastInstance = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete window.electronAPI;
});

describe('startRecording', () => {
  it('skips loopback capture on macOS and starts mic-only recording', async () => {
    installElectronApiMock();
    setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 15_5)');
    const { micTrack, getDisplayMedia } = installBrowserAudioMocks();

    const recorder = await startRecording('meeting-1', 'desktop-1');

    expect(getDisplayMedia).not.toHaveBeenCalled();
    expect(window.electronAPI?.audio.start).toHaveBeenCalledWith('meeting-1', 'desktop-1');
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
});
