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
//      - sent      → status 'contacted', emit `intro_sent` (payload carries
//                    the trial arm, docs/OUTREACH_EMAIL_RUBRIC.md)
//      - drafted   → status 'outreach_drafted', nothing else emitted. Also
//                    where the intro lands when Matchy has no personal line it
//                    trusts (`introNeedsWhyThem`) — staff finish it
//      - no address → emit `contact_not_found`, status stays 'bookmarked'
//
// WALKTHROUGH MODE (lib/walkthrough.ts) changes two things and nothing else:
//   - contact discovery NEVER starts. It spends a Snov/Hunter credit and the
//     result could not be used for anything, so an expert with no address on
//     file ends on outcome `walkthrough_held` with the status still
//     'bookmarked'. No provider is called.
//   - an expert we DO have an address for takes the draftOnly path, exactly as
//     review-first does: the intro is written, the status becomes
//     'outreach_drafted', and nothing is sent.
// Live mode is unchanged.
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
import { clientRateFor, expertRateFor, clampClientRateToBand } from '../../../../../../../lib/pricing';
import { getFirm } from '../../../../../../../lib/firmStore';
import { isWalkthrough } from '../../../../../../../lib/walkthrough';
import { trackProductEvent } from '../../../../../../../lib/productEvents';
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
    //    number was already chosen; clientRate always follows from it. When the
    //    project carries a rate band (what the client said they will pay per
    //    hour) the opening offer is pulled inside it first: the tier is only
    //    an estimate, the band is the rule (docs/MATCHY_SPEC.md).
    const tier        = pe.expert.seniorityTier ?? classifySeniority(pe.expert.title ?? '');
    const seededRate  = pe.expertRate && pe.expertRate > 0
      ? pe.expertRate
      : TIER_PRICING[tier].expertRate;
    const tierClient  = clientRateFor(seededRate);
    const bandClient  = clampClientRateToBand(tierClient, project);
    const expertRate  = bandClient === tierClient ? seededRate : expertRateFor(bandClient);
    const clientRate  = clientRateFor(expertRate);

    // Already bookmarked = this is a retry of a failed outreach attempt, not a
    // new engagement. The write below is idempotent; the event is not.
    const isRetry = pe.status === 'bookmarked';

    // Walkthrough: the client is clicking through the flow, so everything below
    // happens except the two things that reach the outside world — a provider
    // call and a send.
    const held = isWalkthrough(project);

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
      void trackProductEvent({
        type:           'candidate_bookmarked',
        actorEmail:     email,
        organizationId: orgId,
        projectId:      params.projectId,
        payload:        { expertId: params.expertId, tier, walkthrough: held },
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
      // Walkthrough: do not spend a credit looking for an address we could not
      // write to anyway. The outcome is recorded on the expert so the Matchy
      // line survives a reload, and the status stays 'bookmarked'.
      if (held) {
        const marked = await updateExpertStatus(params.projectId, params.expertId, {
          contactStatus:  'walkthrough_held',
          emailCheckedAt: Date.now(),
        });

        await emitEngagementEvent({
          projectId: params.projectId,
          expertId:  params.expertId,
          orgId,
          // 'walkthrough_held' is not one of the allowed event kinds (the check
          // constraint in 20260907000000_matchy_phase1.sql), so it rides on the
          // closest one with a payload that says what actually happened.
          type:      'contact_not_found',
          payload:   { tier, walkthrough: true },
        });

        return NextResponse.json({
          ok:            true,
          projectExpert: redactExpertForViewer(
            marked.experts.find(e => e.expert.id === params.expertId) ?? current,
            { role },
          ),
          outcome:       'walkthrough_held',
        });
      }

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

    // 9. Send the intro, or draft it when the project is on review-first — or
    //    in walkthrough, where nothing may leave the building at all.
    const draftOnly = project.reviewFirst === true || held;

    const result = await runSequenceStep({
      projectId: params.projectId,
      expertId:  params.expertId,
      step:      'intro',
      token:     current.outreachToken ?? '',
      firmType:  firm?.firmType ?? null,
      firmSize:  firm?.firmSize ?? null,
      firmName:  firm?.name ?? null,
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

    // What the step actually did is on the status, not on `draftOnly`: the
    // step also holds an intro when Matchy could not write its personal line
    // (introNeedsWhyThem, lib/outreachSteps.ts) or the send chokepoint refused.
    const sent = current.status === 'contacted';

    if (sent) {
      await emitEngagementEvent({
        projectId: params.projectId,
        expertId:  params.expertId,
        orgId,
        type:      'intro_sent',
        payload:   { hasAddress: true, tier, expertRate, clientRate, introArm: current.introArm ?? null },
      });
    }

    return NextResponse.json({
      ok:            true,
      projectExpert: redactExpertForViewer(current, { role }),
      outcome:       sent ? 'intro_sent' : 'intro_drafted',
      ...(held && { held: true }),
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
