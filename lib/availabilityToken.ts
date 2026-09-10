// Availability token — HMAC-SHA256, self-describing, revocable.
//
// Token format:
//   base64url(projectId:expertId:expiry_ms:nonce_hex) + "." + base64url(HMAC-SHA256(payload, secret))
//
// Signing, verification and the constant-time compare live in lib/hmacToken.ts
// (purpose 'availability'); this module owns the payload shape, the 7-day
// expiry and the revocation hash.
//
// The payload is self-describing: no extra Redis key needed to decode.
// Revocation: SHA-256(rawToken) is stored on ProjectExpert.availabilityTokenHash.
// When a new token is generated, the old hash is overwritten — old tokens fail the hash check.
//
// Secret: process.env.AVAILABILITY_TOKEN_SECRET (32+ hex bytes, never logged)

import { createHash, randomBytes } from 'crypto';
import { sign, verify } from './hmacToken';

const EXPIRY_MS  = 7 * 24 * 60 * 60 * 1000; // 7 days
const NONCE_BYTES = 16;

// ─── Public API ───────────────────────────────────────────────────────────────

export interface GeneratedToken {
  token:     string;   // the full raw token — included in the email link
  tokenHash: string;   // SHA-256(token) — stored on ProjectExpert for revocation
  expiry:    number;   // unix ms
}

/**
 * Generate a signed availability token for a given project + expert.
 * Returns the raw token (to embed in email link) and its SHA-256 hash (to store).
 */
export function generateAvailabilityToken(projectId: string, expertId: string): GeneratedToken {
  const expiry = Date.now() + EXPIRY_MS;
  const nonce  = randomBytes(NONCE_BYTES).toString('hex');
  const token  = sign(`${projectId}:${expertId}:${expiry}:${nonce}`, 'availability');
  return { token, tokenHash: hashToken(token), expiry };
}

/**
 * Generate a signed availability token for the client of a project (no expertId).
 * Token payload format: `client:${projectId}:${expiry}:${nonce}`
 */
export function generateClientAvailabilityToken(projectId: string): GeneratedToken {
  const expiry = Date.now() + EXPIRY_MS;
  const nonce  = randomBytes(NONCE_BYTES).toString('hex');
  const token  = sign(`client:${projectId}:${expiry}:${nonce}`, 'availability');
  return { token, tokenHash: hashToken(token), expiry };
}

/**
 * SHA-256 of the raw token — used to compare against the stored hash for revocation.
 * Never logged, never returned to clients.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface VerifiedToken {
  type:      'expert' | 'client';
  projectId: string;
  expertId:  string | null;  // null for client tokens
  expiry:    number;
}

export type VerifyResult =
  | { ok: true;  data: VerifiedToken }
  | { ok: false; reason: 'malformed' | 'expired' | 'invalid_signature' };

/**
 * Verify a raw token string:
 *  1. Structural integrity and HMAC signature (lib/hmacToken, constant-time)
 *  2. Payload shape — expert (projectId:expertId:expiry:nonce) or client
 *     (client:projectId:expiry:nonce)
 *  3. Expiry
 *
 * Does NOT check revocation (caller must compare SHA-256 against stored hash).
 */
export function verifyAvailabilityToken(token: string): VerifyResult {
  const verified = verify(token, 'availability');
  if (!verified.ok) return { ok: false, reason: verified.reason };

  // ── Parse payload — detect client vs expert token ────────────────────────
  const segments = verified.payload.split(':');

  let type: 'expert' | 'client';
  let projectId: string;
  let expertId: string | null;
  let expiry: number;

  if (segments[0] === 'client') {
    // Client token: client:projectId:expiry:nonce (4 segments)
    if (segments.length !== 4) return { ok: false, reason: 'malformed' };
    projectId = segments[1];
    expiry    = parseInt(segments[2], 10);
    if (!projectId || isNaN(expiry)) return { ok: false, reason: 'malformed' };
    type     = 'client';
    expertId = null;
  } else {
    // Expert token: projectId:expertId:expiry:nonce (4 segments)
    if (segments.length !== 4) return { ok: false, reason: 'malformed' };
    projectId      = segments[0];
    const eId      = segments[1];
    expiry         = parseInt(segments[2], 10);
    if (!projectId || !eId || isNaN(expiry)) return { ok: false, reason: 'malformed' };
    type     = 'expert';
    expertId = eId;
  }

  // ── Expiry check ─────────────────────────────────────────────────────────
  if (Date.now() > expiry) return { ok: false, reason: 'expired' };

  return { ok: true, data: { type, projectId, expertId, expiry } };
}
