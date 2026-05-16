// Signup token — HMAC-SHA256, self-describing, single-use.
//
// Token format:
//   base64url(JSON({ email, firmName, expiry, nonce })) + "." + base64url(HMAC-SHA256(payload, secret))
//
// JSON payload avoids colon-separator ambiguity with email/firmName values.
// Single-use enforcement: SHA-256(rawToken) stored in Redis under signup-token:[hash].
// The hash is stored at generation time (by the caller) and deleted on use.
//
// Secret: process.env.SIGNUP_TOKEN_SECRET (32+ hex bytes, never logged)

import { createHmac, createHash, timingSafeEqual, randomBytes } from 'crypto';

const EXPIRY_MS   = 7 * 24 * 60 * 60 * 1000;
const SEP         = '.';
const NONCE_BYTES = 16;

function getSecret(): string {
  const s = process.env.SIGNUP_TOKEN_SECRET;
  if (!s || s.length < 32) throw new Error('[signupToken] SIGNUP_TOKEN_SECRET missing or too short');
  return s;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface SignupTokenResult {
  token:  string;  // full raw token — embedded in the invite link
  hash:   string;  // SHA-256(token) — stored in Redis for single-use enforcement
  expiry: number;  // unix ms
}

export function generateSignupToken(email: string, firmName: string): SignupTokenResult {
  const secret     = getSecret();
  const expiry     = Date.now() + EXPIRY_MS;
  const nonce      = randomBytes(NONCE_BYTES).toString('hex');
  const payloadObj = { email, firmName, expiry, nonce };
  const payload    = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  const sig        = createHmac('sha256', secret).update(payload).digest('base64url');
  const token      = `${payload}${SEP}${sig}`;

  return { token, hash: hashToken(token), expiry };
}

export interface VerifySignupTokenResult {
  valid:    boolean;
  expired:  boolean;
  email:    string;
  firmName: string;
}

const INVALID = { valid: false, expired: false, email: '', firmName: '' } as const;
const EXPIRED = { valid: false, expired: true,  email: '', firmName: '' } as const;

export function verifySignupToken(token: string): VerifySignupTokenResult {
  const parts = token.split(SEP);
  if (parts.length !== 2) return INVALID;

  const [payloadB64, sigB64] = parts;

  // Decode payload
  let payloadStr: string;
  try {
    payloadStr = Buffer.from(payloadB64, 'base64url').toString('utf8');
  } catch {
    return INVALID;
  }

  // Constant-time HMAC check
  let secret: string;
  try { secret = getSecret(); } catch { return INVALID; }

  const expectedSig = createHmac('sha256', secret).update(payloadB64).digest('base64url');
  const expectedBuf = Buffer.from(expectedSig, 'utf8');
  const actualBuf   = Buffer.from(sigB64,      'utf8');
  // Pad to equal length to prevent length oracle; always run comparison
  const paddedActual = actualBuf.length === expectedBuf.length
    ? actualBuf
    : Buffer.concat([actualBuf, Buffer.alloc(Math.max(0, expectedBuf.length - actualBuf.length))]);
  const sigMatch = timingSafeEqual(expectedBuf, paddedActual) && actualBuf.length === expectedBuf.length;
  if (!sigMatch) return INVALID;

  // Parse and validate payload
  let obj: { email: string; firmName: string; expiry: number; nonce: string };
  try {
    obj = JSON.parse(payloadStr);
    if (typeof obj.email !== 'string' || !obj.email) return INVALID;
    if (typeof obj.firmName !== 'string' || !obj.firmName) return INVALID;
    if (typeof obj.expiry !== 'number') return INVALID;
  } catch {
    return INVALID;
  }

  if (Date.now() > obj.expiry) return EXPIRED;

  return { valid: true, expired: false, email: obj.email, firmName: obj.firmName };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
