// POST /api/projects/:projectId/experts/:expertId/unbookmark
//
// Undo a bookmark, back to 'shortlisted'.
//
// Only while the status is still exactly 'bookmarked' — that is the window in
// which nothing has left the building. The moment Matchy has drafted or sent
// the intro the expert is past 'bookmarked', and there is nothing to take
// back: an email cannot be unsent, so pretending otherwise would be a lie in
// the UI. 409 in that case, and the client can reject the expert instead.
//
// Same access rule as bookmark: the project owner or a platform admin.
// Collaborators are read-only on outreach decisions.
//
// Nothing is emitted. An undone bookmark is not a fact about the expert; the
// original `bookmarked` event stands as the record that it happened.
//
// Never logs: expert name, expert email, project name.

import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '../../../../../../../lib/auth';
import { guardMutatingRequest } from '../../../../../../../lib/projectsGuard';
import { getProjectForUser, updateExpertStatus } from '../../../../../../../lib/projectStore';
import { redactExpertForViewer } from '../../../../../../../lib/redactExpert';
import { trackProductEvent } from '../../../../../../../lib/productEvents';

const ID_RE        = /^[a-f0-9]{24}$/;
const EXPERT_ID_RE = /^[a-zA-Z0-9\-_]+$/;

export async function POST(
  request: NextRequest,
  { params }: { params: { projectId: string; expertId: string } },
): Promise<NextResponse> {
  const guard = await guardMutatingRequest(request);
  if ('error' in guard) return guard.error as NextResponse;

  if (!ID_RE.test(params.projectId)) {
    return NextResponse.json({ error: 'invalid_project_id' }, { status: 400 });
  }
  if (!EXPERT_ID_RE.test(params.expertId)) {
    return NextResponse.json({ error: 'invalid_expert_id' }, { status: 400 });
  }

  try {
    const { email, role } = await getSessionUser(request);
    const project = await getProjectForUser(params.projectId, email, role);
    if (!project) return NextResponse.json({ error: 'project_not_found' }, { status: 404 });

    const pe = project.experts.find(e => e.expert.id === params.expertId);
    if (!pe) return NextResponse.json({ error: 'expert_not_found' }, { status: 404 });

    if (role !== 'admin' && project.ownerEmail !== email) {
      return NextResponse.json(
        { error: 'forbidden', message: 'Only the project owner can undo a bookmark.' },
        { status: 403 },
      );
    }

    if (pe.status !== 'bookmarked') {
      return NextResponse.json(
        {
          error:   'outreach_already_started',
          message: 'Matchy has already written to this expert. Reject them instead.',
        },
        { status: 409 },
      );
    }

    // The seeded rates stay. They cost nothing while the expert sits on the
    // shortlist, and keeping them means re-bookmarking does not silently
    // change a number the client may already have seen.
    const updated = await updateExpertStatus(params.projectId, params.expertId, {
      status: 'shortlisted',
    });
    const after = updated.experts.find(e => e.expert.id === params.expertId);
    void trackProductEvent({
      type:       'candidate_unbookmarked',
      actorEmail: email,
      projectId:  params.projectId,
      payload:    { expertId: params.expertId },
    });

    return NextResponse.json({
      ok:            true,
      projectExpert: after ? redactExpertForViewer(after, { role }) : null,
    });
  } catch (err) {
    console.error('[unbookmark] failed:', err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return NextResponse.json({ error: 'unbookmark_failed' }, { status: 500 });
  }
}
