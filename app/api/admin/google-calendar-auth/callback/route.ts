// GET /api/admin/google-calendar-auth/callback
//
// Auth-gated. Exchanges the OAuth code for tokens.
// LOGS the refresh_token to server stdout — admin copies it to .env.local.
// DOES NOT store the token anywhere.

import { NextRequest, NextResponse } from 'next/server';
import { routeAuthGuard }            from '../../../../../lib/auth';
import { getOauthState, clearOauthState } from '../../../../../lib/adminCalendarOauthState';

interface TokenResponse {
  access_token?:  string;
  refresh_token?: string;
  expires_in?:    number;
  error?:         string;
  error_description?: string;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const authDenied = await routeAuthGuard(request);
  if (authDenied) return authDenied as NextResponse;

  const { searchParams } = request.nextUrl;
  const code  = searchParams.get('code');
  const state = searchParams.get('state');
  const error = searchParams.get('error');

  if (error) {
    const KNOWN_ERRORS = ['access_denied', 'invalid_request', 'invalid_scope', 'server_error', 'temporarily_unavailable'];
    const safeError = KNOWN_ERRORS.includes(String(error)) ? String(error) : 'unknown_error';
    console.error('[google-calendar-auth/callback] OAuth error:', safeError);
    return NextResponse.json({ error: `OAuth error: ${safeError}` }, { status: 400 });
  }

  // ── CSRF state check ──────────────────────────────────────────────────────
  const expectedState = getOauthState();
  if (!state || !expectedState || state !== expectedState) {
    console.error('[google-calendar-auth/callback] state mismatch — possible CSRF');
    return NextResponse.json({ error: 'state_mismatch' }, { status: 400 });
  }
  clearOauthState();

  if (!code) {
    return NextResponse.json({ error: 'missing_code' }, { status: 400 });
  }

  // ── Exchange code for tokens ───────────────────────────────────────────────
  const clientId     = process.env.GOOGLE_CLIENT_ID     ?? '';
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET ?? '';
  const appUrl       = process.env.NEXT_PUBLIC_APP_URL  ?? 'http://localhost:3000';
  const redirectUri  = `${appUrl}/api/admin/google-calendar-auth/callback`;

  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        code,
        client_id:     clientId,
        client_secret: clientSecret,
        redirect_uri:  redirectUri,
        grant_type:    'authorization_code',
      }),
      signal: AbortSignal.timeout(10_000),
    });

    const data = await res.json() as TokenResponse;

    if (data.error || !data.refresh_token) {
      console.error('[google-calendar-auth/callback] token exchange failed:', data.error ?? 'no refresh_token');
      return NextResponse.json(
        { error: data.error ?? 'no_refresh_token', description: data.error_description },
        { status: 400 },
      );
    }

    // ── Return refresh_token to the authenticated admin in the response body ──
    // Displayed once in the browser (admin copies it to .env.local).
    // NOT logged to stdout to prevent token leakage in log aggregation systems.
    const escapedToken = data.refresh_token
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    return new NextResponse(
      `<html><body style="font-family:monospace;padding:2rem;">
        <h2>Google Calendar authorized</h2>
        <p>Copy the value below and add it to <code>.env.local</code> as:</p>
        <pre style="background:#f0f0f0;padding:1rem;">GOOGLE_CALENDAR_REFRESH_TOKEN=${escapedToken}</pre>
        <p><strong>Do not refresh this page.</strong> The token is one-time use for display only.</p>
      </body></html>`,
      { status: 200, headers: { 'Content-Type': 'text/html' } },
    );

  } catch (err) {
    console.error('[google-calendar-auth/callback] error:',
      err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return NextResponse.json({ error: 'token_exchange_failed' }, { status: 500 });
  }
}
