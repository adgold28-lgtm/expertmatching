// Screening link token — HMAC-SHA256, single-use, request+candidate scoped.
//
// Token format:
//   base64url(tokenId:requestId:expiry_ms:nonce_hex) + "." + base64url(HMAC-SHA256(payload, secret))
//
// Signing, verification and the constant-time compare live in lib/hmacToken.ts
// (purpose 'screening'); this module owns the payload shape, the hash and the
// parse. Both ids are uuids and a uuid contains no colon, so the payload splits
// on ':' unambiguously into exactly four segments.
//
// NOT lib/outreachToken.ts. That token addresses a Matchy reply thread
// (projectId:expertId) on the Brief → Matches → Conversations path. This one
// addresses one row of `screening_tokens` — one expert, one request, one
// screening form — and the two purposes are separate so a token minted for one
// can never verify as the other.
//
// EXPIRY IS NOT A POLICY THIS MODULE OWNS. The caller passes `expiresAtMs`, and
// every caller passes the REQUEST'S DEADLINE: a screening link dies when the
// client stops needing answers, not on a fixed clock. The same instant is
// written to screening_tokens.expires_at, so a stale link fails signature-side
// and storage-side alike.
//
// REVOCATION IS NOT IN THE TOKEN EITHER. `tokenHash` (sha256 of the raw token)
// is what the platform stores; the raw token exists only long enough to be put
// in an email or on a staff screen. A link is dead when its hash is not on a
// row, when that row carries `revoked_at`, or — single use — when it already
// carries `submitted_at`. lib/requestStore.ts owns all three checks; a good
// signature means only that the bytes are ours.
//
// Secret: process.env.AVAILABILITY_TOKEN_SECRET (32+ chars, never logged).
//
// NEVER LOGS: the raw token, the token hash, the ids inside it.

import { createHash, randomBytes } from 'crypto';
import { sign, verify } from './hmacToken';

const NONCE_BYTES = 16;

// ─── Public API ───────────────────────────────────────────────────────────────

export interface GeneratedScreeningToken {
  /** The full raw token — goes in the link, and is never stored. */
  token:     string;
  /** SHA-256(token), hex — stored on screening_tokens.token_hash. */
  tokenHash: string;
  /** Unix ms; the same instant stored as screening_tokens.expires_at. */
  expiry:    number;
}

/**
 * Mint a screening link token for one `screening_tokens` row.
 *
 * `tokenId` is the row's uuid (generate it first, sign it, then insert the row
 * with the hash) and `requestId` is the request the row belongs to. Carrying
 * both means the public route can load the request without a second lookup and
 * can refuse a token whose row has been moved to another request.
 *
 * `expiresAtMs` is the request deadline in unix ms. A deadline already in the
 * past still mints — the caller refuses that case with a clearer error than a
 * token that cannot be verified.
 */
export function generateScreeningToken(
  tokenId: string,
  requestId: string,
  expiresAtMs: number,
): GeneratedScreeningToken {
  const expiry = Math.floor(expiresAtMs);
  const nonce  = randomBytes(NONCE_BYTES).toString('hex');
  const token  = sign(`${tokenId}:${requestId}:${expiry}:${nonce}`, 'screening');
  return { token, tokenHash: hashScreeningToken(token), expiry };
}

/**
 * SHA-256 of the raw token — the stored handle, used to find the row and to
 * check revocation. Never logged, never returned to a browser.
 */
export function hashScreeningToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface VerifiedScreeningToken {
  tokenId:   string;
  requestId: string;
  expiry:    number;
}

export type ScreeningVerifyResult =
  | { ok: true;  data: VerifiedScreeningToken }
  | { ok: false; reason: 'malformed' | 'expired' | 'invalid_signature' };

/**
 * Verify a raw token string:
 *   1. Structure and HMAC signature (lib/hmacToken, constant-time)
 *   2. Payload shape — exactly tokenId:requestId:expiry:nonce
 *   3. Expiry
 *
 * Does NOT check revocation or single use: the caller compares
 * `hashScreeningToken(raw)` against the stored hash and reads `revoked_at` /
 * `submitted_at`. The public surface renders the SAME page for every dead
 * reason, so the caller should not branch on `reason` in anything a browser
 * can see.
 */
export function verifyScreeningToken(token: string): ScreeningVerifyResult {
  const verified = verify(token, 'screening');
  if (!verified.ok) return { ok: false, reason: verified.reason };

  const segments = verified.payload.split(':');
  if (segments.length !== 4) return { ok: false, reason: 'malformed' };

  const [tokenId, requestId, expiryStr] = segments;
  const expiry = parseInt(expiryStr, 10);
  if (!tokenId || !requestId || !Number.isFinite(expiry)) return { ok: false, reason: 'malformed' };

  if (Date.now() > expiry) return { ok: false, reason: 'expired' };

  return { ok: true, data: { tokenId, requestId, expiry } };
}
