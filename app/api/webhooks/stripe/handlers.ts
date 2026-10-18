// app/api/webhooks/stripe/handlers.ts — the pure decisions the Stripe webhook
// makes, kept out of route.ts because a Next 14 route file may export only its
// HTTP handlers and its route segment config.
//
// The pure decisions do no I/O: each takes what the route already read and
// returns what the route should do. That is what makes the de-duplication rule
// and the refund transition testable (scripts/test-payout-state.ts) without a
// Stripe account or a Redis instance.
//
// The BRANCH DISPATCH lives here too, as handleStripeEvent(event, deps): the
// route verifies the signature and hands the event over. Its optional `deps`
// argument (the test seam — production omits it) replaces the Stripe client,
// the store writes, the payout calls and the Redis event claim with stubs, so
// scripts/test-stripe-flows.ts can drive every branch — including "a redelivered
// event transfers nothing a second time" — with no Stripe account, no database
// and no Redis.

import type Stripe from 'stripe';
import { randomUUID } from 'crypto';
import type { ProjectExpert } from '../../../../types';
import { stripe } from '../../../../lib/stripe';
import { updateExpertStatus, getProject } from '../../../../lib/projectStore';
import type { UpdateExpertInput } from '../../../../lib/projectStore';
import { runExpertPayout, retryPendingPayoutsForAccount } from '../../../../lib/expertPayout';
import { recordSubscriptionStatus } from '../../../../lib/orgBilling';
import { recordSystemFailure } from '../../../../lib/engagementEvents';
import { getUpstashClient } from '../../../../lib/upstashRedis';
import { recordMismatchRefund, settleMismatchFlag } from '../../../../lib/lateCancelBilling';
import { paymentIsForFlaggedCall, refundIsForFlaggedCall } from '../../../../lib/mismatchGuarantee';
import { log } from '../../../../lib/log';

// ─── Event de-duplication (H-7 companion: branches must not run twice) ────────

/** Redis key for one delivered Stripe event. No PII: event ids are opaque. */
export function stripeEventKey(eventId: string): string {
  return `stripe-event:${eventId}`;
}

/** How long a handled event id is remembered. Stripe retries for up to 3 days. */
export const STRIPE_EVENT_TTL_SECONDS = 7 * 24 * 60 * 60;

export type EventDedupDecision = 'process' | 'duplicate';

/**
 * Legacy pure cache-availability decision, retained for the earlier regression
 * suite. Production uses claimStripeEvent's processing/done protocol below.
 * Neither this helper nor event deduplication guarantees cross-event ordering.
 */
export function decideEventDedup(
  setResult: 'OK' | null,
  available: boolean,
): EventDedupDecision {
  if (!available) return 'process';
  return setResult === 'OK' ? 'process' : 'duplicate';
}

// ─── Engagement lookup ────────────────────────────────────────────────────────

export interface EngagementRef {
  projectId: string;
  expertId:  string;
}

/** Stripe's metadata shape, structurally — avoids importing the SDK type here. */
export type Stripe$Metadata = { [key: string]: string | undefined };

/**
 * The engagement a Stripe object refers to, read off its metadata. Every object
 * this app creates (PaymentIntent, payment link, checkout session) carries
 * projectId and expertId; objects created outside this flow carry neither and
 * are ignored rather than guessed at. Pure.
 */
export function engagementRefFromMetadata(
  metadata: Stripe$Metadata | null | undefined,
): EngagementRef | null {
  const projectId = metadata?.projectId;
  const expertId  = metadata?.expertId;
  if (typeof projectId !== 'string' || !projectId) return null;
  if (typeof expertId  !== 'string' || !expertId)  return null;
  return { projectId, expertId };
}

// ─── Refunds and disputes (H-7) ───────────────────────────────────────────────

export type RefundKind = 'refund' | 'dispute';

export interface RefundDecision {
  /** False when the row already says 'refunded' — a replay or a second partial. */
  write:         boolean;
  /**
   * 'refunded' for every refund and dispute, except the refund of a call the
   * client flagged under the ten-minute mismatch guarantee, which stays
   * 'waived' (lib/mismatchGuarantee.ts).
   */
  paymentStatus: 'refunded' | 'waived';
  /** Short, id-free reason for the system_events row. */
  reason:        string;
  /**
   * True when the refund needs a person: a system_events row goes on the
   * attention list. False only for the expected mismatch-guarantee refund.
   */
  alarm:         boolean;
}

/**
 * The transition for charge.refunded / charge.dispute.created.
 *
 * A refunded or disputed call moves to the terminal 'refunded' state whatever
 * it was before: a dispute can arrive on a row this app never saw reach 'paid'
 * (an out-of-band Stripe dashboard action, or an out-of-order delivery), and
 * pretending it is still 'unpaid' is the desynchronisation H-7 is about. A row
 * already 'refunded' is left alone so a partial refund followed by the rest, or
 * a redelivery, does not write twice.
 *
 * PARTIAL REFUNDS are treated as full ones: the amount is not modelled on the
 * row, and a partially refunded call still needs a human.
 *
 * THE MISMATCH GUARANTEE (2026-10-14). `mismatchRefund` is true when the
 * refunded charge is the one ExpertMatch itself refunded because the client
 * flagged the call inside its first ten minutes
 * (lib/mismatchGuarantee.refundIsForFlaggedCall). That refund is expected: the
 * row stays (or becomes) 'waived', no alarm is raised, and nothing holds the
 * expert's 15-minute payout. A DISPUTE on such a call is still a dispute. Pure.
 */
export function decideRefundTransition(
  current:        ProjectExpert['paymentStatus'],
  kind:           RefundKind,
  mismatchRefund: boolean = false,
): RefundDecision {
  if (mismatchRefund && kind === 'refund') {
    return {
      write:         current !== 'waived',
      paymentStatus: 'waived',
      reason:        'mismatch_guarantee_refund',
      alarm:         false,
    };
  }
  return {
    write:         current !== 'refunded',
    paymentStatus: 'refunded',
    reason:        kind === 'dispute' ? 'refund_or_dispute:dispute' : 'refund_or_dispute:refund',
    alarm:         true,
  };
}

// ─── Signature verification ───────────────────────────────────────────────────

/** The slice of the SDK signature verification needs. */
export interface StripeSignatureClient {
  webhooks: {
    constructEvent(body: string, signature: string, secret: string): Stripe.Event;
  };
}

export type SignatureResult =
  | { ok: true;  event: Stripe.Event }
  | { ok: false; error: 'missing_signature' | 'invalid_signature' };

/**
 * Verifies Stripe's `stripe-signature` header over the RAW body. Returns the
 * parsed event or the exact error string the route answers 400 with — the two
 * strings are unchanged from when this lived inline in route.ts.
 *
 * Stripe signs `t=<unix seconds>` plus `v1=<hmac-sha256(secret, "t.body")>` and
 * the SDK enforces its own five-minute tolerance, so a captured body stops
 * verifying once it is old; scripts/test-webhook-signature.ts asserts that with
 * real HMAC fixtures rather than trusting the claim.
 */
export function verifyStripeSignature(
  body:      string,
  signature: string | null | undefined,
  secret:    string | undefined,
  /** Test seam only. */
  client:    StripeSignatureClient = stripe,
): SignatureResult {
  if (!signature || !secret) return { ok: false, error: 'missing_signature' };
  try {
    return { ok: true, event: client.webhooks.constructEvent(body, signature, secret) };
  } catch {
    return { ok: false, error: 'invalid_signature' };
  }
}

// ─── Branch dispatch (test seam) ──────────────────────────────────────────────

/** The slice of the Stripe SDK the branches use. */
export interface WebhookStripeClient {
  paymentIntents: {
    retrieve(id: string): Promise<{ metadata?: Stripe$Metadata | null }>;
  };
}

/**
 * The parts of a Project the payment and refund branches read. A real Project
 * satisfies it. The mismatch fields decide whether a payment or a refund is for
 * a call the client flagged under the ten-minute guarantee.
 */
export interface WebhookProjectView {
  experts: Array<
    Pick<
      ProjectExpert,
      'paymentStatus' | 'mismatchCallId' | 'billedCallId' | 'stripePaymentIntentId'
    > & { expert: { id: string } }
  >;
}

/**
 * Everything the branches reach outside this module. Production never passes
 * it. Method syntax so a stub may narrow a parameter type.
 */
export interface StripeWebhookDeps {
  stripe: WebhookStripeClient;
  updateExpertStatus(projectId: string, expertId: string, patch: UpdateExpertInput): Promise<unknown>;
  getProject(projectId: string): Promise<WebhookProjectView | null>;
  runExpertPayout(projectId: string, expertId: string): Promise<void>;
  retryPendingPayoutsForAccount(accountId: string): Promise<{ attempted: number; paid: number }>;
  recordSubscriptionStatus(subscriptionId: string, status: string): Promise<void>;
  recordSystemFailure(input: {
    area:       'invoice';
    reason:     string;
    projectId?: string;
    expertId?:  string;
  }): Promise<void>;
  /** Checks completed work and acquires a short processing lease. */
  claimEvent(eventId: string, owner: string): Promise<EventDedupDecision | 'busy'>;
  completeEvent(eventId: string): Promise<void>;
  releaseEvent(eventId: string, owner: string): Promise<void>;
  now(): number;
}

/**
 * The ten-minute mismatch guarantee's two webhook effects. Kept apart from
 * StripeWebhookDeps so a caller that builds that interface in full still
 * type-checks; handleStripeEvent accepts either.
 */
export interface MismatchWebhookDeps {
  /**
   * A payment settled for a flagged call: refund it in full, keep the row
   * 'waived', and pay the expert their 15 minutes
   * (lib/lateCancelBilling.settleMismatchFlag with the payment's intent id).
   */
  settleMismatchPayment(projectId: string, expertId: string, paymentIntentId: string | null): Promise<void>;
  /** The flagged call's refund landed: write 'waived' (lib/lateCancelBilling.recordMismatchRefund). */
  recordMismatchRefund(projectId: string, expertId: string, paymentIntentId: string): Promise<void>;
}

type AllWebhookDeps = StripeWebhookDeps & MismatchWebhookDeps;

function defaultMismatchWebhookDeps(): MismatchWebhookDeps {
  return {
    settleMismatchPayment: async (projectId, expertId, paymentIntentId) => {
      const result = await settleMismatchFlag(projectId, expertId, { paymentIntentId });
      // The refund did not go through: the payment stands for now. Throwing
      // makes the route answer 500 so Stripe redelivers and the refund is
      // retried; the attention row is already written.
      if (!result.ok && result.reason !== 'needs_staff') {
        throw new Error(`mismatch_settlement_failed:${result.reason ?? 'unknown'}`);
      }
    },
    recordMismatchRefund: (projectId, expertId, paymentIntentId) =>
      recordMismatchRefund(projectId, expertId, paymentIntentId),
  };
}

function defaultWebhookDeps(): StripeWebhookDeps {
  return {
    stripe,
    updateExpertStatus,
    getProject,
    runExpertPayout,
    retryPendingPayoutsForAccount,
    recordSubscriptionStatus,
    recordSystemFailure,
    claimEvent: claimStripeEvent,
    completeEvent: completeStripeEvent,
    releaseEvent: releaseStripeEvent,
    now: Date.now,
  };
}

// v2 ignores the old pre-processing markers: they may represent lost work.
const doneKey = (id: string) => `stripe-done:v2:${id}`;
const lockKey = (id: string) => `stripe-processing:v2:${id}`;

export async function claimStripeEvent(eventId: string, owner: string): Promise<EventDedupDecision | 'busy'> {
  const redis = getUpstashClient();
  if (!redis) return 'process';
  try {
    if (await redis.get(doneKey(eventId))) return 'duplicate';
    const acquired = await redis.set(lockKey(eventId), owner, { nx: true, ex: 300 });
    if (!acquired) return 'busy';
    // A prior worker can finish between our first read and acquiring its lock.
    if (await redis.get(doneKey(eventId))) {
      await redis.releaseLockIfOwner(lockKey(eventId), owner);
      return 'duplicate';
    }
    return 'process';
  } catch {
    // Redis is optional. Durable payment state and Stripe idempotency still apply.
    return 'process';
  }
}

async function completeStripeEvent(eventId: string): Promise<void> {
  const redis = getUpstashClient();
  if (redis) await redis.set(doneKey(eventId), '1', { ex: STRIPE_EVENT_TTL_SECONDS });
}

async function releaseStripeEvent(eventId: string, owner: string): Promise<void> {
  const redis = getUpstashClient();
  if (redis) await redis.releaseLockIfOwner(lockKey(eventId), owner);
}

/**
 * Records a successful client payment, then pays out the expert.
 *
 * Except for a call the client flagged under the ten-minute mismatch guarantee
 * (lib/mismatchGuarantee.paymentIsForFlaggedCall): that payment is never
 * recorded as 'paid'. It is refunded, the row stays 'waived', and the expert is
 * paid 15 minutes (MismatchWebhookDeps.settleMismatchPayment). This is what
 * catches a charge that went through while the flag was landing, and a payment
 * link paid after the call was waived.
 */
async function handlePaymentSucceeded(
  projectId: string,
  expertId:  string,
  intentId:  string | null,
  deps:      AllWebhookDeps,
): Promise<void> {
  const project = await deps.getProject(projectId);
  const pe      = project?.experts.find(e => e.expert.id === expertId);
  if (pe && paymentIsForFlaggedCall(pe, intentId)) {
    await deps.settleMismatchPayment(projectId, expertId, intentId);
    return;
  }

  // Do not pay an expert until the client payment has been durably recorded.
  await deps.updateExpertStatus(projectId, expertId, {
    paymentStatus: 'paid',
    paidAt: deps.now(),
    ...(intentId ? { stripePaymentIntentId: intentId } : {}),
  });
  await deps.runExpertPayout(projectId, expertId);
}

async function handlePaymentFailed(
  projectId: string,
  expertId:  string,
  intentId:  string | null,
  deps:      AllWebhookDeps,
): Promise<void> {
  // A charge that was in flight when the client flagged the call failed on its
  // own: the call is already 'waived' and no money was taken, so there is
  // nothing to record and nothing to chase.
  const project = await deps.getProject(projectId);
  const pe      = project?.experts.find(e => e.expert.id === expertId);
  if (pe && pe.paymentStatus === 'waived' && paymentIsForFlaggedCall(pe, intentId)) {
    log.info('[stripe]', 'mismatch-waived-payment-failed', { projectId });
    return;
  }

  await deps.updateExpertStatus(projectId, expertId, { paymentStatus: 'failed' });
  // M-43: a completed call that was never paid for is money the platform is
  // owed and an expert who will never be paid, and it used to exist only as a
  // log line. Recording it puts the engagement on the admin attention list.
  await deps.recordSystemFailure({
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
 * FOUNDER DECISION (2026-09-10, Wave 5): a refund or a dispute moves the
 * engagement to `refunded` and raises the alert, and the expert's transfer is
 * deliberately LEFT ALONE here. Pulling money back out of an expert's bank
 * account is a judgement call about a person we asked to show up, not an
 * automatic consequence of a client's card event, and an unwarranted reversal
 * costs us the expert permanently.
 *
 * Staff decide instead, with a reason, through
 * POST /api/admin/payouts/reverse { projectId, expertId, reason }
 * (adminGuard; lib/stripeConnect.reverseExpertPayout / canReversePayout). The
 * control sits on the Needs Attention item this alert creates, so the refund
 * surfaces and the clawback is one click away from it. The route is idempotent
 * on `expertPayoutReversedAt` and keyed on the payout's own idempotency key, so
 * a double-click replays the first reversal rather than sending a second.
 *
 * THE MISMATCH GUARANTEE. The refund ExpertMatch issued for a call the client
 * flagged inside its first ten minutes is expected: the row stays 'waived', no
 * attention row is raised, and the expert's 15-minute payout is run rather than
 * held (decideRefundTransition with `mismatchRefund`).
 */
async function handleRefundOrDispute(
  ref:      EngagementRef,
  kind:     RefundKind,
  intentId: string | null,
  deps:     AllWebhookDeps,
): Promise<void> {
  const { projectId, expertId } = ref;
  const project = await deps.getProject(projectId);
  const pe = project?.experts.find(e => e.expert.id === expertId);
  if (!pe) return;
  const mismatchRefund = kind === 'refund' && refundIsForFlaggedCall(pe, intentId);
  const decision = decideRefundTransition(pe.paymentStatus ?? null, kind, mismatchRefund);

  if (mismatchRefund && intentId) {
    if (decision.write) await deps.recordMismatchRefund(projectId, expertId, intentId);
    await deps.runExpertPayout(projectId, expertId);
    log.info('[stripe]', 'mismatch-refund-recorded', { projectId });
    return;
  }

  if (decision.write && decision.paymentStatus === 'refunded') {
    await deps.updateExpertStatus(projectId, expertId, { paymentStatus: decision.paymentStatus });
  }

  await deps.recordSystemFailure({
    area:   'invoice',
    reason: decision.reason,
    projectId,
    expertId,
  });
}

/** A Stripe expandable PaymentIntent reference, as its id. */
function intentIdOf(value: string | Stripe.PaymentIntent | null | undefined): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id ?? null;
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
  deps:          StripeWebhookDeps,
): Promise<EngagementRef | null> {
  const direct = engagementRefFromMetadata(metadata);
  if (direct) return direct;

  const intentId = typeof paymentIntent === 'string' ? paymentIntent : paymentIntent?.id;
  if (!intentId) return null;
  const intent = await deps.stripe.paymentIntents.retrieve(intentId);
  return engagementRefFromMetadata(intent.metadata);
}

/**
 * The subscription an invoice bills, on this API version. Since the 2025 basil
 * releases `invoice.subscription` is gone: the link lives under
 * `invoice.parent.subscription_details.subscription`. The legacy top-level
 * field is still read (behind a narrow cast, never `any`) so replayed events
 * from an older API version are handled too. Pure.
 */
export function subscriptionIdForInvoice(invoice: Stripe.Invoice): string | null {
  const fromParent = invoice.parent?.subscription_details?.subscription;
  if (typeof fromParent === 'string') return fromParent;
  if (fromParent && typeof fromParent === 'object') return fromParent.id;

  const legacy = (invoice as { subscription?: string | { id?: string } }).subscription;
  if (typeof legacy === 'string') return legacy;
  if (legacy && typeof legacy.id === 'string') return legacy.id;
  return null;
}

/** What the route answers with. Unchanged from the inline version. */
export interface StripeEventOutcome {
  received:       true;
  duplicate?:     boolean;
  /** Acknowledged without completing: a redelivery could never succeed. */
  unprocessable?: boolean;
}

/**
 * Failures a redelivery can never repair, as distinct from a transient store or
 * provider outage.
 *
 * This distinction is load-bearing. The engagement ids on a Stripe event come
 * from metadata baked into a PaymentIntent or payment link days earlier, and
 * the row they name can be gone by the time the client pays — DELETE
 * /api/projects/[id]/experts/[id] hard-deletes it with no billed-row guard, and
 * projectStore.mutateExpert then throws 'Expert not found'. Asking Stripe to
 * redeliver that for three days achieves nothing and risks Stripe disabling the
 * endpoint, which would stop delivering every OTHER event too: payouts,
 * refunds, subscription status. Such an event is recorded and acknowledged.
 *
 * A missing Stripe object is the same shape: a charge that belongs to a
 * connected account has a PaymentIntent the platform account cannot retrieve,
 * and retrieving it fails permanently with resource_missing.
 */
export function isUnprocessableWebhookError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '');
  if (/^Project not found:/.test(message)) return true;
  if (/^Expert not found:/.test(message)) return true;
  // Stripe's own wording for an object this account cannot see.
  if (/^No such /.test(message)) return true;
  return (err as { code?: unknown } | null)?.code === 'resource_missing';
}

/**
 * Runs the branches for one verified Stripe event.
 *
 * Deliberate properties of this handler, worth knowing before adding a branch:
 *   * CLAIMED, THEN COMPLETED. event.id takes a short owner-safe processing
 *     lease in Redis; the completed marker is written only after the work
 *     succeeds, and a failed claim is released so the route can answer 500 and
 *     Stripe can redeliver. A busy delivery (another worker holds the lease) is
 *     also retried, never acknowledged. The claim FAILS OPEN (no Redis, or a
 *     throwing Redis, processes the event), so every branch must still be safe
 *     to run twice — and is: the paid/failed/refunded writes are last-writer-
 *     wins on the same values, and runExpertPayout guards on the stored
 *     paidCallIds plus a per-call transfer idempotency key.
 *   * NO ORDERING GUARANTEE. Stripe may deliver out of order, so a late
 *     customer.subscription.updated can overwrite a 'past_due' mirrored from
 *     invoice.payment_failed; organization_billing is a hint for the UI, not
 *     the ledger — Stripe is.
 *   * REFUNDS CHANGE STATE, NOT MONEY. charge.refunded and
 *     charge.dispute.created move the engagement to 'refunded' and raise a
 *     system_events row so an operator looks. The expert's payout is NOT
 *     reversed — see the FOUNDER DECISION note on handleRefundOrDispute.
 *   * A FLAGGED CALL IS NEVER 'paid'. A payment that settles for a call the
 *     client flagged under the ten-minute mismatch guarantee is refunded
 *     instead of recorded, and that refund's own charge.refunded keeps the row
 *     'waived' without an alarm (lib/mismatchGuarantee.ts).
 *   * CHECKOUT IS NOT SETTLEMENT. checkout.session.completed only counts as
 *     paid when payment_status is 'paid'; delayed methods settle through
 *     checkout.session.async_payment_succeeded.
 */
export async function handleStripeEvent(
  event: Stripe.Event,
  /** Test seam only — see StripeWebhookDeps. The route omits it. */
  deps?: Partial<StripeWebhookDeps & MismatchWebhookDeps>,
): Promise<StripeEventOutcome> {
  const d: AllWebhookDeps = { ...defaultWebhookDeps(), ...defaultMismatchWebhookDeps(), ...deps };

  const owner = randomUUID();
  const claim = await d.claimEvent(event.id, owner);
  if (claim === 'busy') throw new Error('stripe_event_busy');
  if (claim === 'duplicate') {
    log.info('[stripe]', 'duplicate-event-skipped', { type: event.type });
    return { received: true, duplicate: true };
  }

  try {
    // ── Checkout (payment-link path) ────────────────────────────────────────
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const session   = event.data.object as Stripe.Checkout.Session;
      const projectId = session.metadata?.projectId;
      const expertId  = session.metadata?.expertId;
      const intentId  = typeof session.payment_intent === 'string'
        ? session.payment_intent
        : (session.payment_intent as Stripe.PaymentIntent | null)?.id ?? null;

      if (projectId && expertId && session.payment_status === 'paid') {
        await handlePaymentSucceeded(projectId, expertId, intentId, d);
      }
    }

    if (event.type === 'checkout.session.async_payment_failed') {
      const session   = event.data.object as Stripe.Checkout.Session;
      const projectId = session.metadata?.projectId;
      const expertId  = session.metadata?.expertId;

      if (projectId && expertId) {
        await handlePaymentFailed(projectId, expertId, intentIdOf(session.payment_intent), d);
      }
    }

    // ── PaymentIntent (off-session auto-charge path) ────────────────────────
    // Guard on metadata: intents created outside this flow are ignored.
    if (event.type === 'payment_intent.succeeded') {
      const intent    = event.data.object as Stripe.PaymentIntent;
      const projectId = intent.metadata?.projectId;
      const expertId  = intent.metadata?.expertId;

      if (projectId && expertId) {
        await handlePaymentSucceeded(projectId, expertId, intent.id, d);
      }
    }

    if (event.type === 'payment_intent.payment_failed') {
      const intent    = event.data.object as Stripe.PaymentIntent;
      const projectId = intent.metadata?.projectId;
      const expertId  = intent.metadata?.expertId;

      if (projectId && expertId) {
        await handlePaymentFailed(projectId, expertId, intent.id, d);
      }
    }

    // ── Refunds and chargebacks (H-7) ───────────────────────────────────────
    // Both events carry the charge, not the engagement, so the projectId /
    // expertId are read from the charge's metadata or from its PaymentIntent.
    if (event.type === 'charge.refunded') {
      const charge = event.data.object as Stripe.Charge;
      const ref    = await engagementForCharge(charge.metadata, charge.payment_intent, d);
      if (ref) await handleRefundOrDispute(ref, 'refund', intentIdOf(charge.payment_intent), d);
    }

    if (event.type === 'charge.dispute.created') {
      const dispute = event.data.object as Stripe.Dispute;
      const ref     = await engagementForCharge(dispute.metadata, dispute.payment_intent, d);
      if (ref) await handleRefundOrDispute(ref, 'dispute', intentIdOf(dispute.payment_intent), d);
    }

    // ── Per-seat subscription (organization billing) ────────────────────────
    // Mirrored onto organization_billing so the app can tell a firm its billing
    // needs attention without calling Stripe. recordSubscriptionStatus never
    // throws and ignores subscriptions this deployment does not own.
    if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      const subscription = event.data.object as Stripe.Subscription;
      await d.recordSubscriptionStatus(
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
        await d.recordSubscriptionStatus(subscriptionId, 'past_due');
      }
    }

    // ── Connect account finished onboarding (expert payout) ─────────────────
    // An expert who set up Stripe AFTER their call was billed has a payout sitting
    // in 'pending'; nothing else ever retries it but the nightly sweep.
    // isOnboardingComplete() (lib/stripeConnect.ts) treats details_submitted as
    // the bar, and payouts_enabled is the stricter signal that money can actually
    // move — either is worth a sweep, and runExpertPayout re-checks the account
    // before transferring. Never throws; logs counts only.
    if (event.type === 'account.updated') {
      const account = event.data.object as Stripe.Account;
      const ready =
        account.payouts_enabled === true
        || (account.details_submitted === true && account.charges_enabled === true);
      if (ready && account.id) {
        await d.retryPendingPayoutsForAccount(account.id);
      }
    }

    // Losing the optional dedupe cache must not undo successfully persisted work.
    await d.completeEvent(event.id).catch(() => {});
    return { received: true };
  } catch (err) {
    const ref = engagementRefFromMetadata((event.data.object as { metadata?: Stripe$Metadata }).metadata);
    const unprocessable = isUnprocessableWebhookError(err);
    await d.recordSystemFailure({
      area:   'invoice',
      reason: `${unprocessable ? 'stripe_webhook_unprocessable' : 'stripe_webhook_failed'}:${event.type}`,
      ...(ref ?? {}),
    }).catch(() => {});
    // Recorded, then acknowledged: the operator sees one attention row instead
    // of one per redelivery for three days, and the endpoint stays alive for
    // the events that CAN be processed.
    if (unprocessable) {
      await d.completeEvent(event.id).catch(() => {});
      return { received: true, unprocessable: true };
    }
    throw new Error('stripe_webhook_processing_failed');
  } finally {
    await d.releaseEvent(event.id, owner).catch(() => {});
  }
}
