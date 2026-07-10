import { describe, expect, it } from 'vitest';

import { isBoundsVisibleOnAnyDisplay, resolveWindowBounds } from './window-bounds';

const PRIMARY = { bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
const FALLBACK = { x: 100, y: 100, width: 1280, height: 800 };

describe('isBoundsVisibleOnAnyDisplay', () => {
  it('is visible when fully inside a display', () => {
    const saved = { x: 200, y: 200, width: 800, height: 600 };
    expect(isBoundsVisibleOnAnyDisplay(saved, [PRIMARY])).toBe(true);
  });

  it('is visible when only the corner overlaps (partially off-screen)', () => {
    // 50x50 corner still inside the 1920x1080 display, rest hangs off both edges.
    const saved = { x: 1870, y: 1030, width: 800, height: 600 };
    expect(isBoundsVisibleOnAnyDisplay(saved, [PRIMARY])).toBe(true);
  });

  it('is not visible when entirely off every display (unplugged monitor)', () => {
    const saved = { x: 5000, y: 5000, width: 800, height: 600 };
    expect(isBoundsVisibleOnAnyDisplay(saved, [PRIMARY])).toBe(false);
  });

  it('checks across multiple displays', () => {
    const secondary = { bounds: { x: 1920, y: 0, width: 1920, height: 1080 } };
    const saved = { x: 2200, y: 200, width: 800, height: 600 };
    expect(isBoundsVisibleOnAnyDisplay(saved, [PRIMARY, secondary])).toBe(true);
  });
});

describe('resolveWindowBounds', () => {
  it('returns fallback when nothing was saved', () => {
    expect(resolveWindowBounds(undefined, [PRIMARY], FALLBACK)).toEqual(FALLBACK);
  });

  it('returns the saved bounds when visible and above minimums', () => {
    const saved = { x: 200, y: 200, width: 1280, height: 800 };
    expect(resolveWindowBounds(saved, [PRIMARY], FALLBACK)).toEqual(saved);
  });

  it('clamps below-minimum saved size up to the minimum', () => {
    const saved = { x: 200, y: 200, width: 400, height: 300 };
    const resolved = resolveWindowBounds(saved, [PRIMARY], FALLBACK);
    expect(resolved.width).toBeGreaterThanOrEqual(1024);
    expect(resolved.height).toBeGreaterThanOrEqual(700);
  });

  it('falls back when the saved bounds are off every display', () => {
    const saved = { x: 9000, y: 9000, width: 800, height: 600 };
    expect(resolveWindowBounds(saved, [PRIMARY], FALLBACK)).toEqual(FALLBACK);
  });
});
