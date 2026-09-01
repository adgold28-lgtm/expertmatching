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
// Postgres (via this client) is the source of truth for durable domain data.
// The auth user's app_metadata carries a denormalized copy of the fields that
// middleware and route guards need on every request (role, status, firm,
// onboarding state) so no extra DB round-trip is required per request.
// app_metadata is writable ONLY by the service role — unlike user_metadata,
// which end users can rewrite via supabase.auth.updateUser() — so it is the
// only safe home for authorization data.

import { randomBytes } from 'crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './database.types';

let _adminClient: SupabaseClient<Database> | null = null;

/**
 * Returns a Supabase admin (service-role) client typed to the app schema, or
 * null if the required env vars are absent. Singleton — one client per process.
 *
 * The service-role key BYPASSES Row Level Security, so this client is the only
 * sanctioned way for server-side routes to read/write across organizations and
 * projects. NEVER import it into a client component.
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
 * Canonical, typed service-role client accessor. Alias of
 * getSupabaseAdminClient(); same singleton.
 */
export const getServiceRoleClient = getSupabaseAdminClient;

/**
 * Authorization metadata mirrored onto the auth user's app_metadata.
 * Snake_case keys — this is the wire format read by middleware and guards.
 */
export interface AppMetadata {
  role?:                'admin' | 'user';
  status?:              'pending' | 'active' | 'disabled';
  firm_domain?:         string;
  firm_name?:           string;
  first_name?:          string;
  onboarding_complete?: boolean;
  // True once a card is saved via the onboarding SetupIntent flow. Mirrored so
  // the onboarding gate can branch without a DB read. Never carries the Stripe
  // customer id — that stays server-side in profiles.
  billing_complete?:    boolean;
}

/** Looks up the auth user id (== profiles.id) for an email, or null. */
export async function getAuthUserIdByEmail(email: string): Promise<string | null> {
  const admin = getSupabaseAdminClient();
  if (!admin) return null;
  const { data, error } = await admin
    .from('profiles')
    .select('id')
    .eq('email', email.toLowerCase().trim())
    .maybeSingle();
  if (error || !data) return null;
  return data.id;
}

/**
 * Ensures a Supabase auth account exists for the given email, returning its
 * id (== profiles.id) or null on failure.
 *
 * - Creates the user (email pre-confirmed) if absent. New accounts without an
 *   explicit password get an unguessable random one — the invite set-password
 *   flow replaces it before first login.
 * - If `password` is provided and the user already exists, their password is
 *   updated (invite acceptance / admin reset).
 * - `metadata`, when provided, is merged into app_metadata.
 */
export async function ensureSupabaseUser(
  email: string,
  password: string | null,
  metadata?: AppMetadata,
): Promise<string | null> {
  const admin = getSupabaseAdminClient();
  if (!admin) return null;
  const normalized = email.toLowerCase().trim();

  try {
    const existingId = await getAuthUserIdByEmail(normalized);

    if (!existingId) {
      const { data, error } = await admin.auth.admin.createUser({
        email:         normalized,
        password:      password ?? randomBytes(24).toString('base64url'),
        email_confirm: true,
        ...(metadata ? { app_metadata: { ...metadata } } : {}),
      });
      if (error || !data.user) return null;
      return data.user.id;
    }

    if (password || metadata) {
      const patch: { password?: string; app_metadata?: Record<string, unknown> } = {};
      if (password) patch.password = password;
      if (metadata) {
        // Merge with the current app_metadata so partial updates don't drop keys.
        const { data: current } = await admin.auth.admin.getUserById(existingId);
        patch.app_metadata = { ...(current?.user?.app_metadata ?? {}), ...metadata };
      }
      const { error } = await admin.auth.admin.updateUserById(existingId, patch);
      if (error) return null;
    }
    return existingId;
  } catch {
    // Network error, wrong URL, etc.
    return null;
  }
}

/**
 * Merges the given fields into the auth user's app_metadata. No-op (false) if
 * the user does not exist or the admin client is unavailable.
 */
export async function syncAppMetadata(email: string, metadata: AppMetadata): Promise<boolean> {
  const id = await getAuthUserIdByEmail(email);
  if (!id) return false;
  const admin = getSupabaseAdminClient();
  if (!admin) return false;
  try {
    const { data: current } = await admin.auth.admin.getUserById(id);
    const { error } = await admin.auth.admin.updateUserById(id, {
      app_metadata: { ...(current?.user?.app_metadata ?? {}), ...metadata },
    });
    return !error;
  } catch {
    return false;
  }
}

/** Permanently deletes the auth user (cascades to profiles and memberships). */
export async function deleteSupabaseUser(email: string): Promise<boolean> {
  const id = await getAuthUserIdByEmail(email);
  if (!id) return false;
  const admin = getSupabaseAdminClient();
  if (!admin) return false;
  try {
    const { error } = await admin.auth.admin.deleteUser(id);
    return !error;
  } catch {
    return false;
  }
}
