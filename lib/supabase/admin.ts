// lib/supabase/admin.ts
//
// Supabase admin client — uses the service role key to perform privileged
// server-side operations: creating users, updating user records, bypassing RLS.
//
// NEVER import from client components or expose SUPABASE_SERVICE_ROLE_KEY.
//
// Required env vars (in addition to the public vars):
//   SUPABASE_SERVICE_ROLE_KEY  — from Supabase dashboard → Settings → API
//
// Fails open: all exports return null / false when env vars are absent so
// callers can degrade gracefully to Redis-only auth.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './database.types';

let _adminClient: SupabaseClient<Database> | null = null;

/**
 * Returns a Supabase admin (service-role) client typed to the gated-access
 * schema, or null if the required env vars are absent. Singleton — one client
 * per process.
 *
 * The service-role key BYPASSES Row Level Security, so this client is the only
 * sanctioned way for server-side platform-admin routes to read/write across
 * organizations and projects. NEVER import it into a client component.
 */
export function getSupabaseAdminClient(): SupabaseClient<Database> | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  if (!_adminClient) {
    _adminClient = createClient<Database>(url, key, {
      auth: {
        autoRefreshToken: false,
        persistSession:   false,
      },
    });
  }
  return _adminClient;
}

/**
 * Canonical, typed service-role client accessor for the new Supabase-backed
 * tables (organizations, profiles, projects, project data, ...). Alias of
 * getSupabaseAdminClient(); same singleton. Returns null when env vars are
 * absent so callers can degrade gracefully to Redis-only behavior.
 */
export const getServiceRoleClient = getSupabaseAdminClient;

/**
 * Ensures a Supabase auth account exists for the given email with the given
 * plaintext password.  Creates the user if they don't exist in Supabase;
 * updates their password and metadata if they do.
 *
 * Marks email as pre-confirmed — no verification email is sent.
 * User metadata (role, firmName, etc.) is stored in the Supabase user record
 * for informational purposes; Redis remains the authoritative source.
 *
 * Returns true on success, false if the admin client is unavailable or if
 * the Supabase operation fails.  Callers must fall back to HMAC-only auth.
 */
export async function ensureSupabaseUser(
  email: string,
  password: string,
  metadata: {
    role:               'admin' | 'user';
    firmName?:          string;
    firmDomain?:        string;
    onboardingComplete?: boolean;
  },
): Promise<boolean> {
  const admin = getSupabaseAdminClient();
  if (!admin) return false;

  try {
    // Attempt to create the user; fall through to update if they already exist.
    const { error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm:  true,
      user_metadata:  metadata,
    });

    if (!createErr) return true;

    // User likely already exists — find by email and update password + metadata.
    // listUsers is acceptable here: this is an infrequent server-side operation
    // and B2B firms have tens, not millions, of users.
    const { data: listData, error: listErr } = await admin.auth.admin.listUsers({ perPage: 1000 });
    if (listErr || !listData?.users) return false;

    const existing = listData.users.find(
      u => u.email?.toLowerCase() === email.toLowerCase(),
    );
    if (!existing) return false;

    const { error: updateErr } = await admin.auth.admin.updateUserById(existing.id, {
      password,
      user_metadata: metadata,
    });
    return !updateErr;
  } catch {
    // Network error, wrong URL, etc. — fail open.
    return false;
  }
}
