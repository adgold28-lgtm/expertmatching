// lib/supabase/middleware.ts
//
// Supabase session-refresh helper for middleware.ts.
// Wired into middleware.ts as Stage 2 of the auth migration.
//
// Does NOT replace HMAC session logic — both auth systems run simultaneously.
// Current users (pre-migration) will always get user: null; the HMAC path
// handles all access control for them.  When login is migrated (Stage 3+),
// users with a Supabase session will be surfaced via the returned `user`.

import { type NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import type { User } from '@supabase/supabase-js';

export interface UpdateSessionResult {
  /** Pass-through response (possibly carrying refreshed Supabase cookie headers). */
  response: NextResponse;
  /**
   * The authenticated Supabase user, or null if no valid Supabase session
   * exists.  Null for ALL current users until login is migrated (Stage 3+).
   */
  user: User | null;
}

/**
 * Refreshes the Supabase session cookie and returns the updated response
 * together with the current Supabase user (null if none).
 *
 * Design:
 * - Fails open on every error: missing env vars, network errors, invalid URL.
 *   If Supabase is unreachable, the HMAC path handles auth normally.
 * - Uses getUser() (not getSession()) to validate the JWT server-side.
 * - For users without a Supabase session (all current users), getUser() reads
 *   only the cookie store — no network call, negligible latency.
 * - For users with a valid but near-expiry Supabase session, a token-refresh
 *   network call is made and the updated cookie is written to the response.
 */
export async function updateSession(request: NextRequest): Promise<UpdateSessionResult> {
  // Fail open: if env vars are absent, skip Supabase entirely.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    return { response: NextResponse.next({ request }), user: null };
  }

  // Start with a plain pass-through response.  The setAll handler below may
  // replace this with a new response carrying updated Set-Cookie headers.
  let response = NextResponse.next({ request });
  let user: User | null = null;

  try {
    const supabase = createServerClient(url, key, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          // Write updated cookies onto the request first so downstream server
          // code in the same request lifecycle sees the fresh values, then
          // rebuild the response so the browser receives the Set-Cookie headers.
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

    // getUser() validates the JWT with the Supabase Auth server.
    // Preferred over getSession() which only reads the local cookie without
    // server-side validation.
    const { data } = await supabase.auth.getUser();
    user = data.user;
  } catch {
    // Network error, malformed URL, Supabase outage, etc.
    // Fail open — the HMAC path remains the authoritative auth source.
    user = null;
  }

  return { response, user };
}
