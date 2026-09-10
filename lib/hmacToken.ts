// lib/hmacToken.ts — the one HMAC-SHA256 sign / verify pair, and the one
// constant-time compare, behind every signed token this product mints
// (audit M-11, M-49).
//
// Five callers, two wire formats, one secret (AVAILABILITY_TOKEN_SECRET):
//
//   purpose             wire format                                   caller
//   ──────────────────  ────────────────────────────────────────────  ─────────────────────────────
//   'optout'            b64url(payload) "." b64url(hmac)              lib/optOutToken.ts
//   'outreach'          b64url(payload) "." b64url(hmac)              lib/outreachToken.ts
//   'availability'      b64url(payload) "." b64url(hmac)              lib/availabilityToken.ts
//   'onboarding-oauth'  b64url(payload "." hex(hmac))                 lib/onboardingOauthState.ts
//   'expert-oauth'      b64url(payload "." hex(hmac))                 app/api/availability/[token]/google-auth
//                                                                     app/api/availability/oauth/google/callback
//
// THE FORMATS ARE FROZEN. Opt-out links live in email footers for a year,
// outreach reply tokens for 90 days, availability picker links for 7 days, and
// an OAuth state can be mid-consent in someone's browser. Anything that changes
// the bytes invalidates tokens already in the wild. scripts/test-hmac-tokens.ts
// holds fixtures minted by the pre-consolidation code and asserts they still
// verify; if you change anything here, that script must stay green.
//
// WHAT THIS MODULE DOES NOT DO: payload shapes, expiry policy and revocation
// stay in the calling module. This one signs a string and tells you whether a
// token's signature is good, nothing more.
//
// NEVER LOGS: the secret, the payload, the token.

import { createHmac, timingSafeEqual } from 'crypto';

const SECRET_ENV = 'AVAILABILITY_TOKEN_SECRET';
const SEP        = '.';

export type TokenPurpose =
  | 'optout'
  | 'outreach'
  | 'availability'
  | 'onboarding-oauth'
  | 'expert-oauth';

export type HmacVerifyResult =
  | { ok: true;  payload: string }
  | { ok: false; reason: 'malformed' | 'invalid_signature' };

interface Profile {
  /**
   * 'detached' — the payload is base64url-encoded, the signature is a separate
   *   base64url segment after a dot, and the HMAC covers the ENCODED payload.
   * 'wrapped'  — payload and a hex signature are joined by a dot and the whole
   *   string is base64url-encoded; the HMAC covers the RAW payload.
   */
  style:  'detached' | 'wrapped';
  digest: 'base64url' | 'hex';
  /** The three token modules refuse a short secret; the two state builders never did. */
  minSecretLength: number;
}

const PROFILES: Record<TokenPurpose, Profile> = {
  'optout':           { style: 'detached', digest: 'base64url', minSecretLength: 32 },
  'outreach':         { style: 'detached', digest: 'base64url', minSecretLength: 32 },
  'availability':     { style: 'detached', digest: 'base64url', minSecretLength: 32 },
  'onboarding-oauth': { style: 'wrapped',  digest: 'hex',       minSecretLength: 1  },
  'expert-oauth':     { style: 'wrapped',  digest: 'hex',       minSecretLength: 1  },
};

function getSecret(purpose: TokenPurpose): string {
  const profile = PROFILES[purpose];
  const secret  = process.env[SECRET_ENV];
  if (!secret || secret.length < profile.minSecretLength) {
    throw new Error(`[hmacToken:${purpose}] ${SECRET_ENV} missing or too short`);
  }
  return secret;
}

function digestOf(payload: string, secret: string, profile: Profile): string {
  return createHmac('sha256', secret).update(payload).digest(profile.digest);
}

/**
 * Constant-time string comparison. Buffers of differing length cannot be handed
 * to timingSafeEqual, so the shorter side is zero-padded and the comparison
 * always runs; the length check is folded into the result afterwards, never
 * short-circuited before it.
 */
export function constantTimeEqual(expected: string, actual: string): boolean {
  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf   = Buffer.from(actual,   'utf8');
  const padded = actualBuf.length === expectedBuf.length
    ? actualBuf
    : Buffer.concat([actualBuf, Buffer.alloc(Math.max(0, expectedBuf.length - actualBuf.length))]).subarray(0, expectedBuf.length);
  return timingSafeEqual(expectedBuf, padded) && actualBuf.length === expectedBuf.length;
}

/**
 * Sign a payload for one purpose and return the token in that purpose's wire
 * format. Throws when the secret is missing or shorter than the purpose
 * requires — every caller either guards on the environment first or lets the
 * throw surface.
 */
export function sign(payload: string, purpose: TokenPurpose): string {
  const profile = PROFILES[purpose];
  const secret  = getSecret(purpose);

  if (profile.style === 'detached') {
    const encoded = Buffer.from(payload, 'utf8').toString('base64url');
    return `${encoded}${SEP}${digestOf(encoded, secret, profile)}`;
  }
  return Buffer.from(`${payload}${SEP}${digestOf(payload, secret, profile)}`, 'utf8').toString('base64url');
}

/**
 * Verify a token's structure and signature and hand back the raw payload. The
 * caller parses the payload and enforces its own expiry, nonce and revocation
 * rules. A missing or unusable secret is reported as 'invalid_signature', which
 * is what all five callers did before they shared this module: fail closed, and
 * never let the failure mode distinguish a configuration problem from a forged
 * token.
 */
export function verify(token: string, purpose: TokenPurpose): HmacVerifyResult {
  const profile = PROFILES[purpose];

  let secret: string;
  try { secret = getSecret(purpose); } catch { return { ok: false, reason: 'invalid_signature' }; }

  if (profile.style === 'detached') {
    const parts = token.split(SEP);
    if (parts.length !== 2) return { ok: false, reason: 'malformed' };
    const [encoded, signature] = parts;

    if (!constantTimeEqual(digestOf(encoded, secret, profile), signature)) {
      return { ok: false, reason: 'invalid_signature' };
    }

    let payload: string;
    try { payload = Buffer.from(encoded, 'base64url').toString('utf8'); }
    catch { return { ok: false, reason: 'malformed' }; }
    return { ok: true, payload };
  }

  let decoded: string;
  try { decoded = Buffer.from(token, 'base64url').toString('utf8'); }
  catch { return { ok: false, reason: 'malformed' }; }

  // The signature is hex, so it contains no dot; anything before the LAST dot is
  // payload, and a payload may contain dots of its own.
  const lastDot = decoded.lastIndexOf(SEP);
  if (lastDot < 0) return { ok: false, reason: 'malformed' };

  const payload   = decoded.slice(0, lastDot);
  const signature = decoded.slice(lastDot + 1);
  if (!constantTimeEqual(digestOf(payload, secret, profile), signature)) {
    return { ok: false, reason: 'invalid_signature' };
  }
  return { ok: true, payload };
}
