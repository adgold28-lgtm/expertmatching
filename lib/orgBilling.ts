// lib/orgBilling.ts — organization-level Stripe billing.
//
// The ORGANIZATION is the paying entity. Each org has at most one Stripe
// customer (holding the firm's default card) and one per-seat subscription
// whose quantity always equals the org's active-seat count. Stripe prices the
// seats with the volume tiers in lib/pricing.ts (one tiered Price found by
// SEAT_PRICE_LOOKUP_KEY), so the monthly total is tier-correct automatically
// and prorated on every quantity change.
//
// State lives in public.organization_billing (service-role only — see
// supabase/migrations/20260902000000_org_billing_and_rls_hardening.sql).
// profiles.stripe_customer_id / billing_complete are LEGACY per-user fields
// kept only as a fallback for pre-existing accounts; new flows never write
// them.
//
// Required env vars:
//   STRIPE_SECRET_KEY, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//
// Every function here is best-effort towards callers that must not fail
// (membership changes, webhooks): those catch and log. Functions that gate a
// user-visible step (onboarding) throw so the route can 500 honestly.
//
// NEVER log: emails, names, Stripe customer / subscription / payment-method
// ids. Org ids, seat counts, and amounts are safe.

import type { OrganizationBillingRow } from './supabase/database.types';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OrgBillingStatus {
  organizationId:   string;
  /** A default payment method is saved on the org's Stripe customer. */
  billingComplete:  boolean;
  /** Mirror of the Stripe subscription status, or null before one exists. */
  subscriptionStatus: string | null;
  /** Active seats as last synced to Stripe. */
  seatQuantity:     number;
  /** Profile id of whoever saved the card, if known. */
  setUpBy:          string | null;
}

export interface SeatSyncResult {
  organizationId: string;
  activeSeats:    number;
  /** 'updated' when the Stripe quantity changed, 'unchanged' when it already
   *  matched, 'skipped' when the org has no completed billing yet. */
  outcome:        'updated' | 'unchanged' | 'skipped' | 'error';
}

// ─── Reads ────────────────────────────────────────────────────────────────────

/** Raw organization_billing row, or null if absent / unavailable. Never throws. */
export async function getOrgBillingRow(organizationId: string): Promise<OrganizationBillingRow | null> {
  void organizationId;
  throw new Error('[orgBilling] not implemented');
}

/** Billing status for an org. Never throws — returns a "not set up" status on error. */
export async function getOrgBillingStatus(organizationId: string): Promise<OrgBillingStatus> {
  void organizationId;
  throw new Error('[orgBilling] not implemented');
}

/**
 * The org id a user belongs to (first active membership), or null. Used by the
 * onboarding routes and /api/auth/me to resolve "is billing done for my firm".
 */
export async function getOrganizationIdForUser(email: string): Promise<string | null> {
  void email;
  throw new Error('[orgBilling] not implemented');
}

/**
 * Whether the user's firm has a card on file — org billing first, falling back
 * to the legacy per-user profile flag for accounts created before org billing.
 * Never throws.
 */
export async function isBillingCompleteForUser(email: string): Promise<boolean> {
  void email;
  throw new Error('[orgBilling] not implemented');
}

// ─── Stripe customer + SetupIntent (onboarding) ───────────────────────────────

/**
 * Ensures the org has a Stripe customer (creating it with the org name and the
 * given billing email) and returns the customer id. Persists immediately so a
 * later failure never strands the customer. Throws on Stripe / DB failure.
 */
export async function ensureOrgStripeCustomer(
  organizationId: string,
  billing: { email: string; orgName: string },
): Promise<string> {
  void organizationId; void billing;
  throw new Error('[orgBilling] not implemented');
}

/**
 * Called after a SetupIntent succeeded and was verified to belong to the org's
 * customer: makes the payment method the customer default, marks the org
 * billing_complete (recording who did it), and starts the seat subscription
 * (or syncs its quantity if one already exists). Throws on failure.
 */
export async function completeOrgBilling(
  organizationId: string,
  params: { paymentMethodId: string; setUpByProfileId: string | null },
): Promise<void> {
  void organizationId; void params;
  throw new Error('[orgBilling] not implemented');
}

// ─── Seat subscription ────────────────────────────────────────────────────────

/**
 * Finds or creates the tiered seat Price (lookup_key = SEAT_PRICE_LOOKUP_KEY)
 * and its Product. Idempotent. Throws on Stripe failure.
 */
export async function ensureSeatPrice(): Promise<string> {
  throw new Error('[orgBilling] not implemented');
}

/**
 * Makes the org's Stripe subscription quantity equal its active-seat count
 * (organization_members.status = 'active'). Creates the subscription on first
 * call once billing is complete; no-ops with 'skipped' when it is not. Never
 * throws — membership changes must succeed even if Stripe is down; the next
 * call (or the nightly reconcile) catches up.
 */
export async function syncOrgSeatQuantity(organizationId: string): Promise<SeatSyncResult> {
  void organizationId;
  throw new Error('[orgBilling] not implemented');
}

// ─── Webhook mirror ───────────────────────────────────────────────────────────

/**
 * Mirrors a Stripe subscription status change (customer.subscription.updated /
 * deleted, invoice.payment_failed) onto organization_billing. Looks the org up
 * by stripe_subscription_id; unknown subscriptions are ignored. Never throws.
 */
export async function recordSubscriptionStatus(
  stripeSubscriptionId: string,
  status: string,
): Promise<void> {
  void stripeSubscriptionId; void status;
  throw new Error('[orgBilling] not implemented');
}
