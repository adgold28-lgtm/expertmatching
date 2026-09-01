// GET /api/onboarding/calendar/google — start the per-user Google Calendar link.
//
// Session-authenticated (routeAuthGuard), unlike the expert availability OAuth
// flow which is gated by a signed token. It lives under /api/onboarding/ on
// purpose: middleware.ts only lets a not-yet-onboarded user reach /onboarding*,
// /api/onboarding*, and /api/auth/logout, so a callback anywhere else would be
// swallowed by the onboarding gate before the authorization code arrived.
//
// Flow:
//   1. Mint a CSRF nonce and persist it to user_calendar_connections.oauth_state
//      (Postgres — the callback may run on a different lambda instance)
//   2. Sign {email, nonce, tz} into the OAuth `state` with AVAILABILITY_TOKEN_SECRET
//   3. 302 to Google with access_type=offline&prompt=consent so a refresh token
//      is always issued
//
// Timezone capture: the browser passes its IANA zone as ?tz=America/New_York.
// It rides inside the signed state and is written by the callback, so the Google
// path needs no follow-up PATCH. Invalid or absent → the connection records no
// timezone and the scheduler falls back to the slots' own zone.
//
// Scopes: calendar.freebusy + openid + email. The `email` scope is required for
// the userinfo call in the callback to return the linked account's address —
// the expert flow requests freebusy only, which is why its calendar_email is
// unreliable. Do not copy that scope list here.
//
// Required env vars:
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET  — OAuth 2.0 client
//   AVAILABILITY_TOKEN_SECRET               — HMAC key for the state signature
//   NEXT_PUBLIC_APP_URL                     — base URL for the redirect URI
//
// Redirect URI to register in Google Cloud Console:
//   ${NEXT_PUBLIC_APP_URL}/api/onboarding/calendar/google/callback
//
// NEVER logs: email addresses, the nonce, or the state value.

import { randomBytes } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { routeAuthGuard, getSessionUser } from '../../../../../lib/auth';
import { setOauthState, normalizeTimezone } from '../../../../../lib/calendarConnections';
import { buildOnboardingOAuthState } from '../../../../../lib/onboardingOauthState';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const SCOPES          = 'https://www.googleapis.com/auth/calendar.freebusy openid email';

export async function GET(request: NextRequest): Promise<Response> {
  // Defense in depth — middleware already requires a session on this path.
  const authError = await routeAuthGuard(request);
  if (authError) return authError;

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? request.nextUrl.origin;

  const errorRedirect = (code: string): NextResponse =>
    NextResponse.redirect(new URL(`/onboarding?calendar_error=${code}`, appUrl));

  // ── Env guard ─────────────────────────────────────────────────────────────
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId || !process.env.GOOGLE_CLIENT_SECRET) {
    console.error('[onboarding/calendar/google] Google OAuth credentials not configured');
    return errorRedirect('oauth_not_configured');
  }
  if (!process.env.AVAILABILITY_TOKEN_SECRET) {
    console.error('[onboarding/calendar/google] AVAILABILITY_TOKEN_SECRET not configured');
    return errorRedirect('oauth_not_configured');
  }

  // ── Session ───────────────────────────────────────────────────────────────
  const sessionUser = await getSessionUser(request);
  if (!sessionUser.email) return errorRedirect('unauthorized');

  // ── State + nonce ─────────────────────────────────────────────────────────
  const nonce    = randomBytes(16).toString('hex');
  const timezone = normalizeTimezone(request.nextUrl.searchParams.get('tz')) ?? '';

  let state: string;
  try {
    state = buildOnboardingOAuthState({ email: sessionUser.email, nonce, timezone });
  } catch (err) {
    console.error('[onboarding/calendar/google] state build failed:',
      err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return errorRedirect('server_error');
  }

  // Persist the nonce before redirecting — a partial write that preserves any
  // existing Calendly/manual connection if the user abandons Google's consent.
  const stored = await setOauthState(sessionUser.email, nonce);
  if (!stored) {
    console.error('[onboarding/calendar/google] failed to persist oauth state');
    return errorRedirect('server_error');
  }

  // ── Redirect to Google ────────────────────────────────────────────────────
  const googleUrl = new URL(GOOGLE_AUTH_URL);
  googleUrl.searchParams.set('client_id',     clientId);
  googleUrl.searchParams.set('redirect_uri',  `${appUrl}/api/onboarding/calendar/google/callback`);
  googleUrl.searchParams.set('response_type', 'code');
  googleUrl.searchParams.set('scope',         SCOPES);
  googleUrl.searchParams.set('access_type',   'offline');
  googleUrl.searchParams.set('prompt',        'consent');
  googleUrl.searchParams.set('state',         state);

  return NextResponse.redirect(googleUrl.toString());
}
