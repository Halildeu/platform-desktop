/**
 * Renderer capture (#2) — mic (+ ileride loopback) → AudioWorklet → PCM16 → IPC.
 *
 * Akış: getUserMedia → AudioWorklet (pcm-worklet.js) → Float32 frame →
 * FrameBuffer (100ms) → encodeChunk (mix + 16kHz + PCM16) → electronAPI.audio.sendChunk.
 * Main process JWT ekleyip gateway'e REST chunk olarak yollar. Chunk diske yazılmaz.
 *
 * MVP: mic-only. Loopback (sistem sesi — getDisplayMedia, Windows) sonraki iterasyon.
 */

import { encodeChunk } from './pcm-encode';
import { FrameBuffer } from './frame-buffer';

const TARGET_RATE = 16000;
const CHUNK_MS = 100;

export interface Recorder {
  sessionId: string;
  stop: () => Promise<void>;
}

export async function startRecording(meetingId: string, deviceId: string): Promise<Recorder> {
  const api = window.electronAPI;
  if (!api) {
    throw new Error('electronAPI yok (preload yüklenmedi)');
  }

  // 1) Gateway oturumu (main process JWT ekler)
  const { sessionId } = await api.audio.start(meetingId, deviceId);

  // 2) Mikrofon + AudioWorklet
  const mic = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
  const ctx = new AudioContext();
  await ctx.audioWorklet.addModule('/pcm-worklet.js');
  const src = ctx.createMediaStreamSource(mic);
  const node = new AudioWorkletNode(ctx, 'pcm-capture');

  // 3) Frame → 100ms chunk → PCM16 16kHz → IPC
  const frameSamples = Math.round((ctx.sampleRate * CHUNK_MS) / 1000);
  const fb = new FrameBuffer(frameSamples);
  const empty = new Float32Array(0);

  node.port.onmessage = (ev: MessageEvent<Float32Array>): void => {
    for (const chunk of fb.push(ev.data)) {
      const bytes = encodeChunk(chunk, empty, ctx.sampleRate, TARGET_RATE);
      void api.audio.sendChunk({ bytes, startedAtMs: Date.now() });
    }
  };

  src.connect(node);
  // node'u hoparlöre bağlama (geri besleme/echo olmasın) — sadece veri akışı.

  return {
    sessionId,
    stop: async (): Promise<void> => {
      node.port.onmessage = null;
      const rest = fb.flush();
      if (rest) {
        const bytes = encodeChunk(rest, empty, ctx.sampleRate, TARGET_RATE);
        await api.audio.sendChunk({ bytes, startedAtMs: Date.now() });
      }
      src.disconnect();
      node.disconnect();
      mic.getTracks().forEach((t) => t.stop());
      await ctx.close();
      await api.audio.finish();
    },
  };
}
