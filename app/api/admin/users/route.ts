import { NextRequest } from 'next/server';
import { adminGuard, getSessionUser } from '../../../../lib/auth';
import { provisionAccountInvite } from '../../../../lib/accountProvisioning';
import { syncOrgSeatQuantity } from '../../../../lib/orgBilling';
import {
  getUser,
  upsertUser,
  deleteUser,
  listUsersForFirm,
  listAllUsers,
  type UserStatus,
} from '../../../../lib/firmStore';

const VALID_STATUSES = new Set<UserStatus>(['active', 'disabled']);

/** Seat quantity sync — never lets a billing outage fail an account write. */
async function syncSeats(organizationId: string | undefined): Promise<void> {
  if (!organizationId) return;
  try { await syncOrgSeatQuantity(organizationId); } catch { /* best effort */ }
}

// GET ?all=true          — list all users across every organization (admin panel)
// GET ?domain=<domain>   — list users for a specific organization
export async function GET(request: NextRequest): Promise<Response> {
  const err = await adminGuard(request);
  if (err) return err;

  const all    = request.nextUrl.searchParams.get('all') === 'true';
  const domain = (request.nextUrl.searchParams.get('domain') ?? '').trim().toLowerCase();

  if (all) {
    try {
      const users = await listAllUsers();
      return Response.json({ users });
    } catch {
      console.error('[admin/users] failed to list all users');
      return Response.json({ error: 'Failed to load users' }, { status: 500 });
    }
  }

  if (!domain) {
    return Response.json({ error: 'domain_or_all_required' }, { status: 400 });
  }

  try {
    const users = await listUsersForFirm(domain);
    return Response.json({ users });
  } catch {
    console.error('[admin/users] failed to list users for organization');
    return Response.json({ error: 'Failed to load users' }, { status: 500 });
  }
}

// POST { firstName, lastName, email, organization: { domain?, name? }, role?, reinvite? }
//
// Creating a user IS sending an invite: the invitee sets their own password via
// the tokenized link. There is no admin-sets-password path.
//
// `reinvite: true` re-sends that link to an address that already has an account
// — a pending invitee gets a fresh invitation, an active member gets a
// password-reset link. Without it an existing account is still 409 user_exists.
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

// PATCH { email, status } — update membership status (active | disabled)
export async function PATCH(request: NextRequest): Promise<Response> {
  const err = await adminGuard(request);
  if (err) return err;

  let body: unknown;
  try { body = await request.json(); } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const b      = body as Record<string, unknown>;
  const email  = typeof b.email  === 'string' ? b.email.trim().toLowerCase()  : '';
  const status = typeof b.status === 'string' ? b.status : '';

  if (!email || !email.includes('@')) {
    return Response.json({ error: 'valid_email_required' }, { status: 400 });
  }
  if (!VALID_STATUSES.has(status as UserStatus)) {
    return Response.json(
      { error: 'invalid_status', message: 'status must be "active" or "disabled"' },
      { status: 400 },
    );
  }

  try {
    const user = await getUser(email);
    if (!user) return Response.json({ error: 'user_not_found' }, { status: 404 });

    await upsertUser(email, { status: status as UserStatus });

    // The organization's billable seat count changed.
    await syncSeats(user.orgId);

    return Response.json({ ok: true });
  } catch {
    console.error('[admin/users] failed to update status');
    return Response.json({ error: 'Failed to update user' }, { status: 500 });
  }
}

// DELETE { email } — permanently remove a user
export async function DELETE(request: NextRequest): Promise<Response> {
  const err = await adminGuard(request);
  if (err) return err;

  let body: unknown;
  try { body = await request.json(); } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const b     = body as Record<string, unknown>;
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';

  if (!email || !email.includes('@')) {
    return Response.json({ error: 'valid_email_required' }, { status: 400 });
  }

  // Prevent admins from deleting their own account.
  const sessionUser = await getSessionUser(request);
  if (sessionUser.email.toLowerCase() === email) {
    return Response.json(
      { error: 'cannot_delete_self', message: 'You cannot delete your own account.' },
      { status: 400 },
    );
  }

  try {
    const user = await getUser(email);
    if (!user) return Response.json({ error: 'user_not_found' }, { status: 404 });

    await deleteUser(email);

    // Removing a membership frees a billable seat.
    await syncSeats(user.orgId);

    return Response.json({ ok: true });
  } catch {
    console.error('[admin/users] failed to delete user');
    return Response.json({ error: 'Failed to delete user' }, { status: 500 });
  }
}
