/**
 * Renderer capture (#2): mic + loopback(system audio) -> AudioWorklet -> PCM16 -> IPC.
 *
 * Main process attaches the JWT and sends chunks to audio-gateway.
 * Audio is kept in memory only (KVKK).
 *
 * Loopback: Electron only supports loopback device capture on Windows.
 * Unsupported platforms and denied source selection use mic-only fallback.
 *
 * Mix: ChannelMerger + GainNode ile Web Audio graph'ta toplandıktan sonra
 * tek AudioWorkletNode ile capture edilir (frame-loss riski yok).
 */

import {
  connectLiveSttStream,
  type LiveSttTranscriptEvent,
  type LiveSttStreamConnection,
  type LiveSttStreamStatusEvent,
} from './live-stt-stream';
import { encodeChunk, resampleLinear } from './pcm-encode';
import { FrameBuffer } from './frame-buffer';

const TARGET_RATE = 16000;
const CHUNK_MS = 2000;
const LIVE_STREAM_FRAME_MS = 100;
const AUDIO_ACTIVITY_EVENT_MS = 500;
const MAX_PENDING_AUDIO_MS = 120_000;
const MAX_PENDING_CHUNKS = Math.ceil(MAX_PENDING_AUDIO_MS / CHUNK_MS);
const CAPTURE_PERMISSION_TIMEOUT_MS = 45_000;
const CAPTURE_IPC_TIMEOUT_MS = 15_000;
const LOOPBACK_CAPTURE_TIMEOUT_MS = 5_000;
const WINDOWS_USER_AGENT_RE = /\bWindows NT\b/i;

export function resolvePcmWorkletModuleUrl(baseUri = document.baseURI): string {
  return new URL('pcm-worklet.js', baseUri).toString();
}

export type AudioCapturePreflightStatus = 'idle' | 'checking' | 'ready' | 'error';

export interface AudioCapturePreflightState {
  status: AudioCapturePreflightStatus;
  message: string | null;
  checkedAtMs: number | null;
  elapsedMs: number | null;
  moduleUrl: string | null;
}

export interface AudioCapturePreflightResult {
  ok: boolean;
  message: string;
  elapsedMs: number;
  moduleUrl: string;
}

export const initialAudioCapturePreflightState: AudioCapturePreflightState = {
  status: 'idle',
  message: null,
  checkedAtMs: null,
  elapsedMs: null,
  moduleUrl: null,
};

export async function testAudioCaptureWorklet(
  timeoutMs = 8_000,
  baseUri = document.baseURI,
): Promise<AudioCapturePreflightResult> {
  const startedAtMs = Date.now();
  const moduleUrl = resolvePcmWorkletModuleUrl(baseUri);
  let ctx: AudioContext | null = null;
  const elapsed = (): number => Math.max(0, Date.now() - startedAtMs);

  try {
    ctx = new AudioContext();
    await withTimeout(
      ctx.audioWorklet.addModule(moduleUrl),
      timeoutMs,
      'Audio worklet yukleme zaman asimina ugradi.',
    );
    return {
      ok: true,
      message: 'Ses işleyici hazır.',
      elapsedMs: elapsed(),
      moduleUrl,
    };
  } catch (error) {
    return {
      ok: false,
      message: `Ses işleyici hazır değil: ${
        error instanceof Error ? error.message : String(error)
      }`,
      elapsedMs: elapsed(),
      moduleUrl,
    };
  } finally {
    if (ctx) {
      await ctx.close().catch(() => undefined);
    }
  }
}

export interface Recorder {
  sessionId: string;
  hasLoopback: boolean;
  stop: () => Promise<void>;
  onError: (handler: (err: Error) => void) => void;
}

export interface StartRecordingOptions {
  liveSttStreamUrl?: string | null;
  onLiveStreamReady?: () => void;
  onLiveStreamStatus?: (event: LiveSttStreamStatusEvent) => void;
  onAudioActivity?: (activity: { rms: number; capturedAtMs: number }) => void;
  onLiveTranscriptEvent?: (event: LiveSttTranscriptEvent) => void;
  onLiveTranscriptError?: (err: Error) => void;
}

function canAttemptLoopbackCapture(): boolean {
  return WINDOWS_USER_AGENT_RE.test(navigator.userAgent);
}

async function tryLoopbackStream(): Promise<MediaStream | null> {
  if (!canAttemptLoopbackCapture()) {
    return null;
  }

  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      audio: true,
      video: true,
    });
    stream.getVideoTracks().forEach((t) => t.stop());
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      return null;
    }
    return new MediaStream(audioTracks);
  } catch {
    return null;
  }
}

function stopAllTracks(...streams: (MediaStream | null)[]): void {
  for (const s of streams) {
    s?.getTracks().forEach((t) => t.stop());
  }
}

function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
  onLateResolve?: (value: T) => void,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let didTimeout = false;

  void operation
    .then((value) => {
      if (didTimeout) {
        onLateResolve?.(value);
      }
    })
    .catch(() => undefined);

  return new Promise<T>((resolve, reject) => {
    timeoutId = setTimeout(() => {
      didTimeout = true;
      reject(new Error(message));
    }, timeoutMs);

    operation.then(
      (value) => {
        if (!didTimeout) {
          resolve(value);
        }
      },
      (err: unknown) => {
        if (!didTimeout) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      },
    );
  }).finally(() => {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  });
}

function rms(samples: Float32Array): number {
  if (samples.length === 0) {
    return 0;
  }
  let sum = 0;
  for (const sample of samples) {
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples.length);
}

export async function startRecording(
  meetingId: string,
  deviceId: string,
  options: StartRecordingOptions = {},
): Promise<Recorder> {
  const api = window.electronAPI;
  if (!api) {
    throw new Error('electronAPI yok (preload yuklenmedi)');
  }

  let mic: MediaStream | null = null;
  let loopback: MediaStream | null = null;
  let ctx: AudioContext | null = null;
  let captureLeasePrepared = false;

  try {
    await withTimeout(
      api.audio.prepareCapture(),
      CAPTURE_IPC_TIMEOUT_MS,
      'Recorder izin hazırlığı zaman aşımına uğradı.',
      () => {
        void api.audio.cancelCapture().catch(() => undefined);
      },
    );
    captureLeasePrepared = true;
    mic = await withTimeout(
      navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1 },
      }),
      CAPTURE_PERMISSION_TIMEOUT_MS,
      'Mikrofon izni zaman aşımına uğradı.',
      (stream) => stopAllTracks(stream),
    );
    loopback = await withTimeout(
      tryLoopbackStream(),
      LOOPBACK_CAPTURE_TIMEOUT_MS,
      'Sistem sesi seçimi zaman aşımına uğradı; mikrofonla devam ediliyor.',
      (stream) => stopAllTracks(stream),
    ).catch(() => null);
    ctx = new AudioContext();
    await withTimeout(
      ctx.audioWorklet.addModule(resolvePcmWorkletModuleUrl()),
      CAPTURE_IPC_TIMEOUT_MS,
      'Audio worklet yükleme zaman aşımına uğradı.',
    );
  } catch (err) {
    stopAllTracks(mic, loopback);
    if (ctx) {
      await ctx.close();
    }
    if (captureLeasePrepared) {
      void api.audio.cancelCapture().catch(() => undefined);
    }
    throw err;
  }

  if (!mic || !ctx) {
    if (captureLeasePrepared) {
      void api.audio.cancelCapture().catch(() => undefined);
    }
    throw new Error('audio capture setup failed');
  }

  const micStream = mic;
  const loopbackStream = loopback;
  const audioContext = ctx;
  const micSrc = audioContext.createMediaStreamSource(micStream);

  let mixedSource: AudioNode;

  if (loopbackStream) {
    const loopbackSrc = audioContext.createMediaStreamSource(loopbackStream);
    const micGain = audioContext.createGain();
    micGain.gain.value = 1.0;
    const loopbackGain = audioContext.createGain();
    loopbackGain.gain.value = 1.0;
    const merger = audioContext.createChannelMerger(1);
    micSrc.connect(micGain).connect(merger, 0, 0);
    loopbackSrc.connect(loopbackGain).connect(merger, 0, 0);
    mixedSource = merger;
  } else {
    mixedSource = micSrc;
  }

  const captureNode = new AudioWorkletNode(audioContext, 'pcm-capture');
  const sink = audioContext.createGain();
  sink.gain.value = 0;
  mixedSource.connect(captureNode);
  captureNode.connect(sink).connect(audioContext.destination);

  let session: { sessionId: string; captureId: string };
  try {
    session = await withTimeout(
      api.audio.start(meetingId, deviceId),
      CAPTURE_IPC_TIMEOUT_MS,
      'Audio gateway oturumu zaman aşımına uğradı.',
      (lateSession) => {
        void api.audio.abort(lateSession.captureId).catch(() => undefined);
      },
    );
  } catch (err) {
    stopAllTracks(micStream, loopbackStream);
    await audioContext.close();
    void api.audio.cancelCapture().catch(() => undefined);
    throw err;
  }
  const { sessionId, captureId } = session;

  const frameSamples = Math.round((audioContext.sampleRate * CHUNK_MS) / 1000);
  const fb = new FrameBuffer(frameSamples);
  const empty = new Float32Array(0);
  const liveStreamFrameSamples = Math.round((TARGET_RATE * LIVE_STREAM_FRAME_MS) / 1000);
  const liveStreamBuffer = new FrameBuffer(liveStreamFrameSamples);
  let liveStream: LiveSttStreamConnection | null = null;

  if (options.liveSttStreamUrl) {
    liveStream = connectLiveSttStream(options.liveSttStreamUrl, {
      onReady: options.onLiveStreamReady,
      onStatus: options.onLiveStreamStatus,
      onTranscriptEvent: options.onLiveTranscriptEvent,
      onError: options.onLiveTranscriptError,
    });
  }

  let pendingChunks = 0;
  let uploadError: Error | null = null;
  let uploadTail: Promise<void> = Promise.resolve();
  let errorHandler: ((err: Error) => void) | null = null;
  let lastAudioActivityEventAtMs = 0;

  const stopCapture = (): void => {
    captureNode.port.onmessage = null;
    captureNode.disconnect();
    sink.disconnect();
    liveStream?.close();
    stopAllTracks(micStream, loopbackStream);
    void audioContext.close();
    void api.audio.abort(captureId).catch(() => {});
  };

  const enqueueChunk = (bytes: Uint8Array, startedAtMs: number): void => {
    if (uploadError) {
      return;
    }
    if (pendingChunks >= MAX_PENDING_CHUNKS) {
      uploadError = new Error('audio upload queue full');
      stopCapture();
      errorHandler?.(uploadError);
      return;
    }

    pendingChunks += 1;
    const op = uploadTail.then(async () => {
      if (uploadError) {
        throw uploadError;
      }
      await api.audio.sendChunk({ captureId, bytes, startedAtMs });
    });
    uploadTail = op
      .catch((err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        if (!uploadError) {
          uploadError = error;
          stopCapture();
          errorHandler?.(error);
        }
      })
      .finally(() => {
        pendingChunks -= 1;
      });
  };

  captureNode.port.onmessage = (ev: MessageEvent<Float32Array>): void => {
    const capturedAtMs = Date.now();
    if (
      options.onAudioActivity &&
      capturedAtMs - lastAudioActivityEventAtMs >= AUDIO_ACTIVITY_EVENT_MS
    ) {
      lastAudioActivityEventAtMs = capturedAtMs;
      options.onAudioActivity({ rms: rms(ev.data), capturedAtMs });
    }
    if (liveStream) {
      const liveFrame = resampleLinear(ev.data, audioContext.sampleRate, TARGET_RATE);
      for (const frame of liveStreamBuffer.push(liveFrame)) {
        liveStream.send(frame);
      }
    }
    for (const chunk of fb.push(ev.data)) {
      const bytes = encodeChunk(chunk, empty, audioContext.sampleRate, TARGET_RATE);
      enqueueChunk(bytes, capturedAtMs);
    }
  };

  let stopped = false;

  return {
    sessionId,
    hasLoopback: loopback !== null,
    onError: (handler: (err: Error) => void): void => {
      errorHandler = handler;
    },
    stop: async (): Promise<void> => {
      if (stopped) return;
      stopped = true;

      captureNode.port.onmessage = null;

      if (!uploadError) {
        if (liveStream) {
          const restLiveFrame = liveStreamBuffer.flush();
          if (restLiveFrame) {
            liveStream.send(restLiveFrame);
          }
        }
        const rest = fb.flush();
        if (rest) {
          const bytes = encodeChunk(rest, empty, audioContext.sampleRate, TARGET_RATE);
          enqueueChunk(bytes, Date.now());
        }
      }

      await uploadTail;
      const finalError = uploadError;

      if (!uploadError) {
        captureNode.disconnect();
        sink.disconnect();
        liveStream?.close();
        stopAllTracks(micStream, loopbackStream);
        await audioContext.close();
      }

      if (finalError) {
        if (!uploadError) {
          await api.audio.abort(captureId).catch(() => {});
        }
        throw finalError;
      }
      await api.audio.finish(captureId);
    },
  };
}
