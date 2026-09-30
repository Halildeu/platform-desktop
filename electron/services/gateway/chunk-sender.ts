/**
 * ChunkSender — capture oturumu orchestration (#2 PR-desktop-02).
 *
 * start → çok sayıda send (seq strict-contiguous 0,1,2..) → finish.
 * gateway-client'ı sarar; JWT'yi `getJwt` ile lazily alır (login #1'den BAĞIMSIZ —
 * login gelince getJwt gerçek token döner). Seq state machine saf/test-edilebilir.
 */

import {
  type GatewayConfig,
  GatewayChunkRejectedError,
  GatewaySessionStartRejectedError,
  finishSession,
  newIdempotencyKey,
  sendChunk,
  startSession,
  type SttProvider,
  type TranscriptionMode,
} from './gateway-client.js';

export type SessionState = 'idle' | 'active' | 'finished';
const START_MAX_ATTEMPTS = 2;

/**
 * #138: a short network outage must not end the recording. The renderer keeps
 * later chunks queued for up to 120s (capture.ts MAX_PENDING_AUDIO_MS), so the
 * head chunk is replayed with the SAME seq, bytes and Idempotency-Key for a
 * bounded budget below that. contract-v1 answers an identical replay with
 * 200 `replayed`, so a chunk admitted before its response was lost is not
 * counted twice.
 */
export const CHUNK_OUTAGE_BUDGET_MS = 100_000;

/**
 * #153 attended kanıtı: ağ kesikken istek hemen hata vermiyor, tam
 * `HTTP_TIMEOUT_MS` (15 sn) boyunca asılı kalıyor (makinede Tailscale/Hyper-V
 * gibi sanal bağdaştırıcılar olduğu için paket boşluğa gidiyor). Ağ geri
 * geldiğinde o an uçuşta olan istek yine 15 sn'yi doldurduğundan `recovered`
 * — dolayısıyla canlı hattın yeniden bağlanması — ~20 sn geç tetikleniyordu.
 *
 * İlk deneme tam süreyi korur: anlık bir takılma cezalandırılmamalı. Ama bir
 * chunk bir kez başarısız olduysa hattın bozuk olduğu BİLİNİYOR; sonraki
 * denemeler toparlanma yoklamasıdır ve kısa kesilir. 2 sn'lik PCM16 chunk
 * 64 KB: bunu 4 sn'de gönderemeyen bir hat, her 2 sn'de bir yeni chunk üreten
 * canlı akışa zaten yetişemez. Yoklamanın erken kesilmesi chunk'ı düşürmez,
 * yalnız aynı bütçe içinde bir deneme daha yapılmasına yol açar.
 */
export const CHUNK_OUTAGE_PROBE_TIMEOUT_MS = 4_000;
const CHUNK_RETRY_BACKOFF_MS = [1_000, 2_000, 4_000] as const;
const CHUNK_RETRY_MAX_BACKOFF_MS = 5_000;
const CHUNK_AUTH_RETRY_LIMIT = 1;

export type ChunkDeliveryStatus =
  | {
      state: 'retrying';
      sessionId: string;
      seq: number;
      outageDurationMs: number;
      attempts: number;
      reason: string;
    }
  | {
      state: 'recovered';
      sessionId: string;
      seq: number;
      outageDurationMs: number;
      attempts: number;
    };

export interface ChunkSenderOptions {
  onDeliveryStatus?: (status: ChunkDeliveryStatus) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function isTransientChunkFailure(error: unknown): boolean {
  if (error instanceof GatewayChunkRejectedError) {
    return error.status === 429 || error.status >= 500 || error.retryable === true;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name === 'TimeoutError') {
    return true;
  }
  // Undici reports DNS (ENOTFOUND), refused and reset connections as
  // TypeError('fetch failed'); other TypeErrors are programming errors.
  return error instanceof TypeError && error.message === 'fetch failed';
}

function isAuthChunkFailure(error: unknown): boolean {
  return error instanceof GatewayChunkRejectedError && error.status === 401;
}

function failureReason(error: unknown): string {
  if (error instanceof GatewayChunkRejectedError) {
    return `http-${error.status}`;
  }
  if (error instanceof Error && error.name === 'TimeoutError') {
    return 'timeout';
  }
  return 'network';
}

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
  private sttProvider: SttProvider | null = null;

  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly cfg: GatewayConfig,
    private readonly getJwt: () => string | Promise<string>,
    private readonly options: ChunkSenderOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.sleep =
      options.sleep ??
      ((ms) =>
        new Promise((resolve) => {
          setTimeout(resolve, ms);
        }));
  }

  getState(): SessionState {
    return this.state;
  }

  /** Sonraki gönderilecek chunk sırası (0'dan başlar). */
  nextSeq(): number {
    return this.seq + 1;
  }

  getSttProvider(): SttProvider | null {
    return this.sttProvider;
  }

  async start(
    meetingId: string,
    deviceId: string,
    language = 'tr',
    idempotencyKey = newIdempotencyKey(),
    sttProvider: SttProvider = 'internal',
    transcriptionMode: TranscriptionMode = 'balanced',
    contextTerms: readonly string[] = [],
  ): Promise<string> {
    if (this.state === 'active') {
      throw new Error('session already active');
    }
    const jwt = await this.getJwt();
    let info: Awaited<ReturnType<typeof startSession>> | null = null;
    for (let attempt = 1; attempt <= START_MAX_ATTEMPTS; attempt += 1) {
      try {
        info = await startSession(
          this.cfg,
          jwt,
          { meetingId, deviceId, language, sttProvider, transcriptionMode, contextTerms },
          idempotencyKey,
        );
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
    this.sttProvider = info.sttProvider;
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
      await this.sendWithOutageRetry(this.sessionId, {
        seq,
        bytes: bytes.slice(),
        startedAtMs,
      });
      this.seq = seq;
      return seq;
    });
    this.tail = op.catch((err: unknown) => {
      this.failed = err instanceof Error ? err : new Error(String(err));
    });
    return op;
  }

  private async sendWithOutageRetry(
    sessionId: string,
    chunk: { seq: number; bytes: Uint8Array; startedAtMs: number },
  ): Promise<void> {
    // One key per chunk for its whole life: every replay is the identical request.
    const idempotencyKey = newIdempotencyKey();
    let outageStartedAtMs: number | null = null;
    let attempts = 0;
    let authRetries = 0;
    for (;;) {
      attempts += 1;
      try {
        await sendChunk(
          this.cfg,
          await this.getJwt(),
          sessionId,
          chunk,
          idempotencyKey,
          // Kesinti biliniyorsa bu bir toparlanma yoklaması: kısa kes.
          outageStartedAtMs === null ? undefined : CHUNK_OUTAGE_PROBE_TIMEOUT_MS,
        );
        if (outageStartedAtMs !== null) {
          this.options.onDeliveryStatus?.({
            state: 'recovered',
            sessionId,
            seq: chunk.seq,
            outageDurationMs: this.now() - outageStartedAtMs,
            attempts,
          });
        }
        return;
      } catch (error) {
        const authRetry = isAuthChunkFailure(error) && authRetries < CHUNK_AUTH_RETRY_LIMIT;
        if (!authRetry && !isTransientChunkFailure(error)) {
          throw error;
        }
        if (authRetry) {
          authRetries += 1;
        }
        outageStartedAtMs ??= this.now();
        const elapsedMs = this.now() - outageStartedAtMs;
        const backoffMs = CHUNK_RETRY_BACKOFF_MS[attempts - 1] ?? CHUNK_RETRY_MAX_BACKOFF_MS;
        if (elapsedMs + backoffMs > CHUNK_OUTAGE_BUDGET_MS) {
          throw error;
        }
        this.options.onDeliveryStatus?.({
          state: 'retrying',
          sessionId,
          seq: chunk.seq,
          outageDurationMs: elapsedMs,
          attempts,
          reason: failureReason(error),
        });
        await this.sleep(backoffMs);
      }
    }
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
