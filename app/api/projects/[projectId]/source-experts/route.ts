// POST — protected by routeAuthGuard()
// Starts a background expert-sourcing run for a project and returns
// immediately. Sourcing takes minutes; the browser polls GET /api/projects/[id]
// and reads project.sourcingStatus rather than holding the request open.
//
// Request body (all optional):
//   { businessProblem?: string, expertType?: string }
//   — brief values the user just typed, used for this run.
//
// Responses:
//   200 { ok: true, status: 'running' }
//   409 { error: 'sourcing_already_running' }  — a run started < 15 min ago
//   403 { error: 'forbidden' }                 — a collaborator, not the owner
//   404 { error: 'project_not_found' }         — also for inaccessible projects
//
// NEVER log: project names, research questions, or brief content.

import { NextRequest, NextResponse } from 'next/server';
import { routeAuthGuard, getSessionUser } from '../../../../../lib/auth';
import { requireProjectOwner } from '../../../../../lib/projectsGuard';
import { trackProductEvent } from '../../../../../lib/productEvents';
import { getProjectForUser, updateProjectFields } from '../../../../../lib/projectStore';
import {
  isQStashConfigured,
  publishSourcingJob,
  runSourcingJobDetached,
  SOURCING_STALE_MS,
  type SourcingJob,
} from '../../../../../lib/sourcingJob';

const ID_RE = /^[a-f0-9]{24}$/;

export async function POST(
  request: NextRequest,
  { params }: { params: { projectId: string } },
) {
  // 1. Auth
  const authErr = await routeAuthGuard(request);
  if (authErr) return authErr;

  // 2. Validate ID
  if (!ID_RE.test(params.projectId)) {
    return NextResponse.json({ error: 'invalid_project_id' }, { status: 400 });
  }

  // 3. Body — optional brief overrides.
  //    These are for THIS RUN ONLY: they travel in the QStash job payload and
  //    are never written back to the project, so the saved brief and the inputs
  //    a run actually used can differ. The 5000-char clamp is the only bound on
  //    text that ends up inside an Anthropic prompt downstream.
  let body: Record<string, unknown> = {};
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    // Empty body is valid — fall back to the saved brief.
  }
  const businessProblem = typeof body.businessProblem === 'string'
    ? body.businessProblem.trim().slice(0, 5000)
    : undefined;
  const expertType = typeof body.expertType === 'string'
    ? body.expertType.trim().slice(0, 5000)
    : undefined;

  // 4. Load project (ownership / collaborator / admin scoped).
  //    404 on inaccessible/nonexistent so we do not leak project existence.
  const { email, role } = await getSessionUser(request);
  const project = await getProjectForUser(params.projectId, email, role);
  if (!project) {
    return NextResponse.json({ error: 'project_not_found' }, { status: 404 });
  }

  // 4b. A sourcing run costs real provider spend and rewrites the project's
  //     candidate list, so only the owner (or staff) may start one.
  //     Collaborators are read-only (docs/MATCHY_SPEC.md, founder answer 5).
  const ownerErr = requireProjectOwner(project, { email, role });
  if (ownerErr) return ownerErr as NextResponse;

  // 5. One live run per project. A run older than SOURCING_STALE_MS is
  //    considered dead (worker crash, deploy mid-run) and may be replaced.
  const startedAt = project.sourcingStartedAt ?? 0;
  if (project.sourcingStatus === 'running' && Date.now() - startedAt < SOURCING_STALE_MS) {
    return NextResponse.json({ error: 'sourcing_already_running' }, { status: 409 });
  }

  // 6. Nothing to search on — fail fast rather than burning a job.
  const query = (businessProblem ?? project.researchQuestion ?? '').trim();
  if (!query) {
    return NextResponse.json(
      { error: 'query_required', message: 'Add a business problem to the brief before sourcing.' },
      { status: 400 },
    );
  }

  const job: SourcingJob = {
    projectId: params.projectId,
    ...(businessProblem ? { businessProblem } : {}),
    ...(expertType      ? { expertType }      : {}),
  };

  // 7. Mark running before enqueueing, so a poll that lands between the two
  //    still sees the run.
  await updateProjectFields(params.projectId, {
    sourcingStatus:    'running',
    sourcingStartedAt: Date.now(),
    sourcingError:     null,
  });

  try {
    if (isQStashConfigured()) {
      await publishSourcingJob(job);
    } else {
      // Local dev without QStash — run in-process, detached from this response.
      runSourcingJobDetached(job);
    }
  } catch (err) {
    // Enqueue failed — never leave the project stuck on 'running'.
    console.error('[source-experts] enqueue failed', {
      reason: err instanceof Error ? err.message.slice(0, 120) : 'unknown',
    });
    await updateProjectFields(params.projectId, {
      sourcingStatus:    'failed',
      sourcingStartedAt: null,
      sourcingError:     'Could not start sourcing. Please try again.',
    });
    return NextResponse.json({ error: 'enqueue_failed' }, { status: 502 });
  }

  void trackProductEvent({
    type:       'sourcing_started',
    actorEmail: email,
    projectId:  params.projectId,
    payload:    { existingExperts: project.experts.length, rerun: project.experts.length > 0 },
  });

  return NextResponse.json({ ok: true, status: 'running' });
}
