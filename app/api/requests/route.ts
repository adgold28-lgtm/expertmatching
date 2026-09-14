// GET  /api/requests — the request list behind /requests
// POST /api/requests — the intake form at /requests/new
//
// A REQUEST IS NOT A PROJECT (docs/SCREENING_FLOW_PLAN.md). It is one person's
// topic plus three to six learning objectives, and the whole point of the
// screening flow is that an expert answers those objectives one by one before
// anyone books a call. Nothing here touches Matchy, scheduling or Stripe.
//
// Identity comes from the session, NEVER from the body: getSessionUser gives
// the email and the role, createRequest resolves that email to a profile and to
// the one organization it belongs to, and the owner and organization of the new
// request are derived from that. A caller cannot name an owner, an org, or
// another person's request here.
//
// ACCESS SCOPING LIVES IN THE STORE. listRequestsForUser is owner-or-platform-
// admin (there are no collaborators on a request), so this route adds no
// filtering of its own and must not: the guards below prove a session exists,
// not what it may reach.
//
// VALIDATION RETURNS THE WHOLE LIST. validateIntakeInput reports every broken
// rule separately, and the 400 carries all of them so the intake page can mark
// every bad field at once instead of making the client fix one per round trip.
// `error` / `field` / `message` stay at the top level for the callers that read
// only the first problem.
//
// Never logs: the topic statement, an objective, targeting text, or any part of
// the body — only the message of a thrown error.

import { NextRequest } from 'next/server';
import { routeAuthGuard, getSessionUser } from '../../../lib/auth';
import { guardReadRequest, guardMutatingRequest } from '../../../lib/projectsGuard';
import { createRequest, listRequestsForUser } from '../../../lib/requestStore';
import { validateIntakeInput, isValid } from '../../../lib/screeningValidation';
import { trackProductEvent } from '../../../lib/productEvents';

// The two messages lib/requestStore.createRequest throws when the signed-in
// account is not attached to a firm yet. Both are the same problem for the
// person in front of the form — finish onboarding — so both become one 403
// with a sentence, rather than a 500 that reads like our bug.
const NO_ORG_ERRORS = new Set([
  'Request owner has no account',
  'Request owner has no organization',
]);

export async function GET(request: NextRequest) {
  const authErr = await routeAuthGuard(request);
  if (authErr) return authErr;

  const guardErr = guardReadRequest(request);
  if (guardErr) return guardErr;

  try {
    const { email, role } = await getSessionUser(request);
    const requests = await listRequestsForUser(email, role);
    return Response.json({ requests });
  } catch (err) {
    console.error('[api/requests] GET error:', err instanceof Error ? err.message : String(err));
    return Response.json({ error: 'failed_to_list_requests' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const authErr = await routeAuthGuard(request);
  if (authErr) return authErr;

  const guarded = await guardMutatingRequest(request);
  if ('error' in guarded) return guarded.error;
  const { body } = guarded;

  const validated = validateIntakeInput(body);
  if (!isValid(validated)) {
    const [first] = validated.errors;
    return Response.json(
      {
        error:   first.error,
        field:   first.field,
        message: first.message,
        errors:  validated.errors,
      },
      { status: 400 },
    );
  }
  const { data } = validated;

  try {
    const { email } = await getSessionUser(request);
    const created = await createRequest(data, email);

    // Counts and one boolean. Never the topic, an objective or a company name
    // — lib/engagementEvents.sanitizeEventPayload would drop the prose anyway,
    // but the payload is built so there is nothing to drop.
    void trackProductEvent({
      type:           'request_created',
      actorEmail:     email,
      organizationId: created.organizationId,
      payload: {
        objectiveCount: created.objectives.length,
        hasTargeting:   Object.keys(created.targeting).length > 0,
        callCount:      created.callCount,
      },
    });

    return Response.json({ request: created }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (NO_ORG_ERRORS.has(message)) {
      return Response.json(
        {
          error:   'no_organization',
          message: 'Your account is not attached to a firm yet. Finish onboarding first.',
        },
        { status: 403 },
      );
    }
    console.error('[api/requests] POST error:', message);
    return Response.json({ error: 'failed_to_create_request' }, { status: 500 });
  }
}
