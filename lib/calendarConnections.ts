// lib/calendarConnections.ts — per-user calendar connections (service-role only).
//
// One row per user in public.user_calendar_connections (PK = profile_id), added
// by supabase/migrations/20260901000000_onboarding_billing_calendar.sql. The
// table has RLS enabled with NO authenticated policies — the access_requests
// pattern — so every read/write here goes through the service-role client and
// token ciphertext is unreachable from a browser session.
//
// Providers:
//   google   — AES-256-GCM ciphertext access/refresh tokens (lib/encryption.ts),
//              free/busy read at scheduling time via lib/fetchGoogleFreebusy.ts
//   calendly — a public scheduling URL, resolved lazily via lib/fetchCalendlySlots.ts
//   manual   — slots the user typed, stored as jsonb
//
// Required env vars (via lib/supabase/admin.ts + lib/encryption.ts):
//   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ENCRYPTION_KEY
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (token refresh inside fetchGoogleFreebusy)
//
// Every accessor fails soft: null / [] / false on any error, never throws — the
// scheduler runs in background paths where a throw would strand a project.
//
// NEVER logs: email addresses, calendar ids, tokens (plaintext or ciphertext),
// Calendly URLs, or slot times.

import { getServiceRoleClient, getAuthUserIdByEmail } from './supabase/admin';
import type { Json, UserCalendarConnectionRow }       from './supabase/database.types';
import { fetchGoogleFreebusy }                        from './fetchGoogleFreebusy';
import { fetchCalendlySlots }                         from './fetchCalendlySlots';
import type { AvailabilitySlot }                      from '../types';

// ─── Types ────────────────────────────────────────────────────────────────────

export type CalendarProvider = 'google' | 'calendly' | 'manual';

/**
 * A full connection write. `upsertCalendarConnection` REPLACES the row: any
 * provider-specific column not present here is written as NULL, so switching
 * providers never leaves stale ciphertext or a stale Calendly URL behind.
 * Token fields carry ciphertext produced by lib/encryption.ts — never plaintext.
 */
export interface CalendarConnectionInput {
  provider:       CalendarProvider;
  accessToken?:   string | null;   // AES-256-GCM ciphertext
  refreshToken?:  string | null;   // AES-256-GCM ciphertext
  tokenExpiry?:   number | null;   // Unix epoch milliseconds
  calendarEmail?: string | null;
  calendlyUrl?:   string | null;
  manualSlots?:   AvailabilitySlot[] | null;
  timezone?:      string | null;   // IANA zone, e.g. 'America/New_York'
  oauthState?:    string | null;   // in-flight OAuth nonce; cleared on success
}

const DEFAULT_WINDOW_DAYS = 14;
const MAX_MANUAL_SLOTS    = 60;
const MAX_TIMEZONE_CHARS  = 64;

// ─── Timezone validation ──────────────────────────────────────────────────────

/**
 * Returns a valid IANA timezone name, or null. Validated against the runtime's
 * own zone database via Intl — no hardcoded list to fall out of date, and an
 * attacker-supplied value can never reach the column.
 */
export function normalizeTimezone(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const tz = value.trim();
  if (!tz || tz.length > MAX_TIMEZONE_CHARS) return null;
  if (!/^[A-Za-z0-9_+\-/]+$/.test(tz)) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

// ─── jsonb ⇄ AvailabilitySlot ─────────────────────────────────────────────────

/**
 * Narrows a jsonb value read from `manual_slots` into AvailabilitySlot[].
 * Anything malformed is dropped rather than trusted — the column is written by
 * this app, but a hand-edited row must not be able to crash the scheduler.
 */
function slotsFromJson(value: Json | null): AvailabilitySlot[] {
  if (!Array.isArray(value)) return [];

  const slots: AvailabilitySlot[] = [];

  for (const item of value) {
    if (slots.length >= MAX_MANUAL_SLOTS) break;
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;

    const startTime = typeof item.startTime === 'string' ? item.startTime : '';
    const endTime   = typeof item.endTime   === 'string' ? item.endTime   : '';
    if (!startTime || !endTime) continue;

    const confidence = item.confidence;

    slots.push({
      startTime,
      endTime,
      timezone: typeof item.timezone === 'string' && item.timezone ? item.timezone : 'UTC',
      ...(typeof item.dayOfWeek === 'string' ? { dayOfWeek: item.dayOfWeek } : {}),
      ...(typeof item.date      === 'string' ? { date:      item.date      } : {}),
      ...(confidence === 'high' || confidence === 'medium' || confidence === 'low'
        ? { confidence }
        : {}),
    });
  }

  return slots;
}

/** Builds a jsonb-safe representation of a slot (no implicit index signature on the interface). */
function slotToJson(slot: AvailabilitySlot): Json {
  const out: { [key: string]: Json } = {
    startTime: slot.startTime,
    endTime:   slot.endTime,
    timezone:  slot.timezone,
  };
  if (slot.dayOfWeek)  out.dayOfWeek  = slot.dayOfWeek;
  if (slot.date)       out.date       = slot.date;
  if (slot.confidence) out.confidence = slot.confidence;
  return out;
}

// ─── Reads ────────────────────────────────────────────────────────────────────

/** Returns the caller's calendar connection row, or null if absent/unavailable. */
export async function getCalendarConnection(
  email: string,
): Promise<UserCalendarConnectionRow | null> {
  const db = getServiceRoleClient();
  if (!db) return null;

  try {
    const profileId = await getAuthUserIdByEmail(email);
    if (!profileId) return null;

    const { data, error } = await db
      .from('user_calendar_connections')
      .select('*')
      .eq('profile_id', profileId)
      .maybeSingle();

    if (error || !data) return null;
    return data;
  } catch (err) {
    console.error('[calendarConnections] read error:',
      err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return null;
  }
}

/**
 * True when a row represents a connection the scheduler can actually use:
 *   google   → an offline refresh token is on file
 *   calendly → a scheduling URL is on file
 *   manual   → at least one usable slot is on file
 * A row that only holds an in-flight `oauth_state` is NOT connected.
 */
export function connectionIsUsable(
  row: UserCalendarConnectionRow | null,
): row is UserCalendarConnectionRow {
  if (!row) return false;
  switch (row.provider) {
    case 'google':   return Boolean(row.refresh_token);
    case 'calendly': return Boolean(row.calendly_url);
    case 'manual':   return slotsFromJson(row.manual_slots).length > 0;
    default:         return false;
  }
}

/** Convenience wrapper — one read, boolean answer. */
export async function isCalendarConnected(email: string): Promise<boolean> {
  return connectionIsUsable(await getCalendarConnection(email));
}

// ─── Writes ───────────────────────────────────────────────────────────────────

/**
 * Creates or REPLACES the caller's calendar connection. Provider-specific
 * columns absent from `input` are written as NULL — re-linking overwrites,
 * matching the one-row-per-user design of the table.
 *
 * Returns false (never throws) when the profile or the admin client is missing,
 * or the write fails.
 */
export async function upsertCalendarConnection(
  email: string,
  input: CalendarConnectionInput,
): Promise<boolean> {
  const db = getServiceRoleClient();
  if (!db) return false;

  try {
    const profileId = await getAuthUserIdByEmail(email);
    if (!profileId) return false;

    const manualSlots = input.manualSlots?.length
      ? input.manualSlots.slice(0, MAX_MANUAL_SLOTS).map(slotToJson)
      : null;

    const { error } = await db
      .from('user_calendar_connections')
      .upsert({
        profile_id:     profileId,
        provider:       input.provider,
        access_token:   input.accessToken   ?? null,
        refresh_token:  input.refreshToken  ?? null,
        token_expiry:   input.tokenExpiry   ?? null,
        calendar_email: input.calendarEmail ?? null,
        calendly_url:   input.calendlyUrl   ?? null,
        manual_slots:   manualSlots,
        timezone:       input.timezone      ?? null,
        oauth_state:    input.oauthState    ?? null,
      }, { onConflict: 'profile_id' });

    if (error) {
      console.error('[calendarConnections] upsert failed:', error.message.slice(0, 120));
      return false;
    }
    return true;
  } catch (err) {
    console.error('[calendarConnections] upsert error:',
      err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return false;
  }
}

/** Removes the caller's calendar connection entirely. Returns false on failure. */
export async function deleteCalendarConnection(email: string): Promise<boolean> {
  const db = getServiceRoleClient();
  if (!db) return false;

  try {
    const profileId = await getAuthUserIdByEmail(email);
    if (!profileId) return false;

    const { error } = await db
      .from('user_calendar_connections')
      .delete()
      .eq('profile_id', profileId);

    if (error) {
      console.error('[calendarConnections] delete failed:', error.message.slice(0, 120));
      return false;
    }
    return true;
  } catch (err) {
    console.error('[calendarConnections] delete error:',
      err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return false;
  }
}

/**
 * Persists the CSRF nonce for an in-flight Google authorization round-trip.
 *
 * Deliberately a PARTIAL write, unlike upsertCalendarConnection: if the user
 * already has a working Calendly or manual connection and then abandons the
 * Google consent screen, that connection must survive. Only when no row exists
 * is a pending `provider: 'google'` row inserted (tokens NULL, so
 * connectionIsUsable() still reports it as not connected).
 *
 * The nonce must live in Postgres, not a module-level variable — on Vercel the
 * callback can land on a different lambda instance than the initiate request.
 */
export async function setOauthState(email: string, nonce: string | null): Promise<boolean> {
  const db = getServiceRoleClient();
  if (!db) return false;

  try {
    const profileId = await getAuthUserIdByEmail(email);
    if (!profileId) return false;

    const { data: existing } = await db
      .from('user_calendar_connections')
      .select('profile_id')
      .eq('profile_id', profileId)
      .maybeSingle();

    const { error } = existing
      ? await db
          .from('user_calendar_connections')
          .update({ oauth_state: nonce })
          .eq('profile_id', profileId)
      : await db
          .from('user_calendar_connections')
          .insert({ profile_id: profileId, provider: 'google', oauth_state: nonce });

    if (error) {
      console.error('[calendarConnections] oauth state write failed:', error.message.slice(0, 120));
      return false;
    }
    return true;
  } catch (err) {
    console.error('[calendarConnections] oauth state error:',
      err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return false;
  }
}

/**
 * Partial write used by the freebusy token-refresh callback: rotates the stored
 * access-token ciphertext and its expiry without disturbing the refresh token,
 * calendar email, or timezone.
 */
export async function updateGoogleAccessToken(
  email:                string,
  encryptedAccessToken: string,
  tokenExpiry:          number,
): Promise<boolean> {
  const db = getServiceRoleClient();
  if (!db) return false;

  try {
    const profileId = await getAuthUserIdByEmail(email);
    if (!profileId) return false;

    const { error } = await db
      .from('user_calendar_connections')
      .update({ access_token: encryptedAccessToken, token_expiry: tokenExpiry })
      .eq('profile_id', profileId);

    if (error) {
      console.error('[calendarConnections] token rotate failed:', error.message.slice(0, 120));
      return false;
    }
    return true;
  } catch (err) {
    console.error('[calendarConnections] token rotate error:',
      err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return false;
  }
}

// ─── Scheduling ───────────────────────────────────────────────────────────────

/**
 * Resolves the user's availability for the next `windowDays` days from whichever
 * provider they linked during onboarding. Returns [] when no connection exists
 * or the provider lookup fails — never throws, so the overlap check can fall
 * back to the project-level paths.
 */
export async function getClientSlotsForUser(
  email:      string,
  windowDays: number = DEFAULT_WINDOW_DAYS,
): Promise<AvailabilitySlot[]> {
  try {
    const row = await getCalendarConnection(email);
    if (!row) return [];

    if (row.provider === 'google') {
      if (!row.access_token || !row.refresh_token || !row.calendar_email) return [];
      return await fetchGoogleFreebusy(
        row.access_token,
        row.refresh_token,
        row.calendar_email,
        windowDays,
        async (newEncryptedAccessToken, newExpiry) => {
          await updateGoogleAccessToken(email, newEncryptedAccessToken, newExpiry);
        },
      );
    }

    if (row.provider === 'calendly') {
      if (!row.calendly_url) return [];
      return await fetchCalendlySlots(row.calendly_url, windowDays);
    }

    return slotsFromJson(row.manual_slots);
  } catch (err) {
    console.error('[calendarConnections] slot lookup error:',
      err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return [];
  }
}
