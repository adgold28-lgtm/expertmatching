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
    response: NextResponse.next({ request }),
    user:     null,
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

    const { data } = await supabase.auth.getUser();
    return { response, user: data.user?.email ? data.user : null };
  } catch {
    // Supabase unreachable / misconfigured — treat as signed out.
    return empty;
  }
}
