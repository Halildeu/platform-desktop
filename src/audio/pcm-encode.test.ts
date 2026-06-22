import { describe, expect, it } from 'vitest';

import {
  encodeChunk,
  floatToPcm16,
  mixMono,
  pcm16ToBytes,
  resampleLinear,
} from './pcm-encode';

describe('pcm-encode pure DSP', () => {
  it('floatToPcm16 clamps sample bounds', () => {
    const out = floatToPcm16(new Float32Array([0, 1, -1, 0.5, 2, -2]));
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(32767);
    expect(out[2]).toBe(-32768);
    expect(out[3]).toBe(16383);
    expect(out[4]).toBe(32767);
    expect(out[5]).toBe(-32768);
  });

  it('mixMono sums and clamps sources with different lengths', () => {
    const m = mixMono(new Float32Array([0.5, 0.5, 0.5]), new Float32Array([0.5, 0.6]));
    expect(m[0]).toBeCloseTo(1.0);
    expect(m[1]).toBe(1);
    expect(m[2]).toBeCloseTo(0.5);
  });

  it('resampleLinear maps 48k to 16k length', () => {
    const input = new Float32Array(48).fill(0.25);
    const out = resampleLinear(input, 48000, 16000);
    expect(out.length).toBe(16);
    expect(out[0]).toBeCloseTo(0.25);
  });

  it('resampleLinear returns original buffer when sample rate is unchanged', () => {
    const input = new Float32Array([0.1, 0.2]);
    expect(resampleLinear(input, 16000, 16000)).toBe(input);
  });

  it('resampleLinear attenuates high-frequency content before downsampling', () => {
    const input = Float32Array.from({ length: 48 }, (_, i) => (i % 2 === 0 ? 1 : -1));
    const out = resampleLinear(input, 48000, 16000);
    const peak = Math.max(...Array.from(out, Math.abs));
    expect(peak).toBeLessThan(0.6);
  });

  it('pcm16ToBytes writes little-endian samples', () => {
    const bytes = pcm16ToBytes(new Int16Array([1, -1]));
    expect(bytes.length).toBe(4);
    expect(bytes[0]).toBe(1);
    expect(bytes[1]).toBe(0);
    expect(bytes[2]).toBe(0xff);
    expect(bytes[3]).toBe(0xff);
  });

  it('encodeChunk returns 16kHz PCM16 bytes end to end', () => {
    const loop = new Float32Array(48).fill(0.2);
    const mic = new Float32Array(48).fill(0.1);
    const bytes = encodeChunk(loop, mic, 48000, 16000);
    expect(bytes.length).toBe(32);
  });
});
