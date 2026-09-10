// lib/expertWriteFields.ts — who may write what on one ProjectExpert.
//
// The decision layer behind PUT /api/projects/[projectId]/experts/[expertId].
// It lives here, not in the route, so the boundary can be asserted directly
// (scripts/test-billing-boundaries.ts) instead of only through a live request.
//
// Three tiers:
//   COLLABORATOR_FIELDS — a reader's own notes and their reason for passing.
//   OWNER_ONLY_FIELDS   — the engagement's stage and the rates. The owner (or a
//                         platform admin) decides these; a collaborator gets 403.
//   SERVER_OWNED_FIELDS — what a call cost and whether money moved. NOBODY may
//                         send these, owner and platform admin included.
//
// The third tier is the one with teeth. The project owner is the person whose
// card is charged, so while `paymentStatus` was writable they could send
// { paymentStatus: 'paid' } — or any `stripePaymentIntentId` — before
// completing the call, and lib/createAndSendInvoice.ts's double-bill guard
// would treat the engagement as already billed and charge nothing. The same
// applies to `callDurationMin`: written after the charge, it inflates the
// payout lib/expertPayout.ts computes when Stripe's webhook lands.
//
// These fields are written by exactly three server paths, and no others:
//   POST /api/projects/[projectId]/experts/[expertId]/complete  (recomputes the
//        amount from the stored rate before charging)
//   POST /api/webhooks/zoom          (meeting.ended → actual duration)
//   POST /api/webhooks/stripe        (payment succeeded / failed)

/** Fields any project member may write — their own notes, their own reasons. */
export const COLLABORATOR_FIELDS: ReadonlySet<string> = new Set([
  'note',
  'userNotes',
  'rejectionReason',
  'rejectionNotes',
  'rejectedAt',
]);

/** Fields only the project owner or a platform admin may write. */
export const OWNER_ONLY_FIELDS: readonly string[] = [
  'status',
  'screeningStatus',
  'clientRate',
  'expertRate',
  'expertCounterRate',
];

/** Billing state no request body may write. See the module comment. */
export const SERVER_OWNED_FIELDS: readonly string[] = [
  'callDurationMin',
  'invoiceAmount',
  'paymentStatus',
  'paidAt',
  'stripePaymentLinkId',
  'stripePaymentLinkUrl',
  'stripePaymentIntentId',
];

/**
 * The server-owned fields a request body tries to set, in declaration order.
 * An explicit `undefined` is not an attempt to write — that is how the route's
 * other branches read a body — but `null` is, so it is reported.
 */
export function serverOwnedFieldsIn(body: Record<string, unknown>): string[] {
  return SERVER_OWNED_FIELDS.filter(field => body[field] !== undefined);
}
