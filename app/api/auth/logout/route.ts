import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { COOKIE_NAME } from '../../../../lib/auth';

export async function POST(request: NextRequest): Promise<Response> {
  const response = NextResponse.json({ ok: true });

  // ── 1. Clear the HMAC session cookie ─────────────────────────────────────
  response.cookies.set(COOKIE_NAME, '', {
    httpOnly: true,
    maxAge:   0,
    path:     '/',
    sameSite: 'lax',
  });

  // ── 2. Clear Supabase session cookies ─────────────────────────────────────
  // signOut() clears the Supabase session server-side and writes Max-Age=0
  // Set-Cookie headers for the Supabase auth cookies.  Fails open: if Supabase
  // is unreachable or the user has no Supabase session, we still clear the
  // HMAC cookie above and return a successful logout.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

  if (url && key) {
    try {
      const supabase = createServerClient(url, key, {
        cookies: {
          getAll() { return request.cookies.getAll(); },
          setAll(cookiesToSet) {
            // Write any cookie updates (including Max-Age=0 clearances) onto
            // the response so the browser removes the Supabase session cookies.
            cookiesToSet.forEach(({ name, value, options }) =>
              response.cookies.set(name, value, options ?? {}),
            );
          },
        },
      });

      await supabase.auth.signOut();
    } catch {
      // Supabase unreachable or signOut() failed — fall through to the
      // deterministic clearing below so the session still ends.
    }
  }

  // ── 3. Deterministically expire all Supabase auth cookies ────────────────
  // signOut() above is best-effort. If it throws (network error, already-
  // invalid token) or misses a chunk, the Supabase auth cookies — including the
  // refresh token and any chunked sb-*-auth-token.0/.1 parts — can survive.
  // A surviving refresh token is silently re-minted by the middleware session
  // refresh (updateSession → getUser) on the next request, trapping the user in
  // a half-logged-out state (HMAC cleared, Supabase alive) where `/` keeps
  // redirecting to `/app`. Clear every sb-* cookie here so logout always fully
  // ends the session regardless of signOut()'s outcome.
  for (const { name } of request.cookies.getAll()) {
    if (name.startsWith('sb-')) {
      response.cookies.set(name, '', {
        httpOnly: true,
        maxAge:   0,
        path:     '/',
        sameSite: 'lax',
      });
    }
  }

  return response;
}
