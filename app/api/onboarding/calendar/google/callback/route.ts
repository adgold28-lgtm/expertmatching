// GET /api/onboarding/calendar/google/callback?code=...&state=...
//
// Completes the per-user Google Calendar link started by
// GET /api/onboarding/calendar/google. Session-authenticated; lives under
// /api/onboarding/ so middleware's onboarding gate lets the authorization code
// through (see the initiate route's header).
//
// Flow:
//   1. Read the session, then the caller's own connection row for the stored nonce
//   2. Verify the state HMAC + nonce (constant-time) and that the state's email
//      matches the live session — a state minted for one user can never write
//      another user's row
//   3. Exchange the code for tokens (8s timeout), read the account email via
//      userinfo (the `email` scope is requested for exactly this)
//   4. Encrypt both tokens immediately and replace the connection row,
//      clearing oauth_state so the nonce is single-use
//
// Redirects (never JSON — this is a browser navigation from Google):
//   success → /onboarding?calendar=connected
//   failure → /onboarding?calendar_error=<code>
//
// Required env vars:
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET
//   AVAILABILITY_TOKEN_SECRET  — HMAC key for the state signature
//   ENCRYPTION_KEY             — 64 hex chars (AES-256-GCM key)
//   NEXT_PUBLIC_APP_URL        — base URL for redirect URI construction
//
// NEVER logs: tokens (plaintext or ciphertext), email addresses, the nonce.

import { NextRequest, NextResponse } from 'next/server';
import { routeAuthGuard, getSessionUser } from '../../../../../../lib/auth';
import {
  getCalendarConnection,
  upsertCalendarConnection,
  normalizeTimezone,
} from '../../../../../../lib/calendarConnections';
import { verifyOnboardingOAuthState } from '../../../../../../lib/onboardingOauthState';
import { encrypt } from '../../../../../../lib/encryption';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL     = 'https://www.googleapis.com/oauth2/v3/userinfo';

// ─── Google calls ─────────────────────────────────────────────────────────────

interface TokenResponse {
  access_token:   string;
  refresh_token?: string;
  expires_in?:    number;
  token_type?:    string;
}

async function exchangeCode(code: string, redirectUri: string): Promise<TokenResponse> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      code,
      client_id:     process.env.GOOGLE_CLIENT_ID     ?? '',
      client_secret: process.env.GOOGLE_CLIENT_SECRET ?? '',
      redirect_uri:  redirectUri,
      grant_type:    'authorization_code',
    }),
    signal: AbortSignal.timeout(8_000),
  });

  if (!res.ok) {
    // Google's error bodies carry no user data, but keep them short anyway.
    const body = await res.text().catch(() => '');
    throw new Error(`token exchange failed: ${res.status} ${body.slice(0, 120)}`);
  }

  return res.json() as Promise<TokenResponse>;
}

/** Reads the linked account's address. Returns null on any failure. */
async function fetchAccountEmail(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal:  AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { email?: string };
    return typeof data.email === 'string' && data.email ? data.email : null;
  } catch {
    return null;
  }
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function GET(request: NextRequest): Promise<Response> {
  const authError = await routeAuthGuard(request);
  if (authError) return authError;

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? request.nextUrl.origin;

  const errorRedirect = (code: string): NextResponse =>
    NextResponse.redirect(new URL(`/onboarding?calendar_error=${code}`, appUrl));

  // ── Env guard ─────────────────────────────────────────────────────────────
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    console.error('[onboarding/calendar/google/callback] Google OAuth credentials not configured');
    return errorRedirect('oauth_not_configured');
  }

  // ── Query params ──────────────────────────────────────────────────────────
  const { searchParams } = request.nextUrl;
  const code       = searchParams.get('code');
  const state      = searchParams.get('state');
  const googleErr  = searchParams.get('error');

  if (googleErr) {
    // Consent declined, or Google refused the request.
    console.log('[onboarding/calendar/google/callback] oauth error from Google:', googleErr.slice(0, 120));
    return errorRedirect('access_denied');
  }
  if (!code || !state) return errorRedirect('invalid_callback');

  // ── Session ───────────────────────────────────────────────────────────────
  const sessionUser = await getSessionUser(request);
  if (!sessionUser.email) return errorRedirect('unauthorized');

  // ── Stored nonce (read from the CALLER's row, never from the state) ───────
  const existing = await getCalendarConnection(sessionUser.email);
  if (!existing?.oauth_state) return errorRedirect('invalid_state');

  const verified = verifyOnboardingOAuthState(state, existing.oauth_state);
  if (!verified) {
    console.warn('[onboarding/calendar/google/callback] state verification failed');
    return errorRedirect('invalid_state');
  }

  // The signed email must be the live session's — blocks a state minted in one
  // session from completing in another.
  if (verified.email.toLowerCase().trim() !== sessionUser.email.toLowerCase().trim()) {
    console.warn('[onboarding/calendar/google/callback] state/session identity mismatch');
    return errorRedirect('session_mismatch');
  }

  // ── Exchange the authorization code ───────────────────────────────────────
  let tokens: TokenResponse;
  try {
    tokens = await exchangeCode(code, `${appUrl}/api/onboarding/calendar/google/callback`);
  } catch (err) {
    console.error('[onboarding/calendar/google/callback] token exchange error:',
      err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return errorRedirect('token_exchange_failed');
  }

  // ── Account email (userinfo) ──────────────────────────────────────────────
  const accountEmail = await fetchAccountEmail(tokens.access_token);

  // ── Encrypt immediately ───────────────────────────────────────────────────
  // prompt=consent should always return a refresh token; if Google omits it
  // (re-consent edge case), keep the ciphertext already on file rather than
  // storing a link that can never be refreshed.
  let encryptedAccess:  string;
  let encryptedRefresh: string | null;
  try {
    encryptedAccess  = encrypt(tokens.access_token);
    encryptedRefresh = tokens.refresh_token
      ? encrypt(tokens.refresh_token)
      : existing.refresh_token;
  } catch (err) {
    console.error('[onboarding/calendar/google/callback] encryption failed:',
      err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return errorRedirect('server_error');
  }

  if (!encryptedRefresh) {
    console.error('[onboarding/calendar/google/callback] no refresh token available');
    return errorRedirect('missing_refresh_token');
  }

  // ── Persist ───────────────────────────────────────────────────────────────
  // Full replace: switching from Calendly/manual to Google must not leave the
  // old provider's fields behind. oauth_state is cleared — the nonce is single-use.
  const timezone = normalizeTimezone(verified.timezone) ?? existing.timezone;

  const saved = await upsertCalendarConnection(sessionUser.email, {
    provider:      'google',
    accessToken:   encryptedAccess,
    refreshToken:  encryptedRefresh,
    tokenExpiry:   Date.now() + (tokens.expires_in ?? 3600) * 1000,
    calendarEmail: accountEmail ?? sessionUser.email,
    timezone,
    oauthState:    null,
  });

  if (!saved) {
    console.error('[onboarding/calendar/google/callback] failed to store connection');
    return errorRedirect('server_error');
  }

  console.log('[onboarding/calendar/google/callback] calendar connected', { status: 'ok' });

  return NextResponse.redirect(new URL('/onboarding?calendar=connected', appUrl));
}
