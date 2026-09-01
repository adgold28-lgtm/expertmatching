// GET /api/onboarding/calendar/status — is the caller's calendar linked?
//
// Session-authenticated (routeAuthGuard). Lets the onboarding stepper resume on
// reload and after the Google OAuth round-trip returns to
// /onboarding?calendar=connected.
//
// Response: 200 { connected: boolean, provider: 'google' | 'calendly' | 'manual' | null }
//
// `connected` is false for a row that only holds an in-flight OAuth nonce, so an
// abandoned consent screen never reads as linked. `provider` reports the row's
// stored provider even when unusable, so the UI can show which one to retry.
//
// Deliberately returns no tokens, no calendar email, and no Calendly URL — this
// response reaches the browser.
//
// Required env vars: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// NEVER logs: email addresses or connection details.

import { NextRequest } from 'next/server';
import { routeAuthGuard, getSessionUser } from '../../../../../lib/auth';
import { getCalendarConnection, connectionIsUsable } from '../../../../../lib/calendarConnections';

export async function GET(request: NextRequest): Promise<Response> {
  const authError = await routeAuthGuard(request);
  if (authError) return authError;

  const sessionUser = await getSessionUser(request);
  if (!sessionUser.email) return Response.json({ error: 'unauthorized' }, { status: 401 });

  const row = await getCalendarConnection(sessionUser.email);

  return Response.json({
    connected: connectionIsUsable(row),
    provider:  row?.provider ?? null,
  });
}
