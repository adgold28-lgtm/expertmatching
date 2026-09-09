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
// NEVER log: emails, names, customer ids, payment method ids, or card details.
// Amounts and projectId are safe to log.

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
 * Resolves the payment method to charge for a customer: the default set on
 * invoice_settings by the billing confirm route, falling back to the customer's
 * most recent saved card (covers cards attached outside that flow).
 */
async function resolveDefaultPaymentMethod(customerId: string): Promise<string | null> {
  const customer = await stripe.customers.retrieve(customerId);
  if ('deleted' in customer) return null;

  const fromSettings = toId(customer.invoice_settings?.default_payment_method);
  if (fromSettings) return fromSettings;

  const methods = await stripe.paymentMethods.list({
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
): Promise<string | null> {
  const orgCustomerId = await getBillingCustomerForProject(projectId);
  if (orgCustomerId) return orgCustomerId;

  if (!ownerEmail) return null;
  const payer = await getUser(ownerEmail);
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
 * Idempotency: the key is derived from projectId + expertId, so a webhook retry
 * or a re-completion of the same engagement returns the original PaymentIntent
 * instead of charging the client twice.
 */
export async function chargeSavedCard(params: ChargeSavedCardParams): Promise<ChargeResult> {
  const { projectId, expertId, ownerEmail, amount } = params;

  // A payer needs either a project (→ its organization's card) or an owner
  // email (→ the legacy per-user card). Stripe's minimum charge is $0.50.
  if ((!projectId && !ownerEmail) || !Number.isFinite(amount) || amount < 1) {
    return { outcome: 'no_saved_card' };
  }

  try {
    const customerId = await resolvePayerCustomerId(projectId, ownerEmail);
    if (!customerId) return { outcome: 'no_saved_card' };

    const paymentMethodId = await resolveDefaultPaymentMethod(customerId);
    if (!paymentMethodId) return { outcome: 'no_saved_card' };

    const intent = await stripe.paymentIntents.create(
      {
        customer:             customerId,
        amount:               Math.round(amount * 100),
        currency:             'usd',
        payment_method:       paymentMethodId,
        payment_method_types: ['card'],
        off_session:          true,
        confirm:              true,
        metadata:             { projectId, expertId },
      },
      // Scope of this key: ONE PaymentIntent per (project, expert) pair, for as
      // long as Stripe remembers the key (~24h). It makes a webhook retry or a
      // double-click safe. It is not a business rule — the durable double-bill
      // guard is the paid/stripePaymentIntentId check in
      // lib/createAndSendInvoice.ts, and a SECOND genuine call with the same
      // expert on the same project inside the window would replay this intent
      // rather than raise a new charge.
      { idempotencyKey: `charge:${projectId}:${expertId}` },
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
