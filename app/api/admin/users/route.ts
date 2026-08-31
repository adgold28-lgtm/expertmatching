import { NextRequest } from 'next/server';
import { adminGuard, getSessionUser } from '../../../../lib/auth';
import { ensureSupabaseUser } from '../../../../lib/supabase/admin';
import {
  getUser,
  upsertUser,
  deleteUser,
  listUsersForFirm,
  listAllUsers,
  type UserStatus,
} from '../../../../lib/firmStore';

const VALID_STATUSES = new Set<UserStatus>(['active', 'disabled']);

// GET ?all=true          — list all users across every firm (admin panel)
// GET ?domain=<domain>   — list users for a specific firm
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
    console.error('[admin/users] failed to list users for firm', { domain: '[redacted]' });
    return Response.json({ error: 'Failed to load users' }, { status: 500 });
  }
}

// POST { email, password, role, firmName, firmDomain } — create a new user
export async function POST(request: NextRequest): Promise<Response> {
  const err = await adminGuard(request);
  if (err) return err;

  let body: unknown;
  try { body = await request.json(); } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const b          = body as Record<string, unknown>;
  const email      = typeof b.email      === 'string' ? b.email.trim().toLowerCase().slice(0, 254) : '';
  const password   = typeof b.password   === 'string' ? b.password.slice(0, 200)                   : '';
  const role       = typeof b.role       === 'string' ? b.role                                      : 'user';
  const firmName   = typeof b.firmName   === 'string' ? b.firmName.trim().slice(0, 200)             : '';
  const firmDomain = typeof b.firmDomain === 'string' ? b.firmDomain.trim().toLowerCase().slice(0, 200) : '';

  if (!email || !email.includes('@')) {
    return Response.json({ error: 'valid_email_required' }, { status: 400 });
  }
  if (password.length < 8) {
    return Response.json(
      { error: 'password_too_short', message: 'Password must be at least 8 characters.' },
      { status: 400 },
    );
  }
  if (role !== 'admin' && role !== 'user') {
    return Response.json(
      { error: 'invalid_role', message: 'role must be "admin" or "user"' },
      { status: 400 },
    );
  }

  try {
    // Credentials live in Supabase Auth; domain data + app_metadata via upsertUser.
    const authId = await ensureSupabaseUser(email, password);
    if (!authId) {
      return Response.json({ error: 'Failed to create user' }, { status: 500 });
    }
    await upsertUser(email, {
      role:               role as 'admin' | 'user',
      firmName,
      firmDomain,
      status:             'active',
      onboardingComplete: true,
    });
    return Response.json({ ok: true });
  } catch {
    console.error('[admin/users] failed to create user');
    return Response.json({ error: 'Failed to create user' }, { status: 500 });
  }
}

// PATCH { email, status } — update user status (active | disabled)
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
    return Response.json({ ok: true });
  } catch {
    console.error('[admin/users] failed to update status', { email: '[redacted]' });
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
    return Response.json({ ok: true });
  } catch {
    console.error('[admin/users] failed to delete user', { email: '[redacted]' });
    return Response.json({ error: 'Failed to delete user' }, { status: 500 });
  }
}
