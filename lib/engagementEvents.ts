// The engagement event stream — Matchy's data asset.
//
// Every thing Matchy does or observes on an expert engagement writes one row to
// `engagement_events`: bookmarked, address found or not, intro sent, reply in,
// intent classified, rate offered / countered / agreed, conflict flagged, times
// proposed, scheduled, completed, charged, rejected, client-ready. Over time
// that stream is what tunes the opening rate per tier, re-weights sourcing on
// rejection reasons, and tells us how long each stage really takes.
//
// TWO RULES, both enforced here rather than trusted to callers:
//
//   1. NO PII, EVER. `payload` is typed as a record of numbers, booleans and
//      SHORT enum-like strings. At runtime, any string longer than
//      MAX_STRING_LEN is dropped from the payload before the insert, so a
//      caller that reaches for a research question, an expert name, a reply
//      body or an email address cannot get it into the table. Analytics needs
//      counts and categories; it never needs prose.
//
//   2. NEVER THROWS. Emitting an event is bookkeeping, never the point of the
//      request that triggered it. A failure logs one line (no payload, no ids
//      beyond the project id) and the caller carries on. Losing an event must
//      not lose a send, a booking or a charge.
//
// Writes go through the service-role client: `engagement_events` has RLS
// enabled with no authenticated policies at all (see
// supabase/migrations/20260907000000_matchy_phase1.sql), so a browser session
// can neither read nor write it.

import type { SupabaseClient } from '@supabase/supabase-js';
import { getServiceRoleClient } from './supabase/admin';
import type { EngagementEventType } from './supabase/database.types';

export type { EngagementEventType };

/**
 * The only value shapes an event payload may carry. Strings are for enum-like
 * labels ('senior', 'counter_rate', 'too_junior') — never sentences, never
 * anything a person wrote.
 */
export type EventPayloadValue = number | boolean | string | null;

export type EngagementEventPayload = Record<string, EventPayloadValue>;

/**
 * Longest string a payload value may be. Every enum label, tier name and
 * rejection reason in the product is comfortably under this; a name, an email
 * address or a sentence is not guaranteed to be, so anything longer is
 * dropped rather than truncated (a truncated name is still a name).
 */
export const MAX_STRING_LEN = 64;

/** Most keys one event may carry — a runaway payload is a bug, not a feature. */
const MAX_PAYLOAD_KEYS = 24;

export interface EmitEngagementEventInput {
  projectId: string;
  expertId:  string;
  /** organizations.id. Optional — events outlive the org, so this is best-effort. */
  orgId?:    string | null;
  type:      EngagementEventType;
  payload?:  EngagementEventPayload;
}

/**
 * Strips anything that could carry free text or PII:
 *   - drops undefined values and non-finite numbers
 *   - drops any string longer than MAX_STRING_LEN
 *   - drops nested objects and arrays outright (they are how prose sneaks in)
 *   - caps the number of keys
 *
 * Exported for scripts/tests; `emitEngagementEvent` always applies it.
 */
export function sanitizeEventPayload(payload: EngagementEventPayload | undefined): EngagementEventPayload {
  if (!payload) return {};

  const out: EngagementEventPayload = {};
  let dropped = 0;

  for (const [key, value] of Object.entries(payload)) {
    if (Object.keys(out).length >= MAX_PAYLOAD_KEYS) { dropped++; continue; }

    if (value === null) { out[key] = null; continue; }

    if (typeof value === 'number') {
      if (Number.isFinite(value)) out[key] = value;
      else dropped++;
      continue;
    }

    if (typeof value === 'boolean') { out[key] = value; continue; }

    if (typeof value === 'string') {
      if (value.length <= MAX_STRING_LEN) out[key] = value;
      else dropped++;
      continue;
    }

    // Objects, arrays, functions, undefined — never allowed.
    dropped++;
  }

  if (dropped > 0) {
    console.warn('[engagementEvents] dropped payload value(s) that were too long or not a scalar',
      JSON.stringify({ dropped }));
  }

  return out;
}

/**
 * Record one engagement event. Fire-and-forget by design: awaiting it is fine
 * (it is a single insert), but it resolves rather than rejects on every
 * failure, so no caller needs a try/catch around it.
 */
export async function emitEngagementEvent(input: EmitEngagementEventInput): Promise<void> {
  const { projectId, expertId, orgId, type } = input;

  if (!projectId || !expertId || !type) {
    console.warn('[engagementEvents] refusing to emit an event with no project, expert or type');
    return;
  }

  try {
    const db = getServiceRoleClient();
    if (!db) {
      // Development without Supabase credentials — the app runs on the
      // in-memory project store, so there is no table to write to.
      console.warn('[engagementEvents] no service-role client — event not recorded',
        JSON.stringify({ type }));
      return;
    }

    const { error } = await db.from('engagement_events').insert({
      project_id: projectId,
      expert_id:  expertId,
      org_id:     orgId ?? null,
      type,
      payload:    sanitizeEventPayload(input.payload) as never,
    });

    if (error) {
      console.warn('[engagementEvents] insert failed',
        JSON.stringify({ type, reason: error.message.slice(0, 120) }));
    }
  } catch (err) {
    console.warn('[engagementEvents] emit failed',
      JSON.stringify({ type, reason: err instanceof Error ? err.message.slice(0, 120) : 'unknown' }));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// System failures — the things this product used to swallow
// ═══════════════════════════════════════════════════════════════════════════
//
// A dozen catch blocks across the codebase are deliberately silent: a seat sync
// that cannot reach Stripe must not fail a membership change, a payout retry
// must not fail a webhook, a bounced notification must not fail an approval.
// That is the right call for the REQUEST — and the wrong call for the BUSINESS,
// because it means a firm can quietly stop being billed and nobody finds out.
//
// recordSystemFailure() is what those catch blocks call instead of nothing. It
// keeps the same contract they relied on (never throws, never blocks anything
// that matters) and turns the silence into a row an admin can see at
// GET /api/admin/attention.
//
// WHY A SEPARATE TABLE. `engagement_events` cannot hold these: project_id and
// expert_id are NOT NULL there, and its `type` column is check-constrained to
// the closed list of Matchy actions. Loosening either would weaken the
// guarantees that make the event stream trustworthy as a data asset. So system
// failures live in `public.system_events`
// (supabase/migrations/20260907100000_availability_windows_and_indexes.sql),
// which the code tolerates being absent — one warning, then silence, exactly as
// before the table existed.

/** Which subsystem failed. Deliberately coarse — this is a triage label. */
export type SystemFailureArea = 'seat_sync' | 'payout' | 'mail' | 'sourcing' | 'invoice' | 'nudge';

/** The only kind written today; the column is free-form so a later kind needs no migration. */
export const SYSTEM_FAILURE_KIND = 'system_failure';

export type SystemEventRow = {
  id:              string;
  kind:            string;
  area:            string;
  reason:          string;
  organization_id: string | null;
  project_id:      string | null;
  expert_id:       string | null;
  created_at:      string;
}

export type SystemEventInsert = {
  kind:             string;
  area:             string;
  reason:           string;
  organization_id?: string | null;
  project_id?:      string | null;
  expert_id?:       string | null;
}

/**
 * A minimal schema for the one table lib/supabase/database.types.ts does not
 * describe yet. Casting the service-role client to this keeps `system_events`
 * fully typed at both call sites without an `any` and without editing the
 * generated types file.
 */
export type SystemEventsSchema = {
  public: {
    Tables: {
      system_events: {
        Row:           SystemEventRow;
        Insert:        SystemEventInsert;
        Update:        Partial<SystemEventInsert>;
        Relationships: [];
      };
    };
    Views:          Record<string, never>;
    Functions:      Record<string, never>;
    Enums:          Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}

/** Service-role client typed for `system_events`, or null without credentials. */
export function getSystemEventsClient(): SupabaseClient<SystemEventsSchema> | null {
  const db = getServiceRoleClient();
  return db ? (db as unknown as SupabaseClient<SystemEventsSchema>) : null;
}

/** Longest stored reason. Long enough to be useful, short enough to not be prose. */
const MAX_REASON_LEN = 200;

/** Stripe object ids — never stored, they identify a customer. */
const STRIPE_ID_RE = /\b(?:sub|cus|acct|price|prod|si|in|pi|seti|pm|txn|tr)_[A-Za-z0-9]+/g;
/** Anything shaped like an email address — never stored. */
const EMAIL_RE = /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/g;

/**
 * A short, PII-free reason. Stripe object ids and email addresses are replaced
 * rather than dropped, so the shape of the failure survives the redaction.
 * Exported for the unit tests.
 */
export function sanitizeFailureReason(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value ?? '');
  const clean = raw
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(EMAIL_RE, '[email]')
    .replace(STRIPE_ID_RE, '[id]')
    .trim();
  return (clean || 'unknown').slice(0, MAX_REASON_LEN);
}

export interface RecordSystemFailureInput {
  area:            SystemFailureArea;
  /** Short reason, or the caught error itself — it is sanitized either way. */
  reason:          unknown;
  organizationId?: string | null;
  projectId?:      string | null;
  expertId?:       string | null;
}

/**
 * True once the table has been reported missing, so a deployment without the
 * migration logs one line rather than one per failure.
 */
let systemEventsTableReportedMissing = false;

/** Postgres/PostgREST codes for "that table is not there". */
function tableMissing(error: { code?: string; message?: string }): boolean {
  // 42P01 = undefined_table; PGRST205 = not found in PostgREST's schema cache.
  if (error.code === '42P01' || error.code === 'PGRST205') return true;
  return (error.message ?? '').includes('system_events');
}

/**
 * Records one swallowed failure. NEVER THROWS and never rejects — every caller
 * is a catch block whose whole point is that it must not fail.
 *
 * Callers should `await` it (it is a single insert) but nothing breaks if the
 * promise is dropped.
 */
export async function recordSystemFailure(input: RecordSystemFailureInput): Promise<void> {
  const area   = input.area;
  const reason = sanitizeFailureReason(input.reason);

  // The console line is not a fallback for the table — it is the log the
  // operator already had, kept so a tailed deploy log still shows the failure.
  console.warn('[systemEvents] failure', JSON.stringify({ area, reason }));

  try {
    const db = getSystemEventsClient();
    if (!db) return;   // Development without Supabase credentials.

    const { error } = await db.from('system_events').insert({
      kind:            SYSTEM_FAILURE_KIND,
      area,
      reason,
      organization_id: input.organizationId ?? null,
      project_id:      input.projectId      ?? null,
      expert_id:       input.expertId       ?? null,
    });

    if (!error) return;

    if (tableMissing(error)) {
      if (!systemEventsTableReportedMissing) {
        systemEventsTableReportedMissing = true;
        console.warn('[systemEvents] system_events table is absent — failures are logged only. '
          + 'Apply supabase/migrations/20260907100000_availability_windows_and_indexes.sql.');
      }
      return;
    }

    console.warn('[systemEvents] insert failed',
      JSON.stringify({ area, reason: error.message.slice(0, 120) }));
  } catch (err) {
    console.warn('[systemEvents] record failed',
      JSON.stringify({ area, reason: err instanceof Error ? err.message.slice(0, 120) : 'unknown' }));
  }
}
