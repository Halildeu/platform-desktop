import { useCallback, useEffect, useRef, useState } from 'react';

import {
  initialAudioCapturePreflightState,
  RECORDER_START_OPERATION_TIMEOUT_MS,
  type AudioCapturePreflightState,
  type Recorder,
  type SttProvider,
  type TranscriptionMode,
  startRecording,
  testAudioCaptureWorklet,
} from './audio/capture';
import {
  initialLiveSttPreflightState,
  testLiveSttStreamConnection,
  type LiveSttPreflightResult,
  type LiveSttPreflightState,
} from './audio/live-stt-preflight';
import type { LiveSttStreamStatusEvent, LiveSttTranscriptEvent } from './audio/live-stt-stream';
import { meetingTitleContextTerms } from './audio/live-stt-context';
import {
  ConsentDialog,
  CONSENT_VERSION,
  CONSENT_TEXT_HASH,
  CONSENT_LOCALE,
} from './components/ConsentDialog';
import { MeetingResultPicker, type RecentMeetingsStatus } from './components/MeetingResultPicker';
import { MeetingPlanner, type MeetingPlan } from './components/MeetingPlanner';
import { SummaryPanel, type CanonicalResultLoadStatus } from './components/SummaryPanel';
import type {
  MeetingIntelligenceReadOutcome,
  RecentMeetingSummary,
} from '../electron/services/meeting/meeting-client';
import {
  bindMeetingIntelligenceTarget,
  failMeetingIntelligence,
  initialMeetingIntelligence,
  markIntelligenceRecording,
  markIntelligenceWaiting,
  setMeetingIntelligenceResult,
} from './intelligence/meeting-intelligence';
import {
  canonicalAnalysisRunBaseline,
  isNewCanonicalAnalysisRun,
  meetingIntelligenceResultFromCanonicalResponse,
} from './intelligence/meeting-result-read';
import { TranscriptPanel } from './components/TranscriptPanel';
import {
  failTranscriptSession,
  finishTranscriptSession,
  initialTranscriptSession,
  markTranscriptProcessing,
  markTranscriptSegmentReviewed,
  markTranscriptBlocked,
  markTranscriptReady,
  markTranscriptWaitingForContract,
  reviewTranscriptSegmentText,
  startTranscriptSession,
  type TranscriptSegmentStatus,
  upsertTranscriptSegment,
  collapseAssembledFragments,
} from './transcript/session-transcript';

const MEETING_ID_MISSING_MESSAGE =
  'Geçerli meetingId bulunamadı; kayıt başlatılamaz. (meetingId kaynağı henüz belirlenmedi)';
const RECORDER_MEETING_ID_UNSET_MARKER = 'RECORDER_MEETING_ID tanimli degil';
const TRANSCRIPT_CLIENT_CLOCK_SKEW_MS = 30_000;
const MAX_PENDING_LIVE_TRANSCRIPT_EVENTS = 50;
const ACTIVE_AUDIO_RMS = 0.0008;
const LIVE_STT_PREFLIGHT_MAX_ATTEMPTS = 3;
const LIVE_STT_PREFLIGHT_RETRY_DELAY_MS = 180;
// Canonical analysis can legitimately trail the attended recording by minutes.
// Keep the user-visible state honest while a bounded five-minute follow-up runs.
export const CANONICAL_RESULT_POLL_DELAYS_MS = [
  0, 500, 1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 60_000, 60_000, 60_000, 60_000,
] as const;
export const CANONICAL_RESULT_FOLLOW_UP_TIMEOUT_MS = 300_000;
export const CANONICAL_RESULT_REQUEST_TIMEOUT_MS = 25_000;
export const CANONICAL_RESULT_DURABLE_RETRY_BASE_DELAY_MS = 60_000;
export const CANONICAL_RESULT_DURABLE_RETRY_MAX_DELAY_MS = 15 * 60_000;
export const CANONICAL_RESULT_DURABLE_RETRY_JITTER_RATIO = 0.2;
const LIFECYCLE_RECONCILIATION_MAX_ATTEMPTS = 6;
const LIFECYCLE_RECONCILIATION_BASE_DELAY_MS = 1_000;
export const LIFECYCLE_RECONCILIATION_DURABLE_RETRY_MS = 60_000;

function isLifecycleReconciliationError(message: string): boolean {
  return (
    message.startsWith('Bekleyen kayıt durumu') ||
    /^Bekleyen \d+ kayıt durumu arka planda yeniden denenecek\.$/.test(message)
  );
}
const GATEWAY_LIVE_CORRELATION_ID = 'gateway-live';

type CanonicalResultRetryReason = 'disabled' | 'not_ready' | 'recoverable_error';

interface CanonicalResultLoadOptions {
  pollUntilReady?: boolean;
  previousAnalysisRunId?: string | null;
  generatedNotBeforeMs?: number | null;
  resetDurableBackoff?: boolean;
}

interface RecorderRuntimeConfig {
  meetingId: string | null;
  meetingTitle?: string | null;
  deviceId: string;
  ready: boolean;
  reason: string | null;
  gatewayLiveStreamEnabled: boolean;
  liveSttStreamUrl: string | null;
  liveSttStreamReason: string | null;
}

interface MeetingContract {
  id: string;
  title: string;
  status: string;
  scheduledStart?: string | null;
  scheduledEnd?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

interface StartupPreflightOutcome {
  ok: boolean;
  message: string;
  captureOk: boolean;
  captureMessage: string;
  streamOk: boolean;
  streamMessage: string;
}

interface SafeJwtClaims {
  iss?: string;
  aud?: string | string[];
  azp?: string;
  scope?: string;
  exp?: number;
  tenantId?: number | string;
  userId?: number | string;
  companyId?: number | string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRetryableLiveSttPreflightFailure(message: string): boolean {
  const normalized = message.toLocaleLowerCase('tr-TR');
  return (
    normalized.includes('baglanti') ||
    normalized.includes('bağlantı') ||
    normalized.includes('kapandi') ||
    normalized.includes('kapandı') ||
    normalized.includes('acilamadi') ||
    normalized.includes('açılamadı')
  );
}

async function testLiveSttStreamConnectionWithRetry(
  streamUrl: string,
  onRetry: (attempt: number, previous: LiveSttPreflightResult) => void,
): Promise<LiveSttPreflightResult> {
  let lastResult: LiveSttPreflightResult | null = null;

  for (let attempt = 1; attempt <= LIVE_STT_PREFLIGHT_MAX_ATTEMPTS; attempt += 1) {
    const result = await testLiveSttStreamConnection(streamUrl);
    lastResult = result;
    if (result.ok || attempt === LIVE_STT_PREFLIGHT_MAX_ATTEMPTS) {
      return result;
    }
    if (!isRetryableLiveSttPreflightFailure(result.message)) {
      return result;
    }
    onRetry(attempt + 1, result);
    await delay(LIVE_STT_PREFLIGHT_RETRY_DELAY_MS);
  }

  return (
    lastResult ?? {
      ok: false,
      message: 'Direct STT stream kontrol edilemedi.',
      elapsedMs: 0,
      stage: null,
    }
  );
}

async function startRecordingWithTimeout(
  meetingId: string,
  deviceId: string,
  options?: Parameters<typeof startRecording>[2],
): Promise<Recorder> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let didTimeout = false;
  const pendingRecorder = startRecording(meetingId, deviceId, options);

  void pendingRecorder
    .then((rec) => {
      if (didTimeout) {
        void rec.stop().catch(() => undefined);
      }
    })
    .catch(() => undefined);

  try {
    return await new Promise<Recorder>((resolve, reject) => {
      timeoutId = setTimeout(() => {
        didTimeout = true;
        try {
          void Promise.resolve(window.electronAPI?.audio.cancelCapture()).catch(() => undefined);
        } catch {
          // Cancellation is best-effort; the timeout must still release the UI.
        }
        reject(
          new Error(
            `Recorder başlatma ${Math.round(
              RECORDER_START_OPERATION_TIMEOUT_MS / 1000,
            )} sn içinde yanıt vermedi; izin/gateway zinciri kontrol edilmeli.`,
          ),
        );
      }, RECORDER_START_OPERATION_TIMEOUT_MS);

      pendingRecorder.then(
        (rec) => {
          if (!didTimeout) {
            resolve(rec);
          }
        },
        (err: unknown) => {
          if (!didTimeout) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        },
      );
    });
  } finally {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }
  }
}

function canonicalResultAbortError(): Error {
  return Object.assign(new Error('Canonical result read cancelled'), { name: 'AbortError' });
}

function isCanonicalResultAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function waitForCanonicalResultDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(canonicalResultAbortError());
      return;
    }
    const timeoutId = window.setTimeout(() => {
      signal.removeEventListener('abort', handleAbort);
      resolve();
    }, ms);
    const handleAbort = (): void => {
      window.clearTimeout(timeoutId);
      signal.removeEventListener('abort', handleAbort);
      reject(canonicalResultAbortError());
    };
    signal.addEventListener('abort', handleAbort, { once: true });
  });
}

function withCanonicalResultRequestTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(canonicalResultAbortError());
      return;
    }
    let settled = false;
    const timeoutId = window.setTimeout(
      () => finish(() => reject(new Error('Kalıcı toplantı çıktısı isteği zaman aşımına uğradı'))),
      timeoutMs,
    );
    const handleAbort = (): void => finish(() => reject(canonicalResultAbortError()));
    const finish = (settle: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      window.clearTimeout(timeoutId);
      signal.removeEventListener('abort', handleAbort);
      settle();
    };
    signal.addEventListener('abort', handleAbort, { once: true });
    operation.then(
      (value) => {
        finish(() => resolve(value));
      },
      (error: unknown) => {
        finish(() => reject(error instanceof Error ? error : new Error(String(error))));
      },
    );
  });
}

export function canonicalResultDurableRetryDelayMs(
  attempt: number,
  randomValue = Math.random(),
): number {
  const exponentialDelay = Math.min(
    CANONICAL_RESULT_DURABLE_RETRY_MAX_DELAY_MS,
    CANONICAL_RESULT_DURABLE_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt),
  );
  const boundedRandom = Math.min(1, Math.max(0, randomValue));
  const jitterMultiplier =
    1 -
    CANONICAL_RESULT_DURABLE_RETRY_JITTER_RATIO +
    boundedRandom * CANONICAL_RESULT_DURABLE_RETRY_JITTER_RATIO * 2;
  return Math.round(exponentialDelay * jitterMultiplier);
}

function isRecoverableCanonicalResultError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLocaleLowerCase(
    'tr-TR',
  );
  if (
    /failed:\s*(401|403|400|404|405|409|410|415|422)\b/.test(message) ||
    message.includes('retryable=false') ||
    message.includes('forbidden') ||
    message.includes('unauthorized') ||
    message.includes('validation') ||
    message.includes('invalid canonical') ||
    message.includes('yanıt vermedi')
  ) {
    return false;
  }
  return (
    /failed:\s*(408|425|429|5\d\d)\b/.test(message) ||
    message.includes('retryable=true') ||
    message.includes('network=') ||
    message.includes('fetch failed') ||
    message.includes('socket') ||
    message.includes('bağlantı') ||
    message.includes('baglanti') ||
    message.includes('offline') ||
    message.includes('çevrimdışı') ||
    message.includes('cevrimdisi') ||
    message.includes('zaman aşım') ||
    message.includes('timeout')
  );
}

function transcriptStatusFromGateway(status: string): TranscriptSegmentStatus {
  switch (status.toUpperCase()) {
    case 'FINAL':
      return 'final';
    case 'REVISED':
      return 'revised';
    case 'STABILIZING':
      return 'stabilizing';
    // Gateway cumle birlestiricisinin (backend PR #918) okunabilir satiri.
    // Bu case eklenmeden once UTTERANCE default'a dusup 'draft' sayiliyordu ve
    // ayri bir eventId tasidigi icin AYRI bir segment yaratiyordu — yani ayni
    // metin hem parcali hem butun goruntuleniyordu.
    case 'UTTERANCE':
      return 'utterance';
    default:
      return 'draft';
  }
}

function transcriptStatusFromLiveStream(
  status: LiveSttTranscriptEvent['status'],
): TranscriptSegmentStatus {
  return status === 'final' ? 'final' : 'draft';
}

function transcriptTimelineStartedAtMs(event: {
  chunkStartedAtMs: number;
  windowStartedAtMs?: number | null;
  receivedAtMs?: number | null;
}): number {
  const eventStartedAtMs =
    typeof event.windowStartedAtMs === 'number' && Number.isFinite(event.windowStartedAtMs)
      ? event.windowStartedAtMs
      : event.chunkStartedAtMs;
  const receivedAtMs = event.receivedAtMs;
  if (
    typeof receivedAtMs === 'number' &&
    Number.isFinite(receivedAtMs) &&
    eventStartedAtMs - receivedAtMs > TRANSCRIPT_CLIENT_CLOCK_SKEW_MS
  ) {
    return receivedAtMs;
  }
  return eventStartedAtMs;
}

export function transcriptTimelineEndedAtMs(event: {
  chunkStartedAtMs: number;
  windowStartedAtMs?: number | null;
  windowEndedAtMs?: number | null;
  audioDurationMs?: number | null;
  receivedAtMs?: number | null;
}): number | null {
  const startedAtMs = transcriptTimelineStartedAtMs(event);
  const sourceStartedAtMs =
    typeof event.windowStartedAtMs === 'number' && Number.isFinite(event.windowStartedAtMs)
      ? event.windowStartedAtMs
      : event.chunkStartedAtMs;
  const clockWasRebased = startedAtMs !== sourceStartedAtMs;
  const audioDurationMs =
    typeof event.audioDurationMs === 'number' &&
    Number.isFinite(event.audioDurationMs) &&
    event.audioDurationMs > 0
      ? event.audioDurationMs
      : null;

  if (clockWasRebased) {
    return audioDurationMs === null ? null : startedAtMs + audioDurationMs;
  }
  if (
    typeof event.windowEndedAtMs === 'number' &&
    Number.isFinite(event.windowEndedAtMs) &&
    event.windowEndedAtMs > startedAtMs
  ) {
    return audioDurationMs === null
      ? event.windowEndedAtMs
      : Math.min(event.windowEndedAtMs, startedAtMs + audioDurationMs);
  }
  return audioDurationMs === null ? null : startedAtMs + audioDurationMs;
}

export function transcriptTimelineTimingBasis(event: {
  chunkStartedAtMs: number;
  windowStartedAtMs?: number | null;
  windowEndedAtMs?: number | null;
  audioDurationMs?: number | null;
  receivedAtMs?: number | null;
}): 'source' | 'delivery' | undefined {
  const endedAtMs = transcriptTimelineEndedAtMs(event);
  if (endedAtMs === null) {
    return undefined;
  }
  const sourceStartedAtMs =
    typeof event.windowStartedAtMs === 'number' && Number.isFinite(event.windowStartedAtMs)
      ? event.windowStartedAtMs
      : null;
  return sourceStartedAtMs !== null && transcriptTimelineStartedAtMs(event) === sourceStartedAtMs
    ? 'source'
    : 'delivery';
}

export function transcriptSegmentIdFromGateway(event: {
  eventId: string;
  sessionId: string;
  transportEpoch?: number | null;
  windowSeq?: number | null;
}): string {
  if (
    typeof event.windowSeq === 'number' &&
    Number.isFinite(event.windowSeq) &&
    event.windowSeq >= 0
  ) {
    if (event.eventId.startsWith(`live-${event.sessionId}-`)) {
      const transportEpoch =
        typeof event.transportEpoch === 'number' && Number.isSafeInteger(event.transportEpoch)
          ? event.transportEpoch
          : 0;
      return `gateway:${event.sessionId}:live:${transportEpoch}:window:${event.windowSeq}`;
    }
    return `gateway:${event.sessionId}:window:${event.windowSeq}`;
  }
  return event.eventId;
}

function normalizedTranscriptWords(text: string): string[] {
  return text
    .trim()
    .split(/\s+/)
    .map((word) => word.toLocaleLowerCase('tr-TR').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter(Boolean);
}

function containsContiguousWindow(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) {
    return false;
  }

  for (let index = 0; index <= haystack.length - needle.length; index += 1) {
    if (needle.every((word, offset) => haystack[index + offset] === word)) {
      return true;
    }
  }
  return false;
}

function segmentAlreadyCoversGatewayText(segmentText: string, gatewayText: string): boolean {
  const segmentWords = normalizedTranscriptWords(segmentText);
  const gatewayWords = normalizedTranscriptWords(gatewayText);
  if (segmentWords.length === 0 || gatewayWords.length === 0) {
    return false;
  }

  return (
    segmentWords.join('\u0000') === gatewayWords.join('\u0000') ||
    containsContiguousWindow(segmentWords, gatewayWords)
  );
}

function isGatewayFallbackStatus(status: string): boolean {
  const normalized = status.toUpperCase();
  return normalized === 'FINAL' || normalized === 'REVISED';
}

function shouldApplyGatewayTranscriptEvent(
  current: ReturnType<typeof initialTranscriptSession>,
  event: { text: string; status: string; chunkStartedAtMs: number },
  directStreamHasEvents: boolean,
): boolean {
  const text = event.text.trim();
  if (!text || !Number.isFinite(event.chunkStartedAtMs)) {
    return false;
  }

  if (!directStreamHasEvents) {
    return true;
  }

  if (!isGatewayFallbackStatus(event.status)) {
    return false;
  }

  return !current.segments.some((segment) => segmentAlreadyCoversGatewayText(segment.text, text));
}

function applyLiveTranscriptEvent(
  current: ReturnType<typeof initialTranscriptSession>,
  event: LiveSttTranscriptEvent,
): ReturnType<typeof initialTranscriptSession> {
  return upsertTranscriptSegment(current, {
    id: event.id,
    speakerLabel: 'Konuşmacı',
    startedAtMs: event.startedAtMs,
    endedAtMs: event.endedAtMs ?? null,
    timingBasis: event.timingBasis,
    status: transcriptStatusFromLiveStream(event.status),
    text: event.text,
    source: 'direct-stream',
    elapsedMs: event.elapsedMs ?? null,
    rms: event.rms ?? null,
    receivedAtMs: Date.now(),
  });
}

function isContractCreationExpected(reason: string | null | undefined): boolean {
  return typeof reason === 'string' && reason.includes(RECORDER_MEETING_ID_UNSET_MARKER);
}

function markMeetingIntelligenceWaitingForContract(
  current: ReturnType<typeof initialMeetingIntelligence>,
): ReturnType<typeof initialMeetingIntelligence> {
  return {
    ...current,
    meetingId: null,
    sessionId: null,
    status: 'idle',
    error: null,
    result: null,
  };
}

function App() {
  const [version, setVersion] = useState('');
  const [loggedIn, setLoggedIn] = useState(false);
  const [claims, setClaims] = useState<SafeJwtClaims | null>(null);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [paused, setPaused] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [startPending, setStartPending] = useState(false);
  const [contractPending, setContractPending] = useState(false);
  const [sttProvider, setSttProvider] = useState<SttProvider>('internal');
  const [transcriptionMode, setTranscriptionMode] = useState<TranscriptionMode>('realtime');
  const [meetingPlannerOpen, setMeetingPlannerOpen] = useState(false);
  const [showConsent, setShowConsent] = useState(false);
  const [recorderConfig, setRecorderConfig] = useState<RecorderRuntimeConfig | null>(null);
  const [transcriptSession, setTranscriptSession] = useState(initialTranscriptSession);
  const [meetingIntelligence, setMeetingIntelligence] = useState(initialMeetingIntelligence);
  const [recentMeetings, setRecentMeetings] = useState<RecentMeetingSummary[]>([]);
  const [recentMeetingsStatus, setRecentMeetingsStatus] = useState<RecentMeetingsStatus>('idle');
  const [recentMeetingsError, setRecentMeetingsError] = useState<string | null>(null);
  const [recentMeetingsTotal, setRecentMeetingsTotal] = useState(0);
  const [canonicalResultStatus, setCanonicalResultStatus] =
    useState<CanonicalResultLoadStatus>('idle');
  const [canonicalResultError, setCanonicalResultError] = useState<string | null>(null);
  const [canonicalResultRetryReason, setCanonicalResultRetryReason] =
    useState<CanonicalResultRetryReason>('disabled');
  const [canonicalResultRetryGeneration, setCanonicalResultRetryGeneration] = useState(0);
  const [canonicalNetworkOnline, setCanonicalNetworkOnline] = useState(
    () => navigator.onLine !== false,
  );
  const [canonicalDocumentVisible, setCanonicalDocumentVisible] = useState(
    () => document.visibilityState !== 'hidden',
  );
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [liveStreamActive, setLiveStreamActive] = useState(false);
  const [liveStreamReady, setLiveStreamReady] = useState(false);
  const [liveStreamStatus, setLiveStreamStatus] = useState<LiveSttStreamStatusEvent | null>(null);
  const [liveStreamPreflight, setLiveStreamPreflight] = useState<LiveSttPreflightState>(
    initialLiveSttPreflightState,
  );
  const [audioCapturePreflight, setAudioCapturePreflight] = useState<AudioCapturePreflightState>(
    initialAudioCapturePreflightState,
  );
  const [audioRms, setAudioRms] = useState<number | null>(null);
  const [lastAudioAtMs, setLastAudioAtMs] = useState<number | null>(null);
  const recorderRef = useRef<Recorder | null>(null);
  const startInFlightRef = useRef(false);
  const stopInFlightRef = useRef(false);
  const contractPendingRef = useRef(false);
  const liveStreamHasEventsRef = useRef(false);
  const transcriptSessionIdRef = useRef<string | null>(null);
  const pendingLiveTranscriptEventsRef = useRef<LiveSttTranscriptEvent[]>([]);
  const recentMeetingsReadSequenceRef = useRef(0);
  const canonicalResultReadSequenceRef = useRef(0);
  const canonicalResultAbortControllerRef = useRef<AbortController | null>(null);
  const canonicalResultReadInFlightRef = useRef(false);
  const canonicalResultDurableRetryTimerRef = useRef<number | null>(null);
  const canonicalResultDurableRetryAttemptRef = useRef(0);
  const canonicalResultMeetingIdRef = useRef<string | null>(meetingIntelligence.meetingId);
  const meetingIntelligenceStatusRef = useRef(meetingIntelligence.status);
  const canonicalRunBeforeRecordingRef = useRef<{
    meetingId: string;
    analysisRunId: string | null;
    recordingStartedAtMs: number;
  } | null>(null);
  canonicalResultMeetingIdRef.current = meetingIntelligence.meetingId;
  meetingIntelligenceStatusRef.current = meetingIntelligence.status;

  const disableCanonicalDurableRetry = useCallback((): void => {
    if (canonicalResultDurableRetryTimerRef.current !== null) {
      window.clearTimeout(canonicalResultDurableRetryTimerRef.current);
      canonicalResultDurableRetryTimerRef.current = null;
    }
    setCanonicalResultRetryReason('disabled');
  }, []);

  const enableCanonicalDurableRetry = useCallback(
    (reason: Exclude<CanonicalResultRetryReason, 'disabled'>): void => {
      setCanonicalResultRetryReason(reason);
      setCanonicalResultRetryGeneration((current) => current + 1);
    },
    [],
  );

  const cancelCanonicalResultWork = useCallback((): void => {
    canonicalResultReadSequenceRef.current += 1;
    canonicalResultAbortControllerRef.current?.abort();
    canonicalResultAbortControllerRef.current = null;
    canonicalResultReadInFlightRef.current = false;
    disableCanonicalDurableRetry();
  }, [disableCanonicalDurableRetry]);

  const loadCanonicalMeetingResult = useCallback(
    async (meetingId: string, options: CanonicalResultLoadOptions = {}): Promise<void> => {
      const {
        pollUntilReady = false,
        previousAnalysisRunId = null,
        generatedNotBeforeMs = null,
        resetDurableBackoff = true,
      } = options;
      canonicalResultAbortControllerRef.current?.abort();
      disableCanonicalDurableRetry();
      const abortController = new AbortController();
      canonicalResultAbortControllerRef.current = abortController;
      canonicalResultReadInFlightRef.current = true;
      const readSequence = canonicalResultReadSequenceRef.current + 1;
      canonicalResultReadSequenceRef.current = readSequence;
      if (resetDurableBackoff) {
        canonicalResultDurableRetryAttemptRef.current = 0;
      }
      setCanonicalResultStatus('loading');
      setCanonicalResultError(null);

      const delays = pollUntilReady ? CANONICAL_RESULT_POLL_DELAYS_MS : ([0] as const);
      const followUpDeadlineMs = Date.now() + CANONICAL_RESULT_FOLLOW_UP_TIMEOUT_MS;
      let sawNotReady = false;
      let lastRecoverableError: unknown = null;
      try {
        if (navigator.onLine === false) {
          throw new Error('Cihaz çevrimdışı; kalıcı toplantı çıktısı ağ geri gelince yenilenecek');
        }
        for (const delayMs of delays) {
          if (delayMs > 0) {
            const remainingBeforeDelayMs = followUpDeadlineMs - Date.now();
            if (remainingBeforeDelayMs <= 0) {
              break;
            }
            await waitForCanonicalResultDelay(
              Math.min(delayMs, remainingBeforeDelayMs),
              abortController.signal,
            );
          }
          if (
            abortController.signal.aborted ||
            canonicalResultReadSequenceRef.current !== readSequence
          ) {
            return;
          }

          const remainingBeforeReadMs = followUpDeadlineMs - Date.now();
          if (pollUntilReady && remainingBeforeReadMs <= 0) {
            break;
          }

          const resultRead = window.electronAPI?.meeting.getIntelligenceResult({ meetingId });
          if (!resultRead) {
            throw new Error('Electron meeting result bridge yanıt vermedi');
          }
          const requestTimeoutMs = pollUntilReady
            ? Math.min(CANONICAL_RESULT_REQUEST_TIMEOUT_MS, remainingBeforeReadMs)
            : CANONICAL_RESULT_REQUEST_TIMEOUT_MS;
          let outcome: MeetingIntelligenceReadOutcome;
          try {
            outcome = await withCanonicalResultRequestTimeout(
              resultRead,
              requestTimeoutMs,
              abortController.signal,
            );
          } catch (readError) {
            if (isCanonicalResultAbortError(readError)) {
              return;
            }
            if (!pollUntilReady || !isRecoverableCanonicalResultError(readError)) {
              throw readError;
            }
            lastRecoverableError = readError;
            continue;
          }
          if (!outcome) {
            throw new Error('Electron meeting result bridge yanıt vermedi');
          }
          if (outcome.status === 'ready') {
            if (
              !isNewCanonicalAnalysisRun(
                outcome.result,
                previousAnalysisRunId,
                generatedNotBeforeMs,
              )
            ) {
              sawNotReady = true;
              continue;
            }
            const result = meetingIntelligenceResultFromCanonicalResponse(outcome.result);
            if (
              canonicalResultReadSequenceRef.current !== readSequence ||
              canonicalResultMeetingIdRef.current !== meetingId
            ) {
              return;
            }
            setMeetingIntelligence((current) => {
              if (current.meetingId !== meetingId) {
                return current;
              }
              return setMeetingIntelligenceResult(current, result);
            });
            canonicalRunBeforeRecordingRef.current = null;
            canonicalResultDurableRetryAttemptRef.current = 0;
            setCanonicalResultStatus('ready');
            return;
          }
          sawNotReady = true;
        }

        if (
          canonicalResultReadSequenceRef.current === readSequence &&
          canonicalResultMeetingIdRef.current === meetingId
        ) {
          if (!sawNotReady && lastRecoverableError) {
            throw lastRecoverableError;
          }
          setCanonicalResultStatus('not_ready');
          enableCanonicalDurableRetry('not_ready');
        }
      } catch (readError) {
        if (isCanonicalResultAbortError(readError)) {
          return;
        }
        if (
          canonicalResultReadSequenceRef.current !== readSequence ||
          canonicalResultMeetingIdRef.current !== meetingId
        ) {
          return;
        }
        const message = readError instanceof Error ? readError.message : String(readError);
        setCanonicalResultStatus('error');
        setCanonicalResultError(`Kalıcı toplantı çıktısı alınamadı: ${message}`);
        if (isRecoverableCanonicalResultError(readError)) {
          enableCanonicalDurableRetry('recoverable_error');
        }
      } finally {
        if (canonicalResultAbortControllerRef.current === abortController) {
          canonicalResultAbortControllerRef.current = null;
          canonicalResultReadInFlightRef.current = false;
        }
      }
    },
    [disableCanonicalDurableRetry, enableCanonicalDurableRetry],
  );

  const loadRecentMeetings = useCallback(
    async (preserveMeeting: RecentMeetingSummary | null = null): Promise<void> => {
      const readSequence = recentMeetingsReadSequenceRef.current + 1;
      recentMeetingsReadSequenceRef.current = readSequence;
      setRecentMeetingsStatus('loading');
      setRecentMeetingsError(null);
      try {
        const page = await window.electronAPI?.meeting.listRecent();
        if (!page) {
          throw new Error('Electron meeting list bridge yanıt vermedi');
        }
        if (recentMeetingsReadSequenceRef.current !== readSequence) {
          return;
        }
        const meetings =
          preserveMeeting && !page.meetings.some((meeting) => meeting.id === preserveMeeting.id)
            ? [preserveMeeting, ...page.meetings].slice(0, page.size)
            : page.meetings;
        setRecentMeetings(meetings);
        setRecentMeetingsTotal(Math.max(page.totalElements, meetings.length));
        setRecentMeetingsStatus('ready');
      } catch (listError) {
        if (recentMeetingsReadSequenceRef.current !== readSequence) {
          return;
        }
        const message = listError instanceof Error ? listError.message : String(listError);
        setRecentMeetingsStatus('error');
        setRecentMeetingsError(`Toplantılar alınamadı: ${message}`);
      }
    },
    [],
  );

  const enqueuePendingLiveTranscriptEvent = (event: LiveSttTranscriptEvent): void => {
    pendingLiveTranscriptEventsRef.current = [
      ...pendingLiveTranscriptEventsRef.current,
      event,
    ].slice(-MAX_PENDING_LIVE_TRANSCRIPT_EVENTS);
  };

  useEffect(() => {
    transcriptSessionIdRef.current =
      transcriptSession.gatewaySessionId ?? transcriptSession.sessionId;
  }, [transcriptSession.gatewaySessionId, transcriptSession.sessionId]);

  useEffect(() => {
    if (
      !loggedIn ||
      !meetingIntelligence.meetingId ||
      recording ||
      meetingIntelligenceStatusRef.current === 'recording'
    ) {
      cancelCanonicalResultWork();
      setCanonicalResultStatus('idle');
      setCanonicalResultError(null);
      return;
    }
    const recordingBaseline =
      canonicalRunBeforeRecordingRef.current?.meetingId === meetingIntelligence.meetingId
        ? canonicalRunBeforeRecordingRef.current
        : null;
    void loadCanonicalMeetingResult(meetingIntelligence.meetingId, {
      previousAnalysisRunId: recordingBaseline?.analysisRunId ?? null,
      generatedNotBeforeMs: recordingBaseline?.recordingStartedAtMs ?? null,
    });
  }, [
    cancelCanonicalResultWork,
    loadCanonicalMeetingResult,
    loggedIn,
    meetingIntelligence.meetingId,
    recording,
  ]);

  useEffect(() => {
    canonicalRunBeforeRecordingRef.current = null;
  }, [meetingIntelligence.meetingId]);

  const revalidateCanonicalMeetingResult = useCallback((): void => {
    const meetingId = canonicalResultMeetingIdRef.current;
    if (
      !loggedIn ||
      !meetingId ||
      recording ||
      canonicalResultReadInFlightRef.current ||
      meetingIntelligenceStatusRef.current === 'recording' ||
      navigator.onLine === false ||
      document.visibilityState === 'hidden'
    ) {
      return;
    }
    const recordingBaseline =
      canonicalRunBeforeRecordingRef.current?.meetingId === meetingId
        ? canonicalRunBeforeRecordingRef.current
        : null;
    void loadCanonicalMeetingResult(meetingId, {
      previousAnalysisRunId: recordingBaseline?.analysisRunId ?? null,
      generatedNotBeforeMs: recordingBaseline?.recordingStartedAtMs ?? null,
      resetDurableBackoff: true,
    });
  }, [loadCanonicalMeetingResult, loggedIn, recording]);

  useEffect(() => {
    const handleOnline = (): void => {
      setCanonicalNetworkOnline(true);
      revalidateCanonicalMeetingResult();
    };
    const handleOffline = (): void => {
      setCanonicalNetworkOnline(false);
    };
    const handleVisibilityChange = (): void => {
      const visible = document.visibilityState !== 'hidden';
      setCanonicalDocumentVisible(visible);
      if (visible) {
        revalidateCanonicalMeetingResult();
      }
    };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [revalidateCanonicalMeetingResult]);

  useEffect(() => {
    if (
      canonicalResultRetryReason === 'disabled' ||
      !canonicalNetworkOnline ||
      !canonicalDocumentVisible ||
      !loggedIn ||
      !meetingIntelligence.meetingId ||
      recording ||
      meetingIntelligenceStatusRef.current === 'recording'
    ) {
      if (canonicalResultDurableRetryTimerRef.current !== null) {
        window.clearTimeout(canonicalResultDurableRetryTimerRef.current);
        canonicalResultDurableRetryTimerRef.current = null;
      }
      return;
    }

    const meetingId = meetingIntelligence.meetingId;
    const recordingBaseline =
      canonicalRunBeforeRecordingRef.current?.meetingId === meetingId
        ? canonicalRunBeforeRecordingRef.current
        : null;
    const retryDelayMs = canonicalResultDurableRetryDelayMs(
      canonicalResultDurableRetryAttemptRef.current,
    );
    canonicalResultDurableRetryAttemptRef.current += 1;
    canonicalResultDurableRetryTimerRef.current = window.setTimeout(() => {
      canonicalResultDurableRetryTimerRef.current = null;
      void loadCanonicalMeetingResult(meetingId, {
        previousAnalysisRunId: recordingBaseline?.analysisRunId ?? null,
        generatedNotBeforeMs: recordingBaseline?.recordingStartedAtMs ?? null,
        resetDurableBackoff: false,
      });
    }, retryDelayMs);

    return () => {
      if (canonicalResultDurableRetryTimerRef.current !== null) {
        window.clearTimeout(canonicalResultDurableRetryTimerRef.current);
        canonicalResultDurableRetryTimerRef.current = null;
      }
    };
  }, [
    canonicalDocumentVisible,
    canonicalNetworkOnline,
    canonicalResultRetryGeneration,
    canonicalResultRetryReason,
    loadCanonicalMeetingResult,
    loggedIn,
    meetingIntelligence.meetingId,
    recording,
  ]);

  useEffect(
    () => () => {
      canonicalResultReadSequenceRef.current += 1;
      canonicalResultAbortControllerRef.current?.abort();
      canonicalResultAbortControllerRef.current = null;
      canonicalResultReadInFlightRef.current = false;
      if (canonicalResultDurableRetryTimerRef.current !== null) {
        window.clearTimeout(canonicalResultDurableRetryTimerRef.current);
        canonicalResultDurableRetryTimerRef.current = null;
      }
    },
    [],
  );

  useEffect(() => {
    setLiveStreamPreflight(initialLiveSttPreflightState);
  }, [recorderConfig?.gatewayLiveStreamEnabled, recorderConfig?.liveSttStreamUrl]);

  useEffect(() => {
    if (
      !(transcriptSession.gatewaySessionId ?? transcriptSession.sessionId) ||
      pendingLiveTranscriptEventsRef.current.length === 0
    ) {
      return;
    }

    const pending = pendingLiveTranscriptEventsRef.current;
    pendingLiveTranscriptEventsRef.current = [];
    setTranscriptSession((current) => {
      if (!(current.gatewaySessionId ?? current.sessionId)) {
        pendingLiveTranscriptEventsRef.current = [
          ...pending,
          ...pendingLiveTranscriptEventsRef.current,
        ].slice(-MAX_PENDING_LIVE_TRANSCRIPT_EVENTS);
        return current;
      }
      return pending.reduce(applyLiveTranscriptEvent, current);
    });
  }, [transcriptSession.gatewaySessionId, transcriptSession.sessionId]);

  useEffect(() => {
    void window.electronAPI?.app
      .getVersion()
      .then((v) => setVersion(v))
      .catch(() => setVersion('unknown'));
    void window.electronAPI?.auth
      .status()
      .then((s) => {
        setLoggedIn(s.loggedIn);
        setClaims(s.claims ?? null);
      })
      .catch(() => undefined);
    void window.electronAPI?.audio
      .recorderConfig()
      .then((cfg) => {
        setRecorderConfig(cfg);
        if (!cfg.ready && isContractCreationExpected(cfg.reason)) {
          setTranscriptSession((current) =>
            markTranscriptWaitingForContract(current, { deviceId: cfg.deviceId }),
          );
          setMeetingIntelligence((current) => markMeetingIntelligenceWaitingForContract(current));
          return;
        }
        setTranscriptSession((current) =>
          cfg.ready && cfg.meetingId
            ? markTranscriptReady(current, { meetingId: cfg.meetingId, deviceId: cfg.deviceId })
            : markTranscriptBlocked(current, {
                reason: cfg.reason ?? MEETING_ID_MISSING_MESSAGE,
              }),
        );
        setMeetingIntelligence((current) =>
          bindMeetingIntelligenceTarget(current, { meetingId: cfg.meetingId }),
        );
      })
      .catch(() => {
        const fallback = {
          meetingId: null,
          deviceId: 'desktop-1',
          ready: false,
          reason: 'Recorder runtime config okunamadi.',
          gatewayLiveStreamEnabled: false,
          liveSttStreamUrl: null,
          liveSttStreamReason: null,
        };
        setRecorderConfig(fallback);
        setTranscriptSession((current) =>
          markTranscriptBlocked(current, { reason: fallback.reason }),
        );
        setMeetingIntelligence((current) =>
          bindMeetingIntelligenceTarget(current, { meetingId: fallback.meetingId }),
        );
      });
  }, []);

  useEffect(() => {
    if (!loggedIn) {
      recentMeetingsReadSequenceRef.current += 1;
      setRecentMeetings([]);
      setRecentMeetingsTotal(0);
      setRecentMeetingsStatus('idle');
      setRecentMeetingsError(null);
      return;
    }
    let cancelled = false;
    let retryTimer: number | null = null;
    let reconciliationInFlight = false;
    let immediateRetryRequested = false;
    const clearRetryTimer = (): void => {
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
        retryTimer = null;
      }
    };
    const runtimeCanReconcile = (): boolean =>
      navigator.onLine !== false && document.visibilityState !== 'hidden';
    const scheduleRetry = (attempt: number, delayMs: number): void => {
      clearRetryTimer();
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        void reconcile(attempt);
      }, delayMs);
    };
    const reconcile = async (attempt: number): Promise<void> => {
      if (cancelled) {
        return;
      }
      if (!runtimeCanReconcile()) {
        immediateRetryRequested = true;
        return;
      }
      if (reconciliationInFlight) {
        immediateRetryRequested = true;
        return;
      }
      immediateRetryRequested = false;
      reconciliationInFlight = true;
      let nextAttempt: number | null = null;
      let nextDelayMs: number | null = null;
      try {
        const outcome = await window.electronAPI?.audio.reconcileLifecycle();
        if (cancelled || !outcome) {
          return;
        }
        if (outcome.terminalized > 0) {
          setStatus(
            `${outcome.terminalized} eski Gateway oturumu sunucuda bulunamadi; ` +
              'dayanikli tani kaydina alindi. Yeni kayit baslatilabilir.',
          );
        }
        if (outcome.remaining === 0) {
          setError((current) => (isLifecycleReconciliationError(current) ? '' : current));
          return;
        }
        if (attempt >= LIFECYCLE_RECONCILIATION_MAX_ATTEMPTS - 1) {
          setError(`Bekleyen ${outcome.remaining} kayıt durumu arka planda yeniden denenecek.`);
          nextAttempt = 0;
          nextDelayMs = LIFECYCLE_RECONCILIATION_DURABLE_RETRY_MS;
        } else {
          nextAttempt = attempt + 1;
          nextDelayMs = LIFECYCLE_RECONCILIATION_BASE_DELAY_MS * 2 ** attempt;
        }
      } catch (error) {
        if (cancelled) {
          return;
        }
        if (attempt >= LIFECYCLE_RECONCILIATION_MAX_ATTEMPTS - 1) {
          setError(
            `Bekleyen kayıt durumu arka planda meeting-service ile eşitlenemedi: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          nextAttempt = 0;
          nextDelayMs = LIFECYCLE_RECONCILIATION_DURABLE_RETRY_MS;
        } else {
          nextAttempt = attempt + 1;
          nextDelayMs = LIFECYCLE_RECONCILIATION_BASE_DELAY_MS * 2 ** attempt;
        }
      } finally {
        reconciliationInFlight = false;
        if (!cancelled) {
          if (immediateRetryRequested && runtimeCanReconcile()) {
            immediateRetryRequested = false;
            clearRetryTimer();
            void reconcile(0);
          } else if (nextAttempt !== null && nextDelayMs !== null) {
            scheduleRetry(nextAttempt, nextDelayMs);
          }
        }
      }
    };
    const retryImmediately = (): void => {
      if (!runtimeCanReconcile()) {
        return;
      }
      clearRetryTimer();
      if (reconciliationInFlight) {
        immediateRetryRequested = true;
        return;
      }
      void reconcile(0);
    };
    const handleVisibilityChange = (): void => {
      if (document.visibilityState !== 'hidden') {
        retryImmediately();
      }
    };
    window.addEventListener('online', retryImmediately);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    void reconcile(0);
    void loadRecentMeetings();
    return () => {
      cancelled = true;
      clearRetryTimer();
      window.removeEventListener('online', retryImmediately);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [loadRecentMeetings, loggedIn]);

  useEffect(() => {
    const offTranscriptEvent = window.electronAPI?.audio.onTranscriptEvent?.((event) => {
      const isGatewayLiveEvent = event.correlationId === GATEWAY_LIVE_CORRELATION_ID;
      if (isGatewayLiveEvent) {
        liveStreamHasEventsRef.current = true;
        setLiveStreamReady(true);
        setLiveStreamActive(true);
        setLiveStreamStatus({ status: 'ready' });
      }
      setTranscriptSession((current) => {
        const gatewaySessionId = current.gatewaySessionId ?? current.sessionId;
        if (!gatewaySessionId || event.sessionId !== gatewaySessionId) {
          return current;
        }
        if (
          !shouldApplyGatewayTranscriptEvent(
            current,
            event,
            isGatewayLiveEvent ? false : liveStreamHasEventsRef.current,
          )
        ) {
          return current;
        }
        // UTTERANCE ise once ondan olusturulan ham parcalari kaldir; aksi
        // halde birlesmis cumle parcalarin YANINA eklenir ve tekrar olusur.
        const base =
          transcriptStatusFromGateway(event.status) === 'utterance'
            ? collapseAssembledFragments(current, event.sourceEventIds)
            : current;
        const endedAtMs = transcriptTimelineEndedAtMs(event);
        return upsertTranscriptSegment(base, {
          id: transcriptSegmentIdFromGateway(event),
          speakerLabel: 'Konuşmacı',
          startedAtMs: transcriptTimelineStartedAtMs(event),
          endedAtMs,
          timingBasis: transcriptTimelineTimingBasis(event),
          status: transcriptStatusFromGateway(event.status),
          text: event.text,
          source: 'gateway-events',
          elapsedMs:
            typeof event.durationSeconds === 'number' && Number.isFinite(event.durationSeconds)
              ? Math.round(event.durationSeconds * 1000)
              : null,
          receivedAtMs: event.receivedAtMs ?? null,
        });
      });
    });
    const offTranscriptError = window.electronAPI?.audio.onTranscriptError?.((event) => {
      setTranscriptSession((current) => {
        const gatewaySessionId = current.gatewaySessionId ?? current.sessionId;
        if (!gatewaySessionId || event.sessionId !== gatewaySessionId) {
          return current;
        }
        return { ...current, error: event.message };
      });
    });
    // Recovery must be able to take the warning back. Without this the banner
    // stayed on screen for the rest of the recording even though live delivery
    // had healed seconds later.
    const offTranscriptRecovered = window.electronAPI?.audio.onTranscriptRecovered?.((event) => {
      setTranscriptSession((current) => {
        const gatewaySessionId = current.gatewaySessionId ?? current.sessionId;
        if (!gatewaySessionId || event.sessionId !== gatewaySessionId || current.error === null) {
          return current;
        }
        return { ...current, error: null };
      });
    });
    const notifyRendererUnload = (): void => {
      window.electronAPI?.audio.rendererUnloaded?.();
    };

    window.addEventListener('beforeunload', notifyRendererUnload);

    return () => {
      notifyRendererUnload();
      offTranscriptEvent?.();
      offTranscriptError?.();
      offTranscriptRecovered?.();
      window.removeEventListener('beforeunload', notifyRendererUnload);
    };
  }, []);

  const handleLogin = async (): Promise<void> => {
    setBusy(true);
    setError('');
    setStatus('');
    try {
      const s = await window.electronAPI?.auth.login();
      setLoggedIn(s?.loggedIn ?? false);
      setClaims(s?.claims ?? null);
    } catch (e) {
      setError(`Giriş başarısız: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const bindReadyMeetingContract = (contract: MeetingContract): void => {
    const cfg: RecorderRuntimeConfig = {
      meetingId: contract.id,
      meetingTitle: contract.title,
      deviceId: recorderConfig?.deviceId ?? 'desktop-1',
      ready: true,
      reason: null,
      gatewayLiveStreamEnabled: recorderConfig?.gatewayLiveStreamEnabled ?? false,
      liveSttStreamUrl: recorderConfig?.liveSttStreamUrl ?? null,
      liveSttStreamReason: recorderConfig?.liveSttStreamReason ?? null,
    };
    setRecorderConfig(cfg);
    setTranscriptSession((current) =>
      markTranscriptReady(current, { meetingId: contract.id, deviceId: cfg.deviceId }),
    );
    setMeetingIntelligence((current) =>
      bindMeetingIntelligenceTarget(current, { meetingId: contract.id }),
    );
    const createdAt = contract.createdAt ?? contract.scheduledStart ?? new Date().toISOString();
    const updatedAt = contract.updatedAt ?? createdAt;
    const recentMeeting: RecentMeetingSummary = {
      id: contract.id,
      title: contract.title,
      status: contract.status,
      scheduledStart: contract.scheduledStart ?? null,
      scheduledEnd: contract.scheduledEnd ?? null,
      createdAt,
      updatedAt,
    };
    setRecentMeetings((current) => [
      recentMeeting,
      ...current.filter((meeting) => meeting.id !== contract.id),
    ]);
    setRecentMeetingsStatus('ready');
    setRecentMeetingsError(null);
    setRecentMeetingsTotal((current) => Math.max(current + 1, 1));
    void loadRecentMeetings(recentMeeting);
    setStatus(`Meeting contract hazır: ${contract.id}`);
  };

  const handleMeetingResultSelect = (meetingId: string): void => {
    cancelCanonicalResultWork();
    canonicalRunBeforeRecordingRef.current = null;
    setCanonicalResultError(null);
    const selectedMeeting = recentMeetings.find((meeting) => meeting.id === meetingId);
    setRecorderConfig((current) => {
      if (!current || current.ready || !isContractCreationExpected(current.reason)) {
        return current;
      }
      return {
        ...current,
        meetingId,
        meetingTitle: selectedMeeting?.title,
        ready: true,
        reason: null,
      };
    });
    setTranscriptSession((current) => {
      if (current.meetingId === meetingId) {
        return current;
      }
      return markTranscriptReady(initialTranscriptSession(), {
        meetingId,
        deviceId: recorderConfig?.deviceId ?? current.deviceId ?? 'desktop-1',
      });
    });
    setMeetingIntelligence((current) => bindMeetingIntelligenceTarget(current, { meetingId }));
  };

  const handleCreateMeetingContract = async (plan: MeetingPlan): Promise<void> => {
    if (contractPendingRef.current) {
      return;
    }
    contractPendingRef.current = true;
    setError('');
    setStatus('');
    setContractPending(true);
    try {
      const contract = await window.electronAPI?.meeting.createContract({
        title: plan.title,
        description: plan.description || 'Meeting Intelligence desktop recording.',
        scheduledStart: plan.scheduledStart,
        scheduledEnd: plan.scheduledEnd,
      });
      if (!contract) {
        throw new Error('meeting-service response empty');
      }
      setSttProvider(plan.sttProvider);
      setTranscriptionMode(plan.transcriptionMode);
      bindReadyMeetingContract(contract);
      setMeetingPlannerOpen(false);
    } catch (e) {
      const message = `Meeting contract oluşturulamadı: ${(e as Error).message}`;
      setError(message);
      setTranscriptSession((current) => markTranscriptBlocked(current, { reason: message }));
      setMeetingIntelligence((current) => failMeetingIntelligence(current, message));
    } finally {
      contractPendingRef.current = false;
      setContractPending(false);
    }
  };

  const handleLogout = async (): Promise<void> => {
    setError('');
    cancelCanonicalResultWork();
    try {
      const s = await window.electronAPI?.auth.logout();
      setLoggedIn(s?.loggedIn ?? false);
      setClaims(null);
      transcriptSessionIdRef.current = null;
      pendingLiveTranscriptEventsRef.current = [];
      setLiveStreamActive(false);
      setLiveStreamReady(false);
      setLiveStreamStatus(null);
      setLiveStreamPreflight(initialLiveSttPreflightState);
      setAudioRms(null);
      setLastAudioAtMs(null);
      setTranscriptSession(initialTranscriptSession());
      setMeetingIntelligence(initialMeetingIntelligence());
      recentMeetingsReadSequenceRef.current += 1;
      setRecentMeetings([]);
      setRecentMeetingsTotal(0);
      setRecentMeetingsStatus('idle');
      setRecentMeetingsError(null);
      canonicalRunBeforeRecordingRef.current = null;
      setCanonicalResultStatus('idle');
      setCanonicalResultError(null);
      setStatus('Çıkış yapıldı; Keycloak logout/revoke isteği gönderildi.');
    } catch (e) {
      setError(`Çıkış başarısız: ${(e as Error).message}`);
    }
  };

  const handleRecordClick = (): void => {
    if (!recorderConfig?.ready || !recorderConfig.meetingId) {
      setError(recorderConfig?.reason ?? MEETING_ID_MISSING_MESSAGE);
      setTranscriptSession((current) =>
        markTranscriptBlocked(current, {
          reason: recorderConfig?.reason ?? MEETING_ID_MISSING_MESSAGE,
        }),
      );
      setMeetingIntelligence((current) =>
        bindMeetingIntelligenceTarget(current, { meetingId: recorderConfig?.meetingId ?? null }),
      );
      return;
    }
    setShowConsent(true);
  };

  const handleConsentAccept = (): void => {
    setShowConsent(false);
    void (async () => {
      try {
        await window.electronAPI?.audio.consent(CONSENT_VERSION, CONSENT_TEXT_HASH, CONSENT_LOCALE);
      } catch (e) {
        const message = `Rıza kaydı başarısız: ${(e as Error).message}`;
        setError(message);
        setTranscriptSession((current) => failTranscriptSession(current, message));
        setMeetingIntelligence((current) => failMeetingIntelligence(current, message));
        return;
      }
      await handleStart();
    })();
  };

  const handleConsentCancel = (): void => {
    setShowConsent(false);
  };

  const handleStart = async (): Promise<void> => {
    if (startInFlightRef.current) {
      return;
    }
    startInFlightRef.current = true;
    setError('');
    setStartPending(true);
    cancelCanonicalResultWork();
    try {
      if (!recorderConfig?.ready || !recorderConfig.meetingId) {
        throw new Error(recorderConfig?.reason ?? MEETING_ID_MISSING_MESSAGE);
      }
      if (
        sttProvider === 'speechmatics' &&
        transcriptionMode === 'realtime' &&
        recorderConfig.gatewayLiveStreamEnabled !== true
      ) {
        throw new Error(
          'Speechmatics Anlık modu için yetkili Gateway canlı akışı kullanılabilir değil.',
        );
      }
      let microphonePermission = await window.electronAPI?.audio.permissionStatus();
      if (microphonePermission?.status === 'not-determined') {
        microphonePermission = await window.electronAPI?.audio.requestPermission();
      }
      if (
        microphonePermission?.status === 'denied' ||
        microphonePermission?.status === 'restricted'
      ) {
        throw new Error(
          'Mikrofon izni verilmedi. Sistem Ayarları > Gizlilik ve Güvenlik > Mikrofon bölümünden Meeting Intelligence erişimini açın.',
        );
      }
      const capturePreflight = await handleAudioCapturePreflight();
      if (!capturePreflight.ok) {
        throw new Error(capturePreflight.message);
      }
      const liveSttStreamUrlForSession =
        sttProvider === 'internal' && !recorderConfig.gatewayLiveStreamEnabled
          ? recorderConfig.liveSttStreamUrl
          : null;
      if (
        recorderConfig.gatewayLiveStreamEnabled &&
        (sttProvider === 'internal' || transcriptionMode === 'realtime')
      ) {
        setLiveStreamPreflight({
          status: 'checking',
          message: 'Yetkili Gateway canlı akışı oturumla bağlanıyor...',
          checkedAtMs: null,
          elapsedMs: null,
          stage: null,
        });
      } else if (sttProvider === 'internal' && recorderConfig.liveSttStreamUrl) {
        setLiveStreamPreflight({
          status: 'checking',
          message: 'Direct STT kayıt sırasında bağlanacak...',
          checkedAtMs: null,
          elapsedMs: null,
          stage: null,
        });
      }
      const meetingId = recorderConfig.meetingId;
      const deviceId = recorderConfig.deviceId;
      const meetingTitle =
        recorderConfig.meetingTitle ??
        recentMeetings.find((meeting) => meeting.id === meetingId)?.title ??
        null;
      canonicalRunBeforeRecordingRef.current = {
        meetingId,
        analysisRunId:
          meetingIntelligence.meetingId === meetingId
            ? (meetingIntelligence.result?.analysisRunId ?? null)
            : null,
        recordingStartedAtMs: Date.now(),
      };
      liveStreamHasEventsRef.current = false;
      setLiveStreamActive(false);
      setLiveStreamReady(false);
      setLiveStreamStatus(null);
      setAudioRms(null);
      setLastAudioAtMs(null);
      transcriptSessionIdRef.current = null;
      pendingLiveTranscriptEventsRef.current = [];
      const rec = await startRecordingWithTimeout(meetingId, deviceId, {
        sttProvider,
        transcriptionMode,
        liveSttStreamUrl: liveSttStreamUrlForSession,
        liveSttContextTerms: meetingTitleContextTerms(meetingTitle),
        onLiveStreamReady: () => {
          setLiveStreamReady(true);
        },
        onLiveStreamStatus: (event) => {
          setLiveStreamStatus(event);
          if (event.status !== 'ready') {
            setLiveStreamReady(false);
          }
        },
        onAudioActivity: (activity) => {
          setAudioRms(activity.rms);
          setLastAudioAtMs(activity.capturedAtMs);
        },
        onLiveTranscriptEvent: (event) => {
          liveStreamHasEventsRef.current = true;
          setLiveStreamReady(true);
          setLiveStreamActive(true);
          if (!transcriptSessionIdRef.current) {
            enqueuePendingLiveTranscriptEvent(event);
            return;
          }
          setTranscriptSession((current) => {
            if (!(current.gatewaySessionId ?? current.sessionId)) {
              enqueuePendingLiveTranscriptEvent(event);
              return current;
            }
            return applyLiveTranscriptEvent(current, event);
          });
        },
        onLiveTranscriptError: (err) => {
          setTranscriptSession((current) => {
            if (!(current.gatewaySessionId ?? current.sessionId)) {
              return current;
            }
            return {
              ...current,
              error: `Live STT stream: ${err.message}`,
            };
          });
        },
      });
      rec.onError((err) => {
        recorderRef.current = null;
        transcriptSessionIdRef.current = null;
        pendingLiveTranscriptEventsRef.current = [];
        setLiveStreamActive(false);
        setLiveStreamReady(false);
        setLiveStreamStatus(null);
        setAudioRms(null);
        setLastAudioAtMs(null);
        setRecording(false);
        setPaused(false);
        const message = `Kayıt hatası (ses kaybı): ${err.message}`;
        window.electronAPI?.tray.setRecordingActive(false, 'error', message);
        setError(message);
        setStatus('');
        setTranscriptSession((current) => failTranscriptSession(current, message));
        setMeetingIntelligence((current) => failMeetingIntelligence(current, message));
      });
      recorderRef.current = rec;
      setRecording(true);
      setPaused(false);
      window.electronAPI?.tray.setRecordingActive(true);
      const pendingLiveTranscriptEvents = pendingLiveTranscriptEventsRef.current;
      pendingLiveTranscriptEventsRef.current = [];
      setTranscriptSession((current) =>
        pendingLiveTranscriptEvents.reduce(
          applyLiveTranscriptEvent,
          startTranscriptSession(current, {
            sessionId: rec.transcriptSessionId,
            gatewaySessionId: rec.sessionId,
            meetingId,
            deviceId,
            hasLoopback: rec.hasLoopback,
            startedAtMs: Date.now(),
          }),
        ),
      );
      setMeetingIntelligence((current) =>
        markIntelligenceRecording(current, {
          meetingId,
          sessionId: rec.transcriptSessionId,
        }),
      );
      const mode = rec.hasLoopback ? 'mikrofon + sistem sesi' : 'yalnız mikrofon';
      const gatewayMode = rec.gatewayActive === false ? ', direct stream' : '';
      setStatus(`Kayıt başladı (${mode}${gatewayMode}, oturum ${rec.sessionId})`);
    } catch (e) {
      const message = `Kayıt başlatılamadı: ${(e as Error).message}`;
      transcriptSessionIdRef.current = null;
      pendingLiveTranscriptEventsRef.current = [];
      setLiveStreamActive(false);
      setLiveStreamReady(false);
      setLiveStreamStatus(null);
      setAudioRms(null);
      setLastAudioAtMs(null);
      setError(message);
      setTranscriptSession((current) => failTranscriptSession(current, message));
      setMeetingIntelligence((current) => failMeetingIntelligence(current, message));
    } finally {
      startInFlightRef.current = false;
      setStartPending(false);
    }
  };

  const handleAudioCapturePreflight = async (): Promise<{ ok: boolean; message: string }> => {
    setAudioCapturePreflight({
      status: 'checking',
      message: 'Ses işleyici kontrol ediliyor...',
      checkedAtMs: null,
      elapsedMs: null,
      moduleUrl: null,
    });
    try {
      const result = await testAudioCaptureWorklet();
      setAudioCapturePreflight({
        status: result.ok ? 'ready' : 'error',
        message: result.message,
        checkedAtMs: Date.now(),
        elapsedMs: result.elapsedMs,
        moduleUrl: result.moduleUrl,
      });
      return { ok: result.ok, message: result.message };
    } catch (error) {
      const message = `Ses işleyici test hatası: ${
        error instanceof Error ? error.message : String(error)
      }`;
      setAudioCapturePreflight({
        status: 'error',
        message,
        checkedAtMs: Date.now(),
        elapsedMs: null,
        moduleUrl: null,
      });
      return { ok: false, message };
    }
  };

  const handleLiveStreamPreflight = async (): Promise<StartupPreflightOutcome> => {
    const captureCheck = handleAudioCapturePreflight();

    if (recorderConfig?.gatewayLiveStreamEnabled) {
      const message =
        'Gateway canlı akış yapılandırması bulundu; oturum ve yetki kayıt başlatılırken doğrulanacak.';
      const captureOutcome = await captureCheck;
      setLiveStreamPreflight({
        status: captureOutcome.ok ? 'ready' : 'error',
        message,
        checkedAtMs: Date.now(),
        elapsedMs: null,
        stage: null,
      });
      return {
        ok: captureOutcome.ok,
        message: captureOutcome.ok ? message : captureOutcome.message,
        captureOk: captureOutcome.ok,
        captureMessage: captureOutcome.message,
        streamOk: true,
        streamMessage: message,
      };
    }

    const streamUrl = recorderConfig?.liveSttStreamUrl;
    if (!streamUrl) {
      const message = recorderConfig?.liveSttStreamReason ?? 'LIVE_STT_STREAM_URL tanimli degil.';
      setLiveStreamPreflight({
        status: 'error',
        message,
        checkedAtMs: Date.now(),
        elapsedMs: null,
        stage: null,
      });
      const captureOutcome = await captureCheck;
      return {
        ok: false,
        message,
        captureOk: captureOutcome.ok,
        captureMessage: captureOutcome.message,
        streamOk: false,
        streamMessage: message,
      };
    }

    setLiveStreamPreflight({
      status: 'checking',
      message: 'Direct STT stream kontrol ediliyor...',
      checkedAtMs: null,
      elapsedMs: null,
      stage: null,
    });
    let streamOutcome: { ok: boolean; message: string } = {
      ok: false,
      message: 'Direct STT stream kontrol edilemedi.',
    };
    try {
      const result = await testLiveSttStreamConnectionWithRetry(streamUrl, (attempt, previous) => {
        setLiveStreamPreflight({
          status: 'checking',
          message: `Direct STT bağlantısı tekrar deneniyor (${attempt}/${LIVE_STT_PREFLIGHT_MAX_ATTEMPTS})... Son hata: ${previous.message}`,
          checkedAtMs: null,
          elapsedMs: previous.elapsedMs,
          stage: previous.stage,
        });
      });
      streamOutcome = { ok: result.ok, message: result.message };
      setLiveStreamPreflight({
        status: result.ok ? 'ready' : 'error',
        message: result.message,
        checkedAtMs: Date.now(),
        elapsedMs: result.elapsedMs,
        stage: result.stage,
      });
    } catch (error) {
      streamOutcome = {
        ok: false,
        message: `Direct STT test hatasi: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
      setLiveStreamPreflight({
        status: 'error',
        message: streamOutcome.message,
        checkedAtMs: Date.now(),
        elapsedMs: null,
        stage: null,
      });
    }
    const captureOutcome = await captureCheck;
    if (!captureOutcome.ok) {
      return {
        ok: false,
        message: captureOutcome.message,
        captureOk: false,
        captureMessage: captureOutcome.message,
        streamOk: streamOutcome.ok,
        streamMessage: streamOutcome.message,
      };
    }
    return {
      ok: streamOutcome.ok,
      message: streamOutcome.message,
      captureOk: true,
      captureMessage: captureOutcome.message,
      streamOk: streamOutcome.ok,
      streamMessage: streamOutcome.message,
    };
  };

  const handleStop = useCallback(async (): Promise<void> => {
    // Re-entrancy guard: ilk stop upload/finish beklerken UI butonu veya tray
    // ikinci kez tetiklerse erken "tamamlandı" ilan edilirdi (capture.stop
    // ikinci çağrıda hemen döner). Tek finalizasyon garantisi.
    if (stopInFlightRef.current) {
      return;
    }
    stopInFlightRef.current = true;
    setStopping(true);
    let stopOutcome: 'finished' | 'degraded' | 'error' = 'finished';
    let stopErrorMessage: string | undefined;
    try {
      const recorder = recorderRef.current;
      await recorder?.stop();
      const stopResult = recorder?.getStopResult?.() ?? null;
      const degradedStream = [stopResult?.gatewayLive, stopResult?.liveStt].find(
        (result) => result?.state === 'degraded',
      );
      transcriptSessionIdRef.current = null;
      pendingLiveTranscriptEventsRef.current = [];
      setLiveStreamActive(false);
      setLiveStreamReady(false);
      setLiveStreamStatus(null);
      setAudioRms(null);
      setLastAudioAtMs(null);
      if (degradedStream) {
        const warning = `Kayıt gönderildi; canlı transkriptin son onayı alınamadı (${degradedStream.reason}). Kalıcı sonuç işleniyor.`;
        stopOutcome = 'degraded';
        stopErrorMessage = warning;
        setStatus(warning);
        setError(warning);
        setTranscriptSession((current) => markTranscriptProcessing(current, Date.now(), warning));
      } else {
        setStatus('Kayıt tamamlandı, gönderildi.');
        setTranscriptSession((current) => finishTranscriptSession(current, Date.now()));
      }
      setMeetingIntelligence((current) => markIntelligenceWaiting(current));
    } catch (e) {
      const message = `Kayıt durdurulamadı: ${(e as Error).message}`;
      stopOutcome = 'error';
      stopErrorMessage = message;
      setError(message);
      setTranscriptSession((current) => failTranscriptSession(current, message));
      setMeetingIntelligence((current) => failMeetingIntelligence(current, message));
    } finally {
      recorderRef.current = null;
      setRecording(false);
      setPaused(false);
      setLiveStreamActive(false);
      setLiveStreamReady(false);
      setLiveStreamStatus(null);
      setAudioRms(null);
      setLastAudioAtMs(null);
      window.electronAPI?.tray.setRecordingActive(false, stopOutcome, stopErrorMessage);
      stopInFlightRef.current = false;
      setStopping(false);
    }
  }, []);

  const handlePause = useCallback((): void => {
    const rec = recorderRef.current;
    if (!rec || rec.isPaused()) {
      return;
    }
    rec.pause();
    setPaused(true);
    window.electronAPI?.tray.setPaused(true);
    setStatus('Kayıt duraklatıldı.');
  }, []);

  const handleResume = useCallback((): void => {
    const rec = recorderRef.current;
    if (!rec || !rec.isPaused()) {
      return;
    }
    rec.resume();
    setPaused(false);
    window.electronAPI?.tray.setPaused(false);
    setStatus('Kayıt sürüyor.');
  }, []);

  useEffect(() => {
    // Tray "Kaydı Bitir" tıklaması — sadece aktif kayıt varken menüde etkin
    // (tray-manager.ts), ama burada da savunmacı kontrol edilir.
    const offStopRequested = window.electronAPI?.tray.onStopRequested(() => {
      if (recorderRef.current) {
        void handleStop();
      }
    });
    return () => offStopRequested?.();
  }, [handleStop]);

  useEffect(() => {
    // Tray "Kaydı Duraklat/Sürdür" — #37. Menu item yalnız aktif kayıtta
    // görünür (tray-manager.ts); handler'lar da recorder yoksa no-op.
    const offPause = window.electronAPI?.tray.onPauseRequested(() => handlePause());
    const offResume = window.electronAPI?.tray.onResumeRequested(() => handleResume());
    return () => {
      offPause?.();
      offResume?.();
    };
  }, [handlePause, handleResume]);

  const handleTranscriptSegmentTextChange = (segmentId: string, text: string): void => {
    setTranscriptSession((current) =>
      reviewTranscriptSegmentText(current, {
        id: segmentId,
        text,
        reviewedAtMs: Date.now(),
      }),
    );
  };

  const handleTranscriptSegmentReviewed = (segmentId: string): void => {
    setTranscriptSession((current) =>
      markTranscriptSegmentReviewed(current, {
        id: segmentId,
        reviewedAtMs: Date.now(),
      }),
    );
  };

  const hasMeetingWorkspace = loggedIn && Boolean(meetingIntelligence.meetingId);

  return (
    <div className="app-root">
      <header className="app-header">
        <h1>Meeting Intelligence</h1>
        <span className="version">v{version}</span>
      </header>
      <main className="app-main">
        <section
          className={`recorder-shell${hasMeetingWorkspace ? '' : ' recorder-shell--planning'}`}
          aria-label="Toplantı çalışma alanı"
        >
          <div className="control-panel">
            {!loggedIn ? (
              <>
                <p className="control-copy">Toplantı kaydı için giriş yapın.</p>
                <button
                  className="primary-action"
                  type="button"
                  onClick={() => void handleLogin()}
                  disabled={busy}
                >
                  {busy ? 'Giriş açılıyor...' : 'Giriş'}
                </button>
              </>
            ) : recording ? (
              <>
                <p className="control-copy">{paused ? 'Kayıt duraklatıldı.' : 'Kayıt sürüyor.'}</p>
                <p className="provider-readback">
                  Transkripsiyon: {sttProvider === 'speechmatics' ? 'Speechmatics' : 'Dahili STT'}
                  {' · '}
                  {transcriptionMode === 'realtime' ? 'Anlık' : 'Dengeli'}
                </p>
                <button
                  className="secondary-action"
                  type="button"
                  disabled={stopping}
                  onClick={() => (paused ? handleResume() : handlePause())}
                >
                  {paused ? 'Sürdür' : 'Duraklat'}
                </button>
                <button
                  className="danger-action"
                  type="button"
                  disabled={stopping}
                  onClick={() => void handleStop()}
                >
                  {stopping ? 'Bitiriliyor...' : 'Bitir'}
                </button>
              </>
            ) : (
              <>
                <div className="meeting-launchpad-heading">
                  <div>
                    <h2>{hasMeetingWorkspace ? 'Toplantı hazır' : 'Toplantılar'}</h2>
                    <p>
                      {hasMeetingWorkspace
                        ? 'Kaydı başlatabilir veya başka bir toplantı seçebilirsiniz.'
                        : 'Mevcut bir toplantıyı seçin veya yeni bir toplantı planlayın.'}
                    </p>
                  </div>
                  <MeetingPlanner
                    open={meetingPlannerOpen}
                    pending={contractPending}
                    sttProvider={sttProvider}
                    transcriptionMode={transcriptionMode}
                    onOpen={() => setMeetingPlannerOpen(true)}
                    onCancel={() => setMeetingPlannerOpen(false)}
                    onSubmit={(plan) => void handleCreateMeetingContract(plan)}
                  />
                </div>
                {hasMeetingWorkspace && !meetingPlannerOpen ? (
                  <>
                    <p className="control-copy">Giriş yapıldı. Toplantı kaydına hazır.</p>
                    <label className="stt-provider-field" htmlFor="stt-provider">
                      <span>Transkripsiyon sağlayıcısı</span>
                      <select
                        id="stt-provider"
                        value={sttProvider}
                        disabled={startPending || contractPending || showConsent}
                        onChange={(event) => setSttProvider(event.target.value as SttProvider)}
                      >
                        <option value="internal">Dahili STT</option>
                        <option value="speechmatics">Speechmatics</option>
                      </select>
                    </label>
                    <fieldset className="transcription-mode-field">
                      <legend>Transkript görünümü</legend>
                      <div className="segmented-control">
                        <label>
                          <input
                            type="radio"
                            name="workspace-transcription-mode"
                            value="realtime"
                            checked={transcriptionMode === 'realtime'}
                            disabled={startPending || contractPending || showConsent}
                            onChange={() => setTranscriptionMode('realtime')}
                          />
                          <span>Anlık</span>
                        </label>
                        <label>
                          <input
                            type="radio"
                            name="workspace-transcription-mode"
                            value="balanced"
                            checked={transcriptionMode === 'balanced'}
                            disabled={startPending || contractPending || showConsent}
                            onChange={() => setTranscriptionMode('balanced')}
                          />
                          <span>Dengeli</span>
                        </label>
                      </div>
                    </fieldset>
                    <div className="control-actions">
                      <button
                        className="primary-action"
                        type="button"
                        aria-label="Kaydet"
                        onClick={handleRecordClick}
                        disabled={!recorderConfig?.ready || startPending || contractPending}
                      >
                        {startPending ? 'Başlatılıyor...' : 'Kaydı başlat'}
                      </button>
                    </div>
                  </>
                ) : null}
              </>
            )}
            {status ? <p className="status">{status}</p> : null}
            {error ? <p className="error">{error}</p> : null}
            {loggedIn ? (
              <MeetingResultPicker
                meetings={recentMeetings}
                status={recentMeetingsStatus}
                error={recentMeetingsError}
                totalElements={recentMeetingsTotal}
                selectedMeetingId={meetingIntelligence.meetingId}
                recordingMeetingId={recorderConfig?.meetingId ?? null}
                selectionLocked={
                  startPending || recording || stopping || meetingIntelligence.status === 'waiting'
                }
                onSelect={handleMeetingResultSelect}
                onRefresh={() => void loadRecentMeetings()}
              />
            ) : null}
            {loggedIn ? (
              <button
                className="secondary-action logout-action"
                type="button"
                onClick={() => void handleLogout()}
              >
                Çıkış
              </button>
            ) : null}
            {claims && hasMeetingWorkspace ? (
              <details className="claims diagnostics">
                <summary>Teknik oturum ayrıntıları</summary>
                <dl>
                  <dt>aud</dt>
                  <dd>{Array.isArray(claims.aud) ? claims.aud.join(', ') : (claims.aud ?? '-')}</dd>
                  <dt>azp</dt>
                  <dd>{claims.azp ?? '-'}</dd>
                  <dt>tenantId</dt>
                  <dd>{claims.tenantId ?? '-'}</dd>
                  <dt>userId</dt>
                  <dd>{claims.userId ?? '-'}</dd>
                  <dt>companyId</dt>
                  <dd>{claims.companyId ?? '-'}</dd>
                  <dt>exp</dt>
                  <dd>{claims.exp ? new Date(claims.exp * 1000).toLocaleString() : '-'}</dd>
                </dl>
              </details>
            ) : null}
          </div>
          {hasMeetingWorkspace ? (
            <div className="intelligence-workspace">
              <TranscriptPanel
                session={transcriptSession}
                stream={{
                  directConfigured: Boolean(
                    recorderConfig?.gatewayLiveStreamEnabled || recorderConfig?.liveSttStreamUrl,
                  ),
                  mode: recorderConfig?.gatewayLiveStreamEnabled
                    ? 'gateway-live'
                    : recorderConfig?.liveSttStreamUrl
                      ? 'direct-live'
                      : 'gateway-events',
                  directReady: liveStreamReady,
                  directStatus: liveStreamStatus,
                  directActive: liveStreamActive,
                  audioRms,
                  audioActive: typeof audioRms === 'number' && audioRms >= ACTIVE_AUDIO_RMS,
                  lastAudioAtMs,
                  disabledReason: recorderConfig?.liveSttStreamReason ?? null,
                  preflight: liveStreamPreflight,
                  capturePreflight: audioCapturePreflight,
                  onPreflight: recording ? undefined : () => void handleLiveStreamPreflight(),
                }}
                onSegmentTextChange={handleTranscriptSegmentTextChange}
                onSegmentReviewed={handleTranscriptSegmentReviewed}
              />
              <SummaryPanel
                intelligence={meetingIntelligence}
                transcript={transcriptSession}
                autoSubmitMeetingAi={meetingIntelligence.status === 'waiting'}
                canonicalResultStatus={canonicalResultStatus}
                canonicalResultError={canonicalResultError}
                canonicalResultAutoRetrying={canonicalResultRetryReason !== 'disabled'}
                onCanonicalResultRetry={
                  meetingIntelligence.meetingId
                    ? () =>
                        void loadCanonicalMeetingResult(meetingIntelligence.meetingId!, {
                          pollUntilReady: true,
                          previousAnalysisRunId: canonicalAnalysisRunBaseline(
                            meetingIntelligence.result?.analysisRunId ?? null,
                            canonicalRunBeforeRecordingRef.current?.meetingId ===
                              meetingIntelligence.meetingId
                              ? canonicalRunBeforeRecordingRef.current.analysisRunId
                              : null,
                          ),
                          generatedNotBeforeMs:
                            canonicalRunBeforeRecordingRef.current?.meetingId ===
                            meetingIntelligence.meetingId
                              ? canonicalRunBeforeRecordingRef.current.recordingStartedAtMs
                              : null,
                          resetDurableBackoff: true,
                        })
                    : undefined
                }
                onMeetingAiSubmitted={() => {
                  if (meetingIntelligence.meetingId) {
                    void loadCanonicalMeetingResult(meetingIntelligence.meetingId, {
                      pollUntilReady: true,
                      previousAnalysisRunId: canonicalAnalysisRunBaseline(
                        meetingIntelligence.result?.analysisRunId ?? null,
                        canonicalRunBeforeRecordingRef.current?.meetingId ===
                          meetingIntelligence.meetingId
                          ? canonicalRunBeforeRecordingRef.current.analysisRunId
                          : null,
                      ),
                      generatedNotBeforeMs:
                        canonicalRunBeforeRecordingRef.current?.meetingId ===
                        meetingIntelligence.meetingId
                          ? canonicalRunBeforeRecordingRef.current.recordingStartedAtMs
                          : null,
                      resetDurableBackoff: true,
                    });
                  }
                }}
                onMeetingAiError={(message) =>
                  setMeetingIntelligence((current) => failMeetingIntelligence(current, message))
                }
              />
            </div>
          ) : null}
        </section>
      </main>
      {showConsent ? (
        <ConsentDialog onAccept={handleConsentAccept} onCancel={handleConsentCancel} />
      ) : null}
    </div>
  );
}

export default App;
