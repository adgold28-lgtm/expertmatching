// Outreach reply token — HMAC-SHA256, single-use, project+expert scoped.
// Format: base64url(projectId:expertId:expiry:nonce).base64url(HMAC-SHA256)
// Secret: AVAILABILITY_TOKEN_SECRET (reuses same secret — same trust level)

import { createHmac, createHash, timingSafeEqual, randomBytes } from 'crypto';

const EXPIRY_MS   = 90 * 24 * 60 * 60 * 1000; // 90 days (covers full sequence)
const SEP         = '.';
const NONCE_BYTES = 16;

function toBase64url(s: string): string { return Buffer.from(s, 'utf8').toString('base64url'); }
function fromBase64url(s: string): string { return Buffer.from(s, 'base64url').toString('utf8'); }

function getSecret(): string {
  const s = process.env.AVAILABILITY_TOKEN_SECRET;
  if (!s || s.length < 32) throw new Error('[outreachToken] AVAILABILITY_TOKEN_SECRET missing or too short');
  return s;
}

export interface GeneratedOutreachToken {
  token:     string;
  tokenHash: string;
}

export function generateOutreachToken(projectId: string, expertId: string): GeneratedOutreachToken {
  const secret  = getSecret();
  const expiry  = Date.now() + EXPIRY_MS;
  const nonce   = randomBytes(NONCE_BYTES).toString('hex');
  const payload = toBase64url(`${projectId}:${expertId}:${expiry}:${nonce}`);
  const sig     = createHmac('sha256', secret).update(payload).digest('base64url');
  const token   = `${payload}${SEP}${sig}`;
  return { token, tokenHash: createHash('sha256').update(token, 'utf8').digest('hex') };
}

export function hashOutreachToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface VerifiedOutreachToken {
  projectId: string;
  expertId:  string;
}

export type OutreachVerifyResult =
  | { ok: true;  data: VerifiedOutreachToken }
  | { ok: false; reason: 'malformed' | 'expired' | 'invalid_signature' };

export function verifyOutreachToken(token: string): OutreachVerifyResult {
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
  if (segs.length !== 4) return { ok: false, reason: 'malformed' };
  const [projectId, expertId, expiryStr] = segs;
  const expiry = parseInt(expiryStr, 10);
  if (!projectId || !expertId || isNaN(expiry)) return { ok: false, reason: 'malformed' };
  if (Date.now() > expiry) return { ok: false, reason: 'expired' };
  return { ok: true, data: { projectId, expertId } };
}
