import { NextRequest } from 'next/server';
import { adminGuard, getSessionUser } from '../../../../lib/auth';
import { provisionAccountInvite } from '../../../../lib/accountProvisioning';

// POST { firstName, lastName, email, organization: { domain?, name? }, role?, reinvite? }
//
// Platform-admin invite. All account creation goes through
// provisionAccountInvite — first name, last name, email and organization are
// mandatory on every path.
//
// `reinvite: true` re-sends a link to someone who already has an account
// (otherwise a 409 user_exists): a pending invitee gets a fresh invitation, an
// active member gets a password-reset link and keeps everything else.
export async function POST(request: NextRequest): Promise<Response> {
  const err = await adminGuard(request);
  if (err) return err;

  let body: unknown;
  try { body = await request.json(); } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const b   = (body ?? {}) as Record<string, unknown>;
  const org = (b.organization ?? {}) as Record<string, unknown>;

  const session = await getSessionUser(request);

  const result = await provisionAccountInvite({
    firstName:    typeof b.firstName === 'string' ? b.firstName : '',
    lastName:     typeof b.lastName  === 'string' ? b.lastName  : '',
    email:        typeof b.email     === 'string' ? b.email     : '',
    organization: {
      domain: typeof org.domain === 'string' ? org.domain : undefined,
      name:   typeof org.name   === 'string' ? org.name   : undefined,
    },
    role:            b.role === 'admin' ? 'admin' : 'user',
    invitedByEmail:  session.email,
    isPlatformAdmin: true,
    reinvite:        b.reinvite === true,
  });

  if (!result.ok) {
    return Response.json({ error: result.error, message: result.message }, { status: result.status });
  }

  // The set-password token is deliberately not returned: it would let anyone
  // holding this response set the invitee's password.
  return Response.json({
    ok:        true,
    email:     result.email,
    emailSent: result.emailSent,
    ...(result.reinvited ? { reinvited: true } : {}),
    ...(result.emailSent
      ? {}
      : { warning: `${result.reinvited ? 'Link created' : 'Invite created'}, but the email could not be delivered.` }),
  });
}
