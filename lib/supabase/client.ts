// lib/supabase/client.ts
//
// Browser-side Supabase client.
// Import this only in 'use client' components.
//
// The underlying createBrowserClient returns a singleton — safe to call at
// the module level or from a hook on every render.
//
// NOTE: This is Stage 1 infrastructure only.  The current app auth (HMAC
// session cookies + Upstash Redis) remains unchanged.  This client will be
// wired into the auth flow in a future migration step.

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
