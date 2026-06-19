/**
 * PKCE (RFC 7636) yardımcıları — desktop OAuth code-interception koruması.
 *
 * Saf + deterministik (challenge), Node crypto ile. Test için RFC 7636 örnek
 * vektörü kullanılır. code_verifier asla diske/loga yazılmaz (bellekte, akış süresi).
 */

import { createHash, randomBytes } from 'node:crypto';

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Rastgele code_verifier (RFC 7636: 43-128 char). 32 byte → 43 char base64url. */
export function generateCodeVerifier(): string {
  return base64url(randomBytes(32));
}

/** code_challenge = BASE64URL(SHA256(verifier)) — S256 method. */
export function codeChallengeS256(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest());
}

/** CSRF koruması için rastgele `state`. */
export function generateState(): string {
  return base64url(randomBytes(16));
}
