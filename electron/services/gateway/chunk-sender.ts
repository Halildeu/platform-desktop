/**
 * ChunkSender — capture oturumu orchestration (#2 PR-desktop-02).
 *
 * start → çok sayıda send (seq strict-contiguous 0,1,2..) → finish.
 * gateway-client'ı sarar; JWT'yi `getJwt` ile lazily alır (login #1'den BAĞIMSIZ —
 * login gelince getJwt gerçek token döner). Seq state machine saf/test-edilebilir.
 */

import {
  type GatewayConfig,
  GatewaySessionStartRejectedError,
  finishSession,
  newIdempotencyKey,
  sendChunk,
  startSession,
} from './gateway-client.js';

export type SessionState = 'idle' | 'active' | 'finished';
const START_MAX_ATTEMPTS = 2;

export class AmbiguousGatewaySessionStartError extends Error {
  constructor(error: unknown) {
    super(error instanceof Error ? error.message : String(error));
    this.name = 'AmbiguousGatewaySessionStartError';
  }
}

export class ChunkSender {
  private seq = -1;
  private sessionId: string | null = null;
  private state: SessionState = 'idle';
  private tail: Promise<unknown> = Promise.resolve();
  private failed: Error | null = null;

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

  async start(
    meetingId: string,
    deviceId: string,
    language = 'tr',
    idempotencyKey = newIdempotencyKey(),
  ): Promise<string> {
    if (this.state === 'active') {
      throw new Error('session already active');
    }
    const jwt = await this.getJwt();
    let info: Awaited<ReturnType<typeof startSession>> | null = null;
    for (let attempt = 1; attempt <= START_MAX_ATTEMPTS; attempt += 1) {
      try {
        info = await startSession(this.cfg, jwt, { meetingId, deviceId, language }, idempotencyKey);
        break;
      } catch (error) {
        if (error instanceof GatewaySessionStartRejectedError) {
          if (error.status !== 429 && error.status < 500) {
            throw error;
          }
          if (attempt === START_MAX_ATTEMPTS) {
            throw new AmbiguousGatewaySessionStartError(error);
          }
          continue;
        }
        if (attempt === START_MAX_ATTEMPTS) {
          throw new AmbiguousGatewaySessionStartError(error);
        }
      }
    }
    if (!info) {
      throw new Error('session start could not be confirmed');
    }
    this.sessionId = info.sessionId;
    this.seq = -1;
    this.failed = null;
    this.tail = Promise.resolve();
    this.state = 'active';
    return info.sessionId;
  }

  /** Bir PCM16 chunk gönder; sıra otomatik artar (strict-contiguous). */
  async send(bytes: Uint8Array, startedAtMs: number): Promise<number> {
    const op = this.tail.then(async () => {
      if (this.failed) {
        throw this.failed;
      }
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
    });
    this.tail = op.catch((err: unknown) => {
      this.failed = err instanceof Error ? err : new Error(String(err));
    });
    return op;
  }

  async finish(idempotencyKey = newIdempotencyKey()): Promise<void> {
    await this.tail;
    if (this.failed) {
      throw this.failed;
    }
    if (this.state !== 'active' || this.sessionId === null) {
      throw new Error('no active session');
    }
    await finishSession(this.cfg, await this.getJwt(), this.sessionId, idempotencyKey);
    this.state = 'finished';
  }
}
