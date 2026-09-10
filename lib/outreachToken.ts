// Outreach reply token — HMAC-SHA256, single-use, project+expert scoped.
// Format: base64url(projectId:expertId:expiry:nonce).base64url(HMAC-SHA256)
// Signing, verification and the constant-time compare live in lib/hmacToken.ts
// (purpose 'outreach'); this module owns the payload shape and the expiry.

import { createHash, randomBytes } from 'crypto';
import { sign, verify } from './hmacToken';

const EXPIRY_MS   = 90 * 24 * 60 * 60 * 1000; // 90 days (covers full sequence)
const NONCE_BYTES = 16;

export interface GeneratedOutreachToken {
  token:     string;
  tokenHash: string;
}

export function generateOutreachToken(projectId: string, expertId: string): GeneratedOutreachToken {
  const expiry = Date.now() + EXPIRY_MS;
  const nonce  = randomBytes(NONCE_BYTES).toString('hex');
  const token  = sign(`${projectId}:${expertId}:${expiry}:${nonce}`, 'outreach');
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
  const verified = verify(token, 'outreach');
  if (!verified.ok) return { ok: false, reason: verified.reason };

  const segs = verified.payload.split(':');
  if (segs.length !== 4) return { ok: false, reason: 'malformed' };
  const [projectId, expertId, expiryStr] = segs;
  const expiry = parseInt(expiryStr, 10);
  if (!projectId || !expertId || isNaN(expiry)) return { ok: false, reason: 'malformed' };
  if (Date.now() > expiry) return { ok: false, reason: 'expired' };
  return { ok: true, data: { projectId, expertId } };
}
