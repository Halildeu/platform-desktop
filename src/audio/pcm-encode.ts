/**
 * Pure audio DSP helpers.
 *
 * Flow: loopback + mic -> mix -> 16kHz mono -> PCM16 -> chunk bytes.
 */

export function floatToPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const s = Math.max(-1, Math.min(1, input[i] ?? 0));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

export function mixMono(a: Float32Array, b: Float32Array): Float32Array {
  const n = Math.max(a.length, b.length);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const v = (a[i] ?? 0) + (b[i] ?? 0);
    out[i] = v > 1 ? 1 : v < -1 ? -1 : v;
  }
  return out;
}

function lowPassForDownsample(input: Float32Array, ratio: number): Float32Array {
  const radius = Math.max(1, Math.floor(ratio / 2));
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    let sum = 0;
    let count = 0;
    for (let j = i - radius; j <= i + radius; j += 1) {
      if (j >= 0 && j < input.length) {
        sum += input[j] ?? 0;
        count += 1;
      }
    }
    out[i] = count > 0 ? sum / count : 0;
  }
  return out;
}

export function resampleLinear(
  input: Float32Array,
  srcRate: number,
  dstRate: number,
): Float32Array {
  if (srcRate === dstRate || input.length === 0) {
    return input;
  }
  const ratio = srcRate / dstRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  const source = ratio > 1 ? lowPassForDownsample(input, ratio) : input;
  for (let i = 0; i < outLen; i += 1) {
    const idx = i * ratio;
    const i0 = Math.floor(idx);
    const i1 = Math.min(i0 + 1, source.length - 1);
    const frac = idx - i0;
    out[i] = (source[i0] ?? 0) * (1 - frac) + (source[i1] ?? 0) * frac;
  }
  return out;
}

export function pcm16ToBytes(pcm: Int16Array): Uint8Array {
  const bytes = new Uint8Array(pcm.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < pcm.length; i += 1) {
    view.setInt16(i * 2, pcm[i] ?? 0, true);
  }
  return bytes;
}

export function encodeChunk(
  loopback: Float32Array,
  mic: Float32Array,
  srcRate: number,
  targetRate = 16000,
): Uint8Array {
  const mixed = mixMono(loopback, mic);
  const resampled = resampleLinear(mixed, srcRate, targetRate);
  return pcm16ToBytes(floatToPcm16(resampled));
}
