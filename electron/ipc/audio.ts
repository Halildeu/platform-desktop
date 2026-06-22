/**
 * Audio IPC handlers (#2) — main process: renderer chunk'larını gateway'e gönderir.
 *
 * Renderer capture eder (getUserMedia+loopback+worklet→PCM16); main JWT'yi
 * (login'den) ekler ve ChunkSender ile audio-gateway'e REST chunk olarak yollar.
 * KVKK: chunk diske YAZILMAZ, memory'de akar.
 */

import { ipcMain } from 'electron';

import { ChunkSender } from '../services/gateway/chunk-sender';
import { loadGatewayConfig } from '../services/gateway/gateway-client';
import { getValidAccessToken } from './auth';

let sender: ChunkSender | null = null;

export function registerAudioIpc(): void {
  ipcMain.handle(
    'audio:start',
    async (_e, meetingId: string, deviceId: string): Promise<{ sessionId: string }> => {
      const cfg = loadGatewayConfig();
      sender = new ChunkSender(cfg, () => getValidAccessToken());
      const sessionId = await sender.start(meetingId, deviceId);
      return { sessionId };
    },
  );

  ipcMain.handle(
    'audio:chunk',
    async (_e, payload: { bytes: Uint8Array; startedAtMs: number }): Promise<{ seq: number }> => {
      if (!sender) {
        throw new Error('no active recording session');
      }
      const seq = await sender.send(payload.bytes, payload.startedAtMs);
      return { seq };
    },
  );

  ipcMain.handle('audio:finish', async (): Promise<{ ok: boolean }> => {
    if (!sender) {
      throw new Error('no active recording session');
    }
    await sender.finish();
    sender = null;
    return { ok: true };
  });
}
