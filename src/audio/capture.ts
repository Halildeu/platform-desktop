/**
 * Renderer capture (#2): mic + loopback(system audio) -> AudioWorklet -> PCM16 -> IPC.
 *
 * Main process attaches the JWT and sends chunks to audio-gateway.
 * Audio is kept in memory only (KVKK).
 *
 * Loopback: getDisplayMedia({audio:true}) ile sistem sesi yakalanır.
 * Kullanıcı reddederse veya platform desteklemiyorsa mic-only fallback.
 */

import { encodeChunk } from './pcm-encode';
import { FrameBuffer } from './frame-buffer';

const TARGET_RATE = 16000;
const CHUNK_MS = 100;
const MAX_PENDING_CHUNKS = 20;

export interface Recorder {
  sessionId: string;
  hasLoopback: boolean;
  stop: () => Promise<void>;
  onError: (handler: (err: Error) => void) => void;
}

async function tryLoopbackStream(): Promise<MediaStream | null> {
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

export async function startRecording(meetingId: string, deviceId: string): Promise<Recorder> {
  const api = window.electronAPI;
  if (!api) {
    throw new Error('electronAPI yok (preload yuklenmedi)');
  }

  const mic = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
  const loopback = await tryLoopbackStream();

  const ctx = new AudioContext();
  try {
    await ctx.audioWorklet.addModule('/pcm-worklet.js');
  } catch (err) {
    stopAllTracks(mic, loopback);
    await ctx.close();
    throw err;
  }

  const micSrc = ctx.createMediaStreamSource(mic);
  const micNode = new AudioWorkletNode(ctx, 'pcm-capture');
  const sink = ctx.createGain();
  sink.gain.value = 0;

  let loopbackSrc: MediaStreamAudioSourceNode | null = null;
  let loopbackNode: AudioWorkletNode | null = null;

  if (loopback) {
    loopbackSrc = ctx.createMediaStreamSource(loopback);
    loopbackNode = new AudioWorkletNode(ctx, 'pcm-capture');
  }

  let session: { sessionId: string; captureId: string };
  try {
    session = await api.audio.start(meetingId, deviceId);
  } catch (err) {
    stopAllTracks(mic, loopback);
    await ctx.close();
    throw err;
  }
  const { sessionId, captureId } = session;

  const frameSamples = Math.round((ctx.sampleRate * CHUNK_MS) / 1000);
  const micFb = new FrameBuffer(frameSamples);
  const loopbackFb = loopback ? new FrameBuffer(frameSamples) : null;
  const empty = new Float32Array(0);

  let pendingChunks = 0;
  let uploadError: Error | null = null;
  let uploadTail: Promise<void> = Promise.resolve();
  let errorHandler: ((err: Error) => void) | null = null;

  const stopCapture = (): void => {
    micNode.port.onmessage = null;
    if (loopbackNode) {
      loopbackNode.port.onmessage = null;
    }
    micSrc.disconnect();
    micNode.disconnect();
    loopbackSrc?.disconnect();
    loopbackNode?.disconnect();
    sink.disconnect();
    stopAllTracks(mic, loopback);
    void ctx.close();
    void api.audio.abort(captureId).catch(() => {});
  };

  let micLatest: Float32Array = empty;
  let loopbackLatest: Float32Array = empty;

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

  const emitMixed = (): void => {
    const bytes = encodeChunk(loopbackLatest, micLatest, ctx.sampleRate, TARGET_RATE);
    enqueueChunk(bytes, Date.now());
    micLatest = empty;
    loopbackLatest = empty;
  };

  micNode.port.onmessage = (ev: MessageEvent<Float32Array>): void => {
    for (const chunk of micFb.push(ev.data)) {
      micLatest = chunk;
      if (!loopbackFb) {
        emitMixed();
      }
    }
  };

  if (loopbackNode && loopbackFb) {
    loopbackNode.port.onmessage = (ev: MessageEvent<Float32Array>): void => {
      for (const chunk of loopbackFb.push(ev.data)) {
        loopbackLatest = chunk;
        emitMixed();
      }
    };
  }

  micSrc.connect(micNode);
  micNode.connect(sink).connect(ctx.destination);

  if (loopbackSrc && loopbackNode) {
    loopbackSrc.connect(loopbackNode);
    loopbackNode.connect(sink);
  }

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

      micNode.port.onmessage = null;
      if (loopbackNode) {
        loopbackNode.port.onmessage = null;
      }

      if (!uploadError) {
        const micRest = micFb.flush();
        const loopbackRest = loopbackFb?.flush() ?? null;
        if (micRest || loopbackRest) {
          micLatest = micRest ?? empty;
          loopbackLatest = loopbackRest ?? empty;
          emitMixed();
        }
      }

      await uploadTail;
      const finalError = uploadError;

      if (!uploadError) {
        micSrc.disconnect();
        micNode.disconnect();
        loopbackSrc?.disconnect();
        loopbackNode?.disconnect();
        sink.disconnect();
        stopAllTracks(mic, loopback);
        await ctx.close();
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
