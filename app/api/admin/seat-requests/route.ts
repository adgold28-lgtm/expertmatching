import { NextRequest } from 'next/server';
import { adminGuard, getSessionUser } from '../../../../lib/auth';
import { provisionAccountInvite, splitFullName, sanitizeName } from '../../../../lib/accountProvisioning';
import {
  listSeatRequests,
  getSeatRequest,
  removeSeatRequest,
  getUser,
} from '../../../../lib/firmStore';

// GET — list pending seat requests
export async function GET(request: NextRequest): Promise<Response> {
  const err = await adminGuard(request);
  if (err) return err;

  try {
    const requests = await listSeatRequests();
    return Response.json({ requests });
  } catch {
    console.error('[admin/seat-requests] failed to list');
    return Response.json({ error: 'Failed to load seat requests' }, { status: 500 });
  }
}

// POST { email, action: 'approve' | 'reject', firstName?, lastName? }
//
// Approval re-runs the same provisioning path as any other invite, so the seat
// cap is re-checked there: a still-capped organization is refused with a clear
// message rather than silently over-provisioned.
export async function POST(request: NextRequest): Promise<Response> {
  const err = await adminGuard(request);
  if (err) return err;

  let body: unknown;
  try { body = await request.json(); } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const b      = body as Record<string, unknown>;
  const email  = typeof b.email  === 'string' ? b.email.trim().toLowerCase()  : '';
  const action = typeof b.action === 'string' ? b.action                       : '';

  if (!email || !email.includes('@')) {
    return Response.json({ error: 'valid_email_required' }, { status: 400 });
  }
  if (action !== 'approve' && action !== 'reject') {
    return Response.json(
      { error: 'invalid_action', message: 'action must be "approve" or "reject"' },
      { status: 400 },
    );
  }

  if (action === 'reject') {
    try {
      await removeSeatRequest(email);
      return Response.json({ ok: true });
    } catch {
      return Response.json({ error: 'Failed to reject request' }, { status: 500 });
    }
  }

  const seatRequest = await getSeatRequest(email).catch(() => null);

  // Provisioned in the meantime — just clear the request.
  const existing = await getUser(email).catch(() => null);
  if (existing && (existing.status === 'active' || existing.status === 'pending')) {
    await removeSeatRequest(email).catch(() => {});
    return Response.json({ ok: true, alreadyProvisioned: true });
  }

  const fromRequest = splitFullName(seatRequest?.name ?? '');
  const firstName   = sanitizeName(b.firstName) || fromRequest.firstName;
  const lastName    = sanitizeName(b.lastName)  || fromRequest.lastName;

  if (!firstName || !lastName) {
    return Response.json(
      {
        error:   'name_required',
        message: 'This seat request has no usable name — enter a first and last name to approve it.',
      },
      { status: 400 },
    );
  }

  const domain = seatRequest?.firmDomain || email.split('@')[1]?.toLowerCase() || '';
  if (!domain) return Response.json({ error: 'invalid_email' }, { status: 400 });

  const session = await getSessionUser(request);

  const result = await provisionAccountInvite({
    firstName,
    lastName,
    email,
    organization:    { domain, name: seatRequest?.firmName },
    invitedByEmail:  session.email,
    isPlatformAdmin: true,
  });

  if (!result.ok) {
    return Response.json({ error: result.error, message: result.message }, { status: result.status });
  }

  await removeSeatRequest(email).catch(() => {});

  return Response.json({
    ok:        true,
    emailSent: result.emailSent,
    ...(result.emailSent ? {} : { warning: 'Invite created, but the email could not be delivered.' }),
  });
}
