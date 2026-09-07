// POST /api/projects/:projectId/experts/:expertId/bookmark
//
// The one action that starts an engagement. From here Matchy owns the expert
// relationship (docs/MATCHY_SPEC.md, "Workflow"):
//
//   1. status → 'bookmarked'
//   2. seed the money: expertRate from the seniority tier if it is not already
//      set, clientRate derived from it by lib/pricing.clientRateFor — never
//      recomputed anywhere else
//   3. emit `bookmarked` — once per engagement. Re-bookmarking an expert that
//      is already 'bookmarked' (the retry path after contact_not_found /
//      intro_failed) re-runs the outreach attempt and emits nothing here.
//   4. if we already have an address, send Matchy's intro (or draft it, when
//      the project's review-first switch is on)
//      - sent      → status 'contacted', emit `intro_sent`
//      - drafted   → status 'outreach_drafted', nothing else emitted
//      - no address → emit `contact_not_found`, status stays 'bookmarked'
//
// The send itself runs through lib/outreachSteps.runSequenceStep with
// step 'intro', the same implementation the legacy outreach/start route uses —
// one place that resolves the reply token, indexes it for inbound lookup,
// sends through Resend and writes the status.
//
// WHO MAY: the project owner or a platform admin. Collaborators can see the
// project but cannot send to an expert on someone else's behalf (spec, founder
// answer 5). 404 rather than 403 on an inaccessible project, so the route never
// confirms that a project exists.
//
// Never logs: expert name, expert email, project name, token, email content.

import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '../../../../../../../lib/auth';
import { guardMutatingRequest } from '../../../../../../../lib/projectsGuard';
import { getProjectForUser, updateExpertStatus } from '../../../../../../../lib/projectStore';
import { runSequenceStep } from '../../../../../../../lib/outreachSteps';
import { isSuppressed } from '../../../../../../../lib/outreachSuppressions';
import { emitEngagementEvent } from '../../../../../../../lib/engagementEvents';
import {
  isQStashConfigured,
  publishContactDiscoveryJob,
  runContactDiscoveryJobDetached,
} from '../../../../../../../lib/contactDiscovery';
import { redactExpertForViewer } from '../../../../../../../lib/redactExpert';
import { classifySeniority, TIER_PRICING } from '../../../../../../../lib/seniorityClassifier';
import { clientRateFor } from '../../../../../../../lib/pricing';
import { getFirm } from '../../../../../../../lib/firmStore';
import type { ExpertStatus, ProjectExpert } from '../../../../../../../types';

const ID_RE        = /^[a-f0-9]{24}$/;
const EXPERT_ID_RE = /^[a-zA-Z0-9\-_]+$/;

/**
 * A bookmark is the client saving an expert nothing has been sent to yet.
 *
 * 'bookmarked' is in the set on purpose: it is the status an expert is left in
 * when the outreach attempt did not land (no address on file, the intro failed
 * to send, the suppression check was unavailable). Nothing retries on its own
 * in Phase 1, so bookmarking again IS the retry — it re-runs the attempt
 * without emitting a second `bookmarked` event.
 *
 * Anything past 'bookmarked' still 409s: the engagement started and re-running
 * the intro would be a second cold email.
 */
const BOOKMARKABLE_STATUSES: ReadonlySet<ExpertStatus> = new Set<ExpertStatus>([
  'discovered',
  'shortlisted',
  'bookmarked',
]);

export async function POST(
  request: NextRequest,
  { params }: { params: { projectId: string; expertId: string } },
): Promise<NextResponse> {
  // 1. Guard (kill switch, auth, origin, content-type, body)
  const guard = await guardMutatingRequest(request);
  if ('error' in guard) return guard.error as NextResponse;

  // 2. Validate ids
  if (!ID_RE.test(params.projectId)) {
    return NextResponse.json({ error: 'invalid_project_id' }, { status: 400 });
  }
  if (!EXPERT_ID_RE.test(params.expertId)) {
    return NextResponse.json({ error: 'invalid_expert_id' }, { status: 400 });
  }

  try {
    // 3. Access — 404 on inaccessible so we never leak project existence
    const { email, role } = await getSessionUser(request);
    const project = await getProjectForUser(params.projectId, email, role);
    if (!project) return NextResponse.json({ error: 'project_not_found' }, { status: 404 });

    const pe = project.experts.find(e => e.expert.id === params.expertId);
    if (!pe) return NextResponse.json({ error: 'expert_not_found' }, { status: 404 });

    // 4. Only the owner (or staff) may start outreach. Collaborators read.
    if (role !== 'admin' && project.ownerEmail !== email) {
      return NextResponse.json(
        { error: 'forbidden', message: 'Only the project owner can bookmark an expert.' },
        { status: 403 },
      );
    }

    // 5. Idempotency
    if (!BOOKMARKABLE_STATUSES.has(pe.status)) {
      return NextResponse.json(
        {
          error:   'already_engaged',
          message: 'This expert has already moved past the shortlist.',
        },
        { status: 409 },
      );
    }

    // 6. Seed the two rates. expertRate is the tier's opening offer unless a
    //    number was already chosen; clientRate always follows from it.
    const tier       = pe.expert.seniorityTier ?? classifySeniority(pe.expert.title ?? '');
    const expertRate = pe.expertRate && pe.expertRate > 0
      ? pe.expertRate
      : TIER_PRICING[tier].expertRate;
    const clientRate = clientRateFor(expertRate);

    // Already bookmarked = this is a retry of a failed outreach attempt, not a
    // new engagement. The write below is idempotent; the event is not.
    const isRetry = pe.status === 'bookmarked';

    let current = await applyBookmark(params.projectId, params.expertId, expertRate, clientRate);

    // One organization read: it supplies both the org id every event carries
    // and the firm type/size Matchy uses to describe the client to the expert.
    const firm  = await getFirm(project.firmDomain).catch(() => null);
    const orgId = firm?.id ?? null;

    if (!isRetry) {
      await emitEngagementEvent({
        projectId: params.projectId,
        expertId:  params.expertId,
        orgId,
        type:      'bookmarked',
        payload:   { tier, expertRate, clientRate },
      });
    }

    // 7. Contact. With an address on file the intro goes now (below). Without
    //    one, Matchy goes and looks: the provider waterfall takes seconds to
    //    tens of seconds, so it runs as a background job
    //    (/api/jobs/contact-discovery) rather than on this request, and that
    //    job sends the intro itself when it finds something. The client sees
    //    one line — "Looking for an address…" — not the mechanism.
    //
    //    If the job cannot be queued we fall back to Phase 1's behaviour: say
    //    there is no address and let the client bookmark again to retry.
    if (!current.contactEmail) {
      const queued = await startContactDiscovery(params.projectId, params.expertId);

      await emitEngagementEvent({
        projectId: params.projectId,
        expertId:  params.expertId,
        orgId,
        // `contact_discovery_started` is not one of the allowed event kinds
        // (supabase/migrations/20260907000000_matchy_phase1.sql check
        // constraint), so the start of a search is recorded as the closest
        // one with a payload that says what actually happened.
        type:      'contact_not_found',
        payload:   { tier, stage: 'discovery', reason: queued ? 'queued' : 'queue_failed', attempt: 1 },
      });

      return NextResponse.json({
        ok:            true,
        projectExpert: redactExpertForViewer(current, { role }),
        outcome:       queued ? 'contact_discovery_started' : 'contact_not_found',
      });
    }

    // 8. Global do-not-contact list. Fails CLOSED — if we cannot verify, we do
    //    not send. The bookmark itself stands.
    const suppression = await isSuppressed(current.contactEmail);
    if (!suppression.ok || suppression.suppressed) {
      await emitEngagementEvent({
        projectId: params.projectId,
        expertId:  params.expertId,
        orgId,
        type:      'contact_not_found',
        payload:   { tier, suppressed: suppression.ok && suppression.suppressed },
      });
      return NextResponse.json({
        ok:            true,
        projectExpert: redactExpertForViewer(current, { role }),
        outcome:       suppression.ok ? 'contact_suppressed' : 'contact_check_unavailable',
      });
    }

    await emitEngagementEvent({
      projectId: params.projectId,
      expertId:  params.expertId,
      orgId,
      type:      'contact_found',
      payload:   { tier, verification: current.emailVerificationStatus ?? 'unknown' },
    });

    // 9. Send the intro, or draft it when the project is on review-first.
    const draftOnly = project.reviewFirst === true;

    const result = await runSequenceStep({
      projectId: params.projectId,
      expertId:  params.expertId,
      step:      'intro',
      token:     current.outreachToken ?? '',
      firmType:  firm?.firmType ?? null,
      firmSize:  firm?.firmSize ?? null,
      draftOnly,
    });

    if (!result.ok) {
      // The bookmark stands; the send did not. The client sees that the expert
      // is saved and that we have not written to them yet.
      console.warn('[bookmark] intro not sent', JSON.stringify({ reason: result.error }));
      return NextResponse.json({
        ok:            true,
        projectExpert: redactExpertForViewer(current, { role }),
        outcome:       'intro_failed',
      });
    }

    current = result.project.experts.find(e => e.expert.id === params.expertId) ?? current;

    if (!draftOnly) {
      await emitEngagementEvent({
        projectId: params.projectId,
        expertId:  params.expertId,
        orgId,
        type:      'intro_sent',
        payload:   { hasAddress: true, tier, expertRate, clientRate },
      });
    }

    return NextResponse.json({
      ok:            true,
      projectExpert: redactExpertForViewer(current, { role }),
      outcome:       draftOnly ? 'intro_drafted' : 'intro_sent',
    });
  } catch (err) {
    console.error('[bookmark] failed:', err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return NextResponse.json({ error: 'bookmark_failed' }, { status: 500 });
  }
}

/**
 * Hands the search to the background job and says whether it is on its way.
 *
 * Production: QStash publishes to /api/jobs/contact-discovery (retries off —
 * one attempt per bookmark, because a redelivery would be a second cold email).
 * Local dev without QSTASH_TOKEN: the same function runs in-process, detached,
 * exactly as lib/sourcingJob does.
 *
 * Returns false when the search could not be started at all — the caller then
 * falls back to the "no address on file" line and the client can retry by
 * bookmarking again.
 */
async function startContactDiscovery(projectId: string, expertId: string): Promise<boolean> {
  const job = { projectId, expertId, attempt: 1 };

  if (!isQStashConfigured()) {
    runContactDiscoveryJobDetached(job);
    return true;
  }

  try {
    await publishContactDiscoveryJob(job);
    return true;
  } catch (err) {
    console.error('[bookmark] could not queue contact discovery:',
      err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return false;
  }
}

/** Writes the status and the seeded rates, and returns the updated expert. */
async function applyBookmark(
  projectId: string,
  expertId: string,
  expertRate: number,
  clientRate: number,
): Promise<ProjectExpert> {
  const updated = await updateExpertStatus(projectId, expertId, {
    status: 'bookmarked',
    expertRate,
    clientRate,
  });
  const pe = updated.experts.find(e => e.expert.id === expertId);
  if (!pe) throw new Error('expert vanished during bookmark');
  return pe;
}
