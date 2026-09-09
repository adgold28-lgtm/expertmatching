// lib/productEvents.ts — what people DO in the product, one row per action.
//
// engagement_events is Matchy's record of an EXPERT engagement: it needs a
// project and an expert on every row and its `type` is a closed list of things
// Matchy did. It cannot say "this user signed in", "finished onboarding" or
// "ran sourcing" — the funnel a trial tester walks. That is what this table is.
//
//   product_events (supabase/migrations/20260908000000_…sql)
//     actor_id        profiles.id of the person who did it (null for a system
//                     actor such as a QStash worker)
//     organization_id the account it happened in
//     project_id      when the action was on a project
//     type            one of ProductEventType
//     payload         numbers, booleans and short enum strings — the same
//                     sanitizer engagement_events uses, so no name, email,
//                     brief text or reply body can land here
//
// Read it with scripts/trial-report.ts <email>, which prints one tester's
// timeline and funnel.
//
// Rules: never throws (bookkeeping never fails the request), tolerates the
// table not existing yet (one warning, then silence), never stores prose.

import type { SupabaseClient } from '@supabase/supabase-js';
import { getServiceRoleClient } from './supabase/admin';
import type { Database } from './supabase/database.types';
import { sanitizeEventPayload, type EngagementEventPayload } from './engagementEvents';

export type ProductEventType =
  // account
  | 'account_invited'
  | 'account_activated'
  | 'signed_in'
  | 'trial_started'
  | 'onboarding_step_completed'   // payload.step: calendar | billing | profile
  | 'onboarding_completed'
  // projects
  | 'project_created'
  | 'project_opened'
  | 'project_deleted'
  | 'brief_saved'
  | 'sourcing_started'
  | 'sourcing_completed'          // payload.count, payload.durationMs
  | 'sourcing_failed'
  // candidates
  | 'candidate_bookmarked'
  | 'candidate_unbookmarked'
  | 'candidate_passed'
  | 'candidate_unpassed'
  // the paywall
  | 'restricted_action_attempted' // payload.action, payload.kind
  | 'went_live';

export interface TrackProductEventInput {
  type:            ProductEventType;
  actorId?:        string | null;
  /** Resolved to actor_id when actorId is not at hand. Never stored itself. */
  actorEmail?:     string | null;
  organizationId?: string | null;
  projectId?:      string | null;
  payload?:        EngagementEventPayload;
}

let tableReportedMissing = false;

function tableMissing(error: { code?: string; message?: string }): boolean {
  return error.code === '42P01' || error.code === 'PGRST205'
    || /relation .* does not exist|Could not find the table/i.test(error.message ?? '');
}

async function resolveActorId(client: SupabaseClient<Database>, input: TrackProductEventInput): Promise<string | null> {
  if (input.actorId) return input.actorId;
  if (!input.actorEmail) return null;
  const { data } = await client
    .from('profiles')
    .select('id')
    .eq('email', input.actorEmail.trim().toLowerCase())
    .maybeSingle();
  return data?.id ?? null;
}

/** Records one product event. Resolves on every failure; never rejects. */
export async function trackProductEvent(input: TrackProductEventInput): Promise<void> {
  if (!input.type) return;
  try {
    const client = getServiceRoleClient();
    if (!client) return;

    const actorId = await resolveActorId(client, input);
    const { error } = await client.from('product_events').insert({
      type:            input.type,
      actor_id:        actorId,
      organization_id: input.organizationId ?? null,
      project_id:      input.projectId ?? null,
      payload:         sanitizeEventPayload(input.payload) as Database['public']['Tables']['product_events']['Insert']['payload'],
    });
    if (!error) return;

    if (tableMissing(error)) {
      if (!tableReportedMissing) {
        tableReportedMissing = true;
        console.warn('[productEvents] product_events table is absent — usage is not being recorded. '
          + 'Apply supabase/migrations/20260908000000_identity_boundary_trial_events.sql.');
      }
      return;
    }
    console.warn('[productEvents] insert failed', JSON.stringify({ type: input.type, reason: error.message.slice(0, 120) }));
  } catch (err) {
    console.warn('[productEvents] track failed',
      JSON.stringify({ type: input.type, reason: err instanceof Error ? err.message.slice(0, 120) : 'unknown' }));
  }
}
