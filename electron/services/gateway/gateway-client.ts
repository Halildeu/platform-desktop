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

import { desktopFetch, withDesktopFetchDeadline } from '../net/desktop-fetch.js';

const API = '/api/v1/audio-gateway';
const HTTP_TIMEOUT_MS = 15_000;
const TRANSCRIPT_EVENTS_HTTP_TIMEOUT_MS = 25_000;
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

async function fetchWithTimeout<T>(
  input: string,
  init: RequestInit,
  label: string,
  consume: (response: Response) => Promise<T>,
  timeoutMs: number = HTTP_TIMEOUT_MS,
): Promise<T> {
  return withDesktopFetchDeadline(input, init, timeoutMs, label, consume);
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

export interface FinishSessionInfo {
  sessionId: string;
  correlationId: string;
  finalState: 'FINISHED';
  finishedAtMs: number;
  alreadyFinished: boolean;
}

export class GatewaySessionStartRejectedError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'GatewaySessionStartRejectedError';
    this.status = status;
  }
}

function requiredGatewayIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function parseConsentInfo(value: unknown, expected: RecordConsentArgs): RecordConsentInfo {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('recordConsent response is not an object');
  }
  const record = value as Record<string, unknown>;
  for (const field of [
    'meetingId',
    'captureId',
    'consentVersion',
    'consentTextHash',
    'locale',
  ] as const) {
    if (record[field] !== expected[field]) {
      throw new Error(`recordConsent response ${field} mismatch`);
    }
  }
  const correlationId = requiredGatewayIdentifier(
    record.correlationId,
    'recordConsent correlationId',
  );
  if (
    typeof record.acceptedAtMs !== 'number' ||
    !Number.isSafeInteger(record.acceptedAtMs) ||
    record.acceptedAtMs <= 0 ||
    Math.abs(record.acceptedAtMs - Date.now()) > 5 * 60_000
  ) {
    throw new Error('recordConsent acceptedAtMs is invalid');
  }
  return {
    ...expected,
    correlationId,
    acceptedAtMs: record.acceptedAtMs,
  };
}

function parseSessionInfo(value: unknown): SessionInfo {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('startSession response is not an object');
  }
  const record = value as Record<string, unknown>;
  return {
    sessionId: requiredGatewayIdentifier(record.sessionId, 'startSession sessionId'),
  };
}

function parseFinishSessionInfo(value: unknown, expectedSessionId: string): FinishSessionInfo {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('finishSession response is not an object');
  }
  const record = value as Record<string, unknown>;
  const sessionId = requiredGatewayIdentifier(record.sessionId, 'finishSession sessionId');
  if (sessionId !== expectedSessionId) {
    throw new Error('finishSession response sessionId mismatch');
  }
  if (record.finalState !== 'FINISHED') {
    throw new Error('finishSession response finalState is invalid');
  }
  if (
    typeof record.finishedAtMs !== 'number' ||
    !Number.isSafeInteger(record.finishedAtMs) ||
    record.finishedAtMs <= 0
  ) {
    throw new Error('finishSession response finishedAtMs is invalid');
  }
  if (typeof record.alreadyFinished !== 'boolean') {
    throw new Error('finishSession response alreadyFinished is invalid');
  }
  return {
    sessionId,
    correlationId: requiredGatewayIdentifier(record.correlationId, 'finishSession correlationId'),
    finalState: 'FINISHED',
    finishedAtMs: record.finishedAtMs,
    alreadyFinished: record.alreadyFinished,
  };
}

export interface TranscriptGatewayEvent {
  eventId: string;
  sessionId: string;
  meetingId: string;
  chunkSeq: number;
  chunkStartedAtMs: number;
  windowSeq?: number | null;
  firstChunkSeq?: number | null;
  lastChunkSeq?: number | null;
  windowStartedAtMs?: number | null;
  windowEndedAtMs?: number | null;
  audioDurationMs?: number | null;
  flushReason?: string | null;
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
  return fetchWithTimeout(
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
    async (res) => {
      if (!res.ok) {
        throw new Error(await httpErrorMessage(res, 'recordConsent'));
      }
      return parseConsentInfo(await res.json(), args);
    },
  );
}

/** POST /sessions — oturum başlat (WAV/PCM16 16kHz mono). */
export async function startSession(
  cfg: GatewayConfig,
  jwt: string,
  args: StartSessionArgs,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<SessionInfo> {
  return fetchWithTimeout(
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
    async (res) => {
      if (!res.ok) {
        throw new GatewaySessionStartRejectedError(
          await httpErrorMessage(res, 'startSession'),
          res.status,
        );
      }
      return parseSessionInfo(await res.json());
    },
  );
}

/** POST /sessions/{id}/chunks — sıralı PCM16 chunk gönder. */
export async function sendChunk(
  cfg: GatewayConfig,
  jwt: string,
  sessionId: string,
  chunk: { seq: number; bytes: Uint8Array; startedAtMs: number },
  idempotencyKey: string = newIdempotencyKey(),
): Promise<void> {
  const body = new ArrayBuffer(chunk.bytes.byteLength);
  new Uint8Array(body).set(chunk.bytes);
  await fetchWithTimeout(
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
      body,
    },
    'sendChunk',
    async (res) => {
      if (!res.ok) {
        throw new Error(`${await httpErrorMessage(res, 'sendChunk')} (seq=${chunk.seq})`);
      }
    },
  );
}

/** POST /sessions/{id}/finish — oturumu terminal yap. */
export async function finishSession(
  cfg: GatewayConfig,
  jwt: string,
  sessionId: string,
  idempotencyKey: string = newIdempotencyKey(),
): Promise<FinishSessionInfo> {
  return fetchWithTimeout(
    finishUrl(cfg, sessionId),
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        'Idempotency-Key': idempotencyKey,
      },
    },
    'finishSession',
    async (res) => {
      if (!res.ok) {
        throw new Error(await httpErrorMessage(res, 'finishSession'));
      }
      return parseFinishSessionInfo(await res.json(), sessionId);
    },
  );
}

/** GET /sessions/{id}/transcript-events — cursor-paged live transcript delivery. */
export async function readTranscriptEvents(
  cfg: GatewayConfig,
  jwt: string,
  sessionId: string,
  args: { after?: string | null; limit?: number; signal?: AbortSignal } = {},
): Promise<TranscriptEventsPage> {
  return fetchWithTimeout(
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
    async (res) => {
      if (!res.ok) {
        throw new Error(await httpErrorMessage(res, 'readTranscriptEvents'));
      }
      return (await res.json()) as TranscriptEventsPage;
    },
    TRANSCRIPT_EVENTS_HTTP_TIMEOUT_MS,
  );
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
