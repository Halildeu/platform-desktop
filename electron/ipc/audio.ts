/**
 * Audio IPC handlers (#2) — main process: renderer chunk'larını gateway'e gönderir.
 *
 * Renderer capture eder (getUserMedia+loopback+worklet→PCM16); main JWT'yi
 * (login'den) ekler ve ChunkSender ile audio-gateway'e REST chunk olarak yollar.
 * KVKK: chunk diske YAZILMAZ, memory'de akar.
 */

import { ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';

import {
  AmbiguousGatewaySessionStartError,
  ChunkSender,
} from '../services/gateway/chunk-sender.js';
import {
  finishSession,
  GatewaySessionFinishRejectedError,
  GatewaySessionStartRejectedError,
  loadGatewayConfig,
  newIdempotencyKey,
  recordConsent,
  startSession,
  type SttProvider,
  type TranscriptGatewayEvent,
} from '../services/gateway/gateway-client.js';
import {
  GATEWAY_LIVE_SAMPLE_RATE_HZ,
  GatewayLiveStream,
  normalizeGatewayLiveContextTerms,
  type GatewayLiveDeliveryStatus,
  type GatewayLiveServerEvent,
  type GatewayLiveStreamStopResult,
} from '../services/gateway/gateway-live-stream.js';
import { TranscriptEventSubscription } from '../services/gateway/transcript-event-subscription.js';
import { loadMeetingConfig, syncRecordingLifecycle } from '../services/meeting/meeting-client.js';
import {
  RecordingLifecycleOutbox,
  type PendingRecordingLifecycle,
} from '../services/meeting/recording-lifecycle-outbox.js';
import {
  RecordingStartOutbox,
  type PendingRecordingStart,
} from '../services/meeting/recording-start-outbox.js';
import {
  beginCapturePermissionLease,
  clearCapturePermissionLease,
  setRecordingActive,
} from '../services/display-media-lease.js';
import {
  loadRecorderRuntimeConfig,
  type RecorderRuntimeConfig,
} from '../services/recorder-runtime-config.js';
import { getValidAccessToken } from './auth.js';

const MAX_CHUNK_BYTES = 16_000 * 2 * 2; // 2s @ 16kHz PCM16 mono.
const MAX_LIVE_FRAME_BYTES = 16_000 * 2; // At most 1s @ 16kHz PCM16 mono.
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const MEETING_ID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const CONSENT_VERSION_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const CONSENT_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const LOCALE_PATTERN = /^[a-z]{2}(-[A-Z]{2})?$/;
const STALE_ACTIVE_NO_CHUNK_MS = 45_000;
const STALE_ACTIVE_NO_PROGRESS_MS = 15_000;
const GATEWAY_FINISH_MAX_ATTEMPTS = 3;
const GATEWAY_FINISH_RETRY_DELAY_MS = 150;
const CONSENT_UNCONFIRMED_CODE = 'AUDIO_GATEWAY_CONSENT_UNCONFIRMED';
const SESSION_START_UNCONFIRMED_CODE = 'AUDIO_GATEWAY_SESSION_START_UNCONFIRMED';
const SESSION_START_DENIED_CODE = 'AUDIO_GATEWAY_SESSION_START_DENIED';

interface ConsentRecord {
  acceptedAt: string;
  consentVersion: string;
  consentTextHash: string;
  locale: string;
}

interface ActiveRecording {
  captureId: string;
  meetingId: string;
  externalSessionId: string;
  sttProvider: SttProvider;
  transcriptionMode: TranscriptionMode;
  canonicalStartedAt: string;
  canonicalEndedAt: string | null;
  gatewayFinished: boolean;
  gatewayFinishIdempotencyKey: string;
  sender: ChunkSender;
  liveStream: GatewayLiveStream | null;
  transcriptSubscription: TranscriptEventSubscription;
  startedAtMs: number;
  lastStartedAtMs: number | null;
  rendererWebContentsId: number | null;
  consent: ConsentRecord;
  rendererSend: RendererSend | null;
}

export interface AudioFinishResult {
  ok: true;
  liveTranscript: GatewayLiveStreamStopResult | null;
}

function unconfirmedGatewayMutation(code: string, error: unknown): Error {
  const reason = error instanceof Error ? error.message : String(error);
  return new Error(`${code}: ${reason}`);
}

let active: ActiveRecording | null = null;
let starting = false;
let finishing = false;
let reconcilingLifecycle = false;
let lifecycleReconciliationInFlight: Promise<LifecycleReconciliationResult> | null = null;
let finishInFlight: { captureId: string; operation: Promise<AudioFinishResult> } | null = null;
let pendingConsent: ConsentRecord | null = null;
let startingRendererId: number | null = null;
let startingLiveStream: GatewayLiveStream | null = null;
const lifecycleOutbox = new RecordingLifecycleOutbox();
const startOutbox = new RecordingStartOutbox();
const unloadedRendererIds = new Set<number>();

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} is required`);
  }
  return value;
}

function requireIdentifier(value: unknown, label: string): string {
  const text = requireText(value, label);
  if (!ID_PATTERN.test(text)) {
    throw new Error(`${label} has invalid format`);
  }
  return text;
}

function requireMeetingId(value: unknown): string {
  const meetingId = requireText(value, 'meetingId');
  if (!MEETING_ID_PATTERN.test(meetingId)) {
    throw new Error('meetingId must be a canonical UUID');
  }
  return meetingId;
}

function requireConsentHash(value: unknown): string {
  const hash = requireText(value, 'consentTextHash');
  if (!CONSENT_HASH_PATTERN.test(hash)) {
    throw new Error('consentTextHash must be sha256:<64 lowercase hex>');
  }
  return hash;
}

function requireConsentVersion(value: unknown): string {
  const version = requireText(value, 'consentVersion');
  if (!CONSENT_VERSION_PATTERN.test(version)) {
    throw new Error('consentVersion has invalid format');
  }
  return version;
}

function requireLocale(value: unknown): string {
  const locale = requireText(value, 'locale');
  if (!LOCALE_PATTERN.test(locale)) {
    throw new Error('locale must be ISO language or language-region');
  }
  return locale;
}

function requireSttProvider(value: unknown): SttProvider {
  if (value === undefined) {
    return 'internal';
  }
  if (value !== 'internal' && value !== 'speechmatics') {
    throw new Error('sttProvider must be internal or speechmatics');
  }
  return value;
}

type TranscriptionMode = 'balanced' | 'realtime';

function requireTranscriptionMode(value: unknown): TranscriptionMode {
  if (value === undefined) {
    return 'balanced';
  }
  if (value !== 'balanced' && value !== 'realtime') {
    throw new Error('transcriptionMode must be balanced or realtime');
  }
  return value;
}

function requireActive(captureId: unknown): ActiveRecording {
  const id = requireText(captureId, 'captureId');
  if (!active) {
    throw new Error('no active recording session');
  }
  if (active.captureId !== id) {
    throw new Error('recording session mismatch');
  }
  return active;
}

type RendererSend = (channel: string, payload: unknown) => void;

const GATEWAY_LIVE_CORRELATION_ID = 'gateway-live';

function rendererSend(event: unknown): RendererSend | null {
  const sender = (event as { sender?: { send?: unknown } } | null)?.sender;
  if (typeof sender?.send !== 'function') {
    return null;
  }
  return sender.send.bind(sender) as RendererSend;
}

function rendererWebContentsId(event: unknown): number | null {
  const id = (event as { sender?: { id?: unknown } } | null)?.sender?.id;
  return typeof id === 'number' ? id : null;
}

function takeStartupCancellation(rendererId: number | null): boolean {
  return rendererId !== null && unloadedRendererIds.delete(rendererId);
}

function assertStartupOwnerPresent(rendererId: number | null): void {
  if (takeStartupCancellation(rendererId)) {
    throw new Error('renderer unloaded while recording session was starting');
  }
}

function emitTranscriptEvent(send: RendererSend | null, event: TranscriptGatewayEvent): void {
  if (!send) {
    console.warn('Transcript event dropped because renderer sender is unavailable', {
      sessionId: event.sessionId,
      eventId: event.eventId,
    });
    return;
  }
  send('audio:transcript-event', event);
}

function emitGatewayLiveTranscriptEvent(
  send: RendererSend | null,
  sessionId: string,
  meetingId: string,
  sourceEpochMs: number | null,
  sourceTimingReliable: boolean,
  transportEpoch: number,
  event: GatewayLiveServerEvent,
): void {
  if (event.type !== 'partial' && event.type !== 'final') {
    return;
  }
  const text =
    event.type === 'partial'
      ? [event.confirmed, event.tentative]
          .map((part) => part.trim())
          .filter(Boolean)
          .join(' ')
      : event.text.trim();
  if (!text) {
    return;
  }
  const receivedAtMs = Date.now();
  const elapsedMs =
    typeof event.elapsed_ms === 'number' && Number.isFinite(event.elapsed_ms)
      ? Math.max(0, event.elapsed_ms)
      : null;
  const hasSourceRange = Boolean(
    event.type === 'final' &&
    sourceTimingReliable &&
    sourceEpochMs !== null &&
    typeof event.source_start_sample === 'number' &&
    typeof event.source_end_sample === 'number',
  );
  const sourceStartedAtMs =
    event.type === 'final' && hasSourceRange && sourceEpochMs !== null
      ? sourceEpochMs + (event.source_start_sample! / GATEWAY_LIVE_SAMPLE_RATE_HZ) * 1000
      : null;
  const sourceEndedAtMs =
    event.type === 'final' && hasSourceRange && sourceEpochMs !== null
      ? sourceEpochMs + (event.source_end_sample! / GATEWAY_LIVE_SAMPLE_RATE_HZ) * 1000
      : null;
  const audioDurationMs =
    event.type === 'final' && hasSourceRange
      ? ((event.source_end_sample! - event.source_start_sample!) / GATEWAY_LIVE_SAMPLE_RATE_HZ) *
        1000
      : null;
  emitTranscriptEvent(send, {
    eventId: `live-${sessionId}-${transportEpoch}-${event.seq}`,
    sessionId,
    meetingId,
    chunkSeq: event.seq,
    chunkStartedAtMs:
      sourceStartedAtMs ?? (elapsedMs === null ? receivedAtMs : receivedAtMs - elapsedMs),
    transportEpoch,
    windowSeq: event.seq,
    windowStartedAtMs: sourceStartedAtMs,
    windowEndedAtMs: sourceEndedAtMs,
    audioDurationMs,
    flushReason: event.type === 'final' ? (event.reason ?? null) : null,
    text,
    textLength: text.length,
    status: event.type === 'final' ? 'FINAL' : 'DRAFT',
    receivedAtMs,
    sttLanguage: 'tr',
    durationSeconds: elapsedMs === null ? null : elapsedMs / 1000,
    correlationId: GATEWAY_LIVE_CORRELATION_ID,
  });
}

function transcriptErrorMessage(error: Error): string {
  if (error.message.includes('readTranscriptEvents failed: 404')) {
    return 'Transkript teslim endpointi bu audio-gateway imageinda yok; gateway rollout bekleniyor.';
  }
  return `Transkript akışı alınamadı: ${error.message}`;
}

/**
 * Surface live-delivery health, and — critically — take the warning back.
 *
 * A transient reconnect is silent: the circuit breaker heals it in well under a
 * second while the canonical REST upload never stops, so a red banner would be
 * pure noise. Only an open circuit is announced, and recovery clears it. The
 * previous behaviour warned on every single socket blip and never cleared,
 * which left a permanent alarm on screen for a stream that was working.
 */
function emitLiveDeliveryStatus(
  send: RendererSend | null,
  sessionId: string,
  status: GatewayLiveDeliveryStatus,
): void {
  if (status.kind === 'recovering') {
    return;
  }
  if (status.kind === 'healthy') {
    send?.('audio:transcript-recovered', { sessionId });
    return;
  }
  const retrySeconds = Math.max(1, Math.round((status.retryInMs ?? 0) / 1000));
  send?.('audio:transcript-error', {
    sessionId,
    message:
      `Canlı transkript geçici olarak duraklatıldı (${status.cause ?? 'bağlantı'}); ` +
      `kayıt kesintisiz sürüyor, ~${retrySeconds} sn içinde yeniden denenecek.`,
  });
}

function isTranscriptReadTimeout(error: Error): boolean {
  return /^readTranscriptEvents timed out after \d+ms$/.test(error.message);
}

function emitTranscriptError(send: RendererSend | null, sessionId: string, error: Error): void {
  if (isTranscriptReadTimeout(error)) {
    return;
  }
  send?.('audio:transcript-error', {
    sessionId,
    message: transcriptErrorMessage(error),
  });
}

function activeRecordingIsStale(recording: ActiveRecording, nowMs = Date.now()): boolean {
  const lastProgressMs = recording.lastStartedAtMs ?? recording.startedAtMs;
  const thresholdMs =
    recording.lastStartedAtMs === null ? STALE_ACTIVE_NO_CHUNK_MS : STALE_ACTIVE_NO_PROGRESS_MS;
  return nowMs - lastProgressMs > thresholdMs;
}

async function finishGatewaySessionWithRetry(
  externalSessionId: string,
  idempotencyKey: string,
): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= GATEWAY_FINISH_MAX_ATTEMPTS; attempt += 1) {
    try {
      await finishSession(
        loadGatewayConfig(),
        await getValidAccessToken(),
        externalSessionId,
        idempotencyKey,
      );
      return;
    } catch (error) {
      lastError = error;
      if (
        error instanceof GatewaySessionFinishRejectedError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 429
      ) {
        throw error;
      }
      if (attempt < GATEWAY_FINISH_MAX_ATTEMPTS) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, GATEWAY_FINISH_RETRY_DELAY_MS);
        });
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error('gateway finish could not be confirmed');
}

async function syncPendingLifecycle(record: PendingRecordingLifecycle): Promise<void> {
  let confirmed = record;
  if (confirmed.endedAt !== null && confirmed.gatewayFinishPending) {
    if (!confirmed.gatewayFinishIdempotencyKey) {
      confirmed = lifecycleOutbox.upsert({
        ...confirmed,
        gatewayFinishIdempotencyKey: newIdempotencyKey(),
      });
    }
    const finishIdempotencyKey = confirmed.gatewayFinishIdempotencyKey;
    if (!finishIdempotencyKey) {
      throw new Error('durable gateway finish idempotency key is missing');
    }
    try {
      await finishGatewaySessionWithRetry(confirmed.externalSessionId, finishIdempotencyKey);
      confirmed = lifecycleOutbox.markGatewayFinished(confirmed);
    } catch (error) {
      if (
        error instanceof GatewaySessionFinishRejectedError &&
        error.status === 404 &&
        error.code === 'AUDIO_GATEWAY_SESSION_NOT_FOUND' &&
        error.retryable === false
      ) {
        confirmed = lifecycleOutbox.markGatewaySessionNotFound(confirmed, { attemptCount: 1 });
      } else {
        throw error;
      }
    }
  }
  await syncRecordingLifecycle(loadMeetingConfig(), await getValidAccessToken(), confirmed);
  if (confirmed.endedAt === null || confirmed.gatewayFinishPending) {
    return;
  }
  lifecycleOutbox.remove(confirmed);
}

async function closeGatewayAfterOutboxFailure(
  sender: ChunkSender,
  externalSessionId: string,
  idempotencyKey: string,
): Promise<void> {
  try {
    await sender.finish(idempotencyKey);
  } catch {
    await finishGatewaySessionWithRetry(externalSessionId, idempotencyKey);
  }
}

async function recoverPendingStart(intent: PendingRecordingStart): Promise<void> {
  try {
    const session = await startSession(
      loadGatewayConfig(),
      await getValidAccessToken(),
      {
        meetingId: intent.meetingId,
        deviceId: intent.deviceId,
        language: intent.language,
        sttProvider: intent.sttProvider,
        transcriptionMode: intent.transcriptionMode,
      },
      intent.idempotencyKey,
    );
    const lifecycle =
      lifecycleOutbox
        .list()
        .find(
          (record) =>
            record.meetingId === intent.meetingId && record.externalSessionId === session.sessionId,
        ) ??
      lifecycleOutbox.upsert({
        meetingId: intent.meetingId,
        externalSessionId: session.sessionId,
        startedAt: intent.startedAt,
        endedAt: new Date().toISOString(),
        gatewayFinishPending: true,
        gatewayFinishIdempotencyKey: intent.gatewayFinishIdempotencyKey,
      });
    startOutbox.remove(intent.captureId);
    await syncPendingLifecycle(lifecycle);
  } catch (error) {
    if (
      error instanceof GatewaySessionStartRejectedError &&
      error.status !== 429 &&
      error.status < 500
    ) {
      // An explicit HTTP rejection proves that no session was created for the
      // durable idempotency key, so the intent can be acknowledged safely.
      startOutbox.remove(intent.captureId);
      return;
    }
    throw error;
  }
}

function hasBlockingPendingLifecycle(): boolean {
  return startOutbox.list().length > 0 || lifecycleOutbox.list().length > 0;
}

function ensureLifecycleReadyForNewRecording(): void {
  if (reconcilingLifecycle || lifecycleReconciliationInFlight) {
    throw new Error('recording lifecycle reconciliation is in progress');
  }
  if (hasBlockingPendingLifecycle()) {
    throw new Error('pending recording lifecycle must be reconciled before a new recording');
  }
}

interface LifecycleReconciliationResult {
  ok: boolean;
  processed: number;
  remaining: number;
  terminalized: number;
}

async function flushPendingRecordingLifecycles(): Promise<LifecycleReconciliationResult> {
  let processed = 0;
  let firstError: unknown = null;
  const unreconcilableBefore = lifecycleOutbox.listUnreconcilable().length;
  for (const intent of startOutbox.list()) {
    processed += 1;
    try {
      await recoverPendingStart(intent);
    } catch (error) {
      firstError ??= error;
    }
  }
  for (const pending of lifecycleOutbox.list()) {
    if (
      !pending.endedAt &&
      active?.meetingId === pending.meetingId &&
      active.externalSessionId === pending.externalSessionId
    ) {
      continue;
    }
    processed += 1;
    try {
      const finished = pending.endedAt
        ? pending
        : lifecycleOutbox.markEnded(pending, new Date().toISOString());
      await syncPendingLifecycle(finished);
    } catch (error) {
      firstError ??= error;
    }
  }
  const remainingLifecycle = lifecycleOutbox
    .list()
    .filter(
      (pending) =>
        pending.endedAt !== null ||
        active?.meetingId !== pending.meetingId ||
        active.externalSessionId !== pending.externalSessionId,
    ).length;
  const remaining = startOutbox.list().length + remainingLifecycle;
  if (firstError) {
    console.warn('Recording lifecycle reconciliation left durable work pending', {
      error: firstError instanceof Error ? firstError.message : 'unknown error',
      remaining,
    });
  }
  return {
    ok: firstError === null && remaining === 0,
    processed,
    remaining,
    terminalized: lifecycleOutbox.listUnreconcilable().length - unreconcilableBefore,
  };
}

async function finishActiveRecording(recording: ActiveRecording): Promise<AudioFinishResult> {
  let gatewayError: unknown = null;
  let canonicalError: unknown = null;
  let liveStreamDrainError: Error | null = null;
  let liveTranscript: GatewayLiveStreamStopResult | null = null;
  recording.canonicalEndedAt ??= new Date().toISOString();
  let durableError: unknown = null;
  let pending: PendingRecordingLifecycle = {
    meetingId: recording.meetingId,
    externalSessionId: recording.externalSessionId,
    startedAt: recording.canonicalStartedAt,
    endedAt: recording.canonicalEndedAt,
    gatewayFinishPending: !recording.gatewayFinished,
    gatewayFinishIdempotencyKey: recording.gatewayFinishIdempotencyKey,
  };
  try {
    pending = lifecycleOutbox.markEnded(pending, recording.canonicalEndedAt);
  } catch (error) {
    durableError = error;
  }
  try {
    if (!durableError) {
      if (recording.liveStream) {
        liveTranscript = await recording.liveStream.stop();
        if (liveTranscript.state === 'degraded') {
          liveStreamDrainError = new Error(
            `Canlı transkript son onayı alınamadı (${liveTranscript.reason}); kalıcı Gateway akışı işlenmeye devam ediyor.`,
          );
          emitTranscriptError(
            recording.rendererSend,
            recording.externalSessionId,
            liveStreamDrainError,
          );
        }
      }
      try {
        if (!recording.gatewayFinished) {
          await recording.sender.finish(recording.gatewayFinishIdempotencyKey);
          recording.gatewayFinished = true;
        }
      } catch (error) {
        gatewayError = error;
      }
      if (recording.gatewayFinished) {
        try {
          pending = lifecycleOutbox.markGatewayFinished(pending);
        } catch (error) {
          durableError ??= error;
        }
      }
      if (durableError) {
        throw durableError;
      }
      await syncPendingLifecycle(pending);
      recording.gatewayFinished = true;
    }
  } catch (error) {
    canonicalError = error;
  } finally {
    recording.liveStream?.close();
    recording.transcriptSubscription.stop();
    if (active?.captureId === recording.captureId) {
      active = null;
    }
    if (!active) {
      setRecordingActive(false);
      clearCapturePermissionLease();
    }
  }

  if (canonicalError) {
    throw canonicalError;
  }
  if (durableError) {
    throw durableError;
  }
  if (gatewayError && !recording.gatewayFinished) {
    throw gatewayError;
  }
  return { ok: true, liveTranscript };
}

async function disposeActiveRecording(recording: ActiveRecording): Promise<AudioFinishResult> {
  if (finishInFlight?.captureId === recording.captureId) {
    return finishInFlight.operation;
  }
  if (finishInFlight) {
    throw new Error('another recording lifecycle finish is in progress');
  }

  finishing = true;
  const reconciliation = lifecycleReconciliationInFlight;
  const operation = (async () => {
    if (reconciliation) {
      try {
        await reconciliation;
      } catch {
        // A failed historical reconciliation must not suppress cleanup of the
        // active capture. Its durable entries remain queued for the next pass.
      }
    }
    return finishActiveRecording(recording);
  })().finally(() => {
    if (finishInFlight?.captureId === recording.captureId) {
      finishInFlight = null;
    }
    finishing = false;
  });
  finishInFlight = { captureId: recording.captureId, operation };
  return operation;
}

async function ensureNoActiveRecording(): Promise<void> {
  if (!active) {
    return;
  }
  const recording = active;
  const state = recording.sender.getState();
  if (state !== 'active' || activeRecordingIsStale(recording)) {
    await disposeActiveRecording(recording);
    return;
  }
  throw new Error('recording session already active');
}

function requireChunkPayload(payload: unknown): {
  captureId: string;
  bytes: Uint8Array;
  startedAtMs: number;
} {
  if (!payload || typeof payload !== 'object') {
    throw new Error('invalid audio chunk payload');
  }

  const record = payload as {
    captureId?: unknown;
    bytes?: unknown;
    startedAtMs?: unknown;
  };
  const captureId = requireText(record.captureId, 'captureId');
  if (!(record.bytes instanceof Uint8Array)) {
    throw new Error('audio chunk bytes must be Uint8Array');
  }
  if (record.bytes.byteLength === 0 || record.bytes.byteLength > MAX_CHUNK_BYTES) {
    throw new Error(`audio chunk byte length out of bounds: ${record.bytes.byteLength}`);
  }
  if (
    typeof record.startedAtMs !== 'number' ||
    !Number.isFinite(record.startedAtMs) ||
    record.startedAtMs < 0
  ) {
    throw new Error('startedAtMs must be finite');
  }

  return { captureId, bytes: record.bytes, startedAtMs: record.startedAtMs };
}

function requireLiveFramePayload(payload: unknown): {
  captureId: string;
  bytes: Uint8Array;
  capturedAtMs: number;
} {
  if (!payload || typeof payload !== 'object') {
    throw new Error('invalid live audio frame payload');
  }
  const frame = payload as { captureId?: unknown; bytes?: unknown; capturedAtMs?: unknown };
  const captureId = requireText(frame.captureId, 'captureId');
  if (!(frame.bytes instanceof Uint8Array)) {
    throw new Error('live audio frame bytes must be Uint8Array');
  }
  if (
    frame.bytes.byteLength === 0 ||
    frame.bytes.byteLength > MAX_LIVE_FRAME_BYTES ||
    (frame.bytes.byteLength & 1) !== 0
  ) {
    throw new Error(`live audio frame byte length out of bounds: ${frame.bytes.byteLength}`);
  }
  if (
    typeof frame.capturedAtMs !== 'number' ||
    !Number.isSafeInteger(frame.capturedAtMs) ||
    frame.capturedAtMs < 0
  ) {
    throw new Error('capturedAtMs must be a non-negative safe integer');
  }
  return {
    captureId,
    bytes: frame.bytes,
    capturedAtMs: frame.capturedAtMs,
  };
}

export function registerAudioIpc(): void {
  ipcMain.on('audio:renderer-unloaded', (event): void => {
    unloadedRendererIds.add(event.sender.id);
    if (startingRendererId === event.sender.id) {
      startingLiveStream?.close();
    }
    const recording = active;
    if (!recording || recording.rendererWebContentsId !== event.sender.id) {
      return;
    }
    void disposeActiveRecording(recording).catch((error) => {
      console.warn('Recording lifecycle cleanup remains queued', {
        error: error instanceof Error ? error.message : 'unknown error',
      });
    });
  });

  ipcMain.handle('audio:recorder-config', async (): Promise<RecorderRuntimeConfig> => {
    return loadRecorderRuntimeConfig();
  });

  ipcMain.handle('audio:reconcile-lifecycle', async (): Promise<LifecycleReconciliationResult> => {
    if (starting || finishing || reconcilingLifecycle) {
      throw new Error('recording lifecycle reconciliation is busy');
    }
    reconcilingLifecycle = true;
    const operation = flushPendingRecordingLifecycles();
    lifecycleReconciliationInFlight = operation;
    try {
      return await operation;
    } finally {
      if (lifecycleReconciliationInFlight === operation) {
        lifecycleReconciliationInFlight = null;
      }
      reconcilingLifecycle = false;
    }
  });

  ipcMain.handle(
    'audio:consent',
    async (
      _e,
      consentVersion: unknown,
      consentTextHash: unknown,
      locale: unknown,
    ): Promise<{ ok: boolean }> => {
      const version = requireConsentVersion(consentVersion);
      const hash = requireConsentHash(consentTextHash);
      const loc = requireLocale(locale);
      pendingConsent = {
        acceptedAt: new Date().toISOString(),
        consentVersion: version,
        consentTextHash: hash,
        locale: loc,
      };
      return { ok: true };
    },
  );

  ipcMain.handle(
    'audio:prepare-capture',
    async (): Promise<{ ok: boolean; expiresAtMs: number }> => {
      if (!pendingConsent) {
        throw new Error('consent required before capture permission');
      }
      if (starting || finishing) {
        throw new Error('recording session already active');
      }
      await ensureNoActiveRecording();
      ensureLifecycleReadyForNewRecording();
      return { ok: true, expiresAtMs: beginCapturePermissionLease() };
    },
  );

  ipcMain.handle('audio:cancel-capture', async (event): Promise<{ ok: boolean }> => {
    const rendererId = rendererWebContentsId(event);
    if (rendererId !== null && startingRendererId === rendererId) {
      unloadedRendererIds.add(rendererId);
      startingLiveStream?.close();
    }
    if (!active) {
      clearCapturePermissionLease();
    }
    return { ok: true };
  });

  ipcMain.handle(
    'audio:start',
    async (
      event,
      meetingId: unknown,
      deviceId: unknown,
      contextTerms: unknown,
      sttProvider: unknown,
      transcriptionMode: unknown,
    ): Promise<{
      sessionId: string;
      transcriptSessionId: string;
      captureId: string;
      sttProvider: SttProvider;
      transcriptionMode: TranscriptionMode;
    }> => {
      if (!pendingConsent) {
        throw new Error('consent required before recording');
      }
      if (starting || finishing || reconcilingLifecycle || lifecycleReconciliationInFlight) {
        throw new Error('recording session already active');
      }
      const rendererId = rendererWebContentsId(event);
      if (rendererId !== null) {
        // Discard only an unload from an older document before this start
        // operation. Any unload after this point remains observable.
        unloadedRendererIds.delete(rendererId);
      }
      startingRendererId = rendererId;
      starting = true;
      try {
        await ensureNoActiveRecording();
        assertStartupOwnerPresent(rendererId);
        ensureLifecycleReadyForNewRecording();
        const consent = pendingConsent;
        if (!consent) {
          throw new Error('consent required before recording');
        }
        const normalizedMeetingId = requireMeetingId(meetingId);
        const normalizedDeviceId = requireIdentifier(deviceId, 'deviceId');
        const normalizedContextTerms = normalizeGatewayLiveContextTerms(contextTerms);
        const normalizedSttProvider = requireSttProvider(sttProvider);
        const normalizedTranscriptionMode = requireTranscriptionMode(transcriptionMode);
        pendingConsent = null;
        const captureId = randomUUID();
        const cfg = loadGatewayConfig();
        let consentAccessToken: string;
        try {
          consentAccessToken = await getValidAccessToken();
        } catch (error) {
          throw unconfirmedGatewayMutation(CONSENT_UNCONFIRMED_CODE, error);
        }
        assertStartupOwnerPresent(rendererId);
        try {
          await recordConsent(cfg, consentAccessToken, {
            meetingId: normalizedMeetingId,
            captureId,
            consentVersion: consent.consentVersion,
            consentTextHash: consent.consentTextHash,
            locale: consent.locale,
          });
        } catch (error) {
          throw unconfirmedGatewayMutation(CONSENT_UNCONFIRMED_CODE, error);
        }
        assertStartupOwnerPresent(rendererId);
        const sender = new ChunkSender(cfg, () => getValidAccessToken());
        const canonicalStartedAt = new Date().toISOString();
        const startIdempotencyKey = newIdempotencyKey();
        const gatewayFinishIdempotencyKey = newIdempotencyKey();
        const startIntent = startOutbox.upsert({
          meetingId: normalizedMeetingId,
          captureId,
          deviceId: normalizedDeviceId,
          language: 'tr',
          sttProvider: normalizedSttProvider,
          transcriptionMode: normalizedTranscriptionMode,
          startedAt: canonicalStartedAt,
          idempotencyKey: startIdempotencyKey,
          gatewayFinishIdempotencyKey,
        });
        let sessionId: string;
        try {
          sessionId = await sender.start(
            normalizedMeetingId,
            normalizedDeviceId,
            startIntent.language,
            startIntent.idempotencyKey,
            startIntent.sttProvider,
            startIntent.transcriptionMode,
          );
        } catch (error) {
          if (error instanceof GatewaySessionStartRejectedError) {
            if (error.status === 429 || error.status >= 500) {
              throw unconfirmedGatewayMutation(SESSION_START_UNCONFIRMED_CODE, error);
            }
            startOutbox.remove(captureId);
            throw new Error(`${SESSION_START_DENIED_CODE}: ${error.message}`);
          }
          if (error instanceof AmbiguousGatewaySessionStartError) {
            throw unconfirmedGatewayMutation(SESSION_START_UNCONFIRMED_CODE, error);
          }
          throw error;
        }
        let pendingLifecycle: PendingRecordingLifecycle;
        try {
          pendingLifecycle = lifecycleOutbox.upsert({
            meetingId: normalizedMeetingId,
            externalSessionId: sessionId,
            startedAt: canonicalStartedAt,
            endedAt: null,
            gatewayFinishPending: true,
            gatewayFinishIdempotencyKey,
          });
          startOutbox.remove(captureId);
        } catch (error) {
          void closeGatewayAfterOutboxFailure(sender, sessionId, gatewayFinishIdempotencyKey).catch(
            (cleanupError) => {
              console.warn(
                'Gateway cleanup after durable lifecycle failure could not be confirmed',
                {
                  error: cleanupError instanceof Error ? cleanupError.message : 'unknown error',
                },
              );
            },
          );
          throw error;
        }

        const cancelStartedLifecycle = async (): Promise<void> => {
          if (!takeStartupCancellation(rendererId)) {
            return;
          }
          const finished = lifecycleOutbox.markEnded(pendingLifecycle, new Date().toISOString());
          await syncPendingLifecycle(finished);
          throw new Error('renderer unloaded while recording session was starting');
        };
        const failStartedLifecycle = (error: unknown): never => {
          let pendingFinish = pendingLifecycle;
          try {
            pendingFinish = lifecycleOutbox.markEnded(pendingLifecycle, new Date().toISOString());
          } catch (durableError) {
            console.warn('Canonical start failure could not be marked ended in the durable queue', {
              error: durableError instanceof Error ? durableError.message : 'unknown error',
            });
          }

          // Do not let bounded gateway cleanup delay the canonical error past the
          // renderer IPC timeout. The durable entry remains authoritative and the
          // explicit reconciliation path will retry both canonical and gateway
          // finalization after a crash or an ambiguous response.
          void sender
            .finish(gatewayFinishIdempotencyKey)
            .then(() => {
              try {
                lifecycleOutbox.markGatewayFinished(pendingFinish);
              } catch (durableError) {
                console.warn('Gateway close confirmation remains queued', {
                  error: durableError instanceof Error ? durableError.message : 'unknown error',
                });
              }
            })
            .catch(() => undefined);
          throw error;
        };
        await cancelStartedLifecycle();
        const lifecycleAccessToken = await getValidAccessToken().catch((error: unknown) =>
          failStartedLifecycle(error),
        );
        await cancelStartedLifecycle();
        const canonicalLifecycle = await Promise.resolve()
          .then(() =>
            syncRecordingLifecycle(loadMeetingConfig(), lifecycleAccessToken, pendingLifecycle),
          )
          .catch((error: unknown) => failStartedLifecycle(error));
        const transcriptSessionId = canonicalLifecycle.sessionId;
        await cancelStartedLifecycle();
        const send = rendererSend(event);
        const runtimeConfig = loadRecorderRuntimeConfig();
        let liveStream: GatewayLiveStream | null = null;
        if (
          runtimeConfig.gatewayLiveStreamEnabled === true &&
          (startIntent.sttProvider === 'internal' || normalizedTranscriptionMode === 'realtime')
        ) {
          liveStream = new GatewayLiveStream({
            cfg,
            sessionId,
            contextTerms: normalizedContextTerms,
            getJwt: () => getValidAccessToken(),
            onEvent: (liveEvent) =>
              emitGatewayLiveTranscriptEvent(
                send,
                sessionId,
                normalizedMeetingId,
                liveStream?.getSourceStartedAtMs() ?? null,
                liveStream?.hasReliableSourceTiming() === true,
                liveStream?.getTransportEpoch() ?? -1,
                liveEvent,
              ),
            onError: (streamError) => emitTranscriptError(send, sessionId, streamError),
            onDeliveryStatus: (status) => emitLiveDeliveryStatus(send, sessionId, status),
          });
          startingLiveStream = liveStream;
          try {
            await liveStream.start();
          } catch (error) {
            liveStream.close();
            const ended = lifecycleOutbox.markEnded(pendingLifecycle, new Date().toISOString());
            try {
              await syncPendingLifecycle(ended);
            } catch (cleanupError) {
              console.warn('Gateway live stream startup cleanup remains queued', {
                error: cleanupError instanceof Error ? cleanupError.message : 'unknown error',
              });
            }
            if (rendererId !== null && unloadedRendererIds.delete(rendererId)) {
              throw new Error('renderer unloaded while gateway live stream was starting');
            }
            const reason = error instanceof Error ? error.message : String(error);
            throw new Error(`Yetkili Gateway canlı ses bağlantısı kurulamadı: ${reason}`);
          }
          if (rendererId !== null && unloadedRendererIds.delete(rendererId)) {
            liveStream.close();
            const ended = lifecycleOutbox.markEnded(pendingLifecycle, new Date().toISOString());
            await syncPendingLifecycle(ended);
            throw new Error('renderer unloaded while gateway live stream was starting');
          }
        }
        const transcriptSubscription = new TranscriptEventSubscription({
          cfg,
          sessionId,
          getJwt: () => getValidAccessToken(),
          onEvent: (transcriptEvent) => emitTranscriptEvent(send, transcriptEvent),
          onError: (error) => emitTranscriptError(send, sessionId, error),
          streamPreferred: false,
        });
        transcriptSubscription.start();
        active = {
          captureId,
          meetingId: normalizedMeetingId,
          externalSessionId: sessionId,
          sttProvider: startIntent.sttProvider,
          transcriptionMode: normalizedTranscriptionMode,
          canonicalStartedAt,
          canonicalEndedAt: null,
          gatewayFinished: false,
          gatewayFinishIdempotencyKey,
          sender,
          liveStream,
          transcriptSubscription,
          startedAtMs: Date.now(),
          lastStartedAtMs: null,
          rendererWebContentsId: rendererId,
          consent,
          rendererSend: send,
        };
        setRecordingActive(true);
        return {
          sessionId,
          transcriptSessionId,
          captureId,
          sttProvider: startIntent.sttProvider,
          transcriptionMode: startIntent.transcriptionMode,
        };
      } catch (err) {
        clearCapturePermissionLease();
        throw err;
      } finally {
        startingLiveStream = null;
        startingRendererId = null;
        starting = false;
      }
    },
  );

  ipcMain.handle('audio:chunk', async (_e, payload: unknown): Promise<{ seq: number }> => {
    if (finishing) {
      throw new Error('recording session is finishing');
    }
    const chunk = requireChunkPayload(payload);
    const recording = requireActive(chunk.captureId);
    if (recording.lastStartedAtMs !== null && chunk.startedAtMs < recording.lastStartedAtMs) {
      throw new Error('startedAtMs must be monotonic');
    }
    recording.lastStartedAtMs = chunk.startedAtMs;
    const seq = await recording.sender.send(chunk.bytes, chunk.startedAtMs);
    if (recording.transcriptionMode === 'balanced') {
      recording.liveStream?.sendAfterRestAccepted(chunk.bytes, seq, chunk.startedAtMs);
    }
    return { seq };
  });

  ipcMain.handle(
    'audio:live-frame',
    async (_e, payload: unknown): Promise<{ accepted: boolean }> => {
      if (finishing) {
        return { accepted: false };
      }
      const frame = requireLiveFramePayload(payload);
      const recording = requireActive(frame.captureId);
      if (recording.transcriptionMode !== 'realtime' || !recording.liveStream) {
        return { accepted: false };
      }
      return {
        accepted: recording.liveStream.sendRealtimeFrame(frame.bytes, frame.capturedAtMs),
      };
    },
  );

  ipcMain.handle('audio:finish', async (_e, captureId: unknown): Promise<AudioFinishResult> => {
    const recording = requireActive(captureId);
    return disposeActiveRecording(recording);
  });

  ipcMain.handle('audio:abort', async (_e, captureId: unknown): Promise<{ ok: boolean }> => {
    const id = requireText(captureId, 'captureId');
    if (active?.captureId === id) {
      const recording = active;
      await disposeActiveRecording(recording);
    } else {
      clearCapturePermissionLease();
    }
    return { ok: true };
  });
}
