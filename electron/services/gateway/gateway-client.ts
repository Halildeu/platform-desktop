/**
 * audio-gateway REST client (#2 PR-desktop-02, Halil (b)).
 *
 * Contract-v1 (platform-backend/audio-gateway-service/docs/contract-v1.md):
 *   POST /consents → POST /sessions → POST /sessions/{id}/chunks
 *   (seq strict-contiguous + idempotent) → POST /finish. WS /stream
 *   planned-404, REST kullanılır.
 *
 * JWT login'den BAĞIMSIZ — token parametre olarak alınır (#1 login gelince bağlanır).
 * URL + header kurucular saf/test-edilebilir; HTTP (fetch) gerçek gateway gerektirir.
 */

import { randomBytes } from 'node:crypto';

import { desktopFetch } from '../net/desktop-fetch.js';

const API = '/api/v1/audio-gateway';
const HTTP_TIMEOUT_MS = 15_000;
const SSE_DECODER_FATAL = false;

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
export function consentsUrl(cfg: GatewayConfig): string {
  return `${cfg.baseUrl}${API}/consents`;
}
export function chunksUrl(cfg: GatewayConfig, sessionId: string): string {
  return `${cfg.baseUrl}${API}/sessions/${sessionId}/chunks`;
}
export function finishUrl(cfg: GatewayConfig, sessionId: string): string {
  return `${cfg.baseUrl}${API}/sessions/${sessionId}/finish`;
}
export function transcriptEventsUrl(
  cfg: GatewayConfig,
  sessionId: string,
  args: { after?: string | null; limit?: number } = {},
): string {
  const url = new URL(
    `${cfg.baseUrl}${API}/sessions/${encodeURIComponent(sessionId)}/transcript-events`,
  );
  if (args.after) {
    url.searchParams.set('after', args.after);
  }
  if (typeof args.limit === 'number') {
    url.searchParams.set('limit', String(args.limit));
  }
  return url.toString();
}
export function transcriptEventsStreamUrl(
  cfg: GatewayConfig,
  sessionId: string,
  args: { after?: string | null } = {},
): string {
  const url = new URL(
    `${cfg.baseUrl}${API}/sessions/${encodeURIComponent(sessionId)}/transcript-events/stream`,
  );
  if (args.after) {
    url.searchParams.set('after', args.after);
  }
  return url.toString();
}

/** Idempotency-Key (opaque 16-128 char). */
export function newIdempotencyKey(): string {
  return randomBytes(16).toString('hex');
}

async function fetchWithTimeout(
  input: string,
  init: RequestInit,
  label: string,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  if (init.signal) {
    if (init.signal.aborted) {
      controller.abort();
    } else {
      init.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
  }
  try {
    return await desktopFetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'AbortError' || name === 'TimeoutError') {
      throw new Error(`${label} timed out after ${HTTP_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
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

export interface RecordConsentArgs {
  meetingId: string;
  captureId: string;
  consentVersion: string;
  consentTextHash: string;
  locale: string;
}

export interface RecordConsentInfo {
  meetingId: string;
  captureId: string;
  consentVersion: string;
  consentTextHash: string;
  locale: string;
  correlationId: string;
  acceptedAtMs: number;
}

export interface SessionInfo {
  sessionId: string;
  chunkUploadUrl?: string;
  finishUrl?: string;
}

export interface TranscriptGatewayEvent {
  eventId: string;
  sessionId: string;
  meetingId: string;
  chunkSeq: number;
  chunkStartedAtMs: number;
  text: string;
  textLength: number;
  status: string;
  receivedAtMs?: number | null;
  sttLanguage?: string | null;
  durationSeconds?: number | null;
  correlationId?: string | null;
}

export interface TranscriptEventsPage {
  sessionId: string;
  correlationId: string;
  events: TranscriptGatewayEvent[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface TranscriptEventsStreamArgs {
  after?: string | null;
  signal?: AbortSignal;
  onEvent: (event: TranscriptGatewayEvent) => void;
  onCursor?: (cursor: string) => void;
}

/** POST /consents — server-time audit proof before local capture starts. */
export async function recordConsent(
  cfg: GatewayConfig,
  jwt: string,
  args: RecordConsentArgs,
): Promise<RecordConsentInfo> {
  const res = await fetchWithTimeout(
    consentsUrl(cfg),
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        meetingId: args.meetingId,
        captureId: args.captureId,
        consentVersion: args.consentVersion,
        consentTextHash: args.consentTextHash,
        locale: args.locale,
      }),
    },
    'recordConsent',
  );
  if (!res.ok) {
    throw new Error(await httpErrorMessage(res, 'recordConsent'));
  }
  return (await res.json()) as RecordConsentInfo;
}

/** POST /sessions — oturum başlat (WAV/PCM16 16kHz mono). */
export async function startSession(
  cfg: GatewayConfig,
  jwt: string,
  args: StartSessionArgs,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<SessionInfo> {
  const res = await fetchWithTimeout(
    sessionsUrl(cfg),
    {
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
    },
    'startSession',
  );
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
  const res = await fetchWithTimeout(
    chunksUrl(cfg, sessionId),
    {
      method: 'POST',
      headers: chunkHeaders({
        jwt,
        idempotencyKey,
        seq: chunk.seq,
        startedAtMs: chunk.startedAtMs,
        byteLength: chunk.bytes.byteLength,
      }),
      body: chunk.bytes,
    },
    'sendChunk',
  );
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
  const res = await fetchWithTimeout(
    finishUrl(cfg, sessionId),
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        'Idempotency-Key': idempotencyKey,
      },
    },
    'finishSession',
  );
  if (!res.ok) {
    throw new Error(await httpErrorMessage(res, 'finishSession'));
  }
}

/** GET /sessions/{id}/transcript-events — cursor-paged live transcript delivery. */
export async function readTranscriptEvents(
  cfg: GatewayConfig,
  jwt: string,
  sessionId: string,
  args: { after?: string | null; limit?: number; signal?: AbortSignal } = {},
): Promise<TranscriptEventsPage> {
  const res = await fetchWithTimeout(
    transcriptEventsUrl(cfg, sessionId, { after: args.after, limit: args.limit }),
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/json',
      },
      signal: args.signal,
    },
    'readTranscriptEvents',
  );
  if (!res.ok) {
    throw new Error(await httpErrorMessage(res, 'readTranscriptEvents'));
  }
  return (await res.json()) as TranscriptEventsPage;
}

/** GET /sessions/{id}/transcript-events/stream — SSE live transcript delivery. */
export async function streamTranscriptEvents(
  cfg: GatewayConfig,
  jwt: string,
  sessionId: string,
  args: TranscriptEventsStreamArgs,
): Promise<void> {
  const res = await desktopFetch(transcriptEventsStreamUrl(cfg, sessionId, { after: args.after }), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'text/event-stream',
    },
    signal: args.signal,
  });
  if (!res.ok) {
    throw new Error(await httpErrorMessage(res, 'streamTranscriptEvents'));
  }
  if (!res.body) {
    throw new Error('streamTranscriptEvents failed: response body is empty');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: SSE_DECODER_FATAL });
  const parser = new SseTranscriptParser(args.onEvent, args.onCursor);
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode());
    parser.flush();
  } finally {
    reader.releaseLock();
  }
}

class SseTranscriptParser {
  private buffer = '';
  private eventId: string | null = null;
  private eventName: string | null = null;
  private dataLines: string[] = [];

  constructor(
    private readonly onEvent: (event: TranscriptGatewayEvent) => void,
    private readonly onCursor?: (cursor: string) => void,
  ) {}

  push(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const newlineIndex = this.buffer.search(/\r?\n/);
      if (newlineIndex < 0) {
        return;
      }
      const rawLine = this.buffer.slice(0, newlineIndex);
      const newlineLength = this.buffer[newlineIndex] === '\r' ? 2 : 1;
      this.buffer = this.buffer.slice(newlineIndex + newlineLength);
      this.acceptLine(rawLine);
    }
  }

  flush(): void {
    if (this.buffer.length > 0) {
      this.acceptLine(this.buffer);
      this.buffer = '';
    }
    this.dispatch();
  }

  private acceptLine(rawLine: string): void {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') {
      this.dispatch();
      return;
    }
    if (line.startsWith(':')) {
      return;
    }

    const sep = line.indexOf(':');
    const field = sep >= 0 ? line.slice(0, sep) : line;
    const value = sep >= 0 ? line.slice(sep + 1).replace(/^ /, '') : '';
    if (field === 'id') {
      this.eventId = value;
    } else if (field === 'event') {
      this.eventName = value;
    } else if (field === 'data') {
      this.dataLines.push(value);
    }
  }

  private dispatch(): void {
    const data = this.dataLines.join('\n').trim();
    if (this.eventId) {
      this.onCursor?.(this.eventId);
    }
    if (!data) {
      this.resetEvent();
      return;
    }
    if (this.eventName && this.eventName !== 'transcript-chunk') {
      this.resetEvent();
      return;
    }

    try {
      const event = JSON.parse(data) as TranscriptGatewayEvent;
      if (typeof event.eventId === 'string' && typeof event.text === 'string') {
        this.onEvent(event);
        this.onCursor?.(event.eventId);
      }
    } finally {
      this.resetEvent();
    }
  }

  private resetEvent(): void {
    this.eventId = null;
    this.eventName = null;
    this.dataLines = [];
  }
}
