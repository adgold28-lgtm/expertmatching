// lib/expertFieldTiers.ts
// The three write tiers for PUT /api/projects/[projectId]/experts/[expertId]:
// staff-only (money/Stripe/contact/tokens/calendar/Zoom/scheduling), owner
// (stage/screening), and collaborator (notes). They live here, not in the
// route file, because Next 14 forbids a route.ts from exporting anything
// besides its HTTP handlers and the small config allow-list (dynamic, etc.).

import { sanitizeText, LIMITS } from './projectValidation';
// The same syntax check contact discovery uses before it writes an address, so
// the two paths that can set contactEmail agree on what an address is.
import { isValidEmailSyntax } from './contactDiscovery';

/**
 * TIER 3 — fields ANY project member may write: the notes a reader keeps for
 * themselves and the reason they think an expert is wrong. A body made only of
 * these needs no owner check at all.
 */
export const COLLABORATOR_FIELDS: ReadonlySet<string> = new Set([
  'note',
  'userNotes',
  'rejectionReason',
  'rejectionNotes',
  'rejectedAt',
]);

/**
 * TIER 1 — STAFF ONLY (role 'admin'). Every one of these is derived state or a
 * credential: the two rates and the counter pair (lib/pricing.ts is the only
 * converter, and .../rate-decision the only client path to a rate), everything
 * Stripe writes back through its webhook, the contact address and its
 * verification (contact discovery owns it; whoever sets it decides where
 * Matchy's intro lands), the expert-facing tokens, the calendar and Zoom
 * credentials, and the scheduling / booking / nudge records that bookCall and
 * the nudge job maintain.
 *
 * The project OWNER is refused these exactly like a collaborator. Before the
 * 2026-09-08 audit the gate here was requireProjectOwner, which passes for a
 * role 'user' who owns the project: a client could send {"expertRate": 1} and
 * bill themselves $1/hr while underpaying the expert (C-1), mark the call
 * 'paid' so createAndSendInvoice never charged, or point contactEmail at an
 * address they control and harvest the expert-facing thread (H-1).
 *
 * A field being absent from the route's own body handling is not a defence —
 * this list is checked against the raw body, so a key the route does not read
 * today is still refused if it is ever wired up.
 */
export const STAFF_ONLY_FIELDS: readonly string[] = [
  'expertRate',
  'expertCounterRate',
  'clientCounterRate',
  'counterRateProposed',
  'callDurationMin',
  'invoiceAmount',
  'paymentStatus',
  'paidAt',
  'stripePaymentLinkId',
  'stripePaymentLinkUrl',
  'stripePaymentIntentId',
  'stripeTransferId',
  'expertPaidAt',
  'expertOnboardingStatus',
  'stripeConnectAccountId',
  'contactEmail',
  'emailProvider',
  'emailVerificationStatus',
  'emailCheckedAt',
  'contactStatus',
  'outreachToken',
  'availabilityTokenHash',
  'availabilityTokenExpiry',
  'calendarAccessToken',
  'calendarRefreshToken',
  'oauthState',
  'zoomMeetingId',
  'zoomJoinUrl',
  'zoomStartUrl',
  'scheduling',
  'booking',
  'nudges',
  // Matchy 2.0 (docs/OUTREACH_EMAIL_RUBRIC.md). The intro's personal line names
  // the expert's employer and what they did there — the identity a client is
  // not entitled to before the reveal — and the arm and domain describe the
  // same email; lib/redactExpert.ts strips all three on the way out, so they
  // are refused on the way in too. `introNeedsWhyThem` is the step's own hold
  // flag and `rateAgreedAt` is the rate lock: a client who could clear either
  // could send an intro Matchy declined to write, or re-open an agreed rate.
  'whyThem',
  'introDomain',
  'introArm',
  'introNeedsWhyThem',
  'rateAgreedAt',
];

const STAFF_ONLY_SET: ReadonlySet<string> = new Set(STAFF_ONLY_FIELDS);

/**
 * TIER 2 — OWNER OR ADMIN. What the client who created the project may still
 * move: the engagement's stage (a non-admin is narrowed again by
 * CLIENT_WRITABLE_STATUSES in the route), the screening verdict and its
 * material, the outreach draft, and the contact-path candidates the client
 * picks from. The three note fields are here because an owner writes them too;
 * they are also in COLLABORATOR_FIELDS, which is what actually decides whether
 * the owner check runs. Documentation of the tier, not a second gate: the gate
 * is "present and not in COLLABORATOR_FIELDS" (see classifyBodyFields), so a
 * new key added to the route's handling defaults to owner-or-admin rather than
 * to everyone.
 */
export const OWNER_FIELDS: readonly string[] = [
  'status',
  'screeningStatus',
  // The per-expert client rate (Matchy 2.0). The ONE money field a non-admin
  // may write, and deliberately not on the staff list above: it is the
  // client's own number, fee included, and the route converts it through
  // lib/pricing.expertRateFor → rateFieldsFor so both figures still come out
  // of one conversion. The route refuses it outside the project's band or
  // after the rate is agreed.
  'clientRate',
  'userNotes',
  'rejectionReason',
  'rejectionNotes',
  'rejectedAt',
  'note',
  'contactedAt',
  'outreachSubject',
  'outreachDraft',
  'valueChainPosition',
  'vettingQuestions',
  'screeningNotes',
  'knowledgeFit',
  'communicationQuality',
  'conflictRisk',
  'recommendToClient',
  'availability',
  'rateExpectation',
  'scheduledTime',
  'screenedAt',
  'availabilityRequestedAt',
  'suggestedDomains',
  'publicContactEmails',
  'selectedDomain',
  'selectedContactPathType',
];

/**
 * Sorts the keys a body actually carries into the two tiers that need a check.
 * Pure, so scripts/test-expert-route-authz.ts can prove the tiers without a
 * session, a project or a network.
 *
 *   staffOnly — present keys this caller may never write. Empty for an admin;
 *               for anyone else it is every STAFF_ONLY_FIELDS key in the body.
 *               Non-empty means 403 read_only, whoever is calling.
 *   ownerOnly — present keys outside COLLABORATOR_FIELDS, i.e. the ones that
 *               make this request need requireProjectOwner.
 *
 * "Present" means `!== undefined`, matching how the handler reads the body: an
 * explicit null (`{"paymentStatus": null}`) is a write and is classified.
 */
export function classifyBodyFields(
  body: Record<string, unknown>,
  role: 'admin' | 'user',
): { staffOnly: string[]; ownerOnly: string[] } {
  const present = Object.keys(body).filter(field => body[field] !== undefined);
  return {
    staffOnly: role === 'admin' ? [] : present.filter(field => STAFF_ONLY_SET.has(field)),
    ownerOnly: present.filter(field => !COLLABORATOR_FIELDS.has(field)),
  };
}

/**
 * The only shape check on the address Matchy writes to. Admin-only by the tier
 * above, but a typo from staff sends the intro into the void just as surely as
 * a hostile value would, so the syntax check is unconditional. Lower-cased
 * because outreach_suppressions and the contact cache key on the address
 * (lib/outreachSuppressions.ts), and a mixed-case duplicate would slip a
 * suppressed expert back into the sequence. Returns null when it is not an
 * address, which the caller answers 400 invalid_contact_email.
 */
export function normalizeContactEmail(value: unknown): string | null {
  const trimmed = sanitizeText(value, LIMITS.contactEmail).toLowerCase();
  return isValidEmailSyntax(trimmed) ? trimmed : null;
}
