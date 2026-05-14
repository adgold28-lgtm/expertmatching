// Availability token — HMAC-SHA256, self-describing, revocable.
//
// Token format:
//   base64url(projectId:expertId:expiry_ms:nonce_hex) + "." + base64url(HMAC-SHA256(payload, secret))
//
// The payload is self-describing: no extra Redis key needed to decode.
// Revocation: SHA-256(rawToken) is stored on ProjectExpert.availabilityTokenHash.
// When a new token is generated, the old hash is overwritten — old tokens fail the hash check.
//
// Secret: process.env.AVAILABILITY_TOKEN_SECRET (32+ hex bytes, never logged)

import { createHmac, createHash, timingSafeEqual, randomBytes } from 'crypto';

const EXPIRY_MS  = 7 * 24 * 60 * 60 * 1000; // 7 days
const SEP        = '.';
const NONCE_BYTES = 16;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toBase64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

function fromBase64url(s: string): string {
  return Buffer.from(s, 'base64url').toString('utf8');
}

function getSecret(): string {
  const s = process.env.AVAILABILITY_TOKEN_SECRET;
  if (!s || s.length < 32) throw new Error('[availabilityToken] AVAILABILITY_TOKEN_SECRET missing or too short');
  return s;
}

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
  const secret  = getSecret();
  const expiry  = Date.now() + EXPIRY_MS;
  const nonce   = randomBytes(NONCE_BYTES).toString('hex');
  const payload = toBase64url(`${projectId}:${expertId}:${expiry}:${nonce}`);
  const sig     = createHmac('sha256', secret).update(payload).digest('base64url');
  const token   = `${payload}${SEP}${sig}`;

  const tokenHash = hashToken(token);
  return { token, tokenHash, expiry };
}

/**
 * Generate a signed availability token for the client of a project (no expertId).
 * Token payload format: `client:${projectId}:${expiry}:${nonce}`
 */
export function generateClientAvailabilityToken(projectId: string): GeneratedToken {
  const secret  = getSecret();
  const expiry  = Date.now() + EXPIRY_MS;
  const nonce   = randomBytes(NONCE_BYTES).toString('hex');
  const payload = toBase64url(`client:${projectId}:${expiry}:${nonce}`);
  const sig     = createHmac('sha256', secret).update(payload).digest('base64url');
  const token   = `${payload}${SEP}${sig}`;

  const tokenHash = hashToken(token);
  return { token, tokenHash, expiry };
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
 *  1. Structural integrity (two dot-separated base64url segments)
 *  2. HMAC signature (constant-time)
 *  3. Expiry
 *
 * Does NOT check revocation (caller must compare SHA-256 against stored hash).
 * Supports both expert tokens (projectId:expertId:expiry:nonce)
 * and client tokens (client:projectId:expiry:nonce).
 */
export function verifyAvailabilityToken(token: string): VerifyResult {
  const parts = token.split(SEP);
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };

  const [payloadB64, sigB64] = parts;

  // ── 1. Structural decode ──────────────────────────────────────────────────
  let raw: string;
  try {
    raw = fromBase64url(payloadB64);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  // ── 2. Constant-time signature check ─────────────────────────────────────
  let secret: string;
  try { secret = getSecret(); } catch { return { ok: false, reason: 'invalid_signature' }; }

  const expectedSig = createHmac('sha256', secret).update(payloadB64).digest('base64url');

  // Pad to equal length to avoid length oracle; always run comparison
  const expectedBuf = Buffer.from(expectedSig, 'utf8');
  const actualBuf   = Buffer.from(sigB64,      'utf8');
  const paddedActual = actualBuf.length === expectedBuf.length
    ? actualBuf
    : Buffer.concat([actualBuf, Buffer.alloc(Math.max(0, expectedBuf.length - actualBuf.length))]);

  const sigMatch = timingSafeEqual(expectedBuf, paddedActual) && actualBuf.length === expectedBuf.length;
  if (!sigMatch) return { ok: false, reason: 'invalid_signature' };

  // ── 3. Parse payload — detect client vs expert token ─────────────────────
  const segments = raw.split(':');

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

  // ── 4. Expiry check ───────────────────────────────────────────────────────
  if (Date.now() > expiry) return { ok: false, reason: 'expired' };

  return { ok: true, data: { type, projectId, expertId, expiry } };
}
