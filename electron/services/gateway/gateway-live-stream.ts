import { WebSocket } from 'undici';

import type { GatewayConfig } from './gateway-client.js';

export const GATEWAY_LIVE_AUDIO_FRAME_VERSION = 1;
export const GATEWAY_LIVE_AUDIO_FRAME_HEADER_BYTES = 19;
const GATEWAY_LIVE_AUDIO_FRAME_MAX_PAYLOAD_BYTES = 65_535;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
// Budget for *silence* while waiting for `ready`, not for the whole wait. The
// upstream reports progress with `loading` frames, and each one restarts this
// timer (see the open promise below).
const OPEN_TIMEOUT_MS = 10_000;
// Absolute ceiling on the wait, so a server that keeps emitting `loading`
// forever still fails instead of hanging the recorder.
export const GATEWAY_LIVE_STREAM_OPEN_MAX_WAIT_MS = 300_000;
const STOP_TIMEOUT_MS = 8_000;
const STOP_QUIET_MS = 1_250;
const RECONNECT_BASE_MS = 250;
const RECONNECT_MAX_MS = 2_000;
const MAX_RECONNECT_ATTEMPTS = 60;
const MAX_PENDING_FRAME_COUNT = 32;
const MAX_PENDING_AUDIO_BYTES = 2 * 1024 * 1024;
const SOCKET_BUFFER_HIGH_WATER_BYTES = 512 * 1024;
const SOCKET_BUFFER_LOW_WATER_BYTES = 128 * 1024;
const BACKPRESSURE_RETRY_MS = 25;
const ACK_SILENCE_TIMEOUT_MS = 6_000;
const MAX_ACK_TIMEOUT_RECOVERIES = 3;

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
    }
  | {
      type: 'partial';
      seq: number;
      confirmed: string;
      tentative: string;
      elapsed_ms?: number;
      rms?: number;
      source?: string;
    }
  | { type: 'final'; seq: number; text: string; elapsed_ms?: number; rms?: number }
  | { type: 'audio_ack'; chunk_seq: number }
  | { type: 'eof_ack' | 'drained' }
  | { type: 'error'; msg: string }
  | { type: 'debug' };

export interface GatewayLiveStreamStopResult {
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
  acknowledged: boolean;
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
}

type GatewaySocketFactory = (url: string, jwt: string) => GatewaySocket;

export interface GatewayLiveStreamOptions {
  cfg: GatewayConfig;
  sessionId: string;
  getJwt: () => Promise<string>;
  onEvent: (event: GatewayLiveServerEvent) => void;
  onError: (error: Error) => void;
  socketFactory?: GatewaySocketFactory;
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
      return {
        type: 'ready',
        ...(parsed.capabilities === undefined
          ? {}
          : { capabilities: parsed.capabilities as string[] }),
        ...(parsed.supports_eof === undefined ? {} : { supports_eof: parsed.supports_eof }),
        ...(parsed.partial_mode === undefined ? {} : { partial_mode: parsed.partial_mode }),
      };
    }
    if (parsed.type === 'partial') {
      if (
        !nonNegativeSequence(parsed.seq) ||
        typeof parsed.confirmed !== 'string' ||
        typeof parsed.tentative !== 'string' ||
        !optionalFiniteNumber(parsed.elapsed_ms) ||
        !optionalFiniteNumber(parsed.rms) ||
        (parsed.source !== undefined && typeof parsed.source !== 'string')
      ) {
        return null;
      }
      return parsed as GatewayLiveServerEvent;
    }
    if (parsed.type === 'final') {
      if (
        !nonNegativeSequence(parsed.seq) ||
        typeof parsed.text !== 'string' ||
        !optionalFiniteNumber(parsed.elapsed_ms) ||
        !optionalFiniteNumber(parsed.rms)
      ) {
        return null;
      }
      return parsed as GatewayLiveServerEvent;
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

function reconnectDelay(attempt: number): number {
  return Math.min(RECONNECT_BASE_MS * 2 ** Math.max(0, attempt - 1), RECONNECT_MAX_MS);
}

export class GatewayLiveStream {
  private readonly options: GatewayLiveStreamOptions;
  private readonly socketFactory: GatewaySocketFactory;
  private socket: GatewaySocket | null = null;
  private socketGeneration = 0;
  private connectInFlight: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private latestRestSequence = -1;
  private ready = false;
  private stopping = false;
  private closed = false;
  private eofSent = false;
  private eofSupported = false;
  private pendingAudioBytes = 0;
  private readonly pendingFrames = new Map<number, PendingAudioFrame>();
  private backpressureTimer: ReturnType<typeof setTimeout> | null = null;
  private backpressured = false;
  private ackSilenceTimer: ReturnType<typeof setTimeout> | null = null;
  private ackTimeoutRecoveries = 0;
  private liveDeliveryDegradedReason: 'ack-timeout' | 'buffer-overflow' | null = null;
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
  }

  async start(): Promise<void> {
    if (this.closed || this.stopping) {
      throw new Error('gateway live stream is closed');
    }
    await this.connect();
  }

  sendAfterRestAccepted(pcm16: Uint8Array, chunkSeq: number, capturedAtMs: number): boolean {
    if (!Number.isSafeInteger(chunkSeq) || chunkSeq < 0) {
      throw new Error('gateway live chunk sequence is invalid');
    }
    if (chunkSeq !== this.latestRestSequence + 1) {
      throw new Error('gateway REST chunk sequence is non-contiguous');
    }
    this.latestRestSequence = chunkSeq;

    if (this.stopping || this.closed) {
      return false;
    }

    const encoded = encodeGatewayLivePcm16Frame({ chunkSeq, capturedAtMs, pcm16 });
    if (!this.enqueueFrame(chunkSeq, encoded)) {
      this.scheduleReconnect();
      return false;
    }

    if (!this.ready || !this.socket) {
      this.scheduleReconnect();
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

    if (this.latestRestSequence < 0) {
      this.finishStop({ state: 'drained', reason: 'no-audio', acknowledged: false });
      return this.stopPromise;
    }
    if (this.liveDeliveryDegradedReason) {
      this.finishStop({
        state: 'degraded',
        reason: this.liveDeliveryDegradedReason,
        acknowledged: false,
      });
      return this.stopPromise;
    }
    if (!this.ready || !this.socket) {
      this.finishStop({ state: 'degraded', reason: 'unavailable', acknowledged: false });
      return this.stopPromise;
    }

    this.stopTimeout = setTimeout(() => {
      this.finishStop({ state: 'degraded', reason: 'timeout', acknowledged: false });
    }, STOP_TIMEOUT_MS);

    this.flushPendingFrames();
    if (this.pendingFrames.size === 0) {
      this.beginTerminalStop();
    }
    return this.stopPromise;
  }

  close(): void {
    this.closed = true;
    this.stopping = true;
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

  private connect(): Promise<void> {
    if (this.connectInFlight) {
      return this.connectInFlight;
    }
    const operation = (async (): Promise<void> => {
      const jwt = await this.options.getJwt();
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
          settled = true;
          this.rejectOpen = null;
          this.clearOpenTimers();
          this.ready = true;
          this.reconnectAttempts = 0;
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
    })().finally(() => {
      if (this.connectInFlight === operation) {
        this.connectInFlight = null;
      }
    });
    this.connectInFlight = operation;
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
    if (this.stopping && event.type === 'drained') {
      this.finishStop(
        this.liveDeliveryDegradedReason
          ? { state: 'degraded', reason: this.liveDeliveryDegradedReason, acknowledged: true }
          : { state: 'drained', reason: 'drained', acknowledged: true },
      );
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
      this.options.onError(new Error(`gateway live stream ${reason}; REST transcript continues`));
      this.scheduleReconnect();
    }
  }

  private enqueueFrame(chunkSeq: number, encoded: ArrayBuffer): boolean {
    if (this.liveDeliveryDegradedReason) {
      return false;
    }
    const byteLength = encoded.byteLength;
    if (
      this.pendingFrames.size >= MAX_PENDING_FRAME_COUNT ||
      this.pendingAudioBytes + byteLength > MAX_PENDING_AUDIO_BYTES
    ) {
      if (!this.liveDeliveryDegradedReason) {
        this.liveDeliveryDegradedReason = 'buffer-overflow';
        this.options.onError(
          new Error(
            'gateway live replay buffer is full; canonical REST recording continues without this live frame',
          ),
        );
      }
      this.pendingFrames.clear();
      this.pendingAudioBytes = 0;
      this.resetSocket();
      return false;
    }
    this.pendingFrames.set(chunkSeq, { encoded, byteLength, sentGeneration: null });
    this.pendingAudioBytes += byteLength;
    return true;
  }

  private acknowledgeFrame(chunkSeq: number): void {
    const pending = this.pendingFrames.get(chunkSeq);
    if (!pending) {
      return;
    }
    this.pendingFrames.delete(chunkSeq);
    this.pendingAudioBytes -= pending.byteLength;
    this.ackTimeoutRecoveries = 0;
    this.clearAckSilenceTimer();
    this.flushPendingFrames();
    if (this.pendingFrames.size > 0) {
      this.armAckSilenceTimer(this.socketGeneration);
    }
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

    let sent = false;
    for (const pending of this.pendingFrames.values()) {
      if (pending.sentGeneration === expectedGeneration) {
        continue;
      }
      if (this.socket !== socket || !this.ready) {
        return sent;
      }
      if (socket.bufferedAmount >= SOCKET_BUFFER_HIGH_WATER_BYTES) {
        this.backpressured = true;
        this.scheduleBackpressureRetry(expectedGeneration);
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
    }
    return sent;
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

  private scheduleReconnect(): void {
    if (
      this.closed ||
      this.stopping ||
      this.liveDeliveryDegradedReason ||
      this.ready ||
      this.connectInFlight ||
      this.reconnectTimer
    ) {
      return;
    }
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.options.onError(new Error('gateway live stream reconnect limit reached'));
      return;
    }
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => {
        this.scheduleReconnect();
      });
    }, reconnectDelay(this.reconnectAttempts));
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

  private finishStop(result: GatewayLiveStreamStopResult): void {
    const settle = this.settleStop;
    if (!settle) {
      return;
    }
    this.settleStop = null;
    this.closed = true;
    this.ready = false;
    this.clearReconnectTimer();
    this.clearBackpressureTimer();
    this.clearAckSilenceTimer();
    this.clearStopTimers();
    this.resetSocket();
    this.pendingFrames.clear();
    this.pendingAudioBytes = 0;
    settle(result);
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
  }

  private armAckSilenceTimer(generation: number): void {
    if (
      this.ackSilenceTimer ||
      this.pendingFrames.size === 0 ||
      this.closed ||
      this.stopping ||
      this.liveDeliveryDegradedReason
    ) {
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
        this.stopping ||
        this.liveDeliveryDegradedReason
      ) {
        return;
      }

      this.ackTimeoutRecoveries += 1;
      if (this.ackTimeoutRecoveries >= MAX_ACK_TIMEOUT_RECOVERIES) {
        this.liveDeliveryDegradedReason = 'ack-timeout';
        this.options.onError(
          new Error(
            `gateway live audio acknowledgements timed out after ${MAX_ACK_TIMEOUT_RECOVERIES} recovery attempts; canonical REST recording continues`,
          ),
        );
        this.pendingFrames.clear();
        this.pendingAudioBytes = 0;
        this.resetSocket(socket);
        return;
      }

      console.warn('Gateway live audio acknowledgement timed out; reconnecting bounded replay', {
        pendingFrameCount: this.pendingFrames.size,
        recoveryAttempt: this.ackTimeoutRecoveries,
      });
      this.resetSocket(socket);
      this.scheduleReconnect();
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
