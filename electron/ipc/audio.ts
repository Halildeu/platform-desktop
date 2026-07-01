/**
 * Audio IPC handlers (#2) — main process: renderer chunk'larını gateway'e gönderir.
 *
 * Renderer capture eder (getUserMedia+loopback+worklet→PCM16); main JWT'yi
 * (login'den) ekler ve ChunkSender ile audio-gateway'e REST chunk olarak yollar.
 * KVKK: chunk diske YAZILMAZ, memory'de akar.
 */

import { ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';

import { ChunkSender } from '../services/gateway/chunk-sender.js';
import {
  loadGatewayConfig,
  recordConsent,
  type TranscriptGatewayEvent,
} from '../services/gateway/gateway-client.js';
import { TranscriptEventSubscription } from '../services/gateway/transcript-event-subscription.js';
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
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const CONSENT_VERSION_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const CONSENT_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const LOCALE_PATTERN = /^[a-z]{2}(-[A-Z]{2})?$/;
const STALE_ACTIVE_NO_CHUNK_MS = 45_000;
const STALE_ACTIVE_NO_PROGRESS_MS = 15_000;

interface ConsentRecord {
  acceptedAt: string;
  consentVersion: string;
  consentTextHash: string;
  locale: string;
}

interface ActiveRecording {
  captureId: string;
  sender: ChunkSender;
  transcriptSubscription: TranscriptEventSubscription;
  startedAtMs: number;
  lastStartedAtMs: number | null;
  rendererWebContentsId: number | null;
  consent: ConsentRecord;
}

let active: ActiveRecording | null = null;
let starting = false;
let finishing = false;
let pendingConsent: ConsentRecord | null = null;

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

function transcriptErrorMessage(error: Error): string {
  if (error.message.includes('readTranscriptEvents failed: 404')) {
    return 'Transkript teslim endpointi bu audio-gateway imageinda yok; gateway rollout bekleniyor.';
  }
  return `Transkript akışı alınamadı: ${error.message}`;
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

async function disposeActiveRecording(recording: ActiveRecording): Promise<void> {
  try {
    if (recording.sender.getState() === 'active') {
      await recording.sender.finish();
    }
  } catch {
    // Best-effort temizlik; stale renderer state'i uygulamayi kilitlememeli.
  } finally {
    recording.transcriptSubscription.stop();
    if (active?.captureId === recording.captureId) {
      active = null;
    }
    setRecordingActive(false);
    clearCapturePermissionLease();
  }
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

export function registerAudioIpc(): void {
  ipcMain.on('audio:renderer-unloaded', (event): void => {
    const recording = active;
    if (!recording || recording.rendererWebContentsId !== event.sender.id) {
      return;
    }
    void disposeActiveRecording(recording);
  });

  ipcMain.handle('audio:recorder-config', async (): Promise<RecorderRuntimeConfig> => {
    return loadRecorderRuntimeConfig();
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
      if (starting) {
        throw new Error('recording session already active');
      }
      await ensureNoActiveRecording();
      return { ok: true, expiresAtMs: beginCapturePermissionLease() };
    },
  );

  ipcMain.handle('audio:cancel-capture', async (): Promise<{ ok: boolean }> => {
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
    ): Promise<{ sessionId: string; captureId: string }> => {
      if (!pendingConsent) {
        throw new Error('consent required before recording');
      }
      if (starting) {
        throw new Error('recording session already active');
      }
      starting = true;
      try {
        await ensureNoActiveRecording();
        const consent = pendingConsent;
        if (!consent) {
          throw new Error('consent required before recording');
        }
        pendingConsent = null;
        const normalizedMeetingId = requireIdentifier(meetingId, 'meetingId');
        const normalizedDeviceId = requireIdentifier(deviceId, 'deviceId');
        const captureId = randomUUID();
        const cfg = loadGatewayConfig();
        await recordConsent(cfg, await getValidAccessToken(), {
          meetingId: normalizedMeetingId,
          captureId,
          consentVersion: consent.consentVersion,
          consentTextHash: consent.consentTextHash,
          locale: consent.locale,
        });
        const sender = new ChunkSender(cfg, () => getValidAccessToken());
        const sessionId = await sender.start(normalizedMeetingId, normalizedDeviceId);
        const send = rendererSend(event);
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
          sender,
          transcriptSubscription,
          startedAtMs: Date.now(),
          lastStartedAtMs: null,
          rendererWebContentsId: rendererWebContentsId(event),
          consent,
        };
        setRecordingActive(true);
        return { sessionId, captureId };
      } catch (err) {
        clearCapturePermissionLease();
        throw err;
      } finally {
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
    return { seq };
  });

  ipcMain.handle('audio:finish', async (_e, captureId: unknown): Promise<{ ok: boolean }> => {
    const recording = requireActive(captureId);
    finishing = true;
    try {
      await recording.sender.finish();
    } finally {
      recording.transcriptSubscription.stop();
      finishing = false;
      if (active?.captureId === recording.captureId) {
        active = null;
        setRecordingActive(false);
      }
    }
    return { ok: true };
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
