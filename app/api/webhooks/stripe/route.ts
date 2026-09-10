// POST — public, no auth guard.
// Stripe sends webhook events here. Raw body required.
//
// Handles:
//   checkout.session.completed            → paymentStatus='paid' + expert payout
//   checkout.session.async_payment_failed → paymentStatus='failed'
//   payment_intent.succeeded              → paymentStatus='paid' + expert payout
//                                           (off-session auto-charge path)
//   payment_intent.payment_failed         → paymentStatus='failed'
//   customer.subscription.updated         → mirror status onto organization_billing
//   customer.subscription.deleted         → mirror status onto organization_billing
//   invoice.payment_failed                → mirror 'past_due' for the org whose
//                                           seat subscription the invoice bills
//   account.updated                       → an expert finished Connect
//                                           onboarding: retry their pending
//                                           payouts (with the nightly sweep,
//                                           one of two retry paths)
//   charge.refunded                       → paymentStatus='refunded' + alert
//   charge.dispute.created                → paymentStatus='refunded' + alert
//
// EVENTS THAT MUST BE ENABLED ON THE STRIPE ENDPOINT for the branches below to
// ever run: checkout.session.completed, checkout.session.async_payment_failed,
// payment_intent.succeeded, payment_intent.payment_failed,
// customer.subscription.updated, customer.subscription.deleted,
// invoice.payment_failed, charge.refunded, charge.dispute.created, and
// account.updated on CONNECTED accounts.
//
// Both "money received" branches funnel into runExpertPayout()
// (lib/expertPayout.ts), which recomputes the payout server-side from the
// stored expertRate — a webhook payload is never trusted for money.
//
// PaymentIntents created outside the billing flow carry no projectId/expertId
// metadata; those events are acknowledged and ignored.
//
// Required env vars:
//   STRIPE_SECRET_KEY      — server-side Stripe key
//   STRIPE_WEBHOOK_SECRET  — signature verification (requests are rejected
//                            with 400 when it is absent)
//
// NEVER log: expert names, project names, customer emails, card details,
// accountId, transferId.

import { NextRequest, NextResponse } from 'next/server';
import type Stripe from 'stripe';
import { stripe } from '../../../../lib/stripe';
import { updateExpertStatus, getProject } from '../../../../lib/projectStore';
import { runExpertPayout, retryPendingPayoutsForAccount } from '../../../../lib/expertPayout';
import { recordSubscriptionStatus } from '../../../../lib/orgBilling';
import { recordSystemFailure } from '../../../../lib/engagementEvents';
import { getUpstashClient } from '../../../../lib/upstashRedis';
import type { UpdateExpertInput } from '../../../../lib/projectStore';
import type { ProjectExpert } from '../../../../types';
import {
  decideEventDedup,
  decideRefundTransition,
  engagementRefFromMetadata,
  stripeEventKey,
  STRIPE_EVENT_TTL_SECONDS,
  type EngagementRef,
  type RefundKind,
} from './handlers';

// ─── Shared branch handlers ───────────────────────────────────────────────────

/** Records a successful client payment, then pays out the expert. */
async function handlePaymentSucceeded(
  projectId: string,
  expertId:  string,
  intentId:  string | null,
): Promise<void> {
  try {
    await updateExpertStatus(projectId, expertId, {
      paymentStatus:         'paid',
      paidAt:                Date.now(),
      ...(intentId ? { stripePaymentIntentId: intentId } : {}),
    });
    console.log('[stripe] payment-succeeded', { projectId, expertId });
  } catch (err) {
    console.error('[stripe] webhook update error:', err instanceof Error ? err.message.slice(0, 120) : String(err));
  }

  // Never throws — the client payment is already recorded.
  await runExpertPayout(projectId, expertId);
}

/**
 * The subscription an invoice bills, on this API version. Since the 2025 basil
 * releases `invoice.subscription` is gone: the link lives under
 * `invoice.parent.subscription_details.subscription`. The legacy top-level
 * field is still read (behind a narrow cast, never `any`) so replayed events
 * from an older API version are handled too.
 */
function subscriptionIdForInvoice(invoice: Stripe.Invoice): string | null {
  const fromParent = invoice.parent?.subscription_details?.subscription;
  if (typeof fromParent === 'string') return fromParent;
  if (fromParent && typeof fromParent === 'object') return fromParent.id;

  const legacy = (invoice as { subscription?: string | { id?: string } }).subscription;
  if (typeof legacy === 'string') return legacy;
  if (legacy && typeof legacy.id === 'string') return legacy.id;
  return null;
}

async function handlePaymentFailed(projectId: string, expertId: string): Promise<void> {
  try {
    await updateExpertStatus(projectId, expertId, { paymentStatus: 'failed' });
    console.log('[stripe] payment-failed', { projectId, expertId });
  } catch (err) {
    console.error('[stripe] webhook update error:', err instanceof Error ? err.message.slice(0, 120) : String(err));
  }
  // M-43: a completed call that was never paid for is money the platform is
  // owed and an expert who will never be paid, and it used to exist only as a
  // log line. Recording it puts the engagement on the admin attention list.
  await recordSystemFailure({
    area:   'invoice',
    reason: 'client_payment_failed',
    projectId,
    expertId,
  });
}

/**
 * A refund or a dispute on a call charge (H-7).
 *
 * paymentStatus moves to the terminal 'refunded' and a system_events row puts
 * the engagement on the attention list. The state change is all this does.
 *
 * TODO(founder decision): PAYOUT REVERSAL POLICY. The expert has usually
 * already been transferred their half by the time a refund or chargeback
 * arrives, and nothing here claws it back — the platform absorbs it. The
 * question is a product one, not a technical one: does ExpertMatch reverse the
 * expert's transfer when the client is refunded (and if so, for a dispute the
 * platform may still win?), or does it absorb the cost and treat the expert as
 * having done the work? Implementing "reverse" is one call —
 * `stripe.transfers.createReversal(pe.stripeTransferId, { amount, metadata:
 * { projectId, expertId } })` with an idempotency key mirroring
 * lib/stripeConnect.payoutIdempotencyKey — plus clearing the row's
 * stripeTransferId/paidCallIds entry. It is deliberately NOT implemented until
 * the policy is decided: reversing money out of an expert's bank account by
 * accident is worse than an accountant's adjustment. Deferred in
 * docs/REPAIR_PLAN.md Part H.
 */
async function handleRefundOrDispute(ref: EngagementRef, kind: RefundKind): Promise<void> {
  const { projectId, expertId } = ref;
  let current: ProjectExpert['paymentStatus'] = null;
  try {
    const project = await getProject(projectId);
    const pe      = project?.experts.find(e => e.expert.id === expertId);
    if (!pe) return;
    current = pe.paymentStatus ?? null;
  } catch (err) {
    console.error('[stripe] refund lookup error:', err instanceof Error ? err.message.slice(0, 120) : String(err));
  }

  const decision = decideRefundTransition(current, kind);
  if (decision.write) {
    try {
      const patch: UpdateExpertInput = { paymentStatus: decision.paymentStatus };
      await updateExpertStatus(projectId, expertId, patch);
      console.log('[stripe] refund-recorded', { projectId, expertId, kind });
    } catch (err) {
      console.error('[stripe] refund write error:', err instanceof Error ? err.message.slice(0, 120) : String(err));
    }
  }

  await recordSystemFailure({
    area:   'invoice',
    reason: decision.reason,
    projectId,
    expertId,
  });
}

/**
 * The engagement a Charge belongs to. Stripe copies a PaymentIntent's metadata
 * onto its Charge, but a charge created through a payment link carries the
 * link's metadata on the intent instead — so the intent is the fallback, and a
 * charge that matches neither is somebody else's and is ignored.
 */
async function engagementForCharge(
  metadata:      Stripe.Metadata | null | undefined,
  paymentIntent: string | Stripe.PaymentIntent | null | undefined,
): Promise<EngagementRef | null> {
  const direct = engagementRefFromMetadata(metadata);
  if (direct) return direct;

  const intentId = typeof paymentIntent === 'string' ? paymentIntent : paymentIntent?.id;
  if (!intentId) return null;
  try {
    const intent = await stripe.paymentIntents.retrieve(intentId);
    return engagementRefFromMetadata(intent.metadata);
  } catch (err) {
    console.error('[stripe] intent lookup error:', err instanceof Error ? err.message.slice(0, 120) : String(err));
    return null;
  }
}

/**
 * Claims one event id so its branches run once. Fail-open on Redis: see
 * decideEventDedup in ./handlers.ts for why processing twice is the safe
 * direction here.
 */
async function claimEvent(eventId: string): Promise<'process' | 'duplicate'> {
  const redis = getUpstashClient();
  if (!redis) return decideEventDedup(null, false);
  try {
    const result = await redis.set(stripeEventKey(eventId), '1', {
      nx: true,
      ex: STRIPE_EVENT_TTL_SECONDS,
    });
    return decideEventDedup(result, true);
  } catch {
    return decideEventDedup(null, false);
  }
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const body = await request.text();
  const sig  = request.headers.get('stripe-signature');

  if (!sig || !process.env.STRIPE_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'missing_signature' }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch {
    return NextResponse.json({ error: 'invalid_signature' }, { status: 400 });
  }

  // Signature verified — everything below writes. Deliberate properties of
  // this handler, worth knowing before adding a branch:
  //   * DE-DUPLICATED, BUT NOT DEPENDENT ON IT. event.id is claimed in Redis
  //     with SET NX EX 7d, so a redelivery is answered 200 without running any
  //     branch. The claim FAILS OPEN (no Redis, or a throwing Redis, processes
  //     the event), so every branch must still be safe to run twice — and is:
  //     the paid/failed/refunded writes are last-writer-wins on the same
  //     values, and runExpertPayout guards on the stored paidCallIds plus a
  //     per-call transfer idempotency key.
  //   * NO ORDERING GUARANTEE. Stripe may deliver out of order, so a late
  //     customer.subscription.updated can overwrite a 'past_due' mirrored from
  //     invoice.payment_failed; organization_billing is a hint for the UI, not
  //     the ledger — Stripe is.
  //   * REFUNDS CHANGE STATE, NOT MONEY. charge.refunded and
  //     charge.dispute.created move the engagement to 'refunded' and raise a
  //     system_events row. The expert's payout is NOT reversed — see the
  //     TODO(founder decision) on handleRefundOrDispute.
  //   * ALWAYS 200. A branch that fails logs and is dropped, rather than asking
  //     Stripe to redeliver.

  if (await claimEvent(event.id) === 'duplicate') {
    console.log('[stripe] duplicate-event-skipped', { type: event.type });
    return NextResponse.json({ received: true, duplicate: true });
  }

  // ── Checkout (payment-link path) ────────────────────────────────────────
  if (event.type === 'checkout.session.completed') {
    const session   = event.data.object as Stripe.Checkout.Session;
    const projectId = session.metadata?.projectId;
    const expertId  = session.metadata?.expertId;
    const intentId  = typeof session.payment_intent === 'string'
      ? session.payment_intent
      : (session.payment_intent as Stripe.PaymentIntent | null)?.id ?? null;

    if (projectId && expertId) {
      await handlePaymentSucceeded(projectId, expertId, intentId);
    }
  }

  if (event.type === 'checkout.session.async_payment_failed') {
    const session   = event.data.object as Stripe.Checkout.Session;
    const projectId = session.metadata?.projectId;
    const expertId  = session.metadata?.expertId;

    if (projectId && expertId) {
      await handlePaymentFailed(projectId, expertId);
    }
  }

  // ── PaymentIntent (off-session auto-charge path) ────────────────────────
  // Guard on metadata: intents created outside this flow are ignored.
  if (event.type === 'payment_intent.succeeded') {
    const intent    = event.data.object as Stripe.PaymentIntent;
    const projectId = intent.metadata?.projectId;
    const expertId  = intent.metadata?.expertId;

    if (projectId && expertId) {
      await handlePaymentSucceeded(projectId, expertId, intent.id);
    }
  }

  if (event.type === 'payment_intent.payment_failed') {
    const intent    = event.data.object as Stripe.PaymentIntent;
    const projectId = intent.metadata?.projectId;
    const expertId  = intent.metadata?.expertId;

    if (projectId && expertId) {
      await handlePaymentFailed(projectId, expertId);
    }
  }

  // ── Refunds and chargebacks (H-7) ───────────────────────────────────────
  // Both events carry the charge, not the engagement, so the projectId /
  // expertId are read from the charge's metadata or from its PaymentIntent.
  if (event.type === 'charge.refunded') {
    const charge = event.data.object as Stripe.Charge;
    const ref    = await engagementForCharge(charge.metadata, charge.payment_intent);
    if (ref) await handleRefundOrDispute(ref, 'refund');
  }

  if (event.type === 'charge.dispute.created') {
    const dispute = event.data.object as Stripe.Dispute;
    const ref     = await engagementForCharge(dispute.metadata, dispute.payment_intent);
    if (ref) await handleRefundOrDispute(ref, 'dispute');
  }

  // ── Per-seat subscription (organization billing) ────────────────────────
  // Mirrored onto organization_billing so the app can tell a firm its billing
  // needs attention without calling Stripe. recordSubscriptionStatus never
  // throws and ignores subscriptions this deployment does not own.
  if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object as Stripe.Subscription;
    await recordSubscriptionStatus(
      subscription.id,
      // A deleted subscription is terminal regardless of the status Stripe sent.
      event.type === 'customer.subscription.deleted' ? 'canceled' : subscription.status,
    );
  }

  if (event.type === 'invoice.payment_failed') {
    const invoice = event.data.object as Stripe.Invoice;
    const subscriptionId = subscriptionIdForInvoice(invoice);
    // Only subscription invoices matter here; one-off call charges are tracked
    // through payment_intent.payment_failed above.
    if (subscriptionId) {
      await recordSubscriptionStatus(subscriptionId, 'past_due');
    }
  }

  // ── Connect account finished onboarding (expert payout) ─────────────────
  // An expert who set up Stripe AFTER their call was billed has a payout sitting
  // in 'pending'; nothing else ever retries it. isOnboardingComplete()
  // (lib/stripeConnect.ts) treats details_submitted as the bar, and
  // payouts_enabled is the stricter signal that money can actually move —
  // either is worth a sweep, and runExpertPayout re-checks the account before
  // transferring. Never throws; logs counts only.
  if (event.type === 'account.updated') {
    const account = event.data.object as Stripe.Account;
    const ready =
      account.payouts_enabled === true
      || (account.details_submitted === true && account.charges_enabled === true);
    if (ready && account.id) {
      await retryPendingPayoutsForAccount(account.id);
    }
  }

  // Always return 200
  return NextResponse.json({ received: true });
}
