import { describe, expect, it } from 'vitest';

import { DEFAULT_SKEW_MS, expiresAtFromExpiresIn, isExpired } from './token-store';

describe('token-store (saf yardımcılar)', () => {
  it('expiresAtFromExpiresIn: now + expires_in*1000', () => {
    expect(expiresAtFromExpiresIn(300, 1_000)).toBe(1_000 + 300_000);
  });

  it('isExpired: skew eşiğinden önce geçerli', () => {
    const t = { expiresAt: 100_000 };
    // eşik = expiresAt - skew = 100_000 - 30_000 = 70_000
    expect(isExpired(t, 69_999, DEFAULT_SKEW_MS)).toBe(false);
    expect(isExpired(t, 70_000, DEFAULT_SKEW_MS)).toBe(true);
    expect(isExpired(t, 120_000, DEFAULT_SKEW_MS)).toBe(true);
  });

  it('isExpired: skew=0 → tam expiresAt anında dolar', () => {
    const t = { expiresAt: 100_000 };
    expect(isExpired(t, 99_999, 0)).toBe(false);
    expect(isExpired(t, 100_000, 0)).toBe(true);
  });
});
