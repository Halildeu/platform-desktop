/**
 * Audio DSP çekirdeği — saf, test-edilebilir (getUserMedia/AudioWorklet'ten bağımsız).
 *
 * Akış (contract-v1): loopback (sistem sesi) + mic → mix → 16kHz mono → PCM16 → chunk.
 * Bu modül DSP adımlarını saf fonksiyon olarak verir; I/O (getUserMedia, worklet,
 * IPC) ayrı katmanda. Halil (a): loopback + mic; (b): PCM16 16kHz mono → REST chunks.
 */

/** Float32 [-1,1] örnekleri → Int16 PCM (clamp ile taşmayı önler). */
export function floatToPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const s = Math.max(-1, Math.min(1, input[i] ?? 0));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/** Loopback + mic (iki mono kaynak) → tek mono, toplayıp [-1,1]'e clamp. */
export function mixMono(a: Float32Array, b: Float32Array): Float32Array {
  const n = Math.max(a.length, b.length);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const v = (a[i] ?? 0) + (b[i] ?? 0);
    out[i] = v > 1 ? 1 : v < -1 ? -1 : v;
  }
  return out;
}

/** Lineer resample (mono): srcRate → dstRate (ör. 48000 → 16000). */
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
  for (let i = 0; i < outLen; i += 1) {
    const idx = i * ratio;
    const i0 = Math.floor(idx);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = idx - i0;
    out[i] = (input[i0] ?? 0) * (1 - frac) + (input[i1] ?? 0) * frac;
  }
  return out;
}

/** Int16 PCM → little-endian byte'lar (chunk gövdesi: octet-stream). */
export function pcm16ToBytes(pcm: Int16Array): Uint8Array {
  const bytes = new Uint8Array(pcm.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < pcm.length; i += 1) {
    view.setInt16(i * 2, pcm[i] ?? 0, true); // little-endian
  }
  return bytes;
}

/**
 * Tek geçişte capture DSP: (loopback, mic) → mix → 16kHz → PCM16 byte'lar.
 * `srcRate` AudioContext örnekleme hızı (genelde 48000).
 */
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
