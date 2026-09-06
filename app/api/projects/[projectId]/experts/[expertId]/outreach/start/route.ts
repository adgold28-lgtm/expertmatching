// POST /api/projects/:projectId/experts/:expertId/outreach/start
//
// Session-authed start of the outreach sequence — this is what the "Send
// Email 1" button calls. It exists because /api/email-sequence/trigger demands
// a valid QStash signature in production, so a browser can never drive it.
// Both routes run the same lib/outreachSteps.ts implementation.
//
// Pre-send policy, all fail closed:
//   contactEmail must be present            → 422 no_contact_email
//   expertRate must be set (no default)     → 422 expert_rate_not_set
//   status must be pre-outreach             → 409 outreach_already_started
//   address must not be on the DNC list     → 403 contact_suppressed
//   DNC list unreadable                     → 503 suppression_check_failed
//
// Never logs: expert name, expert email, project name, token, email content.

import { NextRequest, NextResponse } from 'next/server';
import { routeAuthGuard, getSessionUser } from '../../../../../../../../lib/auth';
import { getProjectForUser } from '../../../../../../../../lib/projectStore';
import { runSequenceStep } from '../../../../../../../../lib/outreachSteps';
import { isSuppressed } from '../../../../../../../../lib/outreachSuppressions';
import type { ExpertStatus } from '../../../../../../../../types';

const ID_RE        = /^[a-f0-9]{24}$/;
const EXPERT_ID_RE = /^[a-zA-Z0-9\-_]+$/;

// Statuses from which a first outreach email may be sent. Everything else
// means outreach already started, the expert was rejected, or the engagement
// has moved on — all of which must not re-open a cold email.
const STARTABLE_STATUSES: ReadonlySet<ExpertStatus> = new Set<ExpertStatus>([
  'discovered',
  'shortlisted',
  'contact_found',
  'outreach_drafted',
]);

export async function POST(
  request: NextRequest,
  { params }: { params: { projectId: string; expertId: string } },
): Promise<NextResponse> {
  // 1. Auth
  const authErr = await routeAuthGuard(request);
  if (authErr) return authErr as NextResponse;

  // 2. Validate IDs
  if (!ID_RE.test(params.projectId)) {
    return NextResponse.json({ error: 'invalid_project_id' }, { status: 400 });
  }
  if (!EXPERT_ID_RE.test(params.expertId)) {
    return NextResponse.json({ error: 'invalid_expert_id' }, { status: 400 });
  }

  // 3. Load project (ownership / collaborator / admin scoped) and find expert.
  //    404 on inaccessible/nonexistent so we do not leak project existence.
  const { email, role } = await getSessionUser(request);
  const project = await getProjectForUser(params.projectId, email, role);
  if (!project) {
    return NextResponse.json({ error: 'project_not_found' }, { status: 404 });
  }
  const pe = project.experts.find(e => e.expert.id === params.expertId);
  if (!pe) {
    return NextResponse.json({ error: 'expert_not_found' }, { status: 404 });
  }

  // 4. Contact email
  if (!pe.contactEmail) {
    return NextResponse.json(
      { error: 'no_contact_email', message: 'Find the expert email before starting outreach' },
      { status: 422 },
    );
  }

  // 5. Rate — no fallback. A cold email must never quote a number nobody chose.
  if (!pe.expertRate || pe.expertRate <= 0) {
    return NextResponse.json(
      { error: 'expert_rate_not_set', message: 'Set expert rate before starting outreach' },
      { status: 422 },
    );
  }

  // 6. Idempotency — one cold email per expert, per project
  if (!STARTABLE_STATUSES.has(pe.status) || pe.email1SentAt) {
    return NextResponse.json(
      { error: 'outreach_already_started', message: 'Outreach has already started for this expert' },
      { status: 409 },
    );
  }

  // 7. Global do-not-contact list. Fails CLOSED: if we cannot verify, we do
  //    not send.
  const suppression = await isSuppressed(pe.contactEmail);
  if (!suppression.ok) {
    return NextResponse.json(
      { error: 'suppression_check_failed', message: 'Could not verify the do-not-contact list. Try again shortly.' },
      { status: 503 },
    );
  }
  if (suppression.suppressed) {
    return NextResponse.json(
      { error: 'contact_suppressed', message: 'This address has opted out of outreach' },
      { status: 403 },
    );
  }

  // 8. Send email1 through the shared step implementation
  const result = await runSequenceStep({
    projectId: params.projectId,
    expertId:  params.expertId,
    step:      'email1',
    token:     pe.outreachToken ?? '',
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  const updated = result.project.experts.find(e => e.expert.id === params.expertId);
  return NextResponse.json({ ok: true, projectExpert: updated ?? null });
}
