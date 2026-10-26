// lib/hmacToken.ts — the one HMAC-SHA256 sign / verify pair, and the one
// constant-time compare, behind every signed token this product mints
// (audit M-11, M-49).
//
// Six callers, two wire formats, one secret (AVAILABILITY_TOKEN_SECRET):
//
//   purpose             wire format                                   caller
//   ──────────────────  ────────────────────────────────────────────  ─────────────────────────────
//   'optout'            b64url(payload) "." b64url(hmac)              lib/optOutToken.ts
//   'outreach'          b64url(payload) "." b64url(hmac)              lib/outreachToken.ts
//   'availability'      b64url(payload) "." b64url(hmac)              lib/availabilityToken.ts
//   'screening'         b64url(payload) "." b64url(hmac)              lib/screeningToken.ts
//   'onboarding-oauth'  b64url(payload "." hex(hmac))                 lib/onboardingOauthState.ts
//   'expert-oauth'      b64url(payload "." hex(hmac))                 app/api/availability/[token]/google-auth
//                                                                     app/api/availability/oauth/google/callback
//
// THE FORMATS ARE FROZEN. Opt-out links live in email footers for a year,
// outreach reply tokens for 90 days, availability picker links for 7 days,
// screening links until their request's deadline (up to 90 days), and an OAuth
// state can be mid-consent in someone's browser. Anything that changes
// the bytes invalidates tokens already in the wild. scripts/test-hmac-tokens.ts
// holds fixtures minted by the pre-consolidation code and asserts they still
// verify; if you change anything here, that script must stay green.
//
// ROTATION. AVAILABILITY_TOKEN_SECRET_PREVIOUS, set only while a rotation is
// in progress, is a second secret that verify() accepts and sign() never uses.
// To rotate (08-key-rotation-runbook, section 4): move today's secret into
// AVAILABILITY_TOKEN_SECRET_PREVIOUS, put a fresh `openssl rand -hex 32` in
// AVAILABILITY_TOKEN_SECRET, deploy. New tokens carry the new secret from the
// first request; tokens already in the wild keep verifying under the old one.
// Delete the previous secret only once the longest-lived token signed under it
// is dead: opt-out links live a year, so plan on keeping it for twelve months.
// Deleting it earlier kills every outstanding opt-out, outreach, availability
// and screening link at once. A previous secret shorter than a purpose's
// minimum is ignored for that purpose, exactly as if it were unset.
//
// WHAT THIS MODULE DOES NOT DO: payload shapes, expiry policy and revocation
// stay in the calling module. This one signs a string and tells you whether a
// token's signature is good, nothing more.
//
// NEVER LOGS: the secret, the payload, the token.

import { createHmac, timingSafeEqual } from 'crypto';

const SECRET_ENV          = 'AVAILABILITY_TOKEN_SECRET';
const PREVIOUS_SECRET_ENV = 'AVAILABILITY_TOKEN_SECRET_PREVIOUS';
const SEP                 = '.';

export type TokenPurpose =
  | 'optout'
  | 'outreach'
  | 'availability'
  | 'screening'
  | 'onboarding-oauth'
  | 'expert-oauth'
  | 'payout';

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
  /** The four token modules refuse a short secret; the two state builders never did. */
  minSecretLength: number;
  /**
   * Sign under a key DERIVED from the shared secret and the purpose name
   * instead of the raw secret. The six original purposes share one raw key and
   * three of them share one payload shape, so their separation is by payload
   * convention only; their tokens are in the wild and cannot move. A purpose
   * added later has no legacy tokens, so it gets a key of its own at zero
   * migration cost: a token signed for any other purpose can never verify as
   * it, whatever its payload looks like.
   */
  derivedKey?: true;
}

const PROFILES: Record<TokenPurpose, Profile> = {
  'optout':           { style: 'detached', digest: 'base64url', minSecretLength: 32 },
  'outreach':         { style: 'detached', digest: 'base64url', minSecretLength: 32 },
  'availability':     { style: 'detached', digest: 'base64url', minSecretLength: 32 },
  'screening':        { style: 'detached', digest: 'base64url', minSecretLength: 32 },
  'payout':           { style: 'detached', digest: 'base64url', minSecretLength: 32, derivedKey: true },
  'onboarding-oauth': { style: 'wrapped',  digest: 'hex',       minSecretLength: 1  },
  'expert-oauth':     { style: 'wrapped',  digest: 'hex',       minSecretLength: 1  },
};

/** The current secret, or a throw: sign() has nothing to sign with without it. */
function getSecret(purpose: TokenPurpose): string {
  const profile = PROFILES[purpose];
  const secret  = process.env.AVAILABILITY_TOKEN_SECRET;
  if (!secret || secret.length < profile.minSecretLength) {
    throw new Error(`[hmacToken:${purpose}] ${SECRET_ENV} missing or too short`);
  }
  return secret;
}

/** The previous secret while a rotation is in progress, otherwise null. Too short for the purpose counts as absent. */
function getPreviousSecret(purpose: TokenPurpose): string | null {
  const secret = process.env.AVAILABILITY_TOKEN_SECRET_PREVIOUS;
  if (!secret || secret.length < PROFILES[purpose].minSecretLength) return null;
  return secret;
}

/** The key a purpose signs with under one secret: the secret itself, or one derived for it. */
function keyFrom(secret: string, purpose: TokenPurpose): string | Buffer {
  if (!PROFILES[purpose].derivedKey) return secret;
  return createHmac('sha256', secret).update(`purpose:${purpose}`).digest();
}

/**
 * The keys a token may carry a signature under: the current secret's, then
 * the previous secret's while a rotation is in progress. Throws when the
 * current secret is unusable, whatever the previous one says — a deployment
 * cannot run on its old secret alone.
 */
function verificationKeys(purpose: TokenPurpose): Array<string | Buffer> {
  const current  = getSecret(purpose);
  const previous = getPreviousSecret(purpose);
  const keys     = [keyFrom(current, purpose)];
  if (previous !== null && previous !== current) keys.push(keyFrom(previous, purpose));
  return keys;
}

function digestOf(payload: string, secret: string | Buffer, profile: Profile): string {
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
 * Whether `signature` is the digest of `payload` under ANY of `keys`. Every
 * key is checked and each check is constant-time; nothing short-circuits on
 * the first match, so the time taken does not depend on the token at all.
 */
function signedByAny(payload: string, signature: string, keys: Array<string | Buffer>, profile: Profile): boolean {
  let matched = false;
  for (const key of keys) {
    if (constantTimeEqual(digestOf(payload, key, profile), signature)) matched = true;
  }
  return matched;
}

/**
 * Sign a payload for one purpose and return the token in that purpose's wire
 * format, always under the CURRENT secret. Throws when the secret is missing
 * or shorter than the purpose requires — every caller either guards on the
 * environment first or lets the throw surface.
 */
export function sign(payload: string, purpose: TokenPurpose): string {
  const profile = PROFILES[purpose];
  const secret  = keyFrom(getSecret(purpose), purpose);

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
 * token. During a rotation a signature under the previous secret is as good as
 * one under the current secret.
 */
export function verify(token: string, purpose: TokenPurpose): HmacVerifyResult {
  const profile = PROFILES[purpose];

  let keys: Array<string | Buffer>;
  try { keys = verificationKeys(purpose); } catch { return { ok: false, reason: 'invalid_signature' }; }

  if (profile.style === 'detached') {
    const parts = token.split(SEP);
    if (parts.length !== 2) return { ok: false, reason: 'malformed' };
    const [encoded, signature] = parts;

    if (!signedByAny(encoded, signature, keys, profile)) {
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
  if (!signedByAny(payload, signature, keys, profile)) {
    return { ok: false, reason: 'invalid_signature' };
  }
  return { ok: true, payload };
}
