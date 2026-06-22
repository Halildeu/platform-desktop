import { Buffer } from 'node:buffer';

export interface SafeJwtClaims {
  iss?: string;
  aud?: string | string[];
  azp?: string;
  scope?: string;
  exp?: number;
}

function decodeBase64UrlJson(segment: string): unknown {
  const padded = segment.padEnd(segment.length + ((4 - (segment.length % 4)) % 4), '=');
  const json = Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(
    'utf8',
  );
  return JSON.parse(json);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function safeJwtClaims(token: string | null | undefined): SafeJwtClaims | null {
  if (!token) {
    return null;
  }

  const [, payload] = token.split('.');
  if (!payload) {
    return null;
  }

  try {
    const claims = decodeBase64UrlJson(payload);
    if (!isRecord(claims)) {
      return null;
    }

    const out: SafeJwtClaims = {};
    if (typeof claims.iss === 'string') out.iss = claims.iss;
    if (typeof claims.aud === 'string') out.aud = claims.aud;
    if (Array.isArray(claims.aud) && claims.aud.every((item) => typeof item === 'string')) {
      out.aud = claims.aud;
    }
    if (typeof claims.azp === 'string') out.azp = claims.azp;
    if (typeof claims.scope === 'string') out.scope = claims.scope;
    if (typeof claims.exp === 'number') out.exp = claims.exp;
    return out;
  } catch {
    return null;
  }
}
