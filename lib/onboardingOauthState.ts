// lib/onboardingOauthState.ts — HMAC-signed OAuth `state` for the onboarding
// calendar flow (app/api/onboarding/calendar/google + .../google/callback).
//
// The state carries three things through Google's consent screen:
//   email  — who started the flow; the callback re-checks it against the live
//            session so a state minted for one user cannot land on another's row
//   nonce  — CSRF nonce, also persisted to user_calendar_connections.oauth_state
//            (Postgres, not a module variable — the callback can land on a
//            different Vercel lambda instance than the initiate request)
//   tz     — the browser's IANA timezone, captured on the initiate request so
//            the Google path records a timezone without a second round-trip
//
// Wire format: base64url(`${enc(email)}:${nonce}:${enc(tz)}.${hmac_sha256_hex}`)
// Parts are percent-encoded, so ':' and '.' inside an email or zone name cannot
// desynchronize the split. Signed with AVAILABILITY_TOKEN_SECRET, the same
// secret the expert availability OAuth flow uses.
//
// Required env vars:
//   AVAILABILITY_TOKEN_SECRET — HMAC key for the state signature
//
// NEVER logs: the state value, the nonce, or the email.

import { createHmac, timingSafeEqual } from 'crypto';

const STATE_SECRET_ENV = 'AVAILABILITY_TOKEN_SECRET';

export interface OnboardingOAuthState {
  email:    string;
  nonce:    string;
  timezone: string;
}

/** Constant-time string compare that tolerates differing lengths. */
function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * Builds the signed state parameter. Throws if AVAILABILITY_TOKEN_SECRET is
 * unset — callers guard on env before reaching here.
 */
export function buildOnboardingOAuthState(state: OnboardingOAuthState): string {
  const secret = process.env[STATE_SECRET_ENV];
  if (!secret) throw new Error('[onboarding-oauth-state] AVAILABILITY_TOKEN_SECRET not set');

  const payload = [
    encodeURIComponent(state.email),
    state.nonce,
    encodeURIComponent(state.timezone),
  ].join(':');

  const sig = createHmac('sha256', secret).update(payload).digest('hex');
  return Buffer.from(`${payload}.${sig}`, 'utf8').toString('base64url');
}

/**
 * Verifies the signature and the stored nonce, returning the decoded state or
 * null. Both comparisons are constant-time. `storedNonce` is the value the
 * initiate request wrote to user_calendar_connections.oauth_state.
 */
export function verifyOnboardingOAuthState(
  stateB64:    string,
  storedNonce: string,
): OnboardingOAuthState | null {
  const secret = process.env[STATE_SECRET_ENV];
  if (!secret) return null;

  let decoded: string;
  try {
    decoded = Buffer.from(stateB64, 'base64url').toString('utf8');
  } catch {
    return null;
  }

  const lastDot = decoded.lastIndexOf('.');
  if (lastDot < 0) return null;

  const payload   = decoded.slice(0, lastDot);
  const sigActual = decoded.slice(lastDot + 1);
  const sigExpect = createHmac('sha256', secret).update(payload).digest('hex');

  if (!safeEqual(sigExpect, sigActual)) return null;

  const parts = payload.split(':');
  if (parts.length !== 3) return null;

  const [encEmail, nonce, encTimezone] = parts;

  // Nonce must match the one persisted at initiate time — blocks replay and
  // state-swap even against an attacker who somehow obtained a valid signature.
  if (!safeEqual(storedNonce, nonce)) return null;

  try {
    return {
      email:    decodeURIComponent(encEmail),
      nonce,
      timezone: decodeURIComponent(encTimezone),
    };
  } catch {
    return null;
  }
}
