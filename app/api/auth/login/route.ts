import { NextRequest } from 'next/server';
import { verifyAdminPassword, verifyPassword } from '../../../../lib/authPassword';
import { createSessionCookie, COOKIE_NAME, SESSION_TTL_MS } from '../../../../lib/auth';
import { getUser, upsertUser } from '../../../../lib/firmStore';

const MAX_BODY = 2048; // bytes — covers email + password with JSON overhead

export async function POST(request: NextRequest): Promise<Response> {
  // Content-Type guard
  if (!request.headers.get('content-type')?.includes('application/json')) {
    return Response.json({ error: 'content_type_required' }, { status: 415 });
  }

  // Body size guard
  const cl = request.headers.get('content-length');
  if (cl && parseInt(cl, 10) > MAX_BODY) {
    return Response.json({ error: 'request_too_large' }, { status: 413 });
  }

  let raw: string;
  try { raw = await request.text(); } catch {
    return Response.json({ error: 'invalid_request' }, { status: 400 });
  }
  if (raw.length > MAX_BODY) {
    return Response.json({ error: 'request_too_large' }, { status: 413 });
  }

  let body: unknown;
  try { body = JSON.parse(raw); } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  if (typeof body !== 'object' || body === null) {
    return Response.json({ error: 'invalid_request' }, { status: 400 });
  }

  const b = body as Record<string, unknown>;

  if (typeof b.password !== 'string') {
    return Response.json({ error: 'password_required' }, { status: 400 });
  }

  const password = b.password.slice(0, 200);
  const email    = typeof b.email === 'string' ? b.email.trim().toLowerCase().slice(0, 200) : '';

  // ── Emergency admin override ───────────────────────────────────────────────
  // This ADMIN_EMAIL + ADMIN_PASSWORD_HASH bypass is an emergency bootstrap
  // mechanism only — intended for initial setup before any admin user exists in
  // Redis. Do NOT use this as a normal login path. Requires both env vars to be
  // set and the email to exactly match ADMIN_EMAIL (case-insensitive).
  if (process.env.ADMIN_PASSWORD_HASH && email && verifyAdminPassword(password, email)) {
    // Upsert an admin user record in Redis. Don't clobber an existing passwordHash.
    try {
      await upsertUser(email, { role: 'admin', status: 'active' });
    } catch {
      // Non-fatal: still grant the session even if the upsert fails
    }
    const token = await createSessionCookie('admin', email);
    return sessionResponse(token);
  }

  // ── Normal user flow ───────────────────────────────────────────────────────
  if (!email || !email.includes('@')) {
    return Response.json({ error: 'invalid_credentials' }, { status: 401 });
  }

  let user;
  try {
    user = await getUser(email);
  } catch {
    console.warn('[auth/login] failed to read user record', { email: '[redacted]' });
    return Response.json({ error: 'invalid_credentials' }, { status: 401 });
  }

  if (!user) {
    console.warn('[auth/login] user not found');
    return Response.json({ error: 'invalid_credentials' }, { status: 401 });
  }

  // Password check
  if (!verifyPassword(password, user.passwordHash)) {
    console.warn('[auth/login] invalid password');
    return Response.json({ error: 'invalid_credentials' }, { status: 401 });
  }

  // Status check
  if (user.status === 'pending') {
    return Response.json(
      { error: 'account_pending', message: 'Your account is pending activation.' },
      { status: 403 },
    );
  }

  if (user.status === 'disabled') {
    return Response.json(
      { error: 'account_disabled', message: 'Your account has been disabled. Contact your administrator.' },
      { status: 403 },
    );
  }

  // status === 'active' — grant session
  const token = await createSessionCookie(user.role, user.email, user.firmName);
  return sessionResponse(token);
}

function sessionResponse(token: string): Response {
  const isProduction = process.env.NODE_ENV === 'production';
  const maxAge       = Math.floor(SESSION_TTL_MS / 1000);

  const setCookie = [
    `${COOKIE_NAME}=${token}`,
    'HttpOnly',
    `Max-Age=${maxAge}`,
    'Path=/',
    'SameSite=Lax',
    ...(isProduction ? ['Secure'] : []),
  ].join('; ');

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': setCookie,
    },
  });
}

// Redirect GET to login page instead of 404
export function GET(): Response {
  return Response.redirect('/login', 302);
}
