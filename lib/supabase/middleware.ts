// lib/supabase/middleware.ts
//
// Scaffold for a future Supabase session-refresh middleware helper.
//
// !! NOT WIRED INTO middleware.ts YET !!
//
// When Stage 2 migration begins, import updateSession from here and call it
// at the top of the main middleware function, BEFORE the existing HMAC
// session checks.  At that point the Supabase session cookie will be kept
// fresh on every request and the migration to Supabase Auth can proceed.
//
// Requires both NextRequest and NextResponse to be passed in so that
// Set-Cookie headers produced by token refresh are forwarded to the browser.

import { type NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `[supabase/middleware] Missing required environment variable: ${name}.`,
    );
  }
  return value;
}

/**
 * Refreshes the Supabase session and forwards any updated cookies onto the
 * response.  Returns the (potentially mutated) response so the caller can
 * pass it along the middleware chain.
 *
 * Usage (future Stage 2):
 *
 *   import { updateSession } from '../lib/supabase/middleware';
 *
 *   export async function middleware(request: NextRequest) {
 *     const response = await updateSession(request);
 *     // … existing HMAC checks against response …
 *     return response;
 *   }
 */
export async function updateSession(request: NextRequest): Promise<NextResponse> {
  // Start with a pass-through response so Set-Cookie headers can be appended.
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    getRequiredEnv('NEXT_PUBLIC_SUPABASE_URL'),
    getRequiredEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'),
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          // Write updated cookies onto both the request (so downstream
          // server code sees them) and the response (so the browser stores
          // them).
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // Trigger a session refresh if the token is stale.  getUser() is preferred
  // over getSession() here — getSession() does not validate the JWT.
  await supabase.auth.getUser();

  return response;
}
