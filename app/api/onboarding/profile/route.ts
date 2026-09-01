// POST /api/onboarding/profile — the final onboarding step.
//
// Saves the caller's name/title AND flips onboarding_complete, which is what
// middleware.ts reads to release the rest of the app. Because this single call
// is the gate, it re-checks the two required prerequisites server-side rather
// than trusting the stepper's client-side sequencing:
//
//   billing  — profiles.billing_complete, written only by
//              /api/onboarding/billing/confirm after Stripe confirms the
//              SetupIntent succeeded and belongs to this customer
//   calendar — a usable row in user_calendar_connections (an in-flight OAuth
//              nonce does not count)
//
// Either missing → 409 onboarding_steps_incomplete, with flags so the stepper
// can jump back to the step that is actually outstanding.
//
// NEVER logs: email addresses or profile fields.

import { NextRequest } from 'next/server';
import { routeAuthGuard, getSessionUser } from '../../../../lib/auth';
import { getUser, upsertUser } from '../../../../lib/firmStore';
import { isCalendarConnected } from '../../../../lib/calendarConnections';

export async function POST(request: NextRequest): Promise<Response> {
  const authError = await routeAuthGuard(request);
  if (authError) return authError;

  let body: unknown;
  try { body = await request.json(); } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const b         = body as Record<string, unknown>;
  const firstName = typeof b.firstName === 'string' ? b.firstName.trim().slice(0, 100) : '';
  const lastName  = typeof b.lastName  === 'string' ? b.lastName.trim().slice(0, 100)  : '';
  const title     = typeof b.title     === 'string' ? b.title.trim().slice(0, 200)     : '';

  if (!firstName) return Response.json({ error: 'validation_error', message: 'First name is required.' }, { status: 400 });
  if (!lastName)  return Response.json({ error: 'validation_error', message: 'Last name is required.' },  { status: 400 });

  const sessionUser = await getSessionUser(request);
  if (!sessionUser.email) return Response.json({ error: 'unauthorized' }, { status: 401 });

  // ── Prerequisite check (server-side authority) ──────────────────────────────
  let record: Awaited<ReturnType<typeof getUser>>;
  let calendarConnected: boolean;
  try {
    [record, calendarConnected] = await Promise.all([
      getUser(sessionUser.email),
      isCalendarConnected(sessionUser.email),
    ]);
  } catch {
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }

  if (!record) return Response.json({ error: 'user_not_found' }, { status: 404 });

  const billingComplete = record.billingComplete === true;
  if (!billingComplete || !calendarConnected) {
    return Response.json(
      {
        error:             'onboarding_steps_incomplete',
        calendarConnected,
        billingComplete,
      },
      { status: 409 },
    );
  }

  // Persists to profiles and syncs app_metadata (onboarding_complete,
  // first_name), so middleware and NavBar reflect the completed state on the
  // next request — no session cookie re-mint needed.
  try {
    await upsertUser(sessionUser.email, {
      firstName,
      lastName,
      ...(title ? { title } : {}),
      onboardingComplete: true,
    });
  } catch {
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }

  return Response.json({ ok: true });
}
