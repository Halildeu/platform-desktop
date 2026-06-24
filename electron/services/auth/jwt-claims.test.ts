import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import { safeJwtClaims } from './jwt-claims';

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

describe('safeJwtClaims', () => {
  it('returns only safe diagnostic claims', () => {
    const token = [
      b64url({ alg: 'none' }),
      b64url({
        iss: 'https://testai.acik.com/realms/platform-test',
        aud: ['audio-gateway', 'account'],
        azp: 'platform-desktop',
        scope: 'openid profile email',
        exp: 1_800_000_000,
        tenantId: 1,
        preferred_username: 'zeynep@example.com',
      }),
      'signature',
    ].join('.');

    expect(safeJwtClaims(token)).toEqual({
      iss: 'https://testai.acik.com/realms/platform-test',
      aud: ['audio-gateway', 'account'],
      azp: 'platform-desktop',
      scope: 'openid profile email',
      exp: 1_800_000_000,
      tenantId: 1,
    });
  });

  it('returns null for invalid tokens', () => {
    expect(safeJwtClaims('not-a-jwt')).toBeNull();
    expect(safeJwtClaims(null)).toBeNull();
  });
});
