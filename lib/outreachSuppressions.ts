// Global do-not-contact list for expert outreach.
//
// Backed by public.outreach_suppressions (service-role only, RLS enabled with
// no policies — see supabase/migrations/20260906000000_outreach_suppressions.sql).
//
// The check is keyed on the email address, not on a ProjectExpert: someone who
// declined or opted out in one project must never be cold-emailed from the next.
//
// FAIL-CLOSED BY DESIGN: isSuppressed() reports { ok: false } when the table
// cannot be read (no admin client, network error, Postgres error). Callers must
// treat that as "do not send" — never as "not suppressed". A send we cannot
// justify is worse than a send we skip.
//
// Never logs: the email address.

import { getServiceRoleClient } from './supabase/admin';

export type SuppressionReason = 'opt_out' | 'declined' | 'manual';

export type SuppressionCheck =
  | { ok: true;  suppressed: boolean }
  | { ok: false; reason: 'unavailable' };

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Is this address on the global do-not-contact list?
 *
 * Returns { ok: false } if the answer cannot be established — the caller must
 * refuse to send in that case (the start route answers 503
 * `suppression_check_failed`).
 */
export async function isSuppressed(email: string): Promise<SuppressionCheck> {
  const normalized = normalizeEmail(email);
  if (!normalized) return { ok: false, reason: 'unavailable' };

  const admin = getServiceRoleClient();
  if (!admin) {
    console.error('[outreachSuppressions] no service-role client — failing closed');
    return { ok: false, reason: 'unavailable' };
  }

  try {
    const { data, error } = await admin
      .from('outreach_suppressions')
      .select('email')
      .eq('email', normalized)
      .maybeSingle();

    if (error) {
      console.error('[outreachSuppressions] read error:', error.message.slice(0, 120));
      return { ok: false, reason: 'unavailable' };
    }
    return { ok: true, suppressed: data !== null };
  } catch (err) {
    console.error('[outreachSuppressions] read threw:',
      err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return { ok: false, reason: 'unavailable' };
  }
}

/**
 * Add an address to the do-not-contact list. Idempotent: a repeat opt-out
 * overwrites the existing row rather than erroring on the primary key.
 * Returns false if the write did not land.
 */
export async function suppress(
  email: string,
  reason: SuppressionReason,
  projectId?: string,
): Promise<boolean> {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;

  const admin = getServiceRoleClient();
  if (!admin) {
    console.error('[outreachSuppressions] no service-role client — suppression not recorded');
    return false;
  }

  try {
    const { error } = await admin
      .from('outreach_suppressions')
      .upsert(
        {
          email:             normalized,
          reason,
          source_project_id: projectId ?? null,
        },
        { onConflict: 'email' },
      );

    if (error) {
      console.error('[outreachSuppressions] write error:', error.message.slice(0, 120));
      return false;
    }
    return true;
  } catch (err) {
    console.error('[outreachSuppressions] write threw:',
      err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return false;
  }
}
