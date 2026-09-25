import { WebSocket } from 'undici';

import type { GatewayConfig } from './gateway-client.js';

export const GATEWAY_LIVE_AUDIO_FRAME_VERSION = 1;
export const GATEWAY_LIVE_AUDIO_FRAME_HEADER_BYTES = 19;
export const GATEWAY_LIVE_SAMPLE_RATE_HZ = 16_000;
const GATEWAY_LIVE_AUDIO_FRAME_MAX_PAYLOAD_BYTES = 65_535;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
// Budget for *silence* while waiting for `ready`, not for the whole wait. The
// upstream reports progress with `loading` frames, and each one restarts this
// timer (see the open promise below).
const OPEN_TIMEOUT_MS = 10_000;
// Absolute ceiling on the wait, so a server that keeps emitting `loading`
// forever still fails instead of hanging the recorder.
export const GATEWAY_LIVE_STREAM_OPEN_MAX_WAIT_MS = 300_000;
const STOP_TIMEOUT_FALLBACK_MS = 8_000;
const STOP_TIMEOUT_MAX_MS = 120_000;
const STOP_TIMEOUT_TRANSPORT_MARGIN_MS = 5_000;
const STOP_QUIET_MS = 1_250;
const MAX_PENDING_FRAME_COUNT = 32;
const MAX_PENDING_AUDIO_BYTES = 2 * 1024 * 1024;
// #138: the 32-frame window was sized for 2s REST chunks (~64s). Realtime
// frames are 100ms, where 32 frames held only ~3.2s, so a few seconds of
// network loss evicted speech that is the only STT input for Speechmatics.
// Realtime sizes the window by duration instead; the byte bound (~62s of
// 16 kHz mono PCM16 plus frame headers) still caps memory.
export const REALTIME_MAX_PENDING_FRAME_COUNT = 600;
// #138: the default ladder starts at 30s, so after three quick failures during a
// short outage the lane waited half the replay window before probing again. On
// the realtime (Speechmatics) lane the backlog is the transcript itself, so the
// probe cadence must stay well inside the ~60s window before it widens.
export const REALTIME_CIRCUIT_COOLDOWN_LADDER_MS = [
  5_000, 15_000, 30_000, 60_000, 120_000, 300_000,
] as const;
// #138: after a reconnect the whole backlog (12-14s of audio in the attended
// trace) left in one burst and parts of it never came back as transcript.
// Realtime replays at 4x real time instead: 4 x 100ms frames per 100ms tick.
export const REALTIME_REPLAY_FRAMES_PER_TICK = 4;
const REPLAY_PACE_INTERVAL_MS = 100;
const SOCKET_BUFFER_HIGH_WATER_BYTES = 512 * 1024;
const SOCKET_BUFFER_LOW_WATER_BYTES = 128 * 1024;
const BACKPRESSURE_RETRY_MS = 25;
const ACK_SILENCE_TIMEOUT_MS = 6_000;
// Token fetch happens before any open timer exists, so it needs its own bound.
const TOKEN_DEADLINE_MS = 15_000;

// Recovery budget. Deliberately *not* a session-lifetime counter: a three-hour
// meeting must not accumulate debt from an outage in its first minute. The
// budget is per-episode, and it is renewed only by *proven* delivery (see
// `noteStableDelivery`), never by a bare handshake.
const MAX_IMMEDIATE_RECOVERY_ATTEMPTS = 3;
const IMMEDIATE_RECOVERY_DELAYS_MS = [500, 1_000, 2_000] as const;
const RECOVERY_JITTER_RATIO = 0.2;
const MAX_CONTEXT_TERMS = 32;
const MAX_CONTEXT_TERM_CHARS = 64;
const MAX_CONTEXT_TOTAL_CHARS = 512;
const ALLOWED_CONTEXT_TERM = /^[\p{L}\p{M}\p{N} .'-]+$/u;
// When immediate attempts are exhausted the circuit opens instead of dying.
// Cooldown grows, so a genuinely broken network settles at one probe every five
// minutes rather than a reconnect storm.
const CIRCUIT_COOLDOWN_LADDER_MS = [30_000, 60_000, 120_000, 240_000, 300_000] as const;
// Stability proof required to renew the budget, all three together.
const STABILITY_WINDOW_MS = 30_000;
const STABILITY_ACK_COUNT = 8;

// Capability-negotiated, exactly like `eof` below. Dropping frames mid-audio is
// not neutral for the decoder: without an explicit boundary the upstream splices
// two unrelated moments into one utterance. We announce the gap only when the
// gateway advertises support, and fall back to a plain replay otherwise.
const AUDIO_DISCONTINUITY_CAPABILITY = 'audio_discontinuity_v1';
const AUDIO_DISCONTINUITY_VERSION = 1;

function encodeGatewayLivePcm16Frame(input: {
  chunkSeq: number;
  capturedAtMs: number;
  pcm16: Uint8Array;
}): ArrayBuffer {
  if (!Number.isSafeInteger(input.chunkSeq) || input.chunkSeq < 0) {
    throw new Error('chunkSeq must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(input.capturedAtMs) || input.capturedAtMs < 0) {
    throw new Error('capturedAtMs must be a non-negative safe integer');
  }
  if (
    input.pcm16.byteLength === 0 ||
    input.pcm16.byteLength > GATEWAY_LIVE_AUDIO_FRAME_MAX_PAYLOAD_BYTES
  ) {
    throw new Error('PCM16 payload length must be between 1 and 65535 bytes');
  }
  if ((input.pcm16.byteLength & 1) !== 0) {
    throw new Error('PCM16 payload length must be even');
  }

  const encoded = new ArrayBuffer(GATEWAY_LIVE_AUDIO_FRAME_HEADER_BYTES + input.pcm16.byteLength);
  const view = new DataView(encoded);
  view.setUint8(0, GATEWAY_LIVE_AUDIO_FRAME_VERSION);
  view.setBigInt64(1, BigInt(input.chunkSeq), false);
  view.setBigInt64(9, BigInt(input.capturedAtMs), false);
  view.setUint16(17, input.pcm16.byteLength, false);
  new Uint8Array(encoded, GATEWAY_LIVE_AUDIO_FRAME_HEADER_BYTES).set(input.pcm16);
  return encoded;
}

function gatewayLiveStreamSessionUrl(gatewayBaseUrl: string, sessionId: string): string {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error('sessionId must match the gateway identifier contract');
  }
  const url = new URL(gatewayBaseUrl);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('gatewayBaseUrl must not contain credentials, query, or fragment');
  }
  const localHttp =
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1');
  if (url.protocol === 'https:') {
    url.protocol = 'wss:';
  } else if (localHttp) {
    url.protocol = 'ws:';
  } else {
    throw new Error('gatewayBaseUrl must use HTTPS, except local development URLs');
  }
  const basePath = url.pathname.replace(/\/+$/, '');
  url.pathname = `${basePath}/api/v1/audio-gateway/sessions/${sessionId}/stream`;
  return url.toString();
}

export type GatewayLiveServerEvent =
  | { type: 'loading'; stage?: string }
  | {
      type: 'ready';
      capabilities?: string[];
      supports_eof?: boolean;
      partial_mode?: string;
      terminal_timeout_ms?: number;
    }
  | {
      type: 'partial';
      seq: number;
      confirmed: string;
      tentative: string;
      elapsed_ms?: number;
      rms?: number;
      source?: string;
      // RT-5 gecikme çalışması (gitops#3419): gateway aşama zaman damgaları.
      audio_sent_ms?: number;
      emitted_at_ms?: number;
    }
  | {
      type: 'final';
      seq: number;
      text: string;
      reason?: string;
      elapsed_ms?: number;
      rms?: number;
      source_start_sample?: number;
      source_end_sample?: number;
      audio_sent_ms?: number;
    }
  | { type: 'audio_ack'; chunk_seq: number }
  | { type: 'eof_ack' | 'drained' }
  | { type: 'error'; msg: string }
  | { type: 'debug' };

export type GatewayLiveDeliveryCause =
  | 'ack-timeout'
  | 'buffer-overflow'
  | 'socket-close'
  | 'socket-error';

/**
 * Historical quality of the *live preview* lane only.
 *
 * Deliberately separate from the top-level stop `state`: the canonical REST
 * recording is unaffected by anything reported here. A session whose live
 * preview had a gap but whose terminal handshake succeeded is `drained` +
 * `coverage: 'gapped'` — "there was a gap in the live preview", never "the
 * recording is broken".
 */
export interface GatewayLiveDeliverySummary {
  scope: 'live-preview';
  coverage: 'complete' | 'gapped';
  recovered: boolean;
  recoveryEpisodeCount: number;
  recoveredEpisodeCount: number;
  droppedFrameCount: number;
  droppedAudioBytes: number;
  firstDroppedSequence: number | null;
  lastDroppedSequence: number | null;
  causes: GatewayLiveDeliveryCause[];
}

export interface GatewayLiveStreamStopResult {
  /** Result of the *terminal drain*, not of historical live coverage. */
  state: 'drained' | 'degraded';
  reason:
    | 'no-audio'
    | 'final-ack'
    | 'eof-ack'
    | 'drained'
    | 'quiet'
    | 'timeout'
    | 'socket-close'
    | 'socket-error'
    | 'ack-timeout'
    | 'buffer-overflow'
    | 'unavailable';
  /** Stop/terminal handshake acknowledgement only — *not* "all audio arrived". */
  acknowledged: boolean;
  liveDelivery: GatewayLiveDeliverySummary;
}

interface GatewaySocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
}

interface PendingAudioFrame {
  encoded: ArrayBuffer;
  byteLength: number;
  sentGeneration: number | null;
  /** Wall clock when the frame entered the replay window (delivery backlog age). */
  enqueuedAtMs: number;
}

/**
 * Transcript lag split into the two things that can actually be late.
 * Neither depends on whether anybody is speaking: an idle room is neither a
 * delivery backlog nor an engine backlog (the old "last audio frame minus last
 * text" reported silence and room noise as lag).
 */
export interface GatewayLiveLagSnapshot {
  /** Age of the oldest frame the gateway has not acknowledged yet; 0 when none. */
  deliveryBacklogMs: number;
  /** audio_sent_ms - elapsed_ms of a recent transcript event; null when unknown. */
  engineLagMs: number | null;
  /**
   * Time since the engine last produced text (partial or final); null before
   * the first one. Paired with the speech activity signal it tells a genuine
   * stall (someone is talking, nothing comes back) from plain silence.
   */
  lastEngineEventAgeMs: number | null;
}

const LAG_REPORT_INTERVAL_MS = 1_000;
// An engine reading older than this is not reported: without newer events the
// engine's position is unknown, and a stale catch-up value must not stick.
const ENGINE_LAG_FRESH_MS = 10_000;

type GatewaySocketFactory = (url: string, jwt: string) => GatewaySocket;

/**
 * Live delivery health, for surfacing to the user.
 *
 * `recovering` is deliberately quiet: a blip that self-heals in under a second
 * while the canonical REST upload continues is not something to alarm anyone
 * about. Only `degraded` — the circuit actually open for a cooldown — is worth
 * saying out loud, and `healthy` must take it back.
 */
export interface GatewayLiveDeliveryStatus {
  kind: 'healthy' | 'recovering' | 'degraded';
  cause?: GatewayLiveDeliveryCause;
  retryInMs?: number;
}

export interface GatewayLiveStreamOptions {
  cfg: GatewayConfig;
  sessionId: string;
  contextTerms?: readonly string[];
  getJwt: () => Promise<string>;
  onEvent: (event: GatewayLiveServerEvent) => void;
  onError: (error: Error) => void;
  onDeliveryStatus?: (status: GatewayLiveDeliveryStatus) => void;
  socketFactory?: GatewaySocketFactory;
  /** Replay window in frames; defaults to 32 (sized for 2s REST chunks). */
  maxPendingFrames?: number;
  /** Circuit cooldowns after immediate retries; defaults to 30s..300s. */
  circuitCooldownLadderMs?: readonly number[];
  /**
   * Cap on frames written per flush tick while a backlog is replayed; the rest
   * follow every REPLAY_PACE_INTERVAL_MS. Unset = write the whole backlog at once.
   */
  replayFramesPerTick?: number;
  /** Receives a lag snapshot every second while started; unset = no reporting. */
  onLagSnapshot?: (snapshot: GatewayLiveLagSnapshot) => void;
}

export function normalizeGatewayLiveContextTerms(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > MAX_CONTEXT_TERMS) {
    throw new Error('gateway live context terms must be a bounded list');
  }
  const terms: string[] = [];
  const seen = new Set<string>();
  let totalChars = 0;
  for (const candidate of value) {
    if (typeof candidate !== 'string' || /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Cn}]/u.test(candidate)) {
      throw new Error('gateway live context term is invalid');
    }
    const term = candidate.normalize('NFKC').replace(/\s+/g, ' ').trim();
    if (
      term.length === 0 ||
      term.length > MAX_CONTEXT_TERM_CHARS ||
      !ALLOWED_CONTEXT_TERM.test(term)
    ) {
      throw new Error('gateway live context term is invalid');
    }
    const key = term.toLocaleLowerCase('tr-TR');
    if (seen.has(key)) {
      continue;
    }
    totalChars += term.length;
    if (totalChars > MAX_CONTEXT_TOTAL_CHARS) {
      throw new Error('gateway live context terms exceed total character limit');
    }
    seen.add(key);
    terms.push(term);
  }
  return terms;
}

function defaultSocketFactory(url: string, jwt: string): GatewaySocket {
  return new WebSocket(url, {
    headers: { Authorization: `Bearer ${jwt}` },
  }) as GatewaySocket;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalFiniteNumber(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value));
}

function negotiatedStopTimeoutMs(terminalTimeoutMs: number | undefined): number {
  if (terminalTimeoutMs === undefined || terminalTimeoutMs <= 0) {
    return STOP_TIMEOUT_FALLBACK_MS;
  }
  return Math.min(
    STOP_TIMEOUT_MAX_MS,
    Math.max(
      STOP_TIMEOUT_FALLBACK_MS,
      Math.ceil(terminalTimeoutMs) + STOP_TIMEOUT_TRANSPORT_MARGIN_MS,
    ),
  );
}

function nonNegativeSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function parseServerEvent(data: unknown): GatewayLiveServerEvent | null {
  if (typeof data !== 'string') {
    return null;
  }
  try {
    const parsed = JSON.parse(data) as unknown;
    if (!isRecord(parsed) || typeof parsed.type !== 'string') {
      return null;
    }
    if (parsed.type === 'loading') {
      return parsed.stage === undefined || typeof parsed.stage === 'string'
        ? { type: 'loading', ...(parsed.stage === undefined ? {} : { stage: parsed.stage }) }
        : null;
    }
    if (parsed.type === 'ready') {
      if (
        parsed.capabilities !== undefined &&
        (!Array.isArray(parsed.capabilities) ||
          parsed.capabilities.some((entry) => typeof entry !== 'string'))
      ) {
        return null;
      }
      if (parsed.supports_eof !== undefined && typeof parsed.supports_eof !== 'boolean') {
        return null;
      }
      if (parsed.partial_mode !== undefined && typeof parsed.partial_mode !== 'string') {
        return null;
      }
      if (!optionalFiniteNumber(parsed.terminal_timeout_ms)) {
        return null;
      }
      return {
        type: 'ready',
        ...(parsed.capabilities === undefined
          ? {}
          : { capabilities: parsed.capabilities as string[] }),
        ...(parsed.supports_eof === undefined ? {} : { supports_eof: parsed.supports_eof }),
        ...(parsed.partial_mode === undefined ? {} : { partial_mode: parsed.partial_mode }),
        ...(parsed.terminal_timeout_ms === undefined
          ? {}
          : { terminal_timeout_ms: parsed.terminal_timeout_ms }),
      };
    }
    if (parsed.type === 'partial') {
      if (
        !nonNegativeSequence(parsed.seq) ||
        typeof parsed.confirmed !== 'string' ||
        typeof parsed.tentative !== 'string'
      ) {
        return null;
      }
      const elapsedMs = optionalFiniteNumber(parsed.elapsed_ms) ? parsed.elapsed_ms : undefined;
      const eventRms = optionalFiniteNumber(parsed.rms) ? parsed.rms : undefined;
      const source = typeof parsed.source === 'string' ? parsed.source : undefined;
      const audioSentMs = optionalFiniteNumber(parsed.audio_sent_ms)
        ? parsed.audio_sent_ms
        : undefined;
      const emittedAtMs = optionalFiniteNumber(parsed.emitted_at_ms)
        ? parsed.emitted_at_ms
        : undefined;
      return {
        type: 'partial',
        seq: parsed.seq,
        confirmed: parsed.confirmed,
        tentative: parsed.tentative,
        ...(elapsedMs === undefined ? {} : { elapsed_ms: elapsedMs }),
        ...(eventRms === undefined ? {} : { rms: eventRms }),
        ...(source === undefined ? {} : { source }),
        ...(audioSentMs === undefined ? {} : { audio_sent_ms: audioSentMs }),
        ...(emittedAtMs === undefined ? {} : { emitted_at_ms: emittedAtMs }),
      };
    }
    if (parsed.type === 'final') {
      if (!nonNegativeSequence(parsed.seq) || typeof parsed.text !== 'string') {
        return null;
      }
      const reason =
        typeof parsed.reason === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(parsed.reason)
          ? parsed.reason
          : undefined;
      const elapsedMs = optionalFiniteNumber(parsed.elapsed_ms) ? parsed.elapsed_ms : undefined;
      const eventRms = optionalFiniteNumber(parsed.rms) ? parsed.rms : undefined;
      const audioSentMs = optionalFiniteNumber(parsed.audio_sent_ms)
        ? parsed.audio_sent_ms
        : undefined;
      const hasSourceRange = Boolean(
        nonNegativeSequence(parsed.source_start_sample) &&
        nonNegativeSequence(parsed.source_end_sample) &&
        parsed.source_end_sample > parsed.source_start_sample,
      );
      return {
        type: 'final',
        seq: parsed.seq,
        text: parsed.text,
        ...(reason === undefined ? {} : { reason }),
        ...(elapsedMs === undefined ? {} : { elapsed_ms: elapsedMs }),
        ...(eventRms === undefined ? {} : { rms: eventRms }),
        ...(audioSentMs === undefined ? {} : { audio_sent_ms: audioSentMs }),
        ...(hasSourceRange
          ? {
              source_start_sample: parsed.source_start_sample as number,
              source_end_sample: parsed.source_end_sample as number,
            }
          : {}),
      };
    }
    if (parsed.type === 'audio_ack') {
      return nonNegativeSequence(parsed.chunk_seq)
        ? { type: 'audio_ack', chunk_seq: parsed.chunk_seq }
        : null;
    }
    if (parsed.type === 'error') {
      return typeof parsed.msg === 'string' && parsed.msg.trim()
        ? { type: 'error', msg: parsed.msg }
        : null;
    }
    if (parsed.type === 'eof_ack' || parsed.type === 'drained' || parsed.type === 'debug') {
      return { type: parsed.type };
    }
    return null;
  } catch {
    return null;
  }
}

function jitter(baseMs: number): number {
  const spread = baseMs * RECOVERY_JITTER_RATIO;
  return Math.max(0, Math.round(baseMs - spread + Math.random() * spread * 2));
}

function immediateRecoveryDelay(attempt: number): number {
  const index = Math.min(Math.max(attempt, 1), IMMEDIATE_RECOVERY_DELAYS_MS.length) - 1;
  return jitter(IMMEDIATE_RECOVERY_DELAYS_MS[index]);
}

function cooldownDelay(
  level: number,
  ladder: readonly number[] = CIRCUIT_COOLDOWN_LADDER_MS,
): number {
  const index = Math.min(Math.max(level, 0), ladder.length - 1);
  return jitter(ladder[index]);
}

/**
 * Live delivery health, kept strictly apart from the object lifecycle
 * (`stopping` / `closed`).
 *
 * `degraded` is a circuit-breaker *open* state with a cooldown — not death. It
 * becomes `recovering` again once the cooldown expires and there is new audio
 * worth delivering. The previous implementation modelled this as a one-way
 * latch, which meant a single buffer overflow killed live transcription for the
 * rest of the meeting even after the network fully recovered.
 */
type LiveDeliveryState =
  | { kind: 'healthy' }
  | {
      kind: 'recovering';
      cause: GatewayLiveDeliveryCause;
      episodeId: number;
      attempt: number;
    }
  | {
      kind: 'degraded';
      cause: GatewayLiveDeliveryCause;
      episodeId: number;
      probeNotBeforeMs: number;
      probeClaimedEpisode: number | null;
      cooldownLevel: number;
    };

export class GatewayLiveStream {
  private readonly options: GatewayLiveStreamOptions;
  private readonly socketFactory: GatewaySocketFactory;
  private readonly contextTerms: readonly string[];
  private socket: GatewaySocket | null = null;
  private socketGeneration = 0;
  private connectInFlight: Promise<void> | null = null;
  private connectToken = 0;
  private started = false;
  // At most one budget-spending failure per socket generation.
  private faultedGeneration: number | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private latestSequence = -1;
  private sourceStartedAtMs: number | null = null;
  private sourceTimingReliable = true;
  private ready = false;
  private stopping = false;
  private closed = false;
  private eofSent = false;
  private eofSupported = false;
  private stopTimeoutMs = STOP_TIMEOUT_FALLBACK_MS;
  private pendingAudioBytes = 0;
  private readonly pendingFrames = new Map<number, PendingAudioFrame>();
  private backpressureTimer: ReturnType<typeof setTimeout> | null = null;
  private replayPaceTimer: ReturnType<typeof setTimeout> | null = null;
  private lagReportTimer: ReturnType<typeof setInterval> | null = null;
  private lastEngineLag: { lagMs: number; atMs: number; generation: number } | null = null;
  private lastEngineEventAtMs: number | null = null;
  private backpressured = false;
  private ackSilenceTimer: ReturnType<typeof setTimeout> | null = null;
  private delivery: LiveDeliveryState = { kind: 'healthy' };
  private episodeCounter = 0;
  private cooldownLevel = 0;
  // Stability proof, all three required before the recovery budget is renewed.
  private stableSinceMs: number | null = null;
  private acksSinceRecovery = 0;
  private pendingDrainedSinceRecovery = false;
  // Bounded history. Counters and first/last sequence only — never a per-incident
  // array, which would grow without limit across a long meeting.
  private recoveryEpisodeCount = 0;
  private recoveredEpisodeCount = 0;
  private droppedFrameCount = 0;
  private droppedAudioBytes = 0;
  private firstDroppedSequence: number | null = null;
  private lastDroppedSequence: number | null = null;
  private readonly deliveryCauses = new Set<GatewayLiveDeliveryCause>();
  // Gap announcement, recomputed per socket generation — never carried over.
  private discontinuitySupported = false;
  private discontinuitySentGeneration: number | null = null;
  private pendingDroppedFrames = 0;
  private announcedDiscontinuityBoundary: number | null = null;
  private stopPromise: Promise<GatewayLiveStreamStopResult> | null = null;
  private settleStop: ((result: GatewayLiveStreamStopResult) => void) | null = null;
  private stopTimeout: ReturnType<typeof setTimeout> | null = null;
  private stopQuiet: ReturnType<typeof setTimeout> | null = null;
  private openSilenceTimer: ReturnType<typeof setTimeout> | null = null;
  private openDeadlineTimer: ReturnType<typeof setTimeout> | null = null;
  private rejectOpen: ((reason: string) => void) | null = null;

  constructor(options: GatewayLiveStreamOptions) {
    this.options = options;
    this.socketFactory = options.socketFactory ?? defaultSocketFactory;
    this.contextTerms = normalizeGatewayLiveContextTerms(options.contextTerms);
  }

  async start(): Promise<void> {
    if (this.closed || this.stopping) {
      throw new Error('gateway live stream is closed');
    }
    // Lifecycle, kept apart from delivery health: before `start()` there is no
    // connection to recover, so audio handed in early must be buffered rather
    // than treated as a delivery failure.
    this.started = true;
    this.startLagReporting();
    await this.connect();
  }

  /** Current lag reading; independent of speech, room noise or silence. */
  getLagSnapshot(nowMs = Date.now()): GatewayLiveLagSnapshot {
    const oldest = this.pendingFrames.values().next();
    const deliveryBacklogMs = oldest.done ? 0 : Math.max(0, nowMs - oldest.value.enqueuedAtMs);
    const engine = this.lastEngineLag;
    const engineLagMs =
      engine !== null &&
      engine.generation === this.socketGeneration &&
      nowMs - engine.atMs <= ENGINE_LAG_FRESH_MS
        ? engine.lagMs
        : null;
    const lastEngineEventAgeMs =
      this.lastEngineEventAtMs === null ? null : Math.max(0, nowMs - this.lastEngineEventAtMs);
    return { deliveryBacklogMs, engineLagMs, lastEngineEventAgeMs };
  }

  private startLagReporting(): void {
    const report = this.options.onLagSnapshot;
    if (!report || this.lagReportTimer) {
      return;
    }
    this.lagReportTimer = setInterval(() => {
      if (this.closed) {
        this.stopLagReporting();
        return;
      }
      report(this.getLagSnapshot());
    }, LAG_REPORT_INTERVAL_MS);
  }

  private stopLagReporting(): void {
    if (this.lagReportTimer) {
      clearInterval(this.lagReportTimer);
      this.lagReportTimer = null;
    }
  }

  private noteEngineProgress(event: GatewayLiveServerEvent): void {
    if (event.type !== 'partial' && event.type !== 'final') {
      return;
    }
    // Any text counts, with or without timing fields: the question is only
    // whether the engine is still producing words.
    this.lastEngineEventAtMs = Date.now();
    const sentMs = event.audio_sent_ms;
    const engineMs = event.elapsed_ms;
    if (
      typeof sentMs !== 'number' ||
      typeof engineMs !== 'number' ||
      !Number.isFinite(sentMs) ||
      !Number.isFinite(engineMs)
    ) {
      return;
    }
    this.lastEngineLag = {
      lagMs: Math.max(0, sentMs - engineMs),
      atMs: Date.now(),
      generation: this.socketGeneration,
    };
  }

  sendAfterRestAccepted(pcm16: Uint8Array, chunkSeq: number, capturedAtMs: number): boolean {
    return this.sendSequencedFrame(pcm16, chunkSeq, capturedAtMs, 'REST');
  }

  sendRealtimeFrame(pcm16: Uint8Array, capturedAtMs: number): boolean {
    return this.sendSequencedFrame(pcm16, this.latestSequence + 1, capturedAtMs, 'realtime');
  }

  getSourceStartedAtMs(): number | null {
    return this.sourceStartedAtMs;
  }

  hasReliableSourceTiming(): boolean {
    return this.sourceStartedAtMs !== null && this.sourceTimingReliable;
  }

  getTransportEpoch(): number {
    return this.socketGeneration;
  }

  private sendSequencedFrame(
    pcm16: Uint8Array,
    chunkSeq: number,
    capturedAtMs: number,
    source: 'REST' | 'realtime',
  ): boolean {
    if (!Number.isSafeInteger(chunkSeq) || chunkSeq < 0) {
      throw new Error('gateway live chunk sequence is invalid');
    }
    if (chunkSeq !== this.latestSequence + 1) {
      throw new Error(`gateway ${source} chunk sequence is non-contiguous`);
    }
    this.latestSequence = chunkSeq;

    if (this.stopping || this.closed) {
      return false;
    }

    const encoded = encodeGatewayLivePcm16Frame({ chunkSeq, capturedAtMs, pcm16 });
    if (this.sourceStartedAtMs === null) {
      const frameDurationMs =
        (pcm16.byteLength / Int16Array.BYTES_PER_ELEMENT / GATEWAY_LIVE_SAMPLE_RATE_HZ) * 1000;
      this.sourceStartedAtMs = Math.max(0, Math.round(capturedAtMs - frameDurationMs));
    }
    // Always accepted into the bounded window: a full buffer evicts the oldest
    // frame rather than killing the lane. Recency wins, because a live preview
    // stuck replaying a minute-old backlog is worse than one with a gap.
    this.enqueueFrame(chunkSeq, encoded);

    if (!this.ready || !this.socket) {
      // New audio is exactly the signal a half-open probe waits for.
      this.considerRecoveryProgress();
      return false;
    }
    return this.flushPendingFrames();
  }

  stop(): Promise<GatewayLiveStreamStopResult> {
    if (this.stopPromise) {
      return this.stopPromise;
    }
    this.stopping = true;
    this.clearReconnectTimer();
    this.stopPromise = new Promise<GatewayLiveStreamStopResult>((resolve) => {
      this.settleStop = resolve;
    });

    if (this.latestSequence < 0) {
      this.finishStop({ state: 'drained', reason: 'no-audio', acknowledged: false });
      return this.stopPromise;
    }
    // A past gap must NOT abort the drain of a healthy suffix. The previous
    // implementation returned here the moment any historical degradation had
    // been recorded, discarding audio the socket was perfectly able to deliver.
    if (!this.ready || !this.socket) {
      // Nothing connected to drain through. Report *why* whenever delivery was
      // already in trouble, rather than a generic 'unavailable'.
      const reason = this.delivery.kind === 'healthy' ? 'unavailable' : this.delivery.cause;
      this.finishStop({ state: 'degraded', reason, acknowledged: false });
      return this.stopPromise;
    }

    this.stopTimeout = setTimeout(() => {
      this.finishStop({ state: 'degraded', reason: 'timeout', acknowledged: false });
    }, this.stopTimeoutMs);

    this.flushPendingFrames();
    if (this.pendingFrames.size === 0) {
      this.beginTerminalStop();
    }
    return this.stopPromise;
  }

  close(): void {
    this.closed = true;
    this.stopping = true;
    this.stopLagReporting();
    this.rejectOpen?.('gateway live stream closed while waiting for readiness');
    this.rejectOpen = null;
    this.clearOpenTimers();
    this.clearReconnectTimer();
    this.clearBackpressureTimer();
    this.clearAckSilenceTimer();
    this.clearStopTimers();
    this.resetSocket();
    if (this.settleStop) {
      this.finishStop({ state: 'degraded', reason: 'unavailable', acknowledged: false });
    }
  }

  private async withTokenDeadline(pending: Promise<string>): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(`gateway live stream token did not arrive within ${TOKEN_DEADLINE_MS}ms`),
              ),
            TOKEN_DEADLINE_MS,
          );
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private connect(): Promise<void> {
    if (this.connectInFlight) {
      return this.connectInFlight;
    }
    const operation = (async (): Promise<void> => {
      // Bounded: `getJwt()` runs *before* any open timer exists, so a token
      // promise that never settles would pin `connectInFlight` forever, block
      // every future recovery, and leave `start()` unresolvable — no timer
      // could rescue it because none has been armed yet.
      const jwt = await this.withTokenDeadline(this.options.getJwt());
      if (this.closed || this.stopping) {
        throw new Error('gateway live stream closed while waiting for token');
      }
      if (!jwt) {
        throw new Error('gateway live stream token is unavailable');
      }
      const url = gatewayLiveStreamSessionUrl(this.options.cfg.baseUrl, this.options.sessionId);
      await new Promise<void>((resolve, reject) => {
        const socket = this.socketFactory(url, jwt);
        const generation = ++this.socketGeneration;
        this.socket = socket;
        let settled = false;
        const openStartedAt = Date.now();

        const failOpen = (reason: string): void => {
          if (settled) {
            return;
          }
          settled = true;
          this.rejectOpen = null;
          this.clearOpenTimers();
          this.resetSocket(socket);
          reject(new Error(reason));
        };
        this.rejectOpen = failOpen;

        // Restarted on every `loading` frame: the upstream is telling us it is
        // still working, so silence — not elapsed time — is what we time out
        // on. A cold STT model load takes minutes; a flat 10s budget cancelled
        // it mid-flight, and because the load is triggered by this very
        // connection, cancelling it meant it could never finish. Each retry
        // restarted from zero and no session could ever start.
        const armSilenceTimer = (): void => {
          if (this.openSilenceTimer) {
            clearTimeout(this.openSilenceTimer);
          }
          this.openSilenceTimer = setTimeout(() => {
            failOpen(
              `gateway live stream open timed out after ${OPEN_TIMEOUT_MS}ms without progress`,
            );
          }, OPEN_TIMEOUT_MS);
        };
        armSilenceTimer();
        this.openDeadlineTimer = setTimeout(() => {
          failOpen(
            `gateway live stream did not become ready within ${GATEWAY_LIVE_STREAM_OPEN_MAX_WAIT_MS}ms`,
          );
        }, GATEWAY_LIVE_STREAM_OPEN_MAX_WAIT_MS);

        socket.onopen = () => {
          // The TCP/WebSocket handshake alone is not STT readiness. Audio stays
          // fail-closed until the upstream model's validated `ready` event.
        };
        socket.onmessage = (message) => {
          if (this.socket !== socket) {
            return;
          }
          const event = this.handleMessage(socket, message.data);
          if (!settled && event?.type === 'error') {
            failOpen(`gateway live STT rejected startup: ${event.msg}`);
            return;
          }
          if (!settled && event?.type === 'loading') {
            // Progress, not readiness: the model is still loading. Give it
            // another silence window rather than cancelling a load that only
            // this connection can drive to completion — but never past the
            // absolute ceiling.
            if (Date.now() - openStartedAt >= GATEWAY_LIVE_STREAM_OPEN_MAX_WAIT_MS) {
              failOpen(
                `gateway live stream still loading after ${GATEWAY_LIVE_STREAM_OPEN_MAX_WAIT_MS}ms; giving up`,
              );
              return;
            }
            armSilenceTimer();
            return;
          }
          if (settled || event?.type !== 'ready') {
            return;
          }
          if (Date.now() - openStartedAt >= GATEWAY_LIVE_STREAM_OPEN_MAX_WAIT_MS) {
            failOpen(
              `gateway live stream did not become ready within ${GATEWAY_LIVE_STREAM_OPEN_MAX_WAIT_MS}ms`,
            );
            return;
          }
          try {
            if (
              this.contextTerms.length > 0 &&
              event.capabilities?.includes('context-v1') === true
            ) {
              socket.send(JSON.stringify({ type: 'context', terms: this.contextTerms }));
            }
          } catch {
            failOpen('gateway live stream context relay failed');
            return;
          }
          settled = true;
          this.rejectOpen = null;
          this.clearOpenTimers();
          this.ready = true;
          // Deliberately NOT resetting the recovery budget here: a handshake is
          // not delivery. Only a real acknowledgement clears the episode.
          resolve();
          this.flushPendingFrames(generation);
        };
        socket.onerror = () => {
          if (!settled) {
            failOpen('gateway live stream handshake failed');
          }
          this.handleSocketFailure(socket, 'socket-error');
        };
        socket.onclose = () => {
          if (!settled) {
            failOpen('gateway live stream closed during handshake');
          }
          this.handleSocketFailure(socket, 'socket-close');
        };
      });
    })();
    // Assign *before* attaching the cleanup, so a connection that settles early
    // cannot clear a field that has not been written yet — that would leave
    // `connectInFlight` permanently set and silently block every later attempt.
    this.connectInFlight = operation;
    const token = ++this.connectToken;
    const clear = (): void => {
      if (this.connectToken === token) {
        this.connectInFlight = null;
      }
    };
    // `.then(clear, clear)` rather than `.finally(clear)`: a rejected
    // `operation` makes the promise *derived* by `finally` reject too, and
    // nobody handles that one — callers catch `operation` itself. That derived
    // rejection surfaced as an unhandled error and failed CI.
    void operation.then(clear, clear);
    return operation;
  }

  private handleMessage(socket: GatewaySocket, data: unknown): GatewayLiveServerEvent | null {
    const event = parseServerEvent(data);
    if (!event) {
      this.options.onError(new Error('gateway live stream returned an invalid event'));
      return null;
    }
    if (event.type === 'ready') {
      this.eofSupported =
        event.supports_eof === true || event.capabilities?.includes('eof') === true;
      this.stopTimeoutMs = negotiatedStopTimeoutMs(event.terminal_timeout_ms);
      // Recomputed per generation, never carried over from a previous socket:
      // the peer behind a reconnect may not be the same build.
      this.discontinuitySupported =
        event.capabilities?.includes(AUDIO_DISCONTINUITY_CAPABILITY) === true;
    }
    if (event.type === 'audio_ack') {
      this.acknowledgeFrame(event.chunk_seq);
      if (this.stopping && this.pendingFrames.size === 0) {
        this.beginTerminalStop();
      }
    }
    if (event.type === 'error') {
      this.options.onError(new Error(`gateway live STT error: ${event.msg}`));
      if (this.stopping) {
        this.finishStop({ state: 'degraded', reason: 'socket-error', acknowledged: false });
      } else {
        this.handleSocketFailure(socket, 'socket-error');
      }
    }
    this.noteEngineProgress(event);
    if (this.stopping && event.type === 'drained') {
      // Top-level state describes the terminal drain, not historical live
      // coverage: a gap in the preview must never read as "the recording is
      // broken". The gap travels in `liveDelivery.coverage` instead.
      this.finishStop({ state: 'drained', reason: 'drained', acknowledged: true });
    }
    this.options.onEvent(event);
    return event;
  }

  private handleSocketFailure(
    socket: GatewaySocket,
    reason: 'socket-close' | 'socket-error',
  ): void {
    if (this.socket !== socket) {
      return;
    }
    this.resetSocket(socket);
    if (this.stopping) {
      this.finishStop({ state: 'degraded', reason, acknowledged: false });
      return;
    }
    if (!this.closed) {
      // Deliberately NOT an onError: a transient drop that the circuit breaker
      // heals in well under a second is noise, not news. The user hears about
      // it only if the circuit actually opens (see `openCircuit`).
      console.warn(`Gateway live stream ${reason}; recovering, REST transcript continues`);
      this.noteDeliveryFault(reason);
    }
  }

  /**
   * Accept a frame into the bounded replay window, evicting the oldest frames
   * when it is full.
   *
   * The live lane is best-effort — the canonical REST upload is the recording —
   * so losing the oldest frame is acceptable. Losing the *lane* is not. Keeping
   * the newest audio also matters for quality: a preview that replays a
   * minute-old backlog is further from the speaker than one with a gap.
   */
  private enqueueFrame(chunkSeq: number, encoded: ArrayBuffer): void {
    const byteLength = encoded.byteLength;
    let droppedCount = 0;
    let droppedBytes = 0;
    let firstDropped: number | null = null;
    let lastDropped: number | null = null;

    // Insertion order is ascending sequence, so the first key is the oldest.
    while (
      this.pendingFrames.size > 0 &&
      (this.pendingFrames.size >= (this.options.maxPendingFrames ?? MAX_PENDING_FRAME_COUNT) ||
        this.pendingAudioBytes + byteLength > MAX_PENDING_AUDIO_BYTES)
    ) {
      const oldest = this.pendingFrames.keys().next();
      if (oldest.done) {
        break;
      }
      const victim = this.pendingFrames.get(oldest.value);
      this.pendingFrames.delete(oldest.value);
      if (victim) {
        this.pendingAudioBytes -= victim.byteLength;
        droppedBytes += victim.byteLength;
      }
      droppedCount += 1;
      if (firstDropped === null) {
        firstDropped = oldest.value;
      }
      lastDropped = oldest.value;
    }

    this.pendingFrames.set(chunkSeq, {
      encoded,
      byteLength,
      sentGeneration: null,
      enqueuedAtMs: Date.now(),
    });
    this.pendingAudioBytes += byteLength;

    if (droppedCount > 0 && firstDropped !== null && lastDropped !== null) {
      this.noteDroppedFrames(droppedCount, droppedBytes, firstDropped, lastDropped);
      // Flag the lane as behind, but do NOT tear the socket down: it may be
      // perfectly alive and simply slower than the speaker. A genuinely stalled
      // socket is caught by the acknowledgement watchdog instead.
      this.ensureRecoveryEpisode('buffer-overflow');
    }
  }

  private noteDroppedFrames(count: number, bytes: number, from: number, to: number): void {
    this.sourceTimingReliable = false;
    this.droppedFrameCount += count;
    this.droppedAudioBytes += bytes;
    if (this.firstDroppedSequence === null) {
      this.firstDroppedSequence = from;
    }
    this.lastDroppedSequence = to;
    this.deliveryCauses.add('buffer-overflow');
    // A COUNT, not a range. Coalescing successive drops into `min..max` would
    // sweep in sequences that were already acknowledged between them and
    // declare delivered audio lost — wrong on the wire, where the upstream acts
    // on it. `first/last` stay in the local summary, where "first/last observed"
    // is an honest claim.
    this.pendingDroppedFrames += count;
    // A fresh gap must be announced again on whichever generation replays next.
    this.discontinuitySentGeneration = null;
  }

  private acknowledgeFrame(chunkSeq: number): void {
    const pending = this.pendingFrames.get(chunkSeq);
    if (!pending) {
      return;
    }
    this.pendingFrames.delete(chunkSeq);
    this.pendingAudioBytes -= pending.byteLength;
    if (this.pendingFrames.size === 0) {
      this.pendingDrainedSinceRecovery = true;
    }
    this.noteAcknowledgedDelivery(chunkSeq);
    this.clearAckSilenceTimer();
    this.flushPendingFrames();
    if (this.pendingFrames.size > 0) {
      this.armAckSilenceTimer(this.socketGeneration);
    }
  }

  /**
   * A real acknowledgement is the ONLY proof that live delivery works.
   *
   * `ready` is not proof: a socket can complete its handshake and then stall
   * silently, which is exactly the failure this class exists to survive. The
   * old code reset the reconnect budget on `ready`, so a flapping socket looked
   * healthy forever while delivering nothing.
   */
  private noteAcknowledgedDelivery(chunkSeq: number): void {
    if (this.delivery.kind !== 'healthy') {
      this.recoveredEpisodeCount += 1;
      this.delivery = { kind: 'healthy' };
      this.acksSinceRecovery = 0;
      this.stableSinceMs = Date.now();
      // Recovery is proven by a real acknowledgement, so any warning the user is
      // still looking at can be taken back.
      this.options.onDeliveryStatus?.({ kind: 'healthy' });
    } else if (this.stableSinceMs === null) {
      this.stableSinceMs = Date.now();
    }
    this.acksSinceRecovery += 1;
    // The upstream accepted a frame at or past the announced boundary, so the
    // announcement is complete. Writing the message was never proof of that.
    if (
      this.announcedDiscontinuityBoundary !== null &&
      chunkSeq >= this.announcedDiscontinuityBoundary
    ) {
      this.pendingDroppedFrames = 0;
      this.announcedDiscontinuityBoundary = null;
    }
    this.renewBudgetIfStable();
  }

  /**
   * Renew the recovery budget only on *proven* stability — never on a single
   * acknowledgement, which a flapping socket can produce indefinitely.
   */
  private renewBudgetIfStable(): void {
    if (this.cooldownLevel === 0 || this.stableSinceMs === null) {
      return;
    }
    if (!this.pendingDrainedSinceRecovery || this.acksSinceRecovery < STABILITY_ACK_COUNT) {
      return;
    }
    if (Date.now() - this.stableSinceMs < STABILITY_WINDOW_MS) {
      return;
    }
    // A later, independent outage now starts from a clean budget instead of
    // inheriting debt from an earlier hour of the same meeting.
    this.cooldownLevel = 0;
  }

  private flushPendingFrames(expectedGeneration = this.socketGeneration): boolean {
    const socket = this.socket;
    if (!socket || !this.ready || this.closed || expectedGeneration !== this.socketGeneration) {
      return false;
    }
    if (this.backpressured) {
      if (socket.bufferedAmount > SOCKET_BUFFER_LOW_WATER_BYTES) {
        this.scheduleBackpressureRetry(expectedGeneration);
        return false;
      }
      this.backpressured = false;
    }
    if (this.replayPaceTimer) {
      // A paced replay is draining the backlog in order; it picks this frame up.
      return false;
    }

    const perTick = this.options.replayFramesPerTick;
    let sent = false;
    let written = 0;
    for (const pending of this.pendingFrames.values()) {
      if (pending.sentGeneration === expectedGeneration) {
        continue;
      }
      if (this.socket !== socket || !this.ready) {
        return sent;
      }
      if (perTick !== undefined && written >= perTick) {
        this.scheduleReplayPace(expectedGeneration);
        return sent;
      }
      if (socket.bufferedAmount >= SOCKET_BUFFER_HIGH_WATER_BYTES) {
        this.backpressured = true;
        this.scheduleBackpressureRetry(expectedGeneration);
        return sent;
      }
      if (!this.announceDiscontinuity(socket, expectedGeneration)) {
        return sent;
      }
      try {
        socket.send(pending.encoded);
      } catch {
        this.handleSocketFailure(socket, 'socket-error');
        return sent;
      }
      pending.sentGeneration = expectedGeneration;
      this.armAckSilenceTimer(expectedGeneration);
      sent = true;
      written += 1;
    }
    return sent;
  }

  private scheduleReplayPace(generation: number): void {
    if (this.replayPaceTimer || this.closed) {
      return;
    }
    this.replayPaceTimer = setTimeout(() => {
      this.replayPaceTimer = null;
      this.flushPendingFrames(generation);
    }, REPLAY_PACE_INTERVAL_MS);
  }

  /**
   * An independent signal that the network is back (the durable REST upload
   * just recovered). Waiting out the circuit cooldown after that only delays
   * the backlog: in the attended trace the live lane sat 17-31s behind a REST
   * upload that had already recovered.
   */
  notifyNetworkRecovered(): void {
    if (this.closed || this.stopping || !this.started) {
      return;
    }
    const state = this.delivery;
    if (state.kind !== 'degraded') {
      return;
    }
    state.probeNotBeforeMs = Date.now();
    this.considerRecoveryProgress();
  }

  /**
   * Announce a replay gap once per generation, before the first binary frame of
   * that generation (WebSocket ordering is enough to guarantee "before").
   *
   * Capability-negotiated exactly like `eof`: when the gateway does not
   * advertise support we simply replay the recency window and record the gap
   * locally. We never assume the upstream handled a silent sequence jump
   * correctly — splicing two unrelated moments into one utterance is a real
   * transcript-quality failure, not a cosmetic one.
   *
   * Returns false only when the socket died while writing.
   */
  private announceDiscontinuity(socket: GatewaySocket, generation: number): boolean {
    if (
      this.pendingDroppedFrames === 0 ||
      !this.discontinuitySupported ||
      this.discontinuitySentGeneration === generation
    ) {
      return true;
    }
    const next = this.pendingFrames.keys().next();
    if (next.done) {
      return true;
    }
    try {
      socket.send(
        JSON.stringify({
          type: 'audio_discontinuity',
          version: AUDIO_DISCONTINUITY_VERSION,
          // Authoritative: the decoder-reset boundary. The count is advisory
          // telemetry — it is exact, but the upstream only needs to know that
          // audio before `next_chunk_seq` will never arrive.
          next_chunk_seq: next.value,
          dropped_frame_count: this.pendingDroppedFrames,
        }),
      );
    } catch {
      this.handleSocketFailure(socket, 'socket-error');
      return false;
    }
    // Sent, not yet confirmed: writing to a socket proves nothing. The gap
    // clears only when an acknowledgement at or past the boundary shows the
    // upstream actually accepted it.
    this.discontinuitySentGeneration = generation;
    this.announcedDiscontinuityBoundary = next.value;
    return true;
  }

  private scheduleBackpressureRetry(generation: number): void {
    if (this.backpressureTimer || this.closed) {
      return;
    }
    this.backpressureTimer = setTimeout(() => {
      this.backpressureTimer = null;
      this.flushPendingFrames(generation);
    }, BACKPRESSURE_RETRY_MS);
  }

  private beginTerminalStop(): void {
    if (this.eofSent || !this.socket || !this.ready) {
      return;
    }
    this.eofSent = true;
    if (this.eofSupported) {
      try {
        this.socket.send(JSON.stringify({ type: 'eof' }));
      } catch {
        this.finishStop({ state: 'degraded', reason: 'socket-error', acknowledged: false });
      }
    } else {
      this.scheduleQuietStop('quiet', false);
    }
  }

  /**
   * Mark delivery as unhealthy WITHOUT touching the socket or spending budget.
   *
   * This is what a full replay window reports. An overflow says "delivery is
   * behind", not "this socket is broken": while speech continues the window can
   * be full on every single frame, and tearing the socket down each time would
   * kill each fresh connection before it could ever collect an acknowledgement —
   * a livelock with exactly the symptom this class exists to prevent.
   */
  private ensureRecoveryEpisode(cause: GatewayLiveDeliveryCause): void {
    this.deliveryCauses.add(cause);
    if (this.closed || this.stopping || !this.started) {
      return;
    }
    if (this.delivery.kind !== 'healthy') {
      return;
    }
    this.episodeCounter += 1;
    this.recoveryEpisodeCount += 1;
    this.acksSinceRecovery = 0;
    this.stableSinceMs = null;
    this.pendingDrainedSinceRecovery = false;
    this.delivery = {
      kind: 'recovering',
      cause,
      episodeId: this.episodeCounter,
      attempt: 0,
    };
    this.options.onDeliveryStatus?.({ kind: 'recovering', cause });
  }

  /**
   * Report that the CURRENT socket failed: drop it and spend one retry attempt.
   *
   * Deduped per socket generation — a burst of faults from one dying socket
   * (close + error + a pending ack timeout) must cost a single attempt, not the
   * whole budget.
   */
  private noteDeliveryFault(cause: GatewayLiveDeliveryCause): void {
    this.sourceTimingReliable = false;
    this.ensureRecoveryEpisode(cause);
    this.deliveryCauses.add(cause);
    if (this.closed || this.stopping || !this.started) {
      return;
    }
    if (this.delivery.kind === 'degraded') {
      // The circuit is open; its cooldown owns the schedule and new audio
      // reopens it.
      return;
    }
    if (this.faultedGeneration === this.socketGeneration) {
      return;
    }
    this.faultedGeneration = this.socketGeneration;
    this.resetSocket();
    this.scheduleRecoveryAttempt();
  }

  private scheduleRecoveryAttempt(): void {
    const state = this.delivery;
    if (state.kind !== 'recovering' || this.closed || this.stopping || this.ready) {
      return;
    }
    if (this.reconnectTimer) {
      return;
    }
    const inFlight = this.connectInFlight;
    if (inFlight) {
      // A connect is still settling. Retry once it does rather than dropping
      // this fault on the floor — otherwise a socket that fails while its own
      // connect promise is resolving leaves nobody to schedule the next
      // attempt, and the lane stalls for good.
      void inFlight.then(
        () => this.scheduleRecoveryAttempt(),
        () => this.scheduleRecoveryAttempt(),
      );
      return;
    }
    if (state.attempt >= MAX_IMMEDIATE_RECOVERY_ATTEMPTS) {
      this.openCircuit(state.cause, state.episodeId);
      return;
    }
    state.attempt += 1;
    const episodeId = state.episodeId;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // A timer belonging to an older episode must never drive a newer one.
      if (this.delivery.kind !== 'recovering' || this.delivery.episodeId !== episodeId) {
        return;
      }
      void this.connect().catch(() => {
        if (this.delivery.kind === 'recovering' && this.delivery.episodeId === episodeId) {
          this.scheduleRecoveryAttempt();
        }
      });
    }, immediateRecoveryDelay(state.attempt));
  }

  /**
   * Open the circuit: pause live delivery for a growing cooldown instead of
   * killing it. A genuinely broken network settles at one probe every five
   * minutes; a recovered one resumes on the next frame after the cooldown.
   */
  private openCircuit(cause: GatewayLiveDeliveryCause, episodeId: number): void {
    const ladder = this.options.circuitCooldownLadderMs ?? CIRCUIT_COOLDOWN_LADDER_MS;
    this.cooldownLevel = Math.min(this.cooldownLevel + 1, ladder.length);
    const waitMs = cooldownDelay(this.cooldownLevel - 1, ladder);
    this.delivery = {
      kind: 'degraded',
      cause,
      episodeId,
      probeNotBeforeMs: Date.now() + waitMs,
      probeClaimedEpisode: null,
      cooldownLevel: this.cooldownLevel,
    };
    // Now it is worth saying out loud: live delivery is paused for a cooldown
    // the user will actually notice.
    this.options.onDeliveryStatus?.({ kind: 'degraded', cause, retryInMs: waitMs });
  }

  /**
   * Called when new REST-accepted audio arrives — the only thing that unlocks a
   * half-open probe. Without this gate a silent recorder would keep probing a
   * dead network for nothing.
   */
  private considerRecoveryProgress(): void {
    if (
      this.closed ||
      this.stopping ||
      !this.started ||
      this.connectInFlight ||
      this.reconnectTimer
    ) {
      return;
    }
    const state = this.delivery;
    if (state.kind === 'healthy') {
      this.noteDeliveryFault('socket-close');
      return;
    }
    if (state.kind === 'recovering') {
      this.scheduleRecoveryAttempt();
      return;
    }
    if (Date.now() < state.probeNotBeforeMs || state.probeClaimedEpisode === state.episodeId) {
      return;
    }
    // Exactly one socket per cooldown: start the episode with all but one
    // immediate attempt already spent, so a failed probe returns to a longer
    // cooldown rather than firing a burst.
    state.probeClaimedEpisode = state.episodeId;
    this.delivery = {
      kind: 'recovering',
      cause: state.cause,
      episodeId: state.episodeId,
      attempt: MAX_IMMEDIATE_RECOVERY_ATTEMPTS - 1,
    };
    this.scheduleRecoveryAttempt();
  }

  private scheduleQuietStop(
    reason: 'final-ack' | 'eof-ack' | 'quiet',
    acknowledged: boolean,
  ): void {
    if (this.stopQuiet) {
      clearTimeout(this.stopQuiet);
    }
    this.stopQuiet = setTimeout(() => {
      this.finishStop({ state: acknowledged ? 'drained' : 'degraded', reason, acknowledged });
    }, STOP_QUIET_MS);
  }

  private buildDeliverySummary(): GatewayLiveDeliverySummary {
    return {
      scope: 'live-preview',
      coverage: this.droppedFrameCount > 0 ? 'gapped' : 'complete',
      recovered: this.recoveredEpisodeCount > 0,
      recoveryEpisodeCount: this.recoveryEpisodeCount,
      recoveredEpisodeCount: this.recoveredEpisodeCount,
      droppedFrameCount: this.droppedFrameCount,
      droppedAudioBytes: this.droppedAudioBytes,
      firstDroppedSequence: this.firstDroppedSequence,
      lastDroppedSequence: this.lastDroppedSequence,
      causes: [...this.deliveryCauses],
    };
  }

  private finishStop(result: Omit<GatewayLiveStreamStopResult, 'liveDelivery'>): void {
    const settle = this.settleStop;
    if (!settle) {
      return;
    }
    this.settleStop = null;
    this.closed = true;
    this.ready = false;
    this.stopLagReporting();
    this.clearReconnectTimer();
    this.clearBackpressureTimer();
    this.clearAckSilenceTimer();
    this.clearStopTimers();
    this.resetSocket();
    this.pendingFrames.clear();
    this.pendingAudioBytes = 0;
    settle({ ...result, liveDelivery: this.buildDeliverySummary() });
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearStopTimers(): void {
    if (this.stopTimeout) {
      clearTimeout(this.stopTimeout);
      this.stopTimeout = null;
    }
    if (this.stopQuiet) {
      clearTimeout(this.stopQuiet);
      this.stopQuiet = null;
    }
  }

  private clearOpenTimers(): void {
    if (this.openSilenceTimer) {
      clearTimeout(this.openSilenceTimer);
      this.openSilenceTimer = null;
    }
    if (this.openDeadlineTimer) {
      clearTimeout(this.openDeadlineTimer);
      this.openDeadlineTimer = null;
    }
  }

  private clearBackpressureTimer(): void {
    if (this.backpressureTimer) {
      clearTimeout(this.backpressureTimer);
      this.backpressureTimer = null;
    }
    if (this.replayPaceTimer) {
      clearTimeout(this.replayPaceTimer);
      this.replayPaceTimer = null;
    }
  }

  private armAckSilenceTimer(generation: number): void {
    if (this.ackSilenceTimer || this.pendingFrames.size === 0 || this.closed || this.stopping) {
      return;
    }
    const socket = this.socket;
    if (!socket || !this.ready || generation !== this.socketGeneration) {
      return;
    }
    this.ackSilenceTimer = setTimeout(() => {
      this.ackSilenceTimer = null;
      if (
        this.socket !== socket ||
        generation !== this.socketGeneration ||
        this.pendingFrames.size === 0 ||
        this.closed ||
        this.stopping
      ) {
        return;
      }

      // Silence on a socket that is still open: reconnect and replay the same
      // bounded set. Pending frames are deliberately kept — a short stall must
      // not cost transcript quality.
      console.warn('Gateway live audio acknowledgement timed out; recovering bounded replay', {
        pendingFrameCount: this.pendingFrames.size,
      });
      this.noteDeliveryFault('ack-timeout');
    }, ACK_SILENCE_TIMEOUT_MS);
  }

  private clearAckSilenceTimer(): void {
    if (this.ackSilenceTimer) {
      clearTimeout(this.ackSilenceTimer);
      this.ackSilenceTimer = null;
    }
  }

  private resetSocket(expected?: GatewaySocket): void {
    const socket = this.socket;
    if (expected && socket !== expected) {
      return;
    }
    this.socket = null;
    this.ready = false;
    this.backpressured = false;
    this.clearBackpressureTimer();
    this.clearAckSilenceTimer();
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      socket.close();
    }
  }
}
