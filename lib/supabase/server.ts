// lib/supabase/server.ts
//
// Server-side Supabase client for use in Server Components, Route Handlers,
// and Server Actions.  Creates a new client per request — never share across
// requests.
//
// Uses the cookies() API from next/headers (App Router, Node runtime only).
// Do NOT import from Edge Runtime code paths (middleware.ts, etc.).
//
// STATUS (Sept 2026): live, but with exactly one caller — components/NavBar.tsx
// reads the signed-in user to decide which navigation to render. Route handlers
// use lib/auth.ts instead (it takes the NextRequest, so it also works in the
// Edge middleware bundle), and privileged server work uses the service-role
// client in lib/supabase/admin.ts. This client carries the PUBLISHABLE key, so
// everything it reads is still subject to RLS as the session user.

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
