// PUT | PATCH  — update one expert on a project
// DELETE       — remove one expert from a project
//
// WHO MAY WHAT (docs/MATCHY_SPEC.md, founder answer 5: a shared project is
// read-only for collaborators, and only the owner or staff acts on an expert):
//
//   open to any project member — the notes a reader keeps for themselves, and
//   the reason they think an expert is wrong:
//       note, userNotes, rejectionReason, rejectionNotes, rejectedAt
//
//   OWNER OR ADMIN ONLY (see OWNER_ONLY_FIELDS) — anything that moves the
//   engagement or touches money:
//       status, screeningStatus, expertRate, expertCounterRate,
//       callDurationMin, invoiceAmount, paymentStatus, paidAt,
//       stripePaymentLinkId, stripePaymentLinkUrl, stripePaymentIntentId
//
//   DELETE is owner-or-admin outright — removing an expert throws away the
//   whole engagement.
//
// The owner check always runs AFTER getProjectForUser, so a project the caller
// cannot reach still answers 404 and never confirms that it exists.
//
// MONEY: `expertRate` is never written on its own. projectStore.rateFieldsFor
// derives `clientRate` from it in the same write, so the number the client is
// billed can never drift from the number the expert accepted.
//
// MATCHY 2.0 — THE PER-EXPERT RATE. The owner may set `clientRate` (their
// number, fee included) for one engagement: it must sit on the $50 grid,
// inside the project's band, and the rate must not be agreed yet
// (`rateAgreedAt`, or a status past the negotiation). The expert-side figure is
// derived in the same write (lib/pricing.expertRateFor → rateFieldsFor), the
// mirror of the staff-side `expertRate` write above. Nothing is sent: the next
// message to the expert carries the new number.
//
// A client's "pass" on an expert Matchy has already written to lands on
// `rejected_after_outreach` (the server maps it), so the thread's Pass reads
// the same as a pass from Matches and the nudges stop either way.

import { NextRequest } from 'next/server';
import { updateExpertStatus, addExpertNote, removeExpertFromProject, getProjectForUser, rateFieldsFor } from '../../../../../../lib/projectStore';
import { expertRateFor, isValidClientRateUsd, CLIENT_RATE_FLOOR_USD, CLIENT_RATE_ROUNDING_USD } from '../../../../../../lib/pricing';
import { guardMutatingRequest, requireProjectOwner } from '../../../../../../lib/projectsGuard';
import { getSessionUser } from '../../../../../../lib/auth';
import { sanitizeText, LIMITS } from '../../../../../../lib/projectValidation';
import { EXPERT_STATUSES } from '../../../../../../lib/expertPipeline';
import { redactProjectForViewer } from '../../../../../../lib/redactExpert';
import { trackProductEvent } from '../../../../../../lib/productEvents';
import type { ExpertStatus, RejectionReason, ValueChainPosition, ScreeningStatus, ContactStatus, SuggestedDomain, PublicContactEmail } from '../../../../../../types';

const ID_RE        = /^[a-f0-9]{24}$/;
const EXPERT_ID_RE = /^[a-zA-Z0-9\-_]+$/;

const VALID_STATUSES = new Set<ExpertStatus>(EXPERT_STATUSES);

/**
 * The statuses a CLIENT (owner) may write directly: put a candidate back in the
 * pool, shortlist them, or pass on them. Everything else is the engagement's
 * progress and is written by the server as Matchy works — bookmark has its own
 * route, and `scheduled` / `completed` are half of the identity-reveal
 * condition (lib/redactExpert.isIdentityRevealed), so a client writing them
 * would be a client revealing an expert nobody has booked. Staff may write any.
 */
const CLIENT_WRITABLE_STATUSES = new Set<ExpertStatus>(['discovered', 'shortlisted', 'rejected']);

const VALID_REJECTION_REASONS = new Set<RejectionReason>([
  'too_generic', 'wrong_industry', 'wrong_geography', 'weak_evidence',
  'no_contact_path', 'conflict_risk', 'not_senior_enough',
  'too_academic', 'vendor_biased', 'better_option_available', 'other',
]);

const VALID_VALUE_CHAIN_POSITIONS = new Set<ValueChainPosition>([
  'supplier', 'equipment_vendor', 'producer_operator', 'processor_manufacturer',
  'distributor', 'retail_customer', 'regulator_academic', 'investor_advisor', 'other',
]);

const VALID_SCREENING_STATUSES = new Set<ScreeningStatus>([
  'not_screened', 'vetting_questions_ready', 'outreach_sent', 'expert_replied',
  'screening_scheduled', 'screened', 'client_ready', 'rejected_after_screen',
]);

const VALID_CONFLICT_RISKS = new Set(['low', 'medium', 'high', 'unknown']);

const VALID_EMAIL_VERIFICATION_STATUSES = new Set<ContactStatus>([
  'verified', 'catchall', 'risky', 'invalid', 'not_found',
]);
const VALID_EMAIL_PROVIDERS = new Set(['hunter', 'snov', 'none']);

/**
 * Body keys only the project owner (or a platform admin) may send: the
 * engagement's stage, the screening verdict, and every field that decides what
 * anyone gets charged or paid. A collaborator sending one of these gets 403;
 * a body without any of them is a note or a rejection reason and goes through.
 */
// Fields a COLLABORATOR may write. Everything else on this route is owner or
// platform-admin only: contact details, drafts, availability, screening
// material and every money field move the engagement or steer outreach.
const COLLABORATOR_FIELDS: ReadonlySet<string> = new Set([
  'note',
  'userNotes',
  'rejectionReason',
  'rejectionNotes',
  'rejectedAt',
]);
const OWNER_ONLY_FIELDS: readonly string[] = [
  'status',
  'screeningStatus',
  'clientRate',
  'expertRate',
  'expertCounterRate',
  'callDurationMin',
  'invoiceAmount',
  'paymentStatus',
  'paidAt',
  'stripePaymentLinkId',
  'stripePaymentLinkUrl',
  'stripePaymentIntentId',
];

export async function PUT(
  request: NextRequest,
  { params }: { params: { projectId: string; expertId: string } },
) {
  const guard = await guardMutatingRequest(request);
  if ('error' in guard) return guard.error;
  const { body } = guard;

  if (!ID_RE.test(params.projectId)) {
    return Response.json({ error: 'invalid_project_id' }, { status: 400 });
  }
  if (!EXPERT_ID_RE.test(params.expertId)) {
    return Response.json({ error: 'invalid_expert_id' }, { status: 400 });
  }

  try {
    // Verify the caller can access this project (ownership / collaborator / admin)
    // before any mutation. 404 on inaccessible/nonexistent to avoid leaking existence.
    const { email, role } = await getSessionUser(request);
    const accessible = await getProjectForUser(params.projectId, email, role);
    if (!accessible) return Response.json({ error: 'not_found' }, { status: 404 });

    // Stage and money are the owner's to move; notes are not.
    // Anything outside the collaborator allowlist is owner-or-admin only.
    const writesOwnerField = Object.keys(body).some(
      field => body[field] !== undefined && !COLLABORATOR_FIELDS.has(field),
    );
    if (writesOwnerField || OWNER_ONLY_FIELDS.some(field => body[field] !== undefined)) {
      const ownerErr = requireProjectOwner(accessible, { email, role });
      if (ownerErr) return ownerErr;
    }

    // Dispatch to correct store method based on action
    if (typeof body.note === 'string') {
      const note = body.note.trim().slice(0, LIMITS.userNotes);
      if (!note) return Response.json({ error: 'note cannot be empty' }, { status: 400 });
      const project = await addExpertNote(params.projectId, params.expertId, note);
      return Response.json({ project: redactProjectForViewer(project, { role }) });
    }

    // Status / metadata update
    const input: Parameters<typeof updateExpertStatus>[2] = {};

    if (body.status !== undefined) {
      if (!VALID_STATUSES.has(body.status as ExpertStatus)) {
        return Response.json({ error: 'invalid_status', field: 'status' }, { status: 400 });
      }
      if (role !== 'admin' && !CLIENT_WRITABLE_STATUSES.has(body.status as ExpertStatus)) {
        return Response.json(
          {
            error:   'status_not_client_settable',
            field:   'status',
            message: 'That stage is set by Matchy as the engagement progresses.',
          },
          { status: 403 },
        );
      }
      input.status = body.status as ExpertStatus;
    }

    // A client passing on an expert Matchy has already written to: the
    // engagement ends as `rejected_after_outreach` (nudges stop, the thread
    // keeps its history), never as a pre-contact `rejected`. Staff may write
    // either directly.
    const current = accessible.experts.find(e => e.expert.id === params.expertId);
    if (input.status === 'rejected' && role !== 'admin' && current && (current.outreachToken || current.contactedAt)) {
      input.status = 'rejected_after_outreach';
    }

    if (body.rejectionReason !== undefined) {
      if (body.rejectionReason !== null && !VALID_REJECTION_REASONS.has(body.rejectionReason as RejectionReason)) {
        return Response.json({ error: 'invalid_rejection_reason', field: 'rejectionReason' }, { status: 400 });
      }
      input.rejectionReason = (body.rejectionReason ?? undefined) as RejectionReason | undefined;
    }
    // rejectionNotes — never logged
    if (typeof body.rejectionNotes === 'string') {
      input.rejectionNotes = sanitizeText(body.rejectionNotes, 2_000);
    }
    if (typeof body.rejectedAt === 'number' && Number.isFinite(body.rejectedAt) && body.rejectedAt > 0) {
      input.rejectedAt = body.rejectedAt;
    }

    if (typeof body.contactEmail    === 'string') input.contactEmail    = sanitizeText(body.contactEmail,    LIMITS.contactEmail);
    if (typeof body.contactedAt === 'number' && Number.isFinite(body.contactedAt) && body.contactedAt > 0) {
      input.contactedAt = body.contactedAt;
    }
    if (body.emailVerificationStatus !== undefined) {
      if (body.emailVerificationStatus !== null && !VALID_EMAIL_VERIFICATION_STATUSES.has(body.emailVerificationStatus as ContactStatus)) {
        return Response.json({ error: 'invalid_email_verification_status', field: 'emailVerificationStatus' }, { status: 400 });
      }
      input.emailVerificationStatus = (body.emailVerificationStatus ?? undefined) as ContactStatus | undefined;
    }
    if (body.emailProvider !== undefined) {
      if (body.emailProvider !== null && !VALID_EMAIL_PROVIDERS.has(body.emailProvider as string)) {
        return Response.json({ error: 'invalid_email_provider', field: 'emailProvider' }, { status: 400 });
      }
      input.emailProvider = (body.emailProvider ?? undefined) as 'hunter' | 'snov' | 'none' | undefined;
    }
    if (typeof body.emailCheckedAt === 'number' && Number.isFinite(body.emailCheckedAt) && body.emailCheckedAt > 0) {
      input.emailCheckedAt = body.emailCheckedAt;
    }
    if (typeof body.contactStatus   === 'string') input.contactStatus   = sanitizeText(body.contactStatus,   50);
    if (typeof body.outreachSubject === 'string') input.outreachSubject = sanitizeText(body.outreachSubject, LIMITS.outreachSubject);
    if (typeof body.outreachDraft   === 'string') input.outreachDraft   = sanitizeText(body.outreachDraft,   LIMITS.outreachDraft);
    if (typeof body.userNotes       === 'string') input.userNotes       = sanitizeText(body.userNotes,       LIMITS.userNotes);

    // Screening fields — screeningNotes and availability are never logged
    if (body.valueChainPosition !== undefined) {
      if (!VALID_VALUE_CHAIN_POSITIONS.has(body.valueChainPosition as ValueChainPosition)) {
        return Response.json({ error: 'invalid_value_chain_position', field: 'valueChainPosition' }, { status: 400 });
      }
      input.valueChainPosition = body.valueChainPosition as ValueChainPosition;
    }
    if (body.screeningStatus !== undefined) {
      if (!VALID_SCREENING_STATUSES.has(body.screeningStatus as ScreeningStatus)) {
        return Response.json({ error: 'invalid_screening_status', field: 'screeningStatus' }, { status: 400 });
      }
      input.screeningStatus = body.screeningStatus as ScreeningStatus;
    }
    if (Array.isArray(body.vettingQuestions) && body.vettingQuestions.every(q => typeof q === 'string')) {
      input.vettingQuestions = (body.vettingQuestions as string[]).slice(0, 10).map(q => q.slice(0, 1_000));
    }
    if (typeof body.screeningNotes === 'string') input.screeningNotes = sanitizeText(body.screeningNotes, LIMITS.screeningNotes);
    if (typeof body.knowledgeFit === 'number' && [1,2,3,4,5].includes(body.knowledgeFit)) {
      input.knowledgeFit = body.knowledgeFit as 1 | 2 | 3 | 4 | 5;
    }
    if (typeof body.communicationQuality === 'number' && [1,2,3,4,5].includes(body.communicationQuality)) {
      input.communicationQuality = body.communicationQuality as 1 | 2 | 3 | 4 | 5;
    }
    if (body.conflictRisk !== undefined) {
      if (!VALID_CONFLICT_RISKS.has(body.conflictRisk as string)) {
        return Response.json({ error: 'invalid_conflict_risk', field: 'conflictRisk' }, { status: 400 });
      }
      input.conflictRisk = body.conflictRisk as 'low' | 'medium' | 'high' | 'unknown';
    }
    if (typeof body.recommendToClient === 'boolean') input.recommendToClient = body.recommendToClient;
    if (typeof body.availability    === 'string') input.availability    = sanitizeText(body.availability,    LIMITS.availability);
    if (typeof body.rateExpectation === 'string') input.rateExpectation = sanitizeText(body.rateExpectation, LIMITS.rateExpectation);
    if (typeof body.scheduledTime   === 'string') input.scheduledTime   = sanitizeText(body.scheduledTime,   LIMITS.scheduledTime);
    if (typeof body.screenedAt === 'number' && Number.isFinite(body.screenedAt) && body.screenedAt > 0) {
      input.screenedAt = body.screenedAt;
    }

    // Billing fields. The client rate rides along with the expert rate in the
    // same write (lib/projectStore.rateFieldsFor) — never one without the other.
    if (typeof body.expertRate === 'number' && Number.isFinite(body.expertRate) && body.expertRate >= 1 && body.expertRate <= 9999) {
      const rates = rateFieldsFor(body.expertRate);
      input.expertRate = rates.expertRate;
      input.clientRate = rates.clientRate;
    }

    // The owner's own number for this engagement (Matchy 2.0). Client dollars
    // in; both fields out of one conversion.
    if (body.clientRate !== undefined) {
      const requested = body.clientRate;
      if (!isValidClientRateUsd(requested)) {
        return Response.json(
          {
            error:   'invalid_client_rate',
            field:   'clientRate',
            message: `Whole dollars, at least $${CLIENT_RATE_FLOOR_USD}, in $${CLIENT_RATE_ROUNDING_USD} steps.`,
          },
          { status: 400 },
        );
      }
      const locked = !!current?.rateAgreedAt
        || current?.status === 'scheduling_sent'
        || current?.status === 'scheduled'
        || current?.status === 'completed';
      if (locked) {
        const agreed = typeof current?.clientRate === 'number' ? `$${current.clientRate.toLocaleString('en-US')}/hr` : 'the agreed rate';
        return Response.json(
          { error: 'rate_locked', message: `The rate with this expert is agreed at ${agreed}. It does not move after that.` },
          { status: 409 },
        );
      }
      const min = typeof accessible.clientRateMin === 'number' && accessible.clientRateMin > 0 ? accessible.clientRateMin : null;
      const max = typeof accessible.clientRateMax === 'number' && accessible.clientRateMax > 0 ? accessible.clientRateMax : null;
      if ((min !== null && requested < min) || (max !== null && requested > max)) {
        const band = min !== null && max !== null
          ? `$${min.toLocaleString('en-US')} to $${max.toLocaleString('en-US')}`
          : min !== null ? `at least $${min.toLocaleString('en-US')}` : `at most $${(max as number).toLocaleString('en-US')}`;
        return Response.json(
          { error: 'outside_band', message: `Inside your band, ${band}, in $${CLIENT_RATE_ROUNDING_USD} steps. Change the band in settings for more room.` },
          { status: 409 },
        );
      }
      const rates = rateFieldsFor(expertRateFor(requested));
      input.expertRate = rates.expertRate;
      input.clientRate = rates.clientRate;
    }
    if (typeof body.callDurationMin === 'number' && Number.isInteger(body.callDurationMin) && body.callDurationMin >= 1 && body.callDurationMin <= 480) {
      input.callDurationMin = body.callDurationMin;
    }
    if (typeof body.invoiceAmount === 'number' && Number.isFinite(body.invoiceAmount)) {
      input.invoiceAmount = body.invoiceAmount;
    }
    if (typeof body.stripePaymentLinkId  === 'string') input.stripePaymentLinkId  = body.stripePaymentLinkId;
    if (typeof body.stripePaymentLinkUrl === 'string') input.stripePaymentLinkUrl = body.stripePaymentLinkUrl;
    if (typeof body.stripePaymentIntentId === 'string') input.stripePaymentIntentId = body.stripePaymentIntentId;
    if (body.paymentStatus !== undefined) {
      const VALID_PAYMENT_STATUSES = new Set(['unpaid', 'invoice_sent', 'paid', 'failed']);
      if (body.paymentStatus !== null && !VALID_PAYMENT_STATUSES.has(body.paymentStatus as string)) {
        return Response.json({ error: 'invalid_payment_status' }, { status: 400 });
      }
      input.paymentStatus = (body.paymentStatus ?? null) as 'unpaid' | 'invoice_sent' | 'paid' | 'failed' | null;
    }
    if (typeof body.paidAt === 'number' && Number.isFinite(body.paidAt) && body.paidAt > 0) {
      input.paidAt = body.paidAt;
    }
    if (typeof body.availabilityRequestedAt === 'number' && Number.isFinite(body.availabilityRequestedAt) && body.availabilityRequestedAt > 0) {
      input.availabilityRequestedAt = body.availabilityRequestedAt;
    }

    // Contact path discovery fields — stored as JSON, never logged in full
    if (Array.isArray(body.suggestedDomains)) {
      // Accept only plain objects with required fields — strip unknown keys
      input.suggestedDomains = (body.suggestedDomains as unknown[])
        .filter((d): d is SuggestedDomain =>
          !!d && typeof d === 'object' &&
          typeof (d as Record<string, unknown>).domain === 'string' &&
          typeof (d as Record<string, unknown>).confidence === 'string')
        .slice(0, 20)
        .map(d => ({
          domain:           String(d.domain).slice(0, 253),
          label:            String(d.label ?? d.domain).slice(0, 300),
          confidence:       d.confidence,
          reason:           String(d.reason ?? '').slice(0, 500),
          sourceType:       d.sourceType,
          verifiedOfficial: d.verifiedOfficial,
        }));
    }
    if (Array.isArray(body.publicContactEmails)) {
      input.publicContactEmails = (body.publicContactEmails as unknown[])
        .filter((e): e is PublicContactEmail =>
          !!e && typeof e === 'object' &&
          typeof (e as Record<string, unknown>).email === 'string' &&
          typeof (e as Record<string, unknown>).confidence === 'string')
        .slice(0, 10)
        .map(e => ({
          email:       String(e.email).slice(0, 200),
          label:       String(e.label ?? e.email).slice(0, 200),
          confidence:  e.confidence,
          contactType: e.contactType,
          reason:      String(e.reason ?? '').slice(0, 500),
          sourceUrl:   e.sourceUrl ? String(e.sourceUrl).slice(0, 500) : undefined,
        }));
    }
    if (typeof body.selectedDomain === 'string') {
      input.selectedDomain = sanitizeText(body.selectedDomain, 253);
    }
    const VALID_PATH_TYPES = new Set(['personal_email', 'general_company_email', 'linkedin_source', 'unknown']);
    if (typeof body.selectedContactPathType === 'string' && VALID_PATH_TYPES.has(body.selectedContactPathType)) {
      input.selectedContactPathType = body.selectedContactPathType as 'personal_email' | 'general_company_email' | 'linkedin_source' | 'unknown';
    }

    const before  = accessible.experts.find(e => e.expert.id === params.expertId)?.status;
    const project = await updateExpertStatus(params.projectId, params.expertId, input);

    if (input.status && input.status !== before) {
      const passedNow    = input.status === 'rejected' || input.status === 'rejected_after_outreach';
      const passedBefore = before === 'rejected' || before === 'rejected_after_outreach';
      const type = passedNow && !passedBefore ? 'candidate_passed'
        : passedBefore && !passedNow ? 'candidate_unpassed'
        : null;
      if (type) {
        void trackProductEvent({
          type,
          actorEmail: email,
          projectId:  params.projectId,
          payload:    { expertId: params.expertId, ...(input.rejectionReason ? { reason: input.rejectionReason } : {}) },
        });
      }
    }

    return Response.json({ project: redactProjectForViewer(project, { role }) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('not found')) return Response.json({ error: 'not_found' }, { status: 404 });
    console.error('[api/projects/[id]/experts/[eid]] PUT error:', msg);
    return Response.json({ error: 'failed_to_update_expert' }, { status: 500 });
  }
}

export { PUT as PATCH };

export async function DELETE(
  request: NextRequest,
  { params }: { params: { projectId: string; expertId: string } },
) {
  // A removal is a mutation, so it takes the mutating guard, not the read one.
  const guard = await guardMutatingRequest(request);
  if ('error' in guard) return guard.error;

  if (!ID_RE.test(params.projectId)) {
    return Response.json({ error: 'invalid_project_id' }, { status: 400 });
  }
  if (!EXPERT_ID_RE.test(params.expertId)) {
    return Response.json({ error: 'invalid_expert_id' }, { status: 400 });
  }
  try {
    // Verify the caller can access this project before removing an expert.
    const { email, role } = await getSessionUser(request);
    const accessible = await getProjectForUser(params.projectId, email, role);
    if (!accessible) return Response.json({ error: 'not_found' }, { status: 404 });

    // Throwing away an engagement is the owner's call, not a reader's.
    const ownerErr = requireProjectOwner(accessible, { email, role });
    if (ownerErr) return ownerErr;

    const project = await removeExpertFromProject(params.projectId, params.expertId);
    return Response.json({ project: redactProjectForViewer(project, { role }) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('not found')) return Response.json({ error: 'not_found' }, { status: 404 });
    console.error('[api/projects/[id]/experts/[eid]] DELETE error:', msg);
    return Response.json({ error: 'failed_to_remove_expert' }, { status: 500 });
  }
}
