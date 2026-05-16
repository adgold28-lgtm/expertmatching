import { NextRequest } from 'next/server';
import { routeAuthGuard, getSessionPayload, createSessionCookie, COOKIE_NAME, SESSION_TTL_MS } from '../../../../lib/auth';
import { upsertUser } from '../../../../lib/firmStore';

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

  // Get full session payload — needed to re-issue cookie with updated fields
  const cookieValue = request.cookies.get(COOKIE_NAME)?.value ?? '';
  const payload     = cookieValue ? await getSessionPayload(cookieValue) : null;
  if (!payload) return Response.json({ error: 'unauthorized' }, { status: 401 });

  try {
    await upsertUser(payload.email, {
      firstName,
      lastName,
      ...(title ? { title } : {}),
      onboardingComplete: true,
    });
  } catch {
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }

  // Issue a refreshed session cookie with onboardingComplete: true and firstName
  // so middleware and NavBar reflect the completed state immediately.
  const newToken = await createSessionCookie(payload.role, payload.email, payload.firmName, {
    firstName,
    onboardingComplete: true,
  });

  const isProduction = process.env.NODE_ENV === 'production';
  const maxAge       = Math.floor(SESSION_TTL_MS / 1000);
  const setCookie    = [
    `${COOKIE_NAME}=${newToken}`,
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
      'Set-Cookie':   setCookie,
    },
  });
}
