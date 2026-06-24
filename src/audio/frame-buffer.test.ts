import { describe, expect, it } from 'vitest';

import { FrameBuffer } from './frame-buffer';

describe('FrameBuffer', () => {
  it("küçük frame'ler birikir, chunkSize dolunca emit", () => {
    const fb = new FrameBuffer(4);
    expect(fb.push(new Float32Array([1, 2]))).toEqual([]); // 2/4 birikti
    expect(fb.pending()).toBe(2);
    const out = fb.push(new Float32Array([3, 4, 5]));
    expect(out.length).toBe(1);
    expect(Array.from(out[0])).toEqual([1, 2, 3, 4]); // tam chunk
    expect(fb.pending()).toBe(1); // 5 içeride kaldı
  });

  it('büyük frame → birden çok tam chunk', () => {
    const fb = new FrameBuffer(2);
    const out = fb.push(new Float32Array([1, 2, 3, 4, 5]));
    expect(out.map((c) => Array.from(c))).toEqual([
      [1, 2],
      [3, 4],
    ]);
    expect(fb.pending()).toBe(1); // 5 kaldı
  });

  it('flush: kalan yarım chunk', () => {
    const fb = new FrameBuffer(4);
    fb.push(new Float32Array([1, 2, 3]));
    const rest = fb.flush();
    expect(rest && Array.from(rest)).toEqual([1, 2, 3]);
    expect(fb.flush()).toBeNull(); // tekrar boş
  });

  it('chunkSize <= 0 → hata', () => {
    expect(() => new FrameBuffer(0)).toThrow();
  });
});
