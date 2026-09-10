// Opt-out (unsubscribe) token — HMAC-SHA256, email-scoped, 1 year.
// Format: base64url(optout:base64url(email):expiry:nonce).base64url(HMAC-SHA256)
// Signing, verification and the constant-time compare live in lib/hmacToken.ts
// (purpose 'optout'); this module owns the payload shape and the expiry.
//
// The email is base64url-encoded inside the payload so a local-part containing
// the ":" separator can never split the payload the wrong way.
//
// Never logged: the token, the email it carries.

import { randomBytes } from 'crypto';
import { sign, verify } from './hmacToken';

const EXPIRY_MS   = 365 * 24 * 60 * 60 * 1000; // 1 year — footers outlive a project
const NONCE_BYTES = 16;
const PREFIX      = 'optout';

function toBase64url(s: string): string { return Buffer.from(s, 'utf8').toString('base64url'); }
function fromBase64url(s: string): string { return Buffer.from(s, 'base64url').toString('utf8'); }

export function generateOptOutToken(email: string): string {
  const expiry = Date.now() + EXPIRY_MS;
  const nonce  = randomBytes(NONCE_BYTES).toString('hex');
  return sign(`${PREFIX}:${toBase64url(email.trim().toLowerCase())}:${expiry}:${nonce}`, PREFIX);
}

export type OptOutVerifyResult =
  | { ok: true;  email: string }
  | { ok: false; reason: 'malformed' | 'expired' | 'invalid_signature' };

export function verifyOptOutToken(token: string): OptOutVerifyResult {
  const verified = verify(token, PREFIX);
  if (!verified.ok) return { ok: false, reason: verified.reason };

  const segs = verified.payload.split(':');
  if (segs.length !== 4 || segs[0] !== PREFIX) return { ok: false, reason: 'malformed' };

  let email: string;
  try { email = fromBase64url(segs[1]); } catch { return { ok: false, reason: 'malformed' }; }

  const expiry = parseInt(segs[2], 10);
  if (!email.includes('@') || isNaN(expiry)) return { ok: false, reason: 'malformed' };
  if (Date.now() > expiry) return { ok: false, reason: 'expired' };

  return { ok: true, email: email.trim().toLowerCase() };
}
