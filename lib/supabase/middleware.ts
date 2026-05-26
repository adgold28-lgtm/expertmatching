// lib/supabase/middleware.ts
//
// Supabase session-refresh helper wired into middleware.ts (Stage 2+).
// Refreshes the Supabase session cookie on every non-public request and returns
// the current Supabase user alongside their Redis record for gating decisions.
//
// Both auth systems run simultaneously.  HMAC sessions remain valid for all
// users who haven't yet logged in via Supabase Auth.

import { type NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import type { User } from '@supabase/supabase-js';
import { getUpstashClient } from '../upstashRedis';

/** Minimal user metadata needed by middleware for access-control gating. */
export interface MiddlewareUserRecord {
  role:                'admin' | 'user';
  status?:             string;
  onboardingComplete?: boolean;
}

// Lightweight Redis read — avoids importing firmStore (which pulls in Resend
// and breaks the middleware bundle).  Only reads the fields middleware needs.
async function readRedisUserForMiddleware(email: string): Promise<MiddlewareUserRecord | null> {
  try {
    const redis = getUpstashClient();
    if (!redis) return null;
    const raw = await redis.get(`user:${email}`);
    if (!raw) return null;
    const parsed = JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw)) as {
      role?:               string;
      status?:             string;
      onboardingComplete?: boolean;
    };
    const role: 'admin' | 'user' = parsed.role === 'admin' ? 'admin' : 'user';
    return { role, status: parsed.status, onboardingComplete: parsed.onboardingComplete };
  } catch {
    return null;
  }
}

export interface UpdateSessionResult {
  /** Pass-through response (possibly carrying refreshed Supabase cookie headers). */
  response: NextResponse;
  /**
   * The authenticated Supabase user, or null if no valid Supabase session
   * exists.  Null for all users until they log in via Supabase Auth.
   */
  user: User | null;
  /**
   * Redis record for the Supabase user — populated only when user is non-null.
   * Contains role and onboardingComplete for middleware gating without an
   * extra Redis round-trip inside middleware.ts.
   * Null if the Redis lookup fails or the user has no Redis record.
   */
  redisUser: MiddlewareUserRecord | null;
}

/**
 * Refreshes the Supabase session cookie and returns the updated response
 * together with the current Supabase user and their Redis metadata.
 *
 * Design:
 * - Fails open on all error paths (missing env vars, network, malformed URL).
 * - Uses getUser() (JWT-validated) over getSession() (local-only).
 * - For users without a Supabase session, getUser() reads only the cookie
 *   store — no network call, negligible latency.
 * - For users with a stale Supabase session, a token-refresh call is made
 *   and the updated cookie is written to the response.
 * - When a Supabase user is found, their Redis record is fetched once here
 *   so middleware.ts does not need a separate firmStore import.
 */
export async function updateSession(request: NextRequest): Promise<UpdateSessionResult> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const empty: UpdateSessionResult = {
    response:  NextResponse.next({ request }),
    user:      null,
    redisUser: null,
  };

  if (!url || !key) return empty;

  let response = NextResponse.next({ request });
  let user: User | null = null;
  let redisUser: MiddlewareUserRecord | null = null;

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
    user = data.user;
  } catch {
    // Supabase unreachable / misconfigured — fail open.
    return empty;
  }

  if (user?.email) {
    redisUser = await readRedisUserForMiddleware(user.email);
  }

  return { response, user, redisUser };
}
