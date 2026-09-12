// lib/supabase/middleware.ts
//
// Supabase session-refresh helper wired into middleware.ts.
// Refreshes the Supabase session cookie on every non-public request and
// returns the current user. Authorization metadata (role / status /
// onboarding) travels in user.app_metadata — written only by the service
// role — so middleware needs no extra reads.

import { type NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import type { User } from '@supabase/supabase-js';

export interface UpdateSessionResult {
  /** Pass-through response (possibly carrying refreshed Supabase cookie headers). */
  response: NextResponse;
  /** The authenticated Supabase user, or null if no valid session exists. */
  user: User | null;
  /**
   * True when the request CARRIED a session cookie but Supabase could not be
   * asked whether it is valid (network failure, timeout, 5xx). This is not
   * "signed out" — it is "unknown" — and middleware must not redirect on it.
   *
   * 2026-09-12: a client mid-sourcing was bounced to /login and then to /app
   * because one getUser() call failed transiently. The next request verified
   * fine, so /login sent them home and the project they were on was gone.
   */
  authUnavailable: boolean;
}

/** Any Supabase auth cookie on the request means a session may exist. */
function hasSessionCookie(request: NextRequest): boolean {
  return request.cookies.getAll().some(c => c.name.startsWith('sb-'));
}

/**
 * True for failures that say nothing about the session itself: the auth
 * server could not be reached or answered with a server error. An expired or
 * invalid token comes back as a 4xx AuthApiError and stays "signed out".
 */
function isTransientAuthError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return true;           // thrown non-Error: unknown, not a verdict
  const e = err as { name?: string; status?: number };
  if (e.name === 'AuthRetryableFetchError') return true;
  const status = typeof e.status === 'number' ? e.status : 0;
  return status === 0 || status >= 500;
}

/**
 * Refreshes the Supabase session cookie and returns the updated response
 * together with the current Supabase user.
 *
 * Design:
 * - Fails closed on all error paths: no verified user means null.
 * - Uses getUser() (JWT-validated) over getSession() (local-only).
 * - For requests without a Supabase session, getUser() reads only the cookie
 *   store — no network call, negligible latency.
 * - For requests with a stale session, a token-refresh call is made and the
 *   updated cookie is written to the response.
 */
export async function updateSession(request: NextRequest): Promise<UpdateSessionResult> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const empty: UpdateSessionResult = {
    response:        NextResponse.next({ request }),
    user:            null,
    authUnavailable: false,
  };

  if (!url || !key) return empty;

  let response = NextResponse.next({ request });

  try {
    const supabase = createServerClient(url, key, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          // Propagate refreshed cookies onto both the mutated request (so
          // downstream server code sees them) and a new response (so the
          // browser receives Set-Cookie headers).
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    });

    const { data, error } = await supabase.auth.getUser();
    if (data.user?.email) return { response, user: data.user, authUnavailable: false };
    // No user. Signed out for real (no cookie, or a 4xx verdict on the token),
    // or unknown (cookie present, verification itself failed)?
    const unavailable = hasSessionCookie(request) && !!error && isTransientAuthError(error);
    return { response, user: null, authUnavailable: unavailable };
  } catch (err) {
    // Supabase unreachable / misconfigured. With a session cookie on the
    // request that is "unknown", not "signed out".
    return { ...empty, authUnavailable: hasSessionCookie(request) && isTransientAuthError(err) };
  }
}
