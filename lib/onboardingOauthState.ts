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
// secret the expert availability OAuth flow uses. The signing, the verification
// and the constant-time compare are lib/hmacToken.ts (purpose
// 'onboarding-oauth'); this module owns the payload shape and the nonce check.
//
// Required env vars:
//   AVAILABILITY_TOKEN_SECRET — HMAC key for the state signature
//
// NEVER logs: the state value, the nonce, or the email.

import { constantTimeEqual, sign, verify } from './hmacToken';

export interface OnboardingOAuthState {
  email:    string;
  nonce:    string;
  timezone: string;
}

/**
 * Builds the signed state parameter. Throws if AVAILABILITY_TOKEN_SECRET is
 * unset — callers guard on env before reaching here.
 */
export function buildOnboardingOAuthState(state: OnboardingOAuthState): string {
  const payload = [
    encodeURIComponent(state.email),
    state.nonce,
    encodeURIComponent(state.timezone),
  ].join(':');

  return sign(payload, 'onboarding-oauth');
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
  const verified = verify(stateB64, 'onboarding-oauth');
  if (!verified.ok) return null;

  const parts = verified.payload.split(':');
  if (parts.length !== 3) return null;

  const [encEmail, nonce, encTimezone] = parts;

  // Nonce must match the one persisted at initiate time — blocks replay and
  // state-swap even against an attacker who somehow obtained a valid signature.
  if (!constantTimeEqual(storedNonce, nonce)) return null;

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
