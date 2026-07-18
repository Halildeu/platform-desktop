import { WebSocket } from 'undici';

import type { GatewayConfig } from './gateway-client.js';

export const GATEWAY_LIVE_AUDIO_FRAME_VERSION = 1;
export const GATEWAY_LIVE_AUDIO_FRAME_HEADER_BYTES = 19;
const GATEWAY_LIVE_AUDIO_FRAME_MAX_PAYLOAD_BYTES = 65_535;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const OPEN_TIMEOUT_MS = 10_000;
const STOP_TIMEOUT_MS = 8_000;
const STOP_QUIET_MS = 1_250;
const RECONNECT_BASE_MS = 250;
const RECONNECT_MAX_MS = 2_000;
const MAX_RECONNECT_ATTEMPTS = 60;

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
    | 'unavailable';
  acknowledged: boolean;
}

interface GatewaySocket {
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
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
  private connectInFlight: Promise<void> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private latestRestSequence = -1;
  private nextLiveSequence = 0;
  private ready = false;
  private stopping = false;
  private closed = false;
  private sentAudio = false;
  private eofSupported = false;
  private stopPromise: Promise<GatewayLiveStreamStopResult> | null = null;
  private settleStop: ((result: GatewayLiveStreamStopResult) => void) | null = null;
  private stopTimeout: ReturnType<typeof setTimeout> | null = null;
  private stopQuiet: ReturnType<typeof setTimeout> | null = null;

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

    if (!this.ready || !this.socket || this.stopping || this.closed) {
      this.scheduleReconnect();
      return false;
    }
    if (chunkSeq < this.nextLiveSequence) {
      return false;
    }
    if (chunkSeq !== this.nextLiveSequence) {
      this.options.onError(
        new Error('gateway live sequence diverged; reconnecting from REST baseline'),
      );
      this.resetSocket();
      this.scheduleReconnect();
      return false;
    }

    this.socket.send(
      encodeGatewayLivePcm16Frame({
        chunkSeq,
        capturedAtMs,
        pcm16,
      }),
    );
    this.nextLiveSequence += 1;
    this.sentAudio = true;
    return true;
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

    if (!this.sentAudio) {
      this.finishStop({ state: 'drained', reason: 'no-audio', acknowledged: false });
      return this.stopPromise;
    }
    if (!this.ready || !this.socket) {
      this.finishStop({ state: 'degraded', reason: 'unavailable', acknowledged: false });
      return this.stopPromise;
    }

    this.stopTimeout = setTimeout(() => {
      this.finishStop({ state: 'degraded', reason: 'timeout', acknowledged: false });
    }, STOP_TIMEOUT_MS);

    if (this.eofSupported) {
      this.socket.send(JSON.stringify({ type: 'eof' }));
    } else {
      this.scheduleQuietStop('quiet', false);
    }
    return this.stopPromise;
  }

  close(): void {
    this.closed = true;
    this.stopping = true;
    this.clearReconnectTimer();
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
    const baseline = this.latestRestSequence;
    const operation = (async (): Promise<void> => {
      const jwt = await this.options.getJwt();
      if (!jwt) {
        throw new Error('gateway live stream token is unavailable');
      }
      const url = gatewayLiveStreamSessionUrl(this.options.cfg.baseUrl, this.options.sessionId);
      await new Promise<void>((resolve, reject) => {
        const socket = this.socketFactory(url, jwt);
        this.socket = socket;
        let settled = false;
        const timeout = setTimeout(() => {
          if (settled) {
            return;
          }
          settled = true;
          this.resetSocket();
          reject(new Error(`gateway live stream open timed out after ${OPEN_TIMEOUT_MS}ms`));
        }, OPEN_TIMEOUT_MS);

        socket.onopen = () => {
          // The TCP/WebSocket handshake alone is not STT readiness. Audio stays
          // fail-closed until the upstream model's validated `ready` event.
        };
        socket.onmessage = (message) => {
          const event = this.handleMessage(message.data);
          if (!settled && event?.type === 'error') {
            clearTimeout(timeout);
            settled = true;
            this.resetSocket();
            reject(new Error(`gateway live STT rejected startup: ${event.msg}`));
            return;
          }
          if (settled || event?.type !== 'ready') {
            return;
          }
          if (this.latestRestSequence !== baseline) {
            clearTimeout(timeout);
            settled = true;
            this.resetSocket();
            reject(new Error('gateway live stream baseline changed during handshake'));
            return;
          }
          clearTimeout(timeout);
          settled = true;
          this.ready = true;
          this.reconnectAttempts = 0;
          this.nextLiveSequence = baseline + 1;
          resolve();
        };
        socket.onerror = () => {
          if (!settled) {
            clearTimeout(timeout);
            settled = true;
            reject(new Error('gateway live stream handshake failed'));
          }
          this.handleSocketFailure('socket-error');
        };
        socket.onclose = () => {
          if (!settled) {
            clearTimeout(timeout);
            settled = true;
            reject(new Error('gateway live stream closed during handshake'));
          }
          this.handleSocketFailure('socket-close');
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

  private handleMessage(data: unknown): GatewayLiveServerEvent | null {
    const event = parseServerEvent(data);
    if (!event) {
      this.options.onError(new Error('gateway live stream returned an invalid event'));
      return null;
    }
    if (event.type === 'ready') {
      this.eofSupported =
        event.supports_eof === true || event.capabilities?.includes('eof') === true;
    }
    if (event.type === 'error') {
      this.options.onError(new Error(`gateway live STT error: ${event.msg}`));
      if (this.stopping) {
        this.finishStop({ state: 'degraded', reason: 'socket-error', acknowledged: false });
      }
    }
    if (this.stopping && event.type === 'drained') {
      this.finishStop({ state: 'drained', reason: 'drained', acknowledged: true });
    }
    this.options.onEvent(event);
    return event;
  }

  private handleSocketFailure(reason: 'socket-close' | 'socket-error'): void {
    this.ready = false;
    this.socket = null;
    if (this.stopping) {
      this.finishStop({ state: 'degraded', reason, acknowledged: false });
      return;
    }
    if (!this.closed) {
      this.options.onError(new Error(`gateway live stream ${reason}; REST transcript continues`));
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.stopping || this.ready || this.connectInFlight || this.reconnectTimer) {
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
    this.clearStopTimers();
    this.resetSocket();
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

  private resetSocket(): void {
    const socket = this.socket;
    this.socket = null;
    this.ready = false;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      socket.close();
    }
  }
}
