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

// ─── Matchy project settings ──────────────────────────────────────────────────

/** Client-side hourly rates are set in $50 steps and never below $100. */
const RATE_STEP = 50;
const RATE_FLOOR = 100;

function isValidClientRate(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && Number.isInteger(value)
    && value >= RATE_FLOOR
    && value % RATE_STEP === 0;
}

interface MatchySettingsPatch {
  reviewFirst?:   boolean;
  clientRateMin?: number | null;
  clientRateMax?: number | null;
}

/**
 * Reads the three Matchy fields off a PUT/PATCH body. Returns `touched` so the
 * caller only enforces owner-or-admin when one of them is actually being
 * changed, and validates the band against whatever the project already has —
 * raising just the floor still has to end up <= the existing ceiling.
 */
function validateMatchySettings(
  body: Record<string, unknown>,
  project: { clientRateMin?: number | null; clientRateMax?: number | null },
): { patch: MatchySettingsPatch; touched: boolean } | { error: Response } {
  const patch: MatchySettingsPatch = {};
  let touched = false;

  if ('reviewFirst' in body) {
    if (typeof body.reviewFirst !== 'boolean') {
      return { error: Response.json({ error: 'invalid_review_first', field: 'reviewFirst' }, { status: 400 }) };
    }
    patch.reviewFirst = body.reviewFirst;
    touched = true;
  }

  for (const field of ['clientRateMin', 'clientRateMax'] as const) {
    if (!(field in body)) continue;
    const value = body[field];
    if (value === null) {
      patch[field] = null;
      touched = true;
      continue;
    }
    if (!isValidClientRate(value)) {
      return {
        error: Response.json(
          {
            error:   `invalid_${field === 'clientRateMin' ? 'client_rate_min' : 'client_rate_max'}`,
            field,
            message: `Rates are whole dollars, at least $${RATE_FLOOR}, in $${RATE_STEP} steps.`,
          },
          { status: 400 },
        ),
      };
    }
    patch[field] = value;
    touched = true;
  }

  const min = patch.clientRateMin !== undefined ? patch.clientRateMin : project.clientRateMin ?? null;
  const max = patch.clientRateMax !== undefined ? patch.clientRateMax : project.clientRateMax ?? null;
  if (min !== null && max !== null && min > max) {
    return {
      error: Response.json(
        { error: 'invalid_client_rate_band', message: 'The lowest rate has to be at or below the highest.' },
        { status: 400 },
      ),
    };
  }

  return { patch, touched };
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

    // ── Matchy project settings ──────────────────────────────────────────────
    // The review-first switch and the client-rate band decide what Matchy
    // sends and what it may agree to on the client's behalf, so only the
    // project owner (or staff) may change them. Collaborators are read-only on
    // outreach decisions (docs/MATCHY_SPEC.md, founder answer 5).
    const matchySettings = validateMatchySettings(body, project);
    if ('error' in matchySettings) return matchySettings.error;
    if (matchySettings.touched && role !== 'admin' && project.ownerEmail !== email) {
      return Response.json(
        { error: 'forbidden', message: 'Only the project owner can change outreach settings.' },
        { status: 403 },
      );
    }

    const updated = await updateProject({
      ...project,
      ...matchySettings.patch,
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
