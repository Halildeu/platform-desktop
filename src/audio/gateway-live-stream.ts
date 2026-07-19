import { floatToPcm16, pcm16ToBytes } from './pcm-encode';

export const GATEWAY_LIVE_AUDIO_FRAME_VERSION = 1;
export const GATEWAY_LIVE_AUDIO_FRAME_HEADER_BYTES = 19;
export const GATEWAY_LIVE_AUDIO_FRAME_MAX_PAYLOAD_BYTES = 65_535;

const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export interface GatewayLiveAudioFrameInput {
  chunkSeq: number;
  capturedAtMs: number;
  samples: Float32Array;
}

export interface GatewayLivePcm16FrameInput {
  chunkSeq: number;
  capturedAtMs: number;
  pcm16: Uint8Array;
}

function requireNonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}

/**
 * Encode the gateway v1 binary frame. Header fields use network byte order;
 * audio remains signed little-endian PCM16 as required by the gateway.
 */
export function encodeGatewayLiveAudioFrame(input: GatewayLiveAudioFrameInput): ArrayBuffer {
  const pcm16 = pcm16ToBytes(floatToPcm16(input.samples));
  return encodeGatewayLivePcm16Frame({
    chunkSeq: input.chunkSeq,
    capturedAtMs: input.capturedAtMs,
    pcm16,
  });
}

/**
 * Encode already-normalized PCM16 bytes from the Electron main process without
 * a lossy PCM16 -> float32 -> PCM16 round trip.
 */
export function encodeGatewayLivePcm16Frame(input: GatewayLivePcm16FrameInput): ArrayBuffer {
  requireNonNegativeSafeInteger(input.chunkSeq, 'chunkSeq');
  requireNonNegativeSafeInteger(input.capturedAtMs, 'capturedAtMs');

  const pcm16 = input.pcm16;
  if (pcm16.byteLength === 0 || pcm16.byteLength > GATEWAY_LIVE_AUDIO_FRAME_MAX_PAYLOAD_BYTES) {
    throw new Error('PCM16 payload length must be between 1 and 65535 bytes');
  }
  if ((pcm16.byteLength & 1) !== 0) {
    throw new Error('PCM16 payload length must be even');
  }

  const encoded = new ArrayBuffer(GATEWAY_LIVE_AUDIO_FRAME_HEADER_BYTES + pcm16.byteLength);
  const view = new DataView(encoded);
  view.setUint8(0, GATEWAY_LIVE_AUDIO_FRAME_VERSION);
  view.setBigInt64(1, BigInt(input.chunkSeq), false);
  view.setBigInt64(9, BigInt(input.capturedAtMs), false);
  view.setUint16(17, pcm16.byteLength, false);
  new Uint8Array(encoded, GATEWAY_LIVE_AUDIO_FRAME_HEADER_BYTES).set(pcm16);
  return encoded;
}

function isLocalHttp(url: URL): boolean {
  return (
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1')
  );
}

/**
 * Build the gateway session URL without embedding credentials. The Electron
 * main-process transport must attach the JWT during the WebSocket handshake.
 */
export function gatewayLiveStreamSessionUrl(gatewayBaseUrl: string, sessionId: string): string {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error('sessionId must match the gateway identifier contract');
  }

  let url: URL;
  try {
    url = new URL(gatewayBaseUrl);
  } catch {
    throw new Error('gatewayBaseUrl must be an absolute URL');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('gatewayBaseUrl must not contain credentials, query, or fragment');
  }
  if (url.protocol === 'https:') {
    url.protocol = 'wss:';
  } else if (isLocalHttp(url)) {
    url.protocol = 'ws:';
  } else {
    throw new Error('gatewayBaseUrl must use HTTPS, except local development URLs');
  }

  const basePath = url.pathname.replace(/\/+$/, '');
  url.pathname = `${basePath}/api/v1/audio-gateway/sessions/${sessionId}/stream`;
  return url.toString();
}
