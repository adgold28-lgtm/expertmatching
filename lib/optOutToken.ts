// Opt-out (unsubscribe) token — HMAC-SHA256, email-scoped, 1 year.
// Format: base64url(optout:base64url(email):expiry:nonce).base64url(HMAC-SHA256)
// Secret: AVAILABILITY_TOKEN_SECRET (same construction as lib/outreachToken.ts)
//
// The email is base64url-encoded inside the payload so a local-part containing
// the ":" separator can never split the payload the wrong way.
//
// Never logged: the token, the email it carries.

import { createHmac, timingSafeEqual, randomBytes } from 'crypto';

const EXPIRY_MS   = 365 * 24 * 60 * 60 * 1000; // 1 year — footers outlive a project
const SEP         = '.';
const NONCE_BYTES = 16;
const PREFIX      = 'optout';

function toBase64url(s: string): string { return Buffer.from(s, 'utf8').toString('base64url'); }
function fromBase64url(s: string): string { return Buffer.from(s, 'base64url').toString('utf8'); }

function getSecret(): string {
  const s = process.env.AVAILABILITY_TOKEN_SECRET;
  if (!s || s.length < 32) throw new Error('[optOutToken] AVAILABILITY_TOKEN_SECRET missing or too short');
  return s;
}

export function generateOptOutToken(email: string): string {
  const secret  = getSecret();
  const expiry  = Date.now() + EXPIRY_MS;
  const nonce   = randomBytes(NONCE_BYTES).toString('hex');
  const payload = toBase64url(`${PREFIX}:${toBase64url(email.trim().toLowerCase())}:${expiry}:${nonce}`);
  const sig     = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}${SEP}${sig}`;
}

export type OptOutVerifyResult =
  | { ok: true;  email: string }
  | { ok: false; reason: 'malformed' | 'expired' | 'invalid_signature' };

export function verifyOptOutToken(token: string): OptOutVerifyResult {
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

  const segs = raw.split(':');
  if (segs.length !== 4 || segs[0] !== PREFIX) return { ok: false, reason: 'malformed' };

  let email: string;
  try { email = fromBase64url(segs[1]); } catch { return { ok: false, reason: 'malformed' }; }

  const expiry = parseInt(segs[2], 10);
  if (!email.includes('@') || isNaN(expiry)) return { ok: false, reason: 'malformed' };
  if (Date.now() > expiry) return { ok: false, reason: 'expired' };

  return { ok: true, email: email.trim().toLowerCase() };
}
