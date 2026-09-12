// lib/chargeSavedCard.ts
// Off-session charge against the card the client's FIRM saved during
// onboarding.
//
// The payer is resolved in this order — never the project-level Stripe customer
// that lib/createAndSendInvoice.ts creates for payment links:
//   1. The ORGANIZATION that owns the project (projects.organization_id) once
//      organization_billing says it has a card on file. The firm is the paying
//      entity: one colleague saves the card, every project the firm runs is
//      billed to it.
//   2. LEGACY fallback — the project owner's own Stripe customer on their
//      profile, written by the pre-org onboarding flow. Kept so accounts that
//      completed billing before org billing existed keep charging cleanly.
//
// This module only decides and charges. Persistence, emails, and the
// payment-link fallback are orchestrated by lib/createAndSendInvoice.ts.
//
// Required env vars:
//   STRIPE_SECRET_KEY  — server-side Stripe key
//
// TEST SEAM: every caller in the app calls chargeSavedCard(params) unchanged;
// an optional second argument replaces the Stripe client and the two lookups
// with stubs so scripts/test-stripe-flows.ts can drive the charge, decline and
// no-card paths without a Stripe account (see ChargeDeps).
//
// NEVER log: emails, names, customer ids, payment method ids, or card details.
// Amounts and projectId are safe to log.

import type Stripe from 'stripe';
import { stripe } from './stripe';
import { getUser } from './firmStore';
import { getBillingCustomerForProject } from './orgBilling';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ChargeResult =
  /** Charged off-session. Stripe will emit payment_intent.succeeded. */
  | { outcome: 'charged';         paymentIntentId: string }
  /** No payer, no saved customer, or no saved card — use the payment link. */
  | { outcome: 'no_saved_card' }
  /** Card needs SCA / 3DS, or was declined — fall back to the payment link. */
  | { outcome: 'requires_action'; paymentIntentId: string | null }
  | { outcome: 'declined';        paymentIntentId: string | null }
  /** Stripe or the data layer failed — fall back to the payment link. */
  | { outcome: 'error' };

export interface ChargeSavedCardParams {
  projectId:  string;
  expertId:   string;
  ownerEmail: string;
  /** Whole dollars, already server-recomputed by the caller. */
  amount:     number;
  /**
   * Identity of the CALL being billed (booking.icsUid, else the Zoom meeting
   * id, else the manual id the complete route invents). Optional so a caller
   * that cannot identify the call still charges — such a charge simply shares
   * the per-(project, expert) key it used before.
   */
  callId?:    string | null;
}

// ─── Test seam ────────────────────────────────────────────────────────────────

/**
 * The slice of the Stripe SDK this module touches. Narrow on purpose: the real
 * client satisfies it structurally, and a test stub only has to implement three
 * calls instead of the whole SDK.
 */
export interface ChargeStripeClient {
  customers: {
    retrieve(id: string): Promise<Stripe.Customer | Stripe.DeletedCustomer>;
  };
  paymentMethods: {
    list(params: Stripe.PaymentMethodListParams): Promise<{ data: Array<{ id: string }> }>;
  };
  paymentIntents: {
    create(
      params:   Stripe.PaymentIntentCreateParams,
      options?: { idempotencyKey?: string },
    ): Promise<{ id: string; status: string }>;
  };
}

/**
 * Everything this module reaches outside itself. Production never passes it —
 * chargeSavedCard() with one argument behaves exactly as before; only
 * scripts/test-stripe-flows.ts substitutes parts of it.
 */
export interface ChargeDeps {
  stripe: ChargeStripeClient;
  getBillingCustomerForProject: (projectId: string) => Promise<string | null>;
  getUser: (email: string) => Promise<
    { stripeCustomerId?: string | null; billingComplete?: boolean } | null
  >;
}

/** The real client and the real lookups. Built lazily: touching `stripe`'s
 *  getters would construct the SDK, which must not happen at module load. */
function defaultChargeDeps(): ChargeDeps {
  return { stripe, getBillingCustomerForProject, getUser };
}

/**
 * Minimal structural view of a Stripe error. Stripe's SDK error classes carry
 * `code` and, for off-session failures, the PaymentIntent that failed.
 */
interface StripeErrorShape {
  code?:           unknown;
  decline_code?:   unknown;
  payment_intent?: { id?: unknown };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Stripe expandable fields arrive as an id or an object — normalise to the id. */
function toId(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
}

function readStripeError(err: unknown): { code: string; paymentIntentId: string | null } {
  if (typeof err !== 'object' || err === null) return { code: '', paymentIntentId: null };
  const e   = err as StripeErrorShape;
  const pid = e.payment_intent?.id;
  return {
    code:            typeof e.code === 'string' ? e.code : '',
    paymentIntentId: typeof pid === 'string' ? pid : null,
  };
}

/**
 * Stripe idempotency key for one call's charge. The call component is what
 * makes a SECOND genuine call with the same expert on the same project a new
 * charge rather than a replay of the first PaymentIntent (H-8).
 */
export function chargeIdempotencyKey(
  projectId: string,
  expertId:  string,
  callId:    string | null | undefined,
): string {
  return `charge:${projectId}:${expertId}:${callId ?? 'nocall'}`;
}

/**
 * Resolves the payment method to charge for a customer: the default set on
 * invoice_settings by the billing confirm route, falling back to the customer's
 * most recent saved card (covers cards attached outside that flow).
 */
async function resolveDefaultPaymentMethod(
  customerId: string,
  client:     ChargeStripeClient,
): Promise<string | null> {
  const customer = await client.customers.retrieve(customerId);
  if ('deleted' in customer) return null;

  const fromSettings = toId(customer.invoice_settings?.default_payment_method);
  if (fromSettings) return fromSettings;

  const methods = await client.paymentMethods.list({
    customer: customerId,
    type:     'card',
    limit:    1,
  });
  return methods.data[0]?.id ?? null;
}

/**
 * The Stripe customer to charge for this call: the project's organization when
 * the firm has a card on file, else the project owner's legacy per-user
 * customer. Null when neither exists — the caller falls back to a payment link.
 */
async function resolvePayerCustomerId(
  projectId:  string,
  ownerEmail: string,
  deps:       ChargeDeps,
): Promise<string | null> {
  const orgCustomerId = await deps.getBillingCustomerForProject(projectId);
  if (orgCustomerId) return orgCustomerId;

  if (!ownerEmail) return null;
  const payer = await deps.getUser(ownerEmail);
  if (!payer?.stripeCustomerId || !payer.billingComplete) return null;
  return payer.stripeCustomerId;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Attempts an off-session charge against the firm's saved card (falling back to
 * the project owner's legacy per-user card).
 *
 * Never throws — every failure is reported as an outcome so the caller can fall
 * back to the manual payment-link flow.
 *
 * Idempotency: the key is derived from projectId + expertId + callId, so a
 * webhook retry or a re-completion of the SAME call returns the original
 * PaymentIntent instead of charging the client twice, while a second genuine
 * call raises a new charge.
 */
export async function chargeSavedCard(
  params: ChargeSavedCardParams,
  /** Test seam only — see ChargeDeps. Production calls this with one argument. */
  deps?:  Partial<ChargeDeps>,
): Promise<ChargeResult> {
  const { projectId, expertId, ownerEmail, amount, callId } = params;
  const d = { ...defaultChargeDeps(), ...deps };

  // A payer needs either a project (→ its organization's card) or an owner
  // email (→ the legacy per-user card). Stripe's minimum charge is $0.50.
  if ((!projectId && !ownerEmail) || !Number.isFinite(amount) || amount < 1) {
    return { outcome: 'no_saved_card' };
  }

  try {
    const customerId = await resolvePayerCustomerId(projectId, ownerEmail, d);
    if (!customerId) return { outcome: 'no_saved_card' };

    const paymentMethodId = await resolveDefaultPaymentMethod(customerId, d.stripe);
    if (!paymentMethodId) return { outcome: 'no_saved_card' };

    const intent = await d.stripe.paymentIntents.create(
      {
        customer:             customerId,
        amount:               Math.round(amount * 100),
        currency:             'usd',
        payment_method:       paymentMethodId,
        // Mirrors the SetupIntent in app/api/onboarding/billing/route.ts: a card
        // saved through Stripe Link is a `link` payment method, and omitting it
        // here would make every Link-saved card unchargeable.
        payment_method_types: ['card', 'link'],
        off_session:          true,
        confirm:              true,
        metadata:             { projectId, expertId },
      },
      // Scope of this key: ONE PaymentIntent per (project, expert, call), for
      // as long as Stripe remembers the key (~24h). It makes a webhook retry or
      // a double-click safe, and a SECOND genuine call with the same expert
      // carries a different callId so it raises its own charge. It is not the
      // business rule — that is the durable per-call guard (shouldSkipBilling)
      // in lib/createAndSendInvoice.ts.
      { idempotencyKey: chargeIdempotencyKey(projectId, expertId, callId) },
    );

    if (intent.status === 'succeeded' || intent.status === 'processing') {
      console.log('[stripe] off-session-charge-created', { amount, projectId });
      return { outcome: 'charged', paymentIntentId: intent.id };
    }

    // requires_action / requires_payment_method without a thrown error.
    console.log('[stripe] off-session-charge-unconfirmed', { amount, projectId, status: intent.status });
    return intent.status === 'requires_action'
      ? { outcome: 'requires_action', paymentIntentId: intent.id }
      : { outcome: 'declined',        paymentIntentId: intent.id };
  } catch (err) {
    const { code, paymentIntentId } = readStripeError(err);

    if (code === 'authentication_required') {
      console.log('[stripe] off-session-charge-sca-required', { amount, projectId });
      return { outcome: 'requires_action', paymentIntentId };
    }
    if (code === 'card_declined' || code === 'expired_card' || code === 'insufficient_funds') {
      console.log('[stripe] off-session-charge-declined', { amount, projectId, code });
      return { outcome: 'declined', paymentIntentId };
    }

    const msg = err instanceof Error ? err.message : String(err);
    console.error('[stripe] chargeSavedCard error:', msg.slice(0, 120));
    return { outcome: 'error' };
  }
}
