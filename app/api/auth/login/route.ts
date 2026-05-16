import { NextRequest } from 'next/server';
import { verifyAdminPassword, verifyPassword } from '../../../../lib/authPassword';
import { createSessionCookie, isAuthEnabled, COOKIE_NAME, SESSION_TTL_MS } from '../../../../lib/auth';
import { getUpstashClient } from '../../../../lib/upstashRedis';

const MAX_BODY = 2048; // bytes — covers email + password with JSON overhead

interface UserRecord {
  email:        string;
  firmName:     string;
  passwordHash: string;
  createdAt:    number;
  domain:       string;
}

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

  // ── 1. Admin password check (always tried first, email ignored) ────────────
  if (verifyAdminPassword(password)) {
    const token = await createSessionCookie('admin', 'admin');
    return sessionResponse(token);
  }

  // ── 2. Per-user account lookup ─────────────────────────────────────────────
  if (email && email.includes('@')) {
    try {
      const redis = getUpstashClient();
      if (redis) {
        const raw = await redis.get(`user:${email}`);
        if (raw) {
          const user: UserRecord = JSON.parse(raw);
          if (verifyPassword(password, user.passwordHash)) {
            const token = await createSessionCookie('user', user.email, user.firmName);
            return sessionResponse(token);
          }
        }
      }
    } catch {
      // Fall through to generic failure — never leak Redis errors
    }
  }

  console.warn('[auth/login] failed login attempt');
  return Response.json({ error: 'invalid_credentials' }, { status: 401 });
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
