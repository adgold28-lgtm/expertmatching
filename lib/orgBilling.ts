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

import type Stripe from 'stripe';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getServiceRoleClient, getAuthUserIdByEmail } from './supabase/admin';
import type { Database, OrganizationBillingRow } from './supabase/database.types';
import { stripe } from './stripe';
import { recordSystemFailure } from './engagementEvents';
import {
  SEAT_CURRENCY,
  SEAT_PRICE_LOOKUP_KEY,
  SEAT_PRODUCT_NAME,
  normalizeSeatCount,
  stripeVolumeTiers,
} from './pricing';

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

/** Org + billing context for one user, resolved in a single place. */
export interface UserBillingSummary {
  organizationId:    string | null;
  orgName:           string | null;
  /** Org card on file, or the legacy per-user flag for pre-org accounts. */
  billingComplete:   boolean;
  /** True when THIS user is the one who saved the firm's card. */
  billingSetUpByYou: boolean;
}

// Deterministic Stripe Product id for the seat product. Using the price lookup
// key as the product id turns "find or create the product" into a single
// retrieve — no name search, no duplicate products across processes or deploys.
const SEAT_PRODUCT_ID = SEAT_PRICE_LOOKUP_KEY;

/** Per-process cache of the seat Price id (an id, never a secret). */
let cachedSeatPriceId: string | null = null;

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Service-role client, or null when the Supabase env vars are absent. */
function serviceClient(): SupabaseClient<Database> | null {
  return getServiceRoleClient();
}

/** Same client, for the paths that must fail loudly (onboarding). */
function requireServiceClient(): SupabaseClient<Database> {
  const db = serviceClient();
  if (!db) throw new Error('[orgBilling] Supabase service role unavailable');
  return db;
}

function normEmail(email: string): string {
  return email.toLowerCase().trim();
}

/** Short, PII-free error line — never includes ids that identify a customer. */
function logFailure(scope: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[orgBilling] ${scope} failed:`, msg.slice(0, 120));
}

/** Stripe error code, when the thrown value looks like a Stripe API error. */
function stripeErrorCode(err: unknown): string {
  if (typeof err !== 'object' || err === null) return '';
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : '';
}

// ─── Pure helpers (unit-tested in scripts/test-org-billing.ts) ────────────────

/**
 * Idempotency key for the one-and-only cancellation of an org's seat
 * subscription. Deterministic per org so a retried admin delete cannot bill a
 * second proration invoice. Pure.
 */
export function orgCancelIdempotencyKey(organizationId: string): string {
  return `org-cancel:${organizationId}`;
}

/** The shape of a Stripe subscription this module needs in order to adopt it. */
export interface AdoptableSubscriptionView {
  id:     string;
  status: string;
  items:  { data: Array<{ id: string; price?: { id?: string } | null; quantity?: number | null }> };
}

/** Subscription statuses that still bill (or will bill) the customer. */
const LIVE_SUBSCRIPTION_STATUSES = new Set([
  'active', 'trialing', 'past_due', 'unpaid', 'incomplete', 'paused',
]);

/**
 * H-23: the seat subscription this org ALREADY has at Stripe, if any.
 *
 * The create below carries idempotency key `seat-sub:<orgId>`, and Stripe only
 * remembers a key for about 24 hours — exactly the interval the reconcile cron
 * runs on. So if the row write after a successful create ever fails, the next
 * night's sweep sees no recorded subscription, replays a key Stripe has already
 * forgotten, and creates a SECOND live subscription for the same customer. This
 * check is the fix: before creating, look at what the customer actually has and
 * adopt it.
 *
 * A subscription qualifies when it is not canceled or expired AND it carries a
 * line for the seat price. The first match wins; a customer with two of them is
 * already the bug this prevents, and adopting one of them at least stops the
 * count growing (the duplicate is a dashboard clean-up). Pure.
 */
export function pickAdoptableSubscription<T extends AdoptableSubscriptionView>(
  subscriptions: T[],
  priceId:       string,
): T | null {
  for (const sub of subscriptions) {
    if (!LIVE_SUBSCRIPTION_STATUSES.has(sub.status)) continue;
    const hasSeatLine = sub.items.data.some(item => item.price?.id === priceId);
    if (hasSeatLine) return sub;
  }
  return null;
}

/**
 * Last four characters of a Stripe id — enough to find the object in the
 * dashboard, short enough not to be the id itself in a log or an events row.
 * Pure.
 */
export function stripeIdTail(id: string): string {
  return id.length <= 4 ? id : id.slice(-4);
}

/** Stripe object ids (sub_…, cus_…, acct_…) — stripped before a reason is surfaced. */
const STRIPE_ID_RE = /\b(?:sub|cus|acct|price|prod|si|in|pi|seti|pm|txn|tr)_[A-Za-z0-9]+/g;

/**
 * Short, id-free reason for a failed Stripe call, safe to log and to hand to an
 * admin UI: the Stripe error code when there is one, otherwise the message with
 * every Stripe object id redacted. Pure.
 */
export function stripeFailureReason(err: unknown): string {
  const code = stripeErrorCode(err);
  if (code) return code;
  const msg = err instanceof Error ? err.message : String(err);
  const clean = msg.replace(STRIPE_ID_RE, '[id]').trim();
  return clean.length > 0 ? clean.slice(0, 120) : 'stripe_error';
}

type BillingPatch = Database['public']['Tables']['organization_billing']['Update'];

/** Patches the org's billing row. Returns false (and logs) on failure. */
async function patchBillingRow(organizationId: string, patch: BillingPatch): Promise<boolean> {
  try {
    const db = serviceClient();
    if (!db) return false;
    const { error } = await db
      .from('organization_billing')
      .update(patch)
      .eq('organization_id', organizationId);
    if (error) {
      console.error('[orgBilling] billing row update failed:', error.message.slice(0, 120));
      return false;
    }
    return true;
  } catch (err) {
    logFailure('patchBillingRow', err);
    return false;
  }
}

/**
 * patchBillingRow with two retries, for the ONE write that must not be lost:
 * the subscription id of a subscription Stripe has just created. A row that
 * does not know its subscription is what turns a transient Postgres blip into a
 * second live subscription the next night (H-23).
 */
async function patchBillingRowWithRetry(
  organizationId: string,
  patch:          BillingPatch,
  attempts        = 3,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await patchBillingRow(organizationId, patch)) return true;
  }
  return false;
}

// ─── Reads ────────────────────────────────────────────────────────────────────

/** Raw organization_billing row, or null if absent / unavailable. Never throws. */
export async function getOrgBillingRow(organizationId: string): Promise<OrganizationBillingRow | null> {
  if (!organizationId) return null;
  try {
    const db = serviceClient();
    if (!db) return null;
    const { data, error } = await db
      .from('organization_billing')
      .select('*')
      .eq('organization_id', organizationId)
      .maybeSingle();
    if (error) {
      console.error('[orgBilling] billing row read failed:', error.message.slice(0, 120));
      return null;
    }
    return data ?? null;
  } catch (err) {
    logFailure('getOrgBillingRow', err);
    return null;
  }
}

/** Billing status for an org. Never throws — returns a "not set up" status on error. */
export async function getOrgBillingStatus(organizationId: string): Promise<OrgBillingStatus> {
  const row = await getOrgBillingRow(organizationId);
  return {
    organizationId,
    billingComplete:    row?.billing_complete === true,
    subscriptionStatus: row?.subscription_status ?? null,
    seatQuantity:       row?.seat_quantity_synced ?? 0,
    setUpBy:            row?.set_up_by ?? null,
  };
}

/** Display name of an organization, or null. Never throws. */
export async function getOrganizationName(organizationId: string): Promise<string | null> {
  if (!organizationId) return null;
  try {
    const db = serviceClient();
    if (!db) return null;
    const { data } = await db
      .from('organizations')
      .select('name')
      .eq('id', organizationId)
      .maybeSingle();
    return data?.name ?? null;
  } catch (err) {
    logFailure('getOrganizationName', err);
    return null;
  }
}

/**
 * The org id a user belongs to (first active membership), or null. Used by the
 * onboarding routes and /api/auth/me to resolve "is billing done for my firm".
 *
 * Falls back to the oldest membership of any status, so a user whose seat is
 * still 'pending' mid-onboarding still resolves to their firm.
 */
export async function getOrganizationIdForUser(email: string): Promise<string | null> {
  if (!email) return null;
  try {
    const db = serviceClient();
    if (!db) return null;
    const profileId = await getAuthUserIdByEmail(normEmail(email));
    if (!profileId) return null;

    const { data, error } = await db
      .from('organization_members')
      .select('organization_id,status,created_at')
      .eq('profile_id', profileId)
      .order('created_at', { ascending: true });
    if (error || !data || data.length === 0) return null;

    const active = data.find(m => m.status === 'active');
    return (active ?? data[0]).organization_id;
  } catch (err) {
    logFailure('getOrganizationIdForUser', err);
    return null;
  }
}

/** Active seats (organization_members.status = 'active'). 0 on failure. */
export async function countActiveSeats(organizationId: string): Promise<number> {
  if (!organizationId) return 0;
  try {
    const db = serviceClient();
    if (!db) return 0;
    const { count, error } = await db
      .from('organization_members')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', organizationId)
      .eq('status', 'active');
    if (error) {
      console.error('[orgBilling] seat count failed:', error.message.slice(0, 120));
      return 0;
    }
    return normalizeSeatCount(count ?? 0);
  } catch (err) {
    logFailure('countActiveSeats', err);
    return 0;
  }
}

/**
 * Org + billing context for one user, in one place so /api/auth/me, the
 * onboarding step, and the profile gate all agree. Never throws; degrades to
 * "no org, not complete" when Supabase is unavailable.
 */
export async function getUserBillingSummary(email: string): Promise<UserBillingSummary> {
  const empty: UserBillingSummary = {
    organizationId: null, orgName: null, billingComplete: false, billingSetUpByYou: false,
  };
  if (!email) return empty;

  try {
    const db = serviceClient();
    if (!db) return empty;

    const { data: profile } = await db
      .from('profiles')
      .select('id,billing_complete')
      .eq('email', normEmail(email))
      .maybeSingle();
    if (!profile) return empty;

    const { data: memberships } = await db
      .from('organization_members')
      .select('organization_id,status,created_at')
      .eq('profile_id', profile.id)
      .order('created_at', { ascending: true });

    const membership = memberships?.find(m => m.status === 'active') ?? memberships?.[0] ?? null;
    const organizationId = membership?.organization_id ?? null;
    if (!organizationId) {
      // Legacy account with no org: the per-user flag is all there is.
      return { ...empty, billingComplete: profile.billing_complete === true };
    }

    const [orgName, row] = await Promise.all([
      getOrganizationName(organizationId),
      getOrgBillingRow(organizationId),
    ]);

    const orgComplete = row?.billing_complete === true;
    return {
      organizationId,
      orgName,
      // Org billing wins; the legacy per-user flag keeps pre-org accounts working.
      billingComplete:   orgComplete || profile.billing_complete === true,
      billingSetUpByYou: orgComplete && row?.set_up_by === profile.id,
    };
  } catch (err) {
    logFailure('getUserBillingSummary', err);
    return empty;
  }
}

/**
 * Whether the user's firm has a card on file — org billing first, falling back
 * to the legacy per-user profile flag for accounts created before org billing.
 * Never throws.
 */
export async function isBillingCompleteForUser(email: string): Promise<boolean> {
  const summary = await getUserBillingSummary(email);
  return summary.billingComplete;
}

/**
 * The Stripe customer that should pay for a project's calls: the ORG customer
 * of the project's organization, but only once that org has a card on file.
 * Null means "fall back to the legacy per-user customer". Never throws.
 */
export async function getBillingCustomerForProject(projectId: string): Promise<string | null> {
  if (!projectId) return null;
  try {
    const db = serviceClient();
    if (!db) return null;
    const { data: project } = await db
      .from('projects')
      .select('organization_id')
      .eq('id', projectId)
      .maybeSingle();
    const organizationId = project?.organization_id;
    if (!organizationId) return null;

    const row = await getOrgBillingRow(organizationId);
    if (!row?.billing_complete || !row.stripe_customer_id) return null;
    return row.stripe_customer_id;
  } catch (err) {
    logFailure('getBillingCustomerForProject', err);
    return null;
  }
}

// ─── Stripe customer + SetupIntent (onboarding) ───────────────────────────────

/**
 * Ensures the org has a Stripe customer (creating it with the org name and the
 * given billing email) and returns the customer id. Persists immediately so a
 * later failure never strands the customer. Throws on Stripe / DB failure.
 *
 * Idempotency: `org-customer:<orgId>` means two colleagues racing through
 * onboarding get ONE customer — Stripe replays the first response for the
 * duplicate request instead of creating a second customer for the firm.
 */
export async function ensureOrgStripeCustomer(
  organizationId: string,
  billing: { email: string; orgName: string },
): Promise<string> {
  if (!organizationId) throw new Error('[orgBilling] organizationId required');
  const db = requireServiceClient();

  const existing = await getOrgBillingRow(organizationId);
  if (existing?.stripe_customer_id) return existing.stripe_customer_id;

  const customer = await stripe.customers.create(
    {
      name:     billing.orgName,
      email:    billing.email,
      metadata: { organizationId },
    },
    { idempotencyKey: `org-customer:${organizationId}` },
  );

  // Persist immediately so a failure below never strands the customer. upsert
  // (not insert) because the row may already exist from an earlier partial run.
  const { error } = await db
    .from('organization_billing')
    .upsert(
      {
        organization_id:    organizationId,
        stripe_customer_id: customer.id,
        billing_email:      billing.email,
      },
      { onConflict: 'organization_id' },
    );
  if (error) throw new Error(`[orgBilling] could not persist customer: ${error.message.slice(0, 80)}`);

  return customer.id;
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
  const row = await getOrgBillingRow(organizationId);
  const customerId = row?.stripe_customer_id;
  if (!customerId) throw new Error('[orgBilling] organization has no Stripe customer');

  await stripe.customers.update(customerId, {
    invoice_settings: { default_payment_method: params.paymentMethodId },
  });

  const db = requireServiceClient();
  const { error } = await db
    .from('organization_billing')
    .update({
      billing_complete: true,
      ...(params.setUpByProfileId ? { set_up_by: params.setUpByProfileId } : {}),
    })
    .eq('organization_id', organizationId);
  if (error) throw new Error(`[orgBilling] could not mark billing complete: ${error.message.slice(0, 80)}`);

  // Starts (or corrects) the seat subscription. Never throws: a Stripe outage
  // here must not fail onboarding — the next membership change, or a manual
  // reconcile, catches up.
  await syncOrgSeatQuantity(organizationId);
}

// ─── Seat subscription ────────────────────────────────────────────────────────

/** Find-or-create the seat Product at a deterministic id. Throws on failure. */
async function ensureSeatProduct(): Promise<string> {
  try {
    const product = await stripe.products.retrieve(SEAT_PRODUCT_ID);
    return product.id;
  } catch (err) {
    if (stripeErrorCode(err) !== 'resource_missing') throw err;
  }

  try {
    const created = await stripe.products.create({
      id:   SEAT_PRODUCT_ID,
      name: SEAT_PRODUCT_NAME,
    });
    return created.id;
  } catch (err) {
    // Another process created it between the retrieve and the create.
    if (stripeErrorCode(err) === 'resource_already_exists') return SEAT_PRODUCT_ID;
    throw err;
  }
}

/**
 * Finds or creates the tiered seat Price (lookup_key = SEAT_PRICE_LOOKUP_KEY)
 * and its Product. Idempotent. Throws on Stripe failure.
 *
 * A Stripe Price is immutable, so the tiers from lib/pricing.ts are written
 * once under this lookup key. Changing the tiers means bumping the key so a new
 * Price is created — which is exactly what its version suffix is for.
 */
export async function ensureSeatPrice(): Promise<string> {
  if (cachedSeatPriceId) return cachedSeatPriceId;

  const found = await stripe.prices.list({
    lookup_keys: [SEAT_PRICE_LOOKUP_KEY],
    active:      true,
    limit:       1,
  });
  const existing = found.data[0];
  if (existing) {
    cachedSeatPriceId = existing.id;
    return existing.id;
  }

  const productId = await ensureSeatProduct();
  try {
    const price = await stripe.prices.create(
      {
        currency:       SEAT_CURRENCY,
        product:        productId,
        lookup_key:     SEAT_PRICE_LOOKUP_KEY,
        nickname:       SEAT_PRODUCT_NAME,
        billing_scheme: 'tiered',
        tiers_mode:     'volume',
        tiers:          stripeVolumeTiers(),
        recurring:      { interval: 'month' },
      },
      { idempotencyKey: `seat-price:${SEAT_PRICE_LOOKUP_KEY}` },
    );
    cachedSeatPriceId = price.id;
    return price.id;
  } catch (err) {
    // A concurrent create already claimed the lookup key — read it back rather
    // than failing a user-visible onboarding step.
    const retry = await stripe.prices.list({
      lookup_keys: [SEAT_PRICE_LOOKUP_KEY],
      active:      true,
      limit:       1,
    });
    const raced = retry.data[0];
    if (raced) {
      cachedSeatPriceId = raced.id;
      return raced.id;
    }
    throw err;
  }
}

/** Retrieves a subscription, or null when Stripe no longer knows it. */
async function retrieveSubscription(subscriptionId: string): Promise<Stripe.Subscription | null> {
  try {
    return await stripe.subscriptions.retrieve(subscriptionId);
  } catch (err) {
    if (stripeErrorCode(err) === 'resource_missing') return null;
    throw err;
  }
}

/**
 * Makes the org's Stripe subscription quantity equal its active-seat count
 * (organization_members.status = 'active'). Creates the subscription on first
 * call once billing is complete; no-ops with 'skipped' when it is not. Never
 * throws — membership changes must succeed even if Stripe is down; the next
 * call (or a reconcile) catches up.
 *
 * ONE SUBSCRIPTION PER CUSTOMER. When the billing row records no subscription,
 * this asks Stripe what the customer already has and ADOPTS a live seat
 * subscription rather than creating a second one; only a customer with none is
 * created for. That check, not the idempotency key, is what makes a lost row
 * write survivable (H-23) — the key expires after ~24 hours, the same interval
 * the nightly reconcile runs on.
 *
 * ZERO SEATS. Stripe bills a licensed subscription item for at least one unit
 * and the SDK types put no constraint on `quantity`, so we never gamble a
 * quantity: 0 request in the middle of a membership change. Instead an org that
 * drops to zero active seats has its subscription set to cancel_at_period_end:
 * the firm keeps what it has already paid for and is never billed again. If a
 * seat comes back before the period ends we clear cancel_at_period_end and set
 * the new quantity in one update; if the subscription has already ended, the
 * next sync creates a fresh one.
 */
export async function syncOrgSeatQuantity(organizationId: string): Promise<SeatSyncResult> {
  const activeSeats = await countActiveSeats(organizationId);
  const base = { organizationId, activeSeats } as const;

  try {
    const row = await getOrgBillingRow(organizationId);
    if (!row || !row.billing_complete || !row.stripe_customer_id) {
      return { ...base, outcome: 'skipped' };
    }

    const priceId = await ensureSeatPrice();
    const subscription = row.stripe_subscription_id
      ? await retrieveSubscription(row.stripe_subscription_id)
      : null;

    let live =
      subscription
      && subscription.status !== 'canceled'
      && subscription.status !== 'incomplete_expired'
        ? subscription
        : null;

    // ── Nothing recorded: adopt what the customer already has, or create ─────
    if (!live) {
      if (activeSeats === 0) return { ...base, outcome: 'skipped' };

      // H-23. Before creating, ask Stripe what this customer already has: the
      // idempotency key below expires after ~24 hours, which is exactly the
      // reconcile interval, so a lost row write would otherwise produce a
      // second live subscription every night. This list call is deliberately
      // NOT wrapped in its own catch — if we cannot see the customer's
      // subscriptions we must not create one, and the outer catch turns that
      // into 'error' plus a system_events row (which is a delay, whereas
      // double-billing a firm is a refund and an apology).
      const existing = await stripe.subscriptions.list({
        customer: row.stripe_customer_id,
        status:   'all',
        limit:    20,
      });
      const adopted = pickAdoptableSubscription(existing.data, priceId);

      if (adopted) {
        const adoptedItem =
          adopted.items.data.find(i => i.price?.id === priceId) ?? adopted.items.data[0] ?? null;
        const recorded = await patchBillingRowWithRetry(organizationId, {
          stripe_subscription_id:      adopted.id,
          stripe_subscription_item_id: adoptedItem?.id ?? null,
          subscription_status:         adopted.status,
        });
        if (!recorded) {
          await recordSystemFailure({
            area:   'seat_sync',
            reason: `subscription_adopted_but_unrecorded:${stripeIdTail(adopted.id)}`,
            organizationId,
          });
        }
        console.log('[orgBilling] seat-subscription-adopted', { organizationId, activeSeats });
        // Fall through to the live-subscription handling below, which sets the
        // quantity on the subscription we just adopted.
        live = adopted;
      }
    }

    if (!live) {
      // A previously recorded subscription means this is a RE-create after a
      // cancellation; a distinct idempotency key stops Stripe from replaying
      // the original (now canceled) create.
      const idempotencyKey = row.stripe_subscription_id
        ? `seat-sub:${organizationId}:${row.stripe_subscription_id}`
        : `seat-sub:${organizationId}`;

      const created = await stripe.subscriptions.create(
        {
          customer:           row.stripe_customer_id,
          items:              [{ price: priceId, quantity: activeSeats }],
          collection_method:  'charge_automatically',
          proration_behavior: 'create_prorations',
          metadata:           { organizationId },
        },
        { idempotencyKey },
      );

      // The subscription now EXISTS AT STRIPE and is billing the firm. A row
      // that does not record its id is the whole of H-23, so the write is
      // retried and, if it still fails, recorded as a failure an operator can
      // act on before the next nightly sweep runs (the id's last four
      // characters locate it in the dashboard without logging the id itself).
      const recorded = await patchBillingRowWithRetry(organizationId, {
        stripe_subscription_id:      created.id,
        stripe_subscription_item_id: created.items.data[0]?.id ?? null,
        subscription_status:         created.status,
        seat_quantity_synced:        activeSeats,
      });
      if (!recorded) {
        await recordSystemFailure({
          area:   'seat_sync',
          reason: `subscription_created_but_unrecorded:${stripeIdTail(created.id)}`,
          organizationId,
        });
      }
      console.log('[orgBilling] seat-subscription-created', { organizationId, activeSeats });
      return { ...base, outcome: 'updated' };
    }

    // ── Live subscription: find the seat line ───────────────────────────────
    const item =
      live.items.data.find(i => i.id === row.stripe_subscription_item_id)
      ?? live.items.data.find(i => i.price?.id === priceId)
      ?? live.items.data[0]
      ?? null;

    if (!item) {
      console.error('[orgBilling] subscription has no items', { organizationId });
      await recordSystemFailure({
        area:   'seat_sync',
        reason: 'subscription has no seat line item',
        organizationId,
      });
      return { ...base, outcome: 'error' };
    }

    // ── Zero seats → stop billing at the end of the paid period ─────────────
    if (activeSeats === 0) {
      if (live.cancel_at_period_end) {
        await patchBillingRow(organizationId, {
          subscription_status:  live.status,
          seat_quantity_synced: 0,
        });
        return { ...base, outcome: 'unchanged' };
      }
      const canceling = await stripe.subscriptions.update(live.id, {
        cancel_at_period_end: true,
        proration_behavior:   'none',
      });
      await patchBillingRow(organizationId, {
        subscription_status:  canceling.status,
        seat_quantity_synced: 0,
      });
      console.log('[orgBilling] seat-subscription-cancel-at-period-end', { organizationId });
      return { ...base, outcome: 'updated' };
    }

    // ── Seats returned while the subscription was winding down ──────────────
    if (live.cancel_at_period_end) {
      const resumed = await stripe.subscriptions.update(live.id, {
        cancel_at_period_end: false,
        items:                [{ id: item.id, quantity: activeSeats }],
        proration_behavior:   'create_prorations',
      });
      await patchBillingRow(organizationId, {
        stripe_subscription_id:      resumed.id,
        stripe_subscription_item_id: item.id,
        subscription_status:         resumed.status,
        seat_quantity_synced:        activeSeats,
      });
      console.log('[orgBilling] seat-subscription-resumed', { organizationId, activeSeats });
      return { ...base, outcome: 'updated' };
    }

    // ── Ordinary quantity change ────────────────────────────────────────────
    const stripeQuantity = item.quantity ?? 0;
    if (stripeQuantity !== activeSeats) {
      await stripe.subscriptionItems.update(item.id, {
        quantity:           activeSeats,
        proration_behavior: 'create_prorations',
      });
      await patchBillingRow(organizationId, {
        stripe_subscription_id:      live.id,
        stripe_subscription_item_id: item.id,
        subscription_status:         live.status,
        seat_quantity_synced:        activeSeats,
      });
      console.log('[orgBilling] seat-quantity-synced', { organizationId, activeSeats });
      return { ...base, outcome: 'updated' };
    }

    // Stripe already matches. Keep our mirror honest anyway (status drift, an
    // item id we had not recorded, or a first sync after a manual change).
    if (
      row.seat_quantity_synced !== activeSeats
      || row.subscription_status !== live.status
      || row.stripe_subscription_item_id !== item.id
    ) {
      await patchBillingRow(organizationId, {
        stripe_subscription_item_id: item.id,
        subscription_status:         live.status,
        seat_quantity_synced:        activeSeats,
      });
    }
    return { ...base, outcome: 'unchanged' };
  } catch (err) {
    logFailure('syncOrgSeatQuantity', err);
    // Every caller of this function swallows a failure so a membership change
    // never fails on billing. Recording it here — once, at the source — is what
    // stops that from meaning nobody ever finds out.
    await recordSystemFailure({
      area:   'seat_sync',
      reason: stripeFailureReason(err),
      organizationId,
    });
    return { ...base, outcome: 'error' };
  }
}

// ─── Cancellation (organization deleted) ──────────────────────────────────────

/**
 * Cancels the organization's seat subscription immediately, invoicing the
 * unbilled usage and crediting the unused time (`prorate` + `invoice_now`).
 * Called before an organization row is deleted, so a removed firm is never
 * billed for another month.
 *
 * Outcomes:
 *   'canceled' — Stripe no longer bills this org (including "there was nothing
 *                left to cancel": the subscription is gone or already canceled)
 *   'none'     — the org never had a subscription, or its billing row is
 *                unreadable (the table is missing in production tonight, and
 *                getOrgBillingRow degrades to null); nothing to do
 *   'error'    — Stripe refused; the caller must NOT delete the organization
 *
 * Never throws.
 */
export async function cancelOrgSubscription(
  organizationId: string,
): Promise<{ outcome: 'canceled' | 'none' | 'error'; reason?: string }> {
  if (!organizationId) return { outcome: 'none' };

  try {
    // Null when the row (or the whole table) is unreadable — see getOrgBillingRow.
    const row = await getOrgBillingRow(organizationId);
    const subscriptionId = row?.stripe_subscription_id;
    if (!subscriptionId) return { outcome: 'none' };

    // Already gone or already canceled: nothing to cancel, but the mirror still
    // needs correcting. Also avoids Stripe's ambiguous error for a re-cancel.
    const existing = await retrieveSubscription(subscriptionId);
    if (!existing || existing.status === 'canceled' || existing.status === 'incomplete_expired') {
      await patchBillingRow(organizationId, {
        subscription_status:  'canceled',
        seat_quantity_synced: 0,
      });
      return { outcome: 'canceled' };
    }

    await stripe.subscriptions.cancel(
      subscriptionId,
      { prorate: true, invoice_now: true },
      { idempotencyKey: orgCancelIdempotencyKey(organizationId) },
    );

    await patchBillingRow(organizationId, {
      subscription_status:  'canceled',
      seat_quantity_synced: 0,
    });
    console.log('[orgBilling] seat-subscription-canceled', { organizationId });
    return { outcome: 'canceled' };
  } catch (err) {
    logFailure('cancelOrgSubscription', err);
    // The caller surfaces this one (it refuses to delete the organization), but
    // the standing risk is that we keep charging a firm that asked to leave —
    // that belongs on the attention list regardless of what the caller does.
    await recordSystemFailure({
      area:   'invoice',
      reason: `seat subscription cancel failed: ${stripeFailureReason(err)}`,
      organizationId,
    });
    return { outcome: 'error', reason: stripeFailureReason(err) };
  }
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
  if (!stripeSubscriptionId || !status) return;
  try {
    const db = serviceClient();
    if (!db) return;

    const { data: row, error } = await db
      .from('organization_billing')
      .select('organization_id')
      .eq('stripe_subscription_id', stripeSubscriptionId)
      .maybeSingle();
    if (error) {
      console.error('[orgBilling] subscription lookup failed:', error.message.slice(0, 120));
      return;
    }
    // A subscription this deployment does not own, or a stale test event.
    if (!row) return;

    await patchBillingRow(row.organization_id, { subscription_status: status });
    console.log('[orgBilling] subscription-status-mirrored', {
      organizationId: row.organization_id,
      status,
    });
  } catch (err) {
    logFailure('recordSubscriptionStatus', err);
  }
}
