// GET /api/admin/google-calendar-auth
//
// Auth-gated admin route. Redirects to Google OAuth to authorize the app's
// own calendar. Scope: https://www.googleapis.com/auth/calendar.events
//
// After completing the flow, the refresh_token is logged to server stdout
// so the admin can copy it into GOOGLE_CALENDAR_REFRESH_TOKEN in .env.local.
// The token is NEVER stored in the database.

import { NextRequest, NextResponse } from 'next/server';
import { routeAuthGuard }            from '../../../../lib/auth';
import { getOrCreateOauthState }     from '../../../../lib/adminCalendarOauthState';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const authDenied = await routeAuthGuard(request);
  if (authDenied) return authDenied as NextResponse;

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const appUrl   = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

  if (!clientId) {
    return NextResponse.json({ error: 'GOOGLE_CLIENT_ID not configured' }, { status: 500 });
  }

  const state       = getOrCreateOauthState();
  const redirectUri = `${appUrl}/api/admin/google-calendar-auth/callback`;

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id',     clientId);
  authUrl.searchParams.set('redirect_uri',  redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope',         'https://www.googleapis.com/auth/calendar.events');
  authUrl.searchParams.set('access_type',   'offline');
  authUrl.searchParams.set('prompt',        'consent');
  authUrl.searchParams.set('state',         state);

  console.log('[google-calendar-auth] redirecting to Google OAuth');
  return NextResponse.redirect(authUrl.toString());
}
