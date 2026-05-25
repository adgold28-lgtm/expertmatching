// lib/supabase/server.ts
//
// Server-side Supabase client for use in Server Components, Route Handlers,
// and Server Actions.  Creates a new client per request — never share across
// requests.
//
// Uses the cookies() API from next/headers (App Router, Node runtime only).
// Do NOT import from Edge Runtime code paths (middleware.ts, etc.).
//
// NOTE: This is Stage 1 infrastructure only.  The current app auth (HMAC
// session cookies + Upstash Redis) remains unchanged.  This client will be
// wired into the auth flow in a future migration step.

import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `[supabase/server] Missing required environment variable: ${name}. ` +
      'Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.',
    );
  }
  return value;
}

export function createClient() {
  const cookieStore = cookies();

  return createServerClient(
    getRequiredEnv('NEXT_PUBLIC_SUPABASE_URL'),
    getRequiredEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'),
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options);
            });
          } catch {
            // setAll called from a Server Component — cookies() is read-only
            // there.  Silently ignore; middleware will handle any token
            // refresh writes when that path is wired up.
          }
        },
      },
    },
  );
}
