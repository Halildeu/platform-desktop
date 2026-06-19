import { describe, expect, it } from 'vitest';

import {
  encodeChunk,
  floatToPcm16,
  mixMono,
  pcm16ToBytes,
  resampleLinear,
} from './pcm-encode';

describe('pcm-encode (DSP saf)', () => {
  it('floatToPcm16: sınır + clamp', () => {
    const out = floatToPcm16(new Float32Array([0, 1, -1, 0.5, 2, -2]));
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(32767); // +1 → 0x7fff
    expect(out[2]).toBe(-32768); // -1 → -0x8000
    expect(out[3]).toBe(16383); // 0.5 * 32767
    expect(out[4]).toBe(32767); // clamp +2 → +1
    expect(out[5]).toBe(-32768); // clamp -2 → -1
  });

  it('mixMono: topla + clamp + farklı uzunluk', () => {
    const m = mixMono(new Float32Array([0.5, 0.5, 0.5]), new Float32Array([0.5, 0.6]));
    expect(m[0]).toBeCloseTo(1.0); // 0.5+0.5
    expect(m[1]).toBe(1); // 0.5+0.6=1.1 → clamp 1
    expect(m[2]).toBeCloseTo(0.5); // 0.5 + (yok=0)
  });

  it('resampleLinear: 48k→16k uzunluğu 1/3', () => {
    const input = new Float32Array(48).fill(0.25);
    const out = resampleLinear(input, 48000, 16000);
    expect(out.length).toBe(16);
    expect(out[0]).toBeCloseTo(0.25);
  });

  it('resampleLinear: aynı oran → değişmez', () => {
    const input = new Float32Array([0.1, 0.2]);
    expect(resampleLinear(input, 16000, 16000)).toBe(input);
  });

  it('pcm16ToBytes: little-endian, 2 byte/örnek', () => {
    const bytes = pcm16ToBytes(new Int16Array([1, -1]));
    expect(bytes.length).toBe(4);
    expect(bytes[0]).toBe(1); // 0x0001 LE → 01 00
    expect(bytes[1]).toBe(0);
    expect(bytes[2]).toBe(0xff); // -1 → 0xffff
    expect(bytes[3]).toBe(0xff);
  });

  it('encodeChunk: loopback+mic → 16kHz PCM16 byte (uçtan uca DSP)', () => {
    const loop = new Float32Array(48).fill(0.2);
    const mic = new Float32Array(48).fill(0.1);
    const bytes = encodeChunk(loop, mic, 48000, 16000);
    // 48 örnek @48k → 16 örnek @16k → 16*2 = 32 byte
    expect(bytes.length).toBe(32);
  });
});
