// POST /api/onboarding/profile — the final onboarding step, and afterwards the
// route that edits the same three fields from /settings.
//
// TWO MODES, decided by the caller's own record, never by the request body:
//
//   Onboarding (record.onboardingComplete is false) — saves name/title AND
//   flips onboarding_complete, which is what middleware.ts reads to release the
//   rest of the app. Because this single call is the gate, it re-checks the two
//   required prerequisites server-side rather than trusting the stepper's
//   client-side sequencing.
//
//   Edit (record.onboardingComplete is already true) — saves name/title and
//   NOTHING ELSE. No prerequisite check (an onboarded user who later has a
//   billing hiccup must still be able to fix their own last name) and no
//   re-write of onboarding_complete, so editing a profile can never re-run the
//   gate or flip a flag as a side effect.
//
// The prerequisites, checked in onboarding mode only:
//
//   billing  — the FIRM has a card on file (organization_billing.billing_complete,
//              written only by /api/onboarding/billing/confirm after Stripe
//              confirms the SetupIntent belongs to the org's customer), or the
//              legacy per-user profiles.billing_complete for older accounts
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
import { isBillingCompleteForUser } from '../../../../lib/orgBilling';

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

  // ── Which mode are we in? The stored record decides, not the request. ───────
  let record: Awaited<ReturnType<typeof getUser>>;
  try {
    record = await getUser(sessionUser.email);
  } catch {
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }

  if (!record) return Response.json({ error: 'user_not_found' }, { status: 404 });

  const alreadyOnboarded = record.onboardingComplete === true;

  // ── Prerequisite check (server-side authority) — onboarding mode only ───────
  if (!alreadyOnboarded) {
    let calendarConnected: boolean;
    let billingComplete: boolean;
    try {
      [calendarConnected, billingComplete] = await Promise.all([
        isCalendarConnected(sessionUser.email),
        isBillingCompleteForUser(sessionUser.email),
      ]);
    } catch {
      return Response.json({ error: 'internal_error' }, { status: 500 });
    }

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
  }

  // Persists to profiles and syncs app_metadata (onboarding_complete,
  // first_name), so middleware and NavBar reflect the completed state on the
  // next request — no session cookie re-mint needed.
  //
  // `title` is sent as an explicit empty string when the user clears it, so it
  // is written whenever the key was present rather than only when truthy —
  // otherwise a title could be set but never removed. onboardingComplete is
  // written ONLY on the onboarding pass: an edit must not touch the gate.
  const titleProvided = typeof b.title === 'string';

  try {
    await upsertUser(sessionUser.email, {
      firstName,
      lastName,
      ...(titleProvided ? { title } : {}),
      ...(alreadyOnboarded ? {} : { onboardingComplete: true }),
    });
  } catch {
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }

  return Response.json({ ok: true, updated: alreadyOnboarded });
}
