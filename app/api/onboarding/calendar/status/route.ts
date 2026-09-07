// GET /api/onboarding/calendar/status — is the caller's calendar linked?
//
// Session-authenticated (routeAuthGuard). Lets the onboarding stepper resume on
// reload and after the Google OAuth round-trip returns to
// /onboarding?calendar=connected.
//
// Response: 200 {
//   connected:     boolean,
//   provider:      'google' | 'calendly' | 'manual' | null,
//   timezone:      string | null,
//   hasWeekly:     boolean,
//   weeklyWindows: WeeklyWindow[],
//   slots:         AvailabilitySlot[],
// }
//
// `connected` is false for a row that only holds an in-flight OAuth nonce, so an
// abandoned consent screen never reads as linked. `provider` reports the row's
// stored provider even when unusable, so the UI can show which one to retry.
//
// `hasWeekly` / `weeklyWindows` / `slots` / `timezone` are the caller's OWN
// availability, echoed back so the Settings calendar panel can open pre-filled
// with what they last saved instead of making them retype it. They are not
// secrets from the person who typed them.
//
// Still deliberately absent: tokens, the calendar email, and the Calendly URL —
// this response reaches the browser, and none of those three are needed to
// render the editor.
//
// Required env vars: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// NEVER logs: email addresses or connection details.

import { NextRequest } from 'next/server';
import { routeAuthGuard, getSessionUser } from '../../../../../lib/auth';
import {
  getCalendarConnection,
  connectionIsUsable,
  weeklyWindowsFromRow,
  manualSlotsFromRow,
} from '../../../../../lib/calendarConnections';
import { sortWeeklyWindows } from '../../../../../lib/availabilityWindows';

export async function GET(request: NextRequest): Promise<Response> {
  const authError = await routeAuthGuard(request);
  if (authError) return authError;

  const sessionUser = await getSessionUser(request);
  if (!sessionUser.email) return Response.json({ error: 'unauthorized' }, { status: 401 });

  const row           = await getCalendarConnection(sessionUser.email);
  const weeklyWindows = sortWeeklyWindows(weeklyWindowsFromRow(row));

  return Response.json({
    connected:     connectionIsUsable(row),
    provider:      row?.provider ?? null,
    timezone:      row?.timezone ?? null,
    hasWeekly:     weeklyWindows.length > 0,
    weeklyWindows,
    slots:         manualSlotsFromRow(row),
  });
}
