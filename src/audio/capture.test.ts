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
  port: { onmessage: ((ev: MessageEvent<Float32Array>) => void) | null } = {
    onmessage: null,
  };
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
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete window.electronAPI;
});

describe('startRecording', () => {
  it('continues mic-only when system audio source capture fails', async () => {
    installElectronApiMock();
    const { micTrack, getDisplayMedia } = installBrowserAudioMocks();

    const recorder = await startRecording('meeting-1', 'desktop-1');

    expect(getDisplayMedia).toHaveBeenCalledWith({ audio: true, video: true });
    expect(window.electronAPI?.audio.start).toHaveBeenCalledWith('meeting-1', 'desktop-1');
    expect(recorder.hasLoopback).toBe(false);
    expect(window.electronAPI?.audio.cancelCapture).not.toHaveBeenCalled();

    await recorder.stop();

    expect(micTrack.stop).toHaveBeenCalled();
    expect(window.electronAPI?.audio.finish).toHaveBeenCalledWith('CAP-1');
  });
});
