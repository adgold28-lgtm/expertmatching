import { NextRequest } from 'next/server';
import { verifyAdminPassword } from '../../../../lib/authPassword';
import { createSessionCookie, isAuthEnabled, COOKIE_NAME, SESSION_TTL_MS } from '../../../../lib/auth';

const MAX_BODY = 1024; // bytes

export async function POST(request: NextRequest): Promise<Response> {
  // Content-Type guard
  if (!request.headers.get('content-type')?.includes('application/json')) {
    return Response.json({ error: 'content_type_required' }, { status: 415 });
  }

  // Body size guard (header, then actual)
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

  if (
    typeof body !== 'object' ||
    body === null ||
    typeof (body as Record<string, unknown>).password !== 'string'
  ) {
    return Response.json({ error: 'password_required' }, { status: 400 });
  }

  const password = ((body as Record<string, unknown>).password as string).slice(0, 200);

  if (!verifyAdminPassword(password)) {
    console.warn('[auth/login] failed login attempt');
    return Response.json({ error: 'invalid_credentials' }, { status: 401 });
  }

  const token        = await createSessionCookie();
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
