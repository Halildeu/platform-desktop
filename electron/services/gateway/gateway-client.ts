/**
 * audio-gateway REST client (#2 PR-desktop-02, Halil (b)).
 *
 * Contract-v1 (platform-backend/audio-gateway-service/docs/contract-v1.md):
 *   POST /sessions → POST /sessions/{id}/chunks (seq strict-contiguous + idempotent)
 *   → POST /finish. WS /stream planned-404, REST kullanılır.
 *
 * JWT login'den BAĞIMSIZ — token parametre olarak alınır (#1 login gelince bağlanır).
 * URL + header kurucular saf/test-edilebilir; HTTP (fetch) gerçek gateway gerektirir.
 */

import { randomBytes } from 'node:crypto';

const API = '/api/v1/audio-gateway';

export interface GatewayConfig {
  baseUrl: string;
}

function isLocalHttp(url: URL): boolean {
  return (
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1')
  );
}

export function loadGatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const raw = (env.GATEWAY_BASE_URL ?? '').replace(/\/+$/, '');
  if (!raw) {
    throw new Error('GATEWAY_BASE_URL is required');
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('GATEWAY_BASE_URL must be an absolute URL');
  }

  if (parsed.protocol !== 'https:' && !isLocalHttp(parsed)) {
    throw new Error('GATEWAY_BASE_URL must use https, except local development URLs');
  }

  return { baseUrl: raw };
}

export function sessionsUrl(cfg: GatewayConfig): string {
  return `${cfg.baseUrl}${API}/sessions`;
}
export function chunksUrl(cfg: GatewayConfig, sessionId: string): string {
  return `${cfg.baseUrl}${API}/sessions/${sessionId}/chunks`;
}
export function finishUrl(cfg: GatewayConfig, sessionId: string): string {
  return `${cfg.baseUrl}${API}/sessions/${sessionId}/finish`;
}

/** Idempotency-Key (opaque 16-128 char). */
export function newIdempotencyKey(): string {
  return randomBytes(16).toString('hex');
}

/** Chunk admission header'ları (contract-v1: seq + started-at + byte-length + format/rate/channels). */
export function chunkHeaders(args: {
  jwt: string;
  idempotencyKey: string;
  seq: number;
  startedAtMs: number;
  byteLength: number;
  audioFormat?: string;
  sampleRateHz?: number;
  channels?: number;
}): Record<string, string> {
  return {
    Authorization: `Bearer ${args.jwt}`,
    'Idempotency-Key': args.idempotencyKey,
    'X-Audio-Chunk-Seq': String(args.seq),
    'X-Audio-Chunk-Started-At-Ms': String(args.startedAtMs),
    'X-Audio-Byte-Length': String(args.byteLength),
    'X-Audio-Format': args.audioFormat ?? 'PCM16',
    'X-Audio-Sample-Rate-Hz': String(args.sampleRateHz ?? 16000),
    'X-Audio-Channels': String(args.channels ?? 1),
    'Content-Type': 'application/octet-stream',
  };
}

async function httpErrorMessage(res: Response, label: string): Promise<string> {
  const contentType = res.headers?.get('content-type') ?? '';
  let body = '';
  try {
    body = typeof res.text === 'function' ? await res.text() : '';
  } catch {
    body = '';
  }

  const fields: string[] = [];
  if (contentType.toLowerCase().includes('application/json') && body.trim()) {
    try {
      const parsed = JSON.parse(body) as {
        code?: unknown;
        correlationId?: unknown;
        retryable?: unknown;
      };
      if (typeof parsed.code === 'string' && /^[A-Z_]{1,64}$/.test(parsed.code)) {
        fields.push(`code=${parsed.code}`);
      }
      if (
        typeof parsed.correlationId === 'string' &&
        /^[A-Za-z0-9._:-]{1,128}$/.test(parsed.correlationId)
      ) {
        fields.push(`correlationId=${parsed.correlationId}`);
      }
      if (typeof parsed.retryable === 'boolean') {
        fields.push(`retryable=${String(parsed.retryable)}`);
      }
    } catch {
      fields.push('response=unparseable');
    }
  } else if (contentType) {
    fields.push(`contentType=${contentType}`);
  }

  const suffix = fields.length > 0 ? ` ${fields.join(' ')}` : '';
  return `${label} failed: ${res.status}${suffix}`;
}

export interface StartSessionArgs {
  meetingId: string;
  deviceId: string;
  language: string;
}

export interface SessionInfo {
  sessionId: string;
  chunkUploadUrl?: string;
  finishUrl?: string;
}

/** POST /sessions — oturum başlat (WAV/PCM16 16kHz mono). */
export async function startSession(
  cfg: GatewayConfig,
  jwt: string,
  args: StartSessionArgs,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<SessionInfo> {
  const res = await fetch(sessionsUrl(cfg), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      'Idempotency-Key': idempotencyKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      meetingId: args.meetingId,
      deviceId: args.deviceId,
      language: args.language,
      audioFormat: 'PCM16',
      sampleRateHz: 16000,
      channels: 1,
    }),
  });
  if (!res.ok) {
    throw new Error(await httpErrorMessage(res, 'startSession'));
  }
  return (await res.json()) as SessionInfo;
}

/** POST /sessions/{id}/chunks — sıralı PCM16 chunk gönder. */
export async function sendChunk(
  cfg: GatewayConfig,
  jwt: string,
  sessionId: string,
  chunk: { seq: number; bytes: Uint8Array; startedAtMs: number },
  idempotencyKey: string = newIdempotencyKey(),
): Promise<void> {
  const res = await fetch(chunksUrl(cfg, sessionId), {
    method: 'POST',
    headers: chunkHeaders({
      jwt,
      idempotencyKey,
      seq: chunk.seq,
      startedAtMs: chunk.startedAtMs,
      byteLength: chunk.bytes.byteLength,
    }),
    body: chunk.bytes,
  });
  if (!res.ok) {
    throw new Error(`${await httpErrorMessage(res, 'sendChunk')} (seq=${chunk.seq})`);
  }
}

/** POST /sessions/{id}/finish — oturumu terminal yap. */
export async function finishSession(
  cfg: GatewayConfig,
  jwt: string,
  sessionId: string,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<void> {
  const res = await fetch(finishUrl(cfg, sessionId), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      'Idempotency-Key': idempotencyKey,
    },
  });
  if (!res.ok) {
    throw new Error(await httpErrorMessage(res, 'finishSession'));
  }
}
