// Signup token — HMAC-SHA256, self-describing.
//
// Token format:
//   base64url(JSON({ email, firmName, expiry, nonce, orgId?, kind? })) + "." +
//   base64url(HMAC-SHA256(payload, secret))
//
// JSON payload avoids colon-separator ambiguity with email/firmName values.
//
// SINGLE USE is Supabase's job, not this module's: lib/authLinks.ts redeems a
// Supabase recovery token, which can only be spent once. The Redis marker this
// module used to key (tokenRedisKey / tokenTtlSeconds) was removed 2026-09-09
// (W4-1) — nothing had written or read it since that move, and an Upstash
// rate-limit could stop an invitee from setting a password.
//
// `orgId` pins the invite to the organization that minted it, so accepting an
// invite can never re-home the account onto a different organization derived
// from the email domain. `kind` separates an invitation ('invite') from a
// password reset ('reset'); tokens minted before both fields existed verify as
// { kind: 'invite', orgId: null }.
//
// Secret: process.env.SIGNUP_TOKEN_SECRET (32+ characters, never logged).
//
// ROTATION: SIGNUP_TOKEN_SECRET_PREVIOUS, same rule, is honoured by
// verifySignupToken() only, while a rotation is in progress;
// generateSignupToken() always signs with the current secret. Invites live 24
// hours and reset links one hour, so the previous secret can be deleted a day
// after the rotation (08-key-rotation-runbook, section 4).

import { createHmac, createHash, randomBytes } from 'crypto';
import { constantTimeEqual } from './hmacToken';

const INVITE_EXPIRY_MS = 24 * 60 * 60 * 1000;
const RESET_EXPIRY_MS  = 60 * 60 * 1000;   // password reset links are short-lived
const SEP              = '.';
const NONCE_BYTES      = 16;

const MIN_SECRET_LENGTH = 32;

function usable(secret: string | undefined): string | null {
  return secret && secret.length >= MIN_SECRET_LENGTH ? secret : null;
}

/** The current secret, or a throw: nothing can be minted without it. */
function getSecret(): string {
  const s = usable(process.env.SIGNUP_TOKEN_SECRET);
  if (!s) throw new Error('[signupToken] SIGNUP_TOKEN_SECRET missing or too short');
  return s;
}

/**
 * The secrets a token may have been signed with: the current one, then the
 * previous one while a rotation is in progress. A previous secret that is
 * unset, too short, or the same as the current one adds nothing.
 */
function verificationSecrets(): string[] {
  const current  = getSecret();
  const previous = usable(process.env.SIGNUP_TOKEN_SECRET_PREVIOUS);
  return previous !== null && previous !== current ? [current, previous] : [current];
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** 'invite' creates/activates an account; 'reset' only replaces a password. */
export type SignupTokenKind = 'invite' | 'reset';

export interface SignupTokenResult {
  token:  string;  // full raw token — embedded in the invite link
  hash:   string;  // SHA-256(token) — stored in Redis for single-use enforcement
  expiry: number;  // unix ms
  kind:   SignupTokenKind;
}

export interface GenerateSignupTokenOptions {
  /** organizations.id (uuid) the invite belongs to. */
  orgId?: string;
  /** Defaults to 'invite'. */
  kind?:  SignupTokenKind;
}

export function generateSignupToken(
  email:    string,
  firmName: string,
  opts:     GenerateSignupTokenOptions = {},
): SignupTokenResult {
  const secret = getSecret();
  const kind   = opts.kind === 'reset' ? 'reset' : 'invite';
  const expiry = Date.now() + (kind === 'reset' ? RESET_EXPIRY_MS : INVITE_EXPIRY_MS);
  const nonce  = randomBytes(NONCE_BYTES).toString('hex');

  const payloadObj = {
    email,
    firmName,
    expiry,
    nonce,
    kind,
    ...(opts.orgId ? { orgId: opts.orgId } : {}),
  };

  const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  const sig     = createHmac('sha256', secret).update(payload).digest('base64url');
  const token   = `${payload}${SEP}${sig}`;

  return { token, hash: hashToken(token), expiry, kind };
}

export interface VerifySignupTokenResult {
  valid:    boolean;
  expired:  boolean;
  email:    string;
  firmName: string;
  /** null for legacy tokens minted before invites carried their organization. */
  orgId:    string | null;
  /** Legacy tokens (no `kind` in the payload) verify as 'invite'. */
  kind:     SignupTokenKind;
}

const INVALID: VerifySignupTokenResult =
  { valid: false, expired: false, email: '', firmName: '', orgId: null, kind: 'invite' };
const EXPIRED: VerifySignupTokenResult =
  { valid: false, expired: true,  email: '', firmName: '', orgId: null, kind: 'invite' };

interface RawPayload {
  email:     unknown;
  firmName:  unknown;
  expiry:    unknown;
  nonce:     unknown;
  orgId?:    unknown;
  kind?:     unknown;
}

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

  // Constant-time HMAC check against the current secret and, during a
  // rotation, the previous one. Every secret is checked; nothing short-circuits
  // on the first match, so the time taken does not depend on the token.
  let secrets: string[];
  try { secrets = verificationSecrets(); } catch { return INVALID; }

  let sigMatch = false;
  for (const secret of secrets) {
    const expectedSig = createHmac('sha256', secret).update(payloadB64).digest('base64url');
    if (constantTimeEqual(expectedSig, sigB64)) sigMatch = true;
  }
  if (!sigMatch) return INVALID;

  // Parse and validate payload
  let obj: RawPayload;
  try {
    obj = JSON.parse(payloadStr) as RawPayload;
  } catch {
    return INVALID;
  }

  if (typeof obj.email    !== 'string' || !obj.email)    return INVALID;
  if (typeof obj.firmName !== 'string' || !obj.firmName) return INVALID;
  if (typeof obj.expiry   !== 'number')                  return INVALID;

  // Backward compatibility: tokens minted before these fields existed are
  // organization-less invites.
  const kind: SignupTokenKind = obj.kind === 'reset' ? 'reset' : 'invite';
  if (obj.kind !== undefined && obj.kind !== 'reset' && obj.kind !== 'invite') return INVALID;
  const orgId = typeof obj.orgId === 'string' && obj.orgId ? obj.orgId : null;

  if (Date.now() > obj.expiry) return EXPIRED;

  return { valid: true, expired: false, email: obj.email, firmName: obj.firmName, orgId, kind };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
