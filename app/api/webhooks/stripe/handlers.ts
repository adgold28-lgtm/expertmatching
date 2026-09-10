// app/api/webhooks/stripe/handlers.ts — the pure decisions the Stripe webhook
// makes, kept out of route.ts because a Next 14 route file may export only its
// HTTP handlers and its route segment config.
//
// Nothing here does I/O: every function takes what the route already read and
// returns what the route should do. That is what makes the de-duplication rule
// and the refund transition testable (scripts/test-payout-state.ts) without a
// Stripe account or a Redis instance.

import type { ProjectExpert } from '../../../../types';

// ─── Event de-duplication (H-7 companion: branches must not run twice) ────────

/** Redis key for one delivered Stripe event. No PII: event ids are opaque. */
export function stripeEventKey(eventId: string): string {
  return `stripe-event:${eventId}`;
}

/** How long a handled event id is remembered. Stripe retries for up to 3 days. */
export const STRIPE_EVENT_TTL_SECONDS = 7 * 24 * 60 * 60;

export type EventDedupDecision = 'process' | 'duplicate';

/**
 * Decides whether to run the branches for an event, given the result of
 * `SET stripe-event:<id> NX EX 7d`.
 *
 *   'OK'  → this delivery claimed the key: process.
 *   null  → the key already existed: a redelivery, skip and answer 200.
 *
 * FAIL-OPEN. When Redis is absent or the SET threw (`available: false`) the
 * event is processed: every branch is independently idempotent (the paid/failed
 * writes are last-writer-wins, the payout guard is the stored paidCallIds, the
 * subscription mirror is a copy of Stripe's own state), so processing twice
 * costs a duplicate write, while refusing would cost a lost payment. Pure.
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
  paymentStatus: 'refunded';
  /** Short, id-free reason for the system_events row. */
  reason:        string;
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
 * row, and a partially refunded call still needs a human. Pure.
 */
export function decideRefundTransition(
  current: ProjectExpert['paymentStatus'],
  kind:    RefundKind,
): RefundDecision {
  return {
    write:         current !== 'refunded',
    paymentStatus: 'refunded',
    reason:        kind === 'dispute' ? 'refund_or_dispute:dispute' : 'refund_or_dispute:refund',
  };
}
