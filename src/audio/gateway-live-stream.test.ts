import { describe, expect, it } from 'vitest';

import {
  encodeGatewayLiveAudioFrame,
  encodeGatewayLivePcm16Frame,
  GATEWAY_LIVE_AUDIO_FRAME_HEADER_BYTES,
  gatewayLiveStreamSessionUrl,
} from './gateway-live-stream';

describe('gateway live stream contract', () => {
  it('encodes the v1 network-order header and little-endian PCM16 payload', () => {
    const encoded = encodeGatewayLiveAudioFrame({
      chunkSeq: 7,
      capturedAtMs: 1_781_820_000_123,
      samples: new Float32Array([0, 1, -1, 0.5]),
    });
    const view = new DataView(encoded);

    expect(encoded.byteLength).toBe(GATEWAY_LIVE_AUDIO_FRAME_HEADER_BYTES + 8);
    expect(view.getUint8(0)).toBe(1);
    expect(view.getBigInt64(1, false)).toBe(7n);
    expect(view.getBigInt64(9, false)).toBe(1_781_820_000_123n);
    expect(view.getUint16(17, false)).toBe(8);
    expect(Array.from(new Uint8Array(encoded, GATEWAY_LIVE_AUDIO_FRAME_HEADER_BYTES))).toEqual([
      0x00, 0x00, 0xff, 0x7f, 0x00, 0x80, 0xff, 0x3f,
    ]);
  });

  it('rejects invalid sequence, timestamp, empty, and oversized payloads', () => {
    expect(() =>
      encodeGatewayLiveAudioFrame({
        chunkSeq: -1,
        capturedAtMs: 1,
        samples: new Float32Array([0]),
      }),
    ).toThrow('chunkSeq must be a non-negative safe integer');
    expect(() =>
      encodeGatewayLiveAudioFrame({
        chunkSeq: 0,
        capturedAtMs: Number.MAX_SAFE_INTEGER + 1,
        samples: new Float32Array([0]),
      }),
    ).toThrow('capturedAtMs must be a non-negative safe integer');
    expect(() =>
      encodeGatewayLiveAudioFrame({
        chunkSeq: 0,
        capturedAtMs: 1,
        samples: new Float32Array(0),
      }),
    ).toThrow('PCM16 payload length must be between 1 and 65535 bytes');
    expect(() =>
      encodeGatewayLiveAudioFrame({
        chunkSeq: 0,
        capturedAtMs: 1,
        samples: new Float32Array(32_768),
      }),
    ).toThrow('PCM16 payload length must be between 1 and 65535 bytes');
  });

  it('encodes pre-normalized PCM16 without changing the payload', () => {
    const pcm16 = new Uint8Array([0x34, 0x12, 0xcc, 0xed]);
    const encoded = encodeGatewayLivePcm16Frame({
      chunkSeq: 2,
      capturedAtMs: 3,
      pcm16,
    });
    const view = new DataView(encoded);

    expect(view.getBigInt64(1, false)).toBe(2n);
    expect(view.getBigInt64(9, false)).toBe(3n);
    expect(view.getUint16(17, false)).toBe(4);
    expect(Array.from(new Uint8Array(encoded, GATEWAY_LIVE_AUDIO_FRAME_HEADER_BYTES))).toEqual([
      0x34, 0x12, 0xcc, 0xed,
    ]);
    expect(() =>
      encodeGatewayLivePcm16Frame({
        chunkSeq: 0,
        capturedAtMs: 1,
        pcm16: new Uint8Array([1]),
      }),
    ).toThrow('PCM16 payload length must be even');
  });

  it('builds the canonical session WebSocket URL from the gateway base URL', () => {
    expect(gatewayLiveStreamSessionUrl('https://testai.acik.com/', 'SES-1')).toBe(
      'wss://testai.acik.com/api/v1/audio-gateway/sessions/SES-1/stream',
    );
    expect(gatewayLiveStreamSessionUrl('http://127.0.0.1:8210', 'SES-LOCAL')).toBe(
      'ws://127.0.0.1:8210/api/v1/audio-gateway/sessions/SES-LOCAL/stream',
    );
  });

  it('rejects unsafe gateway bases and invalid session identifiers', () => {
    expect(() => gatewayLiveStreamSessionUrl('http://gateway.example.com', 'SES-1')).toThrow(
      'gatewayBaseUrl must use HTTPS',
    );
    expect(() =>
      gatewayLiveStreamSessionUrl('https://user:pass@gateway.example.com', 'SES-1'),
    ).toThrow('gatewayBaseUrl must not contain credentials');
    expect(() => gatewayLiveStreamSessionUrl('https://gateway.example.com', '../session')).toThrow(
      'sessionId must match the gateway identifier contract',
    );
  });
});
