// TODO(calendar-integration): This is a stub. Replace with real OAuth flows.
//
// Google Calendar requirements:
//   - GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI
//   - Scopes: https://www.googleapis.com/auth/calendar.readonly
//   - Redirect to Google OAuth → handle callback → store refresh_token on UserRecord
//
// Outlook (Microsoft Graph) requirements:
//   - OUTLOOK_CLIENT_ID, OUTLOOK_CLIENT_SECRET, OUTLOOK_REDIRECT_URI
//   - Scopes: Calendars.Read, offline_access
//   - Same OAuth callback pattern
//
// Suggested real implementation:
//   POST → initiate OAuth: return { authUrl } and redirect client
//   GET  → OAuth callback: exchange code for tokens, store, mark user calendarConnected: true

import { NextRequest } from 'next/server';
import { routeAuthGuard } from '../../../../lib/auth';

export async function POST(request: NextRequest): Promise<Response> {
  const authError = await routeAuthGuard(request);
  if (authError) return authError;

  let body: unknown;
  try { body = await request.json(); } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const provider = (body as Record<string, unknown>).provider;
  if (provider !== 'google' && provider !== 'outlook') {
    return Response.json({ error: 'invalid_provider' }, { status: 400 });
  }

  // Stub: always succeeds. Real implementation stores OAuth tokens on UserRecord.
  return Response.json({ ok: true, stubbed: true, provider });
}
