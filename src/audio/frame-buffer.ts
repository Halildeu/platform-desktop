/**
 * FrameBuffer — AudioWorklet'ten gelen küçük frame'leri (genelde 128 örnek)
 * sabit chunk boyutuna toplar (ör. 100ms @16kHz = 1600 örnek), tam chunk'lar
 * hazır olunca verir. Saf + test-edilebilir (getUserMedia/AudioWorklet'ten bağımsız).
 *
 * Akış: worklet → push(frame) → [tam chunk'lar] → encodeChunk → gateway.
 */
export class FrameBuffer {
  private readonly buf: Float32Array;
  private filled = 0;

  constructor(private readonly chunkSize: number) {
    if (chunkSize <= 0) {
      throw new Error('chunkSize must be > 0');
    }
    this.buf = new Float32Array(chunkSize);
  }

  /** Frame ekle; sınırı geçen tam chunk'ları döndür (kalan içeride birikir). */
  push(frame: Float32Array): Float32Array[] {
    const out: Float32Array[] = [];
    let i = 0;
    while (i < frame.length) {
      const space = this.chunkSize - this.filled;
      const take = Math.min(space, frame.length - i);
      this.buf.set(frame.subarray(i, i + take), this.filled);
      this.filled += take;
      i += take;
      if (this.filled === this.chunkSize) {
        out.push(this.buf.slice());
        this.filled = 0;
      }
    }
    return out;
  }

  /** Kayıt biterken kalan (yarım) chunk'ı al; yoksa null. */
  flush(): Float32Array | null {
    if (this.filled === 0) {
      return null;
    }
    const rest = this.buf.slice(0, this.filled);
    this.filled = 0;
    return rest;
  }

  /** İçeride bekleyen örnek sayısı. */
  pending(): number {
    return this.filled;
  }
}
