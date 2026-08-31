import { NextRequest } from 'next/server';
import { routeAuthGuard, getSessionUser } from '../../../../lib/auth';
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

  const sessionUser = await getSessionUser(request);
  if (!sessionUser.email) return Response.json({ error: 'unauthorized' }, { status: 401 });

  // Persists to profiles and syncs app_metadata (onboarding_complete,
  // first_name), so middleware and NavBar reflect the completed state on the
  // next request — no session cookie re-mint needed.
  try {
    await upsertUser(sessionUser.email, {
      firstName,
      lastName,
      ...(title ? { title } : {}),
      onboardingComplete: true,
    });
  } catch {
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }

  return Response.json({ ok: true });
}
