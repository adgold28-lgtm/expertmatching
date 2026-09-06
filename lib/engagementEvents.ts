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
