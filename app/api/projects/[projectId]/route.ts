import { NextRequest } from 'next/server';
import { getProject, getProjectForUser, updateProject, deleteProject } from '../../../../lib/projectStore';
import { guardReadRequest, guardMutatingRequest } from '../../../../lib/projectsGuard';
import { sanitizeText, LIMITS, VALID_PERSPECTIVES } from '../../../../lib/projectValidation';
import { getSessionUser } from '../../../../lib/auth';
import { redactProjectForViewer, isIdentityRevealed } from '../../../../lib/redactExpert';
import { backfillProjectAnonymization, needsAnonymization } from '../../../../lib/anonymizeExpert';

const ID_RE = /^[a-f0-9]{24}$/;

/**
 * Lazily enriches experts that predate anonymized descriptors.
 *
 * The response is NOT held up for this: the redactor already substitutes a
 * deterministic fallback descriptor, so the client sees a complete card now and
 * an LLM-written one on the next load. Next 14 has no `after()` helper, so this
 * is a deliberate floating promise (same convention as
 * lib/sourcingJob.runSourcingJobDetached). If the serverless instance freezes
 * before it finishes, the work is simply retried on the next load — the backfill
 * is idempotent and only ever touches experts still missing a descriptor.
 *
 * Failures are swallowed and logged without any expert data.
 */
function scheduleAnonymizationBackfill(projectId: string): void {
  void backfillProjectAnonymization(projectId).catch((err: unknown) => {
    console.warn('[api/projects/[id]] anonymization backfill failed:',
      err instanceof Error ? err.message : String(err));
  });
}

export async function GET(
  request: NextRequest,
  { params }: { params: { projectId: string } },
) {
  const err = guardReadRequest(request);
  if (err) return err;

  if (!ID_RE.test(params.projectId)) {
    return Response.json({ error: 'invalid_project_id' }, { status: 400 });
  }
  try {
    const { email, role } = await getSessionUser(request);
    const project = await getProjectForUser(params.projectId, email, role);
    if (!project) return Response.json({ error: 'not_found' }, { status: 404 });

    // A non-admin looking at an expert who is still anonymized needs a
    // descriptor. If any such expert has none stored, enrich them for next time.
    if (role !== 'admin') {
      const needsBackfill = project.experts.some(pe =>
        !isIdentityRevealed(pe.status) && needsAnonymization(pe.expert),
      );
      if (needsBackfill) scheduleAnonymizationBackfill(params.projectId);
    }

    return Response.json({ project: redactProjectForViewer(project, { role }) });
  } catch (err) {
    console.error('[api/projects/[id]] GET error:', err instanceof Error ? err.message : String(err));
    return Response.json({ error: 'failed_to_get_project' }, { status: 500 });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: { projectId: string } },
) {
  const guard = await guardMutatingRequest(request);
  if ('error' in guard) return guard.error;
  const { body } = guard;

  if (!ID_RE.test(params.projectId)) {
    return Response.json({ error: 'invalid_project_id' }, { status: 400 });
  }
  try {
    const { email, role } = await getSessionUser(request);
    const project = await getProjectForUser(params.projectId, email, role);
    if (!project) return Response.json({ error: 'not_found' }, { status: 404 });

    const updated = await updateProject({
      ...project,
      ...(typeof body.name  === 'string' && { name:  sanitizeText(body.name,  LIMITS.projectName) || project.name }),
      // Client scheduling fields — stored as-is (validated by request-client-availability route)
      ...('clientEmail' in body && { clientEmail: typeof body.clientEmail === 'string' ? body.clientEmail.trim() || null : null }),
      ...('clientName'  in body && { clientName:  typeof body.clientName  === 'string' ? body.clientName.trim()  || null : null }),
      ...(typeof body.notes === 'string' && { notes: sanitizeText(body.notes, LIMITS.notes) }),
      ...(typeof body.confidentialNotes === 'string' && {
        confidentialNotes: sanitizeText(body.confidentialNotes, LIMITS.confidentialNotes),
      }),
      ...(typeof body.timeline === 'string' && {
        timeline: sanitizeText(body.timeline, LIMITS.timeline) || undefined,
      }),
      ...(typeof body.targetExpertCount === 'number' && {
        targetExpertCount: Math.max(1, Math.min(200, Math.floor(body.targetExpertCount))),
      }),
      ...(typeof body.keyQuestions === 'string' && {
        keyQuestions: sanitizeText(body.keyQuestions, LIMITS.keyQuestions) || undefined,
      }),
      ...(typeof body.initialHypotheses === 'string' && {
        initialHypotheses: sanitizeText(body.initialHypotheses, LIMITS.initialHypotheses) || undefined,
      }),
      ...(typeof body.conflictExclusions === 'string' && {
        conflictExclusions: sanitizeText(body.conflictExclusions, LIMITS.conflictExclusions) || undefined,
      }),
      // Additional brief context fields
      ...(typeof body.additionalContext === 'string' && {
        additionalContext: sanitizeText(body.additionalContext, LIMITS.additionalContext) || undefined,
      }),
      ...(typeof body.mustHaveExpertise === 'string' && {
        mustHaveExpertise: sanitizeText(body.mustHaveExpertise, LIMITS.mustHaveExpertise) || undefined,
      }),
      ...(typeof body.niceToHaveExpertise === 'string' && {
        niceToHaveExpertise: sanitizeText(body.niceToHaveExpertise, LIMITS.niceToHaveExpertise) || undefined,
      }),
      ...(typeof body.targetCompanies === 'string' && {
        targetCompanies: sanitizeText(body.targetCompanies, LIMITS.targetCompanies) || undefined,
      }),
      ...(typeof body.companiesToAvoid === 'string' && {
        companiesToAvoid: sanitizeText(body.companiesToAvoid, LIMITS.companiesToAvoid) || undefined,
      }),
      ...(typeof body.peopleToAvoid === 'string' && {
        peopleToAvoid: sanitizeText(body.peopleToAvoid, LIMITS.peopleToAvoid) || undefined,
      }),
      ...(Array.isArray(body.perspectivesNeeded) && {
        perspectivesNeeded: (body.perspectivesNeeded as unknown[])
          .filter((v): v is string => typeof v === 'string' && VALID_PERSPECTIVES.has(v))
          .slice(0, 10),
      }),
      ...(typeof body.researchQuestion === 'string' && {
        researchQuestion: sanitizeText(body.researchQuestion, LIMITS.researchQuestion) || project.researchQuestion,
      }),
      ...(typeof body.expertType === 'string' && {
        expertType: sanitizeText(body.expertType, LIMITS.functionField) || undefined,
      }),
      ...((body.outreachMode === 'auto' || body.outreachMode === 'review') && {
        outreachMode: body.outreachMode as 'auto' | 'review',
      }),
    });

    return Response.json({ project: redactProjectForViewer(updated, { role }) });
  } catch (err) {
    console.error('[api/projects/[id]] PUT error:', err instanceof Error ? err.message : String(err));
    return Response.json({ error: 'failed_to_update_project' }, { status: 500 });
  }
}

export { PUT as PATCH };

export async function DELETE(
  request: NextRequest,
  { params }: { params: { projectId: string } },
) {
  const err = guardReadRequest(request);
  if (err) return err;

  if (!ID_RE.test(params.projectId)) {
    return Response.json({ error: 'invalid_project_id' }, { status: 400 });
  }
  try {
    const { email, role } = await getSessionUser(request);
    const project = await getProjectForUser(params.projectId, email, role);
    if (!project) return Response.json({ error: 'not_found' }, { status: 404 });

    // Only owner (or admin) can delete.
    if (role !== 'admin' && project.ownerEmail !== email) {
      return Response.json({ error: 'forbidden' }, { status: 403 });
    }

    const result = await deleteProject(params.projectId);
    console.info('[api/projects/[id]] DELETE', JSON.stringify({ action: 'delete_project', result: result.success ? 'success' : 'failure' }));
    if (!result.success) {
      return Response.json({ error: 'failed_to_delete_project' }, { status: 500 });
    }
    return Response.json({ ok: true });
  } catch (err) {
    console.error('[api/projects/[id]] DELETE error:', err instanceof Error ? err.message : String(err));
    return Response.json({ error: 'failed_to_delete_project' }, { status: 500 });
  }
}
