// Unsubscribe token — HMAC-SHA256, email-scoped, 3-year expiry.
// Format: base64url(normalizedEmail:expiry:nonce).base64url(HMAC-SHA256)
// Reuses AVAILABILITY_TOKEN_SECRET (same trust level as outreach tokens).

import { createHmac, timingSafeEqual, randomBytes } from 'crypto';

const EXPIRY_MS   = 3 * 365 * 24 * 60 * 60 * 1000; // 3 years
const SEP         = '.';
const NONCE_BYTES = 16;

function toBase64url(s: string): string { return Buffer.from(s, 'utf8').toString('base64url'); }
function fromBase64url(s: string): string { return Buffer.from(s, 'base64url').toString('utf8'); }

function getSecret(): string {
  const s = process.env.AVAILABILITY_TOKEN_SECRET;
  if (!s || s.length < 32) throw new Error('[unsubscribeToken] AVAILABILITY_TOKEN_SECRET missing or too short');
  return s;
}

export function generateUnsubscribeToken(email: string): string {
  const secret  = getSecret();
  const expiry  = Date.now() + EXPIRY_MS;
  const nonce   = randomBytes(NONCE_BYTES).toString('hex');
  const normalized = email.toLowerCase().trim();
  const payload = toBase64url(`${normalized}:${expiry}:${nonce}`);
  const sig     = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}${SEP}${sig}`;
}

export type UnsubscribeVerifyResult =
  | { ok: true;  email: string }
  | { ok: false; reason: 'malformed' | 'expired' | 'invalid_signature' };

export function verifyUnsubscribeToken(token: string): UnsubscribeVerifyResult {
  const parts = token.split(SEP);
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };
  const [payloadB64, sigB64] = parts;
  let raw: string;
  try { raw = fromBase64url(payloadB64); } catch { return { ok: false, reason: 'malformed' }; }
  let secret: string;
  try { secret = getSecret(); } catch { return { ok: false, reason: 'invalid_signature' }; }
  const expectedSig = createHmac('sha256', secret).update(payloadB64).digest('base64url');
  const expectedBuf = Buffer.from(expectedSig, 'utf8');
  const actualBuf   = Buffer.from(sigB64, 'utf8');
  const padded      = actualBuf.length === expectedBuf.length ? actualBuf
    : Buffer.concat([actualBuf, Buffer.alloc(Math.max(0, expectedBuf.length - actualBuf.length))]);
  const match = timingSafeEqual(expectedBuf, padded) && actualBuf.length === expectedBuf.length;
  if (!match) return { ok: false, reason: 'invalid_signature' };
  // payload is normalizedEmail:expiry:nonce — email cannot contain ':'
  const firstColon  = raw.indexOf(':');
  const secondColon = raw.indexOf(':', firstColon + 1);
  if (firstColon === -1 || secondColon === -1) return { ok: false, reason: 'malformed' };
  const email     = raw.slice(0, firstColon);
  const expiryStr = raw.slice(firstColon + 1, secondColon);
  const expiry    = parseInt(expiryStr, 10);
  if (!email || isNaN(expiry)) return { ok: false, reason: 'malformed' };
  if (Date.now() > expiry) return { ok: false, reason: 'expired' };
  return { ok: true, email };
}
