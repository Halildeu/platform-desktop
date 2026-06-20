import { describe, expect, it } from 'vitest';

import { codeChallengeS256, generateCodeVerifier, generateState } from './pkce';

describe('pkce (RFC 7636)', () => {
  it('RFC 7636 örnek vektörü: bilinen verifier → bilinen challenge', () => {
    // RFC 7636 Appendix B
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(codeChallengeS256(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('generateCodeVerifier: base64url, 43+ char', () => {
    const v = generateCodeVerifier();
    expect(v.length).toBeGreaterThanOrEqual(43);
    expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('challenge deterministik, verifier rastgele (çakışmaz)', () => {
    expect(generateCodeVerifier()).not.toBe(generateCodeVerifier());
    const v = generateCodeVerifier();
    expect(codeChallengeS256(v)).toBe(codeChallengeS256(v));
  });

  it('generateState: base64url, boş değil', () => {
    expect(generateState()).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
