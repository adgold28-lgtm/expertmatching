// lib/entitlements.ts — what an organization's account is allowed to do.
//
// ONE RULE, stated once: an organization may reach the outside world (email an
// expert, look up an address, book a call, create a Zoom meeting, charge a
// card, pay an expert) only when it has a card on file —
// organization_billing.billing_complete. Everything inside the product (sign
// in, onboard, write a brief, run sourcing, read anonymized candidates,
// bookmark, pass, read the walkthrough thread) is open to every active account.
//
// A TRIAL account is an organization a platform admin provisioned without a
// card. It is recorded on the same billing row the card would land on:
//
//   organization_billing.subscription_status = 'trialing'
//   organization_billing.billing_complete    = false
//
// Stripe's own vocabulary for a subscription that has not started paying, on
// the row Stripe will later own, so converting a trial is nothing more than the
// champion adding a card: POST /api/onboarding/billing/confirm sets
// billing_complete, syncOrgSeatQuantity starts the subscription and overwrites
// the status. No column, no migration, no second concept of "paid".
//
// Two things make this a boundary rather than a UI courtesy:
//
//   1. A project cannot leave WALKTHROUGH mode (lib/walkthrough.ts) while
//      canGoLive is false — PUT /api/projects/[id] refuses `walkthrough:false`
//      with 403 activation_required. Every send path already holds in
//      walkthrough, so a trial project never reaches an expert.
//   2. The chokepoints re-check anyway: lib/emailSequence.sendSequenceEmail,
//      lib/sendAvailabilityRequest.sendBookingEmail, lib/bookCall,
//      lib/createAndSendInvoice and the QStash workers all read
//      getEntitlementsForProject before doing the one thing they exist to do.
//      A route that forgot the first rule still cannot get past the second.
//
// Every refusal is recorded as a `restricted_action_attempted` product event
// (lib/productEvents.ts), which is exactly the moment a trial tester hit the
// paywall — the number we most want to know.

import type { SupabaseClient } from '@supabase/supabase-js';
import { getServiceRoleClient } from './supabase/admin';
import type { Database, OrganizationBillingRow } from './supabase/database.types';
import { trackProductEvent } from './productEvents';

export type AccountKind = 'trial' | 'customer';

/** The subscription_status value that marks a trial organization. */
export const TRIAL_SUBSCRIPTION_STATUS = 'trialing';

export interface Entitlements {
  organizationId:        string | null;
  kind:                  AccountKind;
  /** A default card is saved on the organization's Stripe customer. */
  billingComplete:       boolean;
  // ── Always on for an active account ─────────────────────────────────────
  canCreateProject:      true;
  canRunSourcing:        true;
  canViewCandidates:     true;
  canBookmarkCandidates: true;
  // ── Gated on the card ───────────────────────────────────────────────────
  /** Switch a project from walkthrough to live. */
  canGoLive:             boolean;
  /** Email an expert, look up an address, relay a message. */
  canOutreachExperts:    boolean;
  /** Propose times, book or move a call, create a Zoom meeting, send an .ics. */
  canScheduleCalls:      boolean;
  /** Charge the client's card, send an invoice, pay an expert. */
  canCharge:             boolean;
}

/** The action names a refusal is recorded under. Short enum strings, never prose. */
export type RestrictedAction =
  | 'go_live'
  | 'send_email'
  | 'send_booking_email'
  | 'book_call'
  | 'rebook_call'
  | 'charge_card'
  | 'contact_discovery'
  | 'send_nudge';

/** Copy shown wherever an action needs an activated account. */
export const ACTIVATION_REQUIRED_MESSAGE: Record<AccountKind, string> = {
  trial:    'Your trial covers everything up to outreach. Add your firm’s card in Settings → Payment method to go live — then Matchy can write to experts and book calls.',
  customer: 'Going live needs a card on file for your firm. Add one in Settings → Payment method.',
};

// ─── Pure ─────────────────────────────────────────────────────────────────────

type BillingShape = Pick<OrganizationBillingRow, 'billing_complete' | 'subscription_status'> | null | undefined;

/**
 * Entitlements from a billing row. Pure — the whole rule in one function.
 * No row at all is an organization that has never touched billing: a
 * customer who has not added a card yet, with everything external closed.
 */
export function entitlementsFromBilling(organizationId: string | null, row: BillingShape): Entitlements {
  const billingComplete = row?.billing_complete === true;
  const kind: AccountKind =
    !billingComplete && row?.subscription_status === TRIAL_SUBSCRIPTION_STATUS ? 'trial' : 'customer';
  return {
    organizationId,
    kind,
    billingComplete,
    canCreateProject:      true,
    canRunSourcing:        true,
    canViewCandidates:     true,
    canBookmarkCandidates: true,
    canGoLive:             billingComplete,
    canOutreachExperts:    billingComplete,
    canScheduleCalls:      billingComplete,
    canCharge:             billingComplete,
  };
}

/** What a user with no organization at all may do: nothing external. */
export const NO_ORG_ENTITLEMENTS: Entitlements = entitlementsFromBilling(null, null);

// ─── Lookups (service role; never throw) ──────────────────────────────────────

function db(): SupabaseClient<Database> | null {
  return getServiceRoleClient();
}

async function billingRowFor(organizationId: string): Promise<BillingShape> {
  const client = db();
  if (!client) return null;
  const { data, error } = await client
    .from('organization_billing')
    .select('billing_complete, subscription_status')
    .eq('organization_id', organizationId)
    .maybeSingle();
  if (error) {
    console.error('[entitlements] billing row read failed:', error.message.slice(0, 120));
    return null;
  }
  return data ?? null;
}

/** Entitlements for one organization. A read failure is "not activated". */
export async function getOrgEntitlements(organizationId: string | null | undefined): Promise<Entitlements> {
  if (!organizationId) return NO_ORG_ENTITLEMENTS;
  try {
    return entitlementsFromBilling(organizationId, await billingRowFor(organizationId));
  } catch (err) {
    console.error('[entitlements] org lookup failed:', err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return entitlementsFromBilling(organizationId, null);
  }
}

/**
 * Entitlements for the organization a user belongs to (first active membership).
 *
 * NOTE the membership choice differs from lib/firmStore.getMembership, which
 * takes the OLDEST membership whatever its status and is what feeds
 * app_metadata / the guards. For a profile in two organizations the two can
 * name different orgs. Only one caller uses this
 * (app/api/onboarding/profile); every other path resolves the org first and
 * calls getOrgEntitlements, which has no such ambiguity.
 */
export async function getEntitlementsForUser(email: string): Promise<Entitlements> {
  const client = db();
  if (!client || !email) return NO_ORG_ENTITLEMENTS;
  try {
    const { data: profile } = await client
      .from('profiles')
      .select('id')
      .eq('email', email.trim().toLowerCase())
      .maybeSingle();
    if (!profile) return NO_ORG_ENTITLEMENTS;

    const { data: memberships } = await client
      .from('organization_members')
      .select('organization_id, status, created_at')
      .eq('profile_id', profile.id)
      .order('created_at', { ascending: true });
    const membership = memberships?.find(m => m.status === 'active') ?? memberships?.[0] ?? null;
    return getOrgEntitlements(membership?.organization_id ?? null);
  } catch (err) {
    console.error('[entitlements] user lookup failed:', err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return NO_ORG_ENTITLEMENTS;
  }
}

/** Entitlements for the organization that owns a project. */
export async function getEntitlementsForProject(projectId: string): Promise<Entitlements> {
  const client = db();
  if (!client || !projectId) return NO_ORG_ENTITLEMENTS;
  try {
    const { data: project } = await client
      .from('projects')
      .select('organization_id')
      .eq('id', projectId)
      .maybeSingle();
    return getOrgEntitlements(project?.organization_id ?? null);
  } catch (err) {
    console.error('[entitlements] project lookup failed:', err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return NO_ORG_ENTITLEMENTS;
  }
}

// ─── Trial lifecycle ──────────────────────────────────────────────────────────

/**
 * Marks an organization as a trial: a billing row that says 'trialing' and has
 * no card. A no-op (true) when the org already has a card — an activated
 * customer is never demoted to a trial by a stray admin click.
 */
export async function startTrial(organizationId: string, startedByProfileId?: string | null): Promise<boolean> {
  const client = db();
  if (!client) return false;
  try {
    const existing = await billingRowFor(organizationId);
    if (existing?.billing_complete) return true;

    const { error } = await client
      .from('organization_billing')
      .upsert(
        {
          organization_id:     organizationId,
          billing_complete:    false,
          subscription_status: TRIAL_SUBSCRIPTION_STATUS,
          ...(startedByProfileId ? { set_up_by: startedByProfileId } : {}),
        },
        { onConflict: 'organization_id' },
      );
    if (error) {
      console.error('[entitlements] startTrial failed:', error.message.slice(0, 120));
      return false;
    }

    await trackProductEvent({ type: 'trial_started', organizationId, actorId: startedByProfileId ?? null });
    return true;
  } catch (err) {
    console.error('[entitlements] startTrial threw:', err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return false;
  }
}

// ─── Refusals ─────────────────────────────────────────────────────────────────

export interface RefusalContext {
  action:      RestrictedAction;
  /** The signed-in user who tried, when there is one (a webhook has none). */
  actorId?:    string | null;
  projectId?:  string | null;
  expertId?:   string | null;
}

/**
 * Records that an unactivated account reached for an external action. Never
 * throws; the caller still returns its own refusal.
 */
export async function recordRestrictedAttempt(ent: Entitlements, ctx: RefusalContext): Promise<void> {
  await trackProductEvent({
    type:           'restricted_action_attempted',
    actorId:        ctx.actorId ?? null,
    organizationId: ent.organizationId,
    projectId:      ctx.projectId ?? null,
    payload:        { action: ctx.action, kind: ent.kind, ...(ctx.expertId ? { expertId: ctx.expertId } : {}) },
  });
}

/**
 * The HTTP refusal every route returns for a gated action:
 * 403 { error: 'activation_required', action, kind, message }.
 */
export async function activationRequired(ent: Entitlements, ctx: RefusalContext): Promise<Response> {
  await recordRestrictedAttempt(ent, ctx);
  return Response.json(
    {
      error:   'activation_required',
      action:  ctx.action,
      kind:    ent.kind,
      message: ACTIVATION_REQUIRED_MESSAGE[ent.kind],
    },
    { status: 403 },
  );
}
