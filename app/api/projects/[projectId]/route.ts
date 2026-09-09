// GET | PUT | PATCH | DELETE  /api/projects/[projectId]
//
// The project workspace's own endpoint: load the brief and every expert on it,
// save the brief, flip the Matchy settings, delete the project.
//
// ACCESS, in this order everywhere below:
//   1. guardReadRequest / guardMutatingRequest (kill switch, auth, content-type,
//      body size — lib/projectsGuard.ts)
//   2. getProjectForUser → null means 404, so an inaccessible project is
//      indistinguishable from one that does not exist
//   3. for PUT and DELETE only: owner-or-admin. A shared project is READ-ONLY
//      for collaborators (docs/MATCHY_SPEC.md, founder answer 5) — they may
//      write per-expert notes through the experts/[expertId] route, nothing here.
//
// Every `{ project }` body is passed through redactProjectForViewer first, so a
// non-admin never receives contact paths, expertRate, tokens or an unrevealed
// expert's real name (lib/redactExpert.ts).
//
// THREE SEPARATE GATES SIT ON THE PUT and are easy to confuse:
//   - the owner check       — who may write at all
//   - entitlements          — whether this org may leave walkthrough (a card on
//                             file; lib/entitlements.ts)
//   - the brief version     — whether the brief moved under the writer (409)
//
// Never logs: project names, research questions, confidential notes, expert data.

import { NextRequest } from 'next/server';
import { getProject, getProjectForUser, updateProject, deleteProject } from '../../../../lib/projectStore';
import { guardReadRequest, guardMutatingRequest } from '../../../../lib/projectsGuard';
import { sanitizeText, LIMITS, VALID_PERSPECTIVES } from '../../../../lib/projectValidation';
import { getSessionUser } from '../../../../lib/auth';
import { redactProjectForViewer, isIdentityRevealed } from '../../../../lib/redactExpert';
import { backfillProjectAnonymization, needsAnonymization } from '../../../../lib/anonymizeExpert';
import { getEntitlementsForProject, activationRequired } from '../../../../lib/entitlements';
import { trackProductEvent } from '../../../../lib/productEvents';
import { getAuthUserIdByEmail } from '../../../../lib/supabase/admin';

/**
 * Brief fields a PUT may change. Everything here is merged into the brief
 * document (lib/projectStore.updateProject rewrites the whole jsonb), which is
 * why saving carries a version: two people editing the same brief must not
 * silently overwrite each other (see `briefVersion` below).
 */
const BRIEF_FIELDS = new Set([
  'name', 'clientEmail', 'clientName', 'notes', 'confidentialNotes', 'timeline',
  'targetExpertCount', 'keyQuestions', 'initialHypotheses', 'conflictExclusions',
  'additionalContext', 'mustHaveExpertise', 'niceToHaveExpertise', 'targetCompanies',
  'companiesToAvoid', 'peopleToAvoid', 'perspectivesNeeded', 'researchQuestion', 'expertType',
]);

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
  walkthrough?:   boolean;
  clientRateMin?: number | null;
  clientRateMax?: number | null;
}

/**
 * Reads the Matchy fields off a PUT/PATCH body. Returns `touched` so the
 * caller only enforces owner-or-admin when one of them is actually being
 * changed, and validates the band against whatever the project already has —
 * raising just the floor still has to end up <= the existing ceiling.
 *
 * GOING LIVE LANDS ON REVIEW-FIRST. `walkthrough: false` without an explicit
 * `reviewFirst` in the same body sets `reviewFirst: true`, so the step from
 * "nothing is sent" to "real emails" is never also a step to "and they go on
 * their own". An owner who wants auto-send says so in the same request.
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

  if ('walkthrough' in body) {
    if (typeof body.walkthrough !== 'boolean') {
      return { error: Response.json({ error: 'invalid_walkthrough', field: 'walkthrough' }, { status: 400 }) };
    }
    patch.walkthrough = body.walkthrough;
    touched = true;
    if (body.walkthrough === false && !('reviewFirst' in body)) {
      patch.reviewFirst = true;
    }
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
        !isIdentityRevealed(pe) && needsAnonymization(pe.expert),
      );
      if (needsBackfill) scheduleAnonymizationBackfill(params.projectId);
    }

    // The workspace's FIRST fetch says so with a header; the 5-second sourcing
    // poll and the thread refreshes do not, so one visit is one event.
    if (request.headers.get('x-em-visit') === '1') {
      void trackProductEvent({ type: 'project_opened', actorEmail: email, projectId: params.projectId });
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

    // ── Who may write ────────────────────────────────────────────────────────
    // A shared project is READ-ONLY for collaborators (docs/MATCHY_SPEC.md,
    // founder answer 5): they read the brief, the candidates and the thread,
    // and may keep notes on an expert — nothing here. Only the owner (or staff)
    // edits the brief or changes what Matchy is allowed to send.
    if (role !== 'admin' && project.ownerEmail !== email) {
      return Response.json(
        { error: 'read_only', message: 'Only the project owner can edit this project.' },
        { status: 403 },
      );
    }

    // ── Matchy project settings ──────────────────────────────────────────────
    const matchySettings = validateMatchySettings(body, project);
    if ('error' in matchySettings) return matchySettings.error;

    // ── Going live needs an activated account ────────────────────────────────
    // THE trial boundary (lib/entitlements.ts). Every send path holds in
    // walkthrough, so a project that cannot leave walkthrough can never reach
    // an expert. A card on file is what lifts this; nothing in the request can.
    if (matchySettings.patch.walkthrough === false && project.walkthrough !== false) {
      const entitlements = await getEntitlementsForProject(params.projectId);
      if (!entitlements.canGoLive) {
        const actorId = await getAuthUserIdByEmail(email).catch(() => null);
        return activationRequired(entitlements, { action: 'go_live', actorId, projectId: params.projectId });
      }
    }

    // ── Brief version check ──────────────────────────────────────────────────
    // The client sends the `briefUpdatedAt` it loaded. If the brief moved since
    // (a colleague saved, or another tab), refuse with the current project so
    // the UI can show their version instead of overwriting it. Only brief
    // fields bump the version — a bookmark or a sourcing run does not, so a
    // user is never told their own brief changed under them for no reason.
    const touchesBrief = Object.keys(body).some(k => BRIEF_FIELDS.has(k) && body[k] !== undefined);
    if (touchesBrief && typeof body.briefVersion === 'number') {
      const current = typeof project.briefUpdatedAt === 'number' ? project.briefUpdatedAt : 0;
      if (current !== body.briefVersion) {
        return Response.json(
          {
            error:   'brief_conflict',
            message: 'This brief changed since you opened it. Review the latest version before saving again.',
            project: redactProjectForViewer(project, { role }),
          },
          { status: 409 },
        );
      }
    }
    const briefVersionPatch = touchesBrief ? { briefUpdatedAt: Date.now() } : {};

    // READ-MODIFY-WRITE OF THE WHOLE PROJECT. `project` here is the RAW row we
    // loaded above (never the redacted copy — redaction happens only on the way
    // out), and projectStore.updateProject rewrites the entire `brief` jsonb
    // from this object. So every key the spread does not overwrite is written
    // back verbatim, and any brief key another writer changed between the load
    // and this line is lost. `briefVersion` only guards the fields in
    // BRIEF_FIELDS; unpromoted keys written by background work (sourcingStatus,
    // sourcingAdjacent, walkthrough) are not versioned and can be clobbered by a
    // concurrent save. Each `...(typeof body.x === 'string' && {...})` below is
    // therefore both the sanitizer AND the allow-list: a key with no clause here
    // cannot be written through this route at all.
    const updated = await updateProject({
      ...project,
      ...matchySettings.patch,
      ...briefVersionPatch,
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
      // An explicit empty string CLEARS the question — the old `|| project.
      // researchQuestion` fallback silently resurrected deleted text on reload.
      ...(typeof body.researchQuestion === 'string' && {
        researchQuestion: sanitizeText(body.researchQuestion, LIMITS.researchQuestion),
      }),
      ...(typeof body.expertType === 'string' && {
        expertType: sanitizeText(body.expertType, LIMITS.functionField) || undefined,
      }),
    });

    if (touchesBrief) {
      void trackProductEvent({
        type:       'brief_saved',
        actorEmail: email,
        projectId:  params.projectId,
        payload:    {
          hasQuestion:   (updated.researchQuestion ?? '').trim().length > 0,
          hasExpertType: (updated.expertType ?? '').trim().length > 0,
        },
      });
    }
    if (matchySettings.patch.walkthrough === false && project.walkthrough !== false) {
      void trackProductEvent({ type: 'went_live', actorEmail: email, projectId: params.projectId });
    }

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
    void trackProductEvent({
      type:       'project_deleted',
      actorEmail: email,
      projectId:  params.projectId,
      payload:    { experts: project.experts.length },
    });
    return Response.json({ ok: true });
  } catch (err) {
    console.error('[api/projects/[id]] DELETE error:', err instanceof Error ? err.message : String(err));
    return Response.json({ error: 'failed_to_delete_project' }, { status: 500 });
  }
}
