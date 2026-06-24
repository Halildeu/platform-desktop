/**
 * Renderer capture (#2): mic -> AudioWorklet -> PCM16 -> IPC.
 *
 * Main process attaches the JWT and sends chunks to audio-gateway.
 * Audio is kept in memory only.
 */

import { encodeChunk } from './pcm-encode';
import { FrameBuffer } from './frame-buffer';

const TARGET_RATE = 16000;
const CHUNK_MS = 100;
const MAX_PENDING_CHUNKS = 20;

export interface Recorder {
  sessionId: string;
  stop: () => Promise<void>;
  onError: (handler: (err: Error) => void) => void;
}

export async function startRecording(meetingId: string, deviceId: string): Promise<Recorder> {
  const api = window.electronAPI;
  if (!api) {
    throw new Error('electronAPI yok (preload yuklenmedi)');
  }

  const mic = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
  const ctx = new AudioContext();
  try {
    await ctx.audioWorklet.addModule('/pcm-worklet.js');
  } catch (err) {
    mic.getTracks().forEach((track) => {
      track.stop();
    });
    await ctx.close();
    throw err;
  }
  const src = ctx.createMediaStreamSource(mic);
  const node = new AudioWorkletNode(ctx, 'pcm-capture');
  const sink = ctx.createGain();
  sink.gain.value = 0;
  let session: { sessionId: string; captureId: string };
  try {
    session = await api.audio.start(meetingId, deviceId);
  } catch (err) {
    mic.getTracks().forEach((track) => {
      track.stop();
    });
    await ctx.close();
    throw err;
  }
  const { sessionId, captureId } = session;

  const frameSamples = Math.round((ctx.sampleRate * CHUNK_MS) / 1000);
  const fb = new FrameBuffer(frameSamples);
  const empty = new Float32Array(0);
  let pendingChunks = 0;
  let uploadError: Error | null = null;
  let uploadTail: Promise<void> = Promise.resolve();
  let errorHandler: ((err: Error) => void) | null = null;

  const stopCapture = (): void => {
    node.port.onmessage = null;
    src.disconnect();
    node.disconnect();
    sink.disconnect();
    mic.getTracks().forEach((track) => {
      track.stop();
    });
    void ctx.close();
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

  node.port.onmessage = (ev: MessageEvent<Float32Array>): void => {
    for (const chunk of fb.push(ev.data)) {
      const bytes = encodeChunk(chunk, empty, ctx.sampleRate, TARGET_RATE);
      enqueueChunk(bytes, Date.now());
    }
  };

  src.connect(node);
  node.connect(sink).connect(ctx.destination);

  let stopped = false;

  return {
    sessionId,
    onError: (handler: (err: Error) => void): void => {
      errorHandler = handler;
    },
    stop: async (): Promise<void> => {
      if (stopped) return;
      stopped = true;

      node.port.onmessage = null;
      if (!uploadError) {
        const rest = fb.flush();
        if (rest) {
          const bytes = encodeChunk(rest, empty, ctx.sampleRate, TARGET_RATE);
          enqueueChunk(bytes, Date.now());
        }
      }

      await uploadTail;
      const finalError = uploadError;

      if (!uploadError) {
        src.disconnect();
        node.disconnect();
        sink.disconnect();
        mic.getTracks().forEach((track) => {
          track.stop();
        });
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
