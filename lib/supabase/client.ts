// lib/supabase/client.ts
//
// Browser-side Supabase client.
// Import this only in 'use client' components.
//
// The underlying createBrowserClient returns a singleton — safe to call at
// the module level or from a hook on every render.
//
// STATUS (verified by grep, Sept 2026): nothing imports this module. The HMAC
// session cookie it was written alongside is gone — Supabase Auth is now the
// only session system, and every path that needs a session reads it
// server-side (lib/supabase/middleware.ts in the Edge middleware,
// lib/auth.ts in route handlers, lib/supabase/server.ts in Server
// Components). Kept as the sanctioned entry point should a client component
// ever need the browser SDK; it must never be handed the service-role key.

import { createBrowserClient } from '@supabase/ssr';

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `[supabase/client] Missing required environment variable: ${name}. ` +
      'Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.',
    );
  }
  return value;
}

export function createClient() {
  return createBrowserClient(
    getRequiredEnv('NEXT_PUBLIC_SUPABASE_URL'),
    getRequiredEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'),
  );
}
