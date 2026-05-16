import { NextRequest } from 'next/server';
import { adminGuard } from '../../../../lib/auth';
import {
  listUsersForFirm,
  updateUserStatus,
  type UserRecord,
  type UserStatus,
} from '../../../../lib/firmStore';

const VALID_STATUSES = new Set<UserStatus>(['active', 'disabled']);

// Strip passwordHash before sending to client
function sanitize(user: UserRecord): Omit<UserRecord, 'passwordHash'> {
  const { passwordHash: _pw, ...rest } = user;
  void _pw;
  return rest;
}

// GET ?domain=xxx — list users for a firm
export async function GET(request: NextRequest): Promise<Response> {
  const err = await adminGuard(request);
  if (err) return err;

  const domain = (request.nextUrl.searchParams.get('domain') ?? '').trim().toLowerCase();
  if (!domain) {
    return Response.json({ error: 'domain_required' }, { status: 400 });
  }

  try {
    const users = await listUsersForFirm(domain);
    return Response.json({ users: users.map(sanitize) });
  } catch {
    console.error('[admin/users] failed to list users', { domain: '[redacted]' });
    return Response.json({ error: 'Failed to load users' }, { status: 500 });
  }
}

// PATCH { email, status } — update user status
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
    return Response.json({ error: 'invalid_status', message: 'status must be "active" or "disabled"' }, { status: 400 });
  }

  try {
    await updateUserStatus(email, status as UserStatus);
    console.log('[admin/users] status updated', { status });
    return Response.json({ ok: true });
  } catch {
    console.error('[admin/users] failed to update status', { email: '[redacted]' });
    return Response.json({ error: 'Failed to update user' }, { status: 500 });
  }
}
