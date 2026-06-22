/**
 * ChunkSender — capture oturumu orchestration (#2 PR-desktop-02).
 *
 * start → çok sayıda send (seq strict-contiguous 0,1,2..) → finish.
 * gateway-client'ı sarar; JWT'yi `getJwt` ile lazily alır (login #1'den BAĞIMSIZ —
 * login gelince getJwt gerçek token döner). Seq state machine saf/test-edilebilir.
 */

import {
  type GatewayConfig,
  finishSession,
  newIdempotencyKey,
  sendChunk,
  startSession,
} from './gateway-client';

export type SessionState = 'idle' | 'active' | 'finished';

export class ChunkSender {
  private seq = -1;
  private sessionId: string | null = null;
  private state: SessionState = 'idle';

  constructor(
    private readonly cfg: GatewayConfig,
    private readonly getJwt: () => string | Promise<string>,
  ) {}

  getState(): SessionState {
    return this.state;
  }

  /** Sonraki gönderilecek chunk sırası (0'dan başlar). */
  nextSeq(): number {
    return this.seq + 1;
  }

  async start(meetingId: string, deviceId: string, language = 'tr'): Promise<string> {
    if (this.state === 'active') {
      throw new Error('session already active');
    }
    const info = await startSession(
      this.cfg,
      await this.getJwt(),
      { meetingId, deviceId, language },
      newIdempotencyKey(),
    );
    this.sessionId = info.sessionId;
    this.seq = -1;
    this.state = 'active';
    return info.sessionId;
  }

  /** Bir PCM16 chunk gönder; sıra otomatik artar (strict-contiguous). */
  async send(bytes: Uint8Array, startedAtMs: number): Promise<number> {
    if (this.state !== 'active' || this.sessionId === null) {
      throw new Error('no active session');
    }
    const seq = this.seq + 1;
    await sendChunk(
      this.cfg,
      await this.getJwt(),
      this.sessionId,
      { seq, bytes, startedAtMs },
      newIdempotencyKey(),
    );
    this.seq = seq;
    return seq;
  }

  async finish(): Promise<void> {
    if (this.state !== 'active' || this.sessionId === null) {
      throw new Error('no active session');
    }
    await finishSession(this.cfg, await this.getJwt(), this.sessionId, newIdempotencyKey());
    this.state = 'finished';
  }
}
