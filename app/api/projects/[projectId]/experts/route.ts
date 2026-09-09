import { NextRequest } from 'next/server';
import { addExpertsToProject, getProjectForUser } from '../../../../../lib/projectStore';
import { guardMutatingRequest, requireProjectOwner } from '../../../../../lib/projectsGuard';
import { getSessionUser } from '../../../../../lib/auth';
import { validateProjectExpert, MAX_EXPERTS_PER_PROJECT } from '../../../../../lib/projectValidation';
import { EXPERT_STATUSES } from '../../../../../lib/expertPipeline';
import { redactProjectForViewer } from '../../../../../lib/redactExpert';
import type { ExpertStatus } from '../../../../../types';

const ID_RE = /^[a-f0-9]{24}$/;

const VALID_STATUSES = new Set<ExpertStatus>(EXPERT_STATUSES);

/**
 * A client may add a candidate as found or shortlisted — never as anything the
 * engagement has to EARN (contacted, scheduled, completed …). Those statuses
 * are written by the server as Matchy works, and `scheduled`/`completed` are
 * half of the identity-reveal condition (lib/redactExpert.isIdentityRevealed).
 * Staff may seed any status.
 */
const CLIENT_ADDABLE_STATUSES = new Set<ExpertStatus>(['discovered', 'shortlisted']);

export async function POST(
  request: NextRequest,
  { params }: { params: { projectId: string } },
) {
  const guard = await guardMutatingRequest(request);
  if ('error' in guard) return guard.error;
  const { body } = guard;

  if (!ID_RE.test(params.projectId)) {
    return Response.json({ error: 'invalid_project_id' }, { status: 400 });
  }
  if (!Array.isArray(body.experts)) {
    return Response.json({ error: 'experts must be an array', field: 'experts' }, { status: 400 });
  }

  try {
    // Verify the caller can access this project (ownership / collaborator / admin).
    // Returns null for inaccessible or nonexistent projects — 404 either way so we
    // do not leak whether the project exists.
    const { email, role } = await getSessionUser(request);
    const existing = await getProjectForUser(params.projectId, email, role);
    if (!existing) return Response.json({ error: 'not_found' }, { status: 404 });

    // Adding candidates changes what the project is about; a collaborator reads
    // (docs/MATCHY_SPEC.md, founder answer 5). 404 above ran first, so this
    // never confirms a project the caller cannot reach.
    const ownerErr = requireProjectOwner(existing, { email, role });
    if (ownerErr) return ownerErr;

    const incoming = (body.experts as unknown[]).length;
    if (existing.experts.length + incoming > MAX_EXPERTS_PER_PROJECT) {
      return Response.json(
        { error: `project full — max ${MAX_EXPERTS_PER_PROJECT} experts`, field: 'experts' },
        { status: 422 },
      );
    }

    // The Source panel's "adjacent candidates" reach the browser through
    // project.sourcingAdjacent, which is ANONYMIZED for a non-admin. If we
    // stored what comes back we would overwrite raw identity with "Scott S."
    // and a blank title. The stored candidate is authoritative: whenever the
    // posted id matches one, the server's own copy is what gets persisted.
    const storedCandidates = new Map(
      (existing.sourcingAdjacent ?? []).map(candidate => [candidate.id, candidate]),
    );

    const validated = (body.experts as unknown[])
      .map(raw => {
        if (!raw || typeof raw !== 'object') return null;
        const entry  = raw as Record<string, unknown>;
        const posted = validateProjectExpert(entry.expert);
        if (!posted) return null;
        const expert = storedCandidates.get(posted.id) ?? posted;
        const rawStatus = entry.status;
        const allowed = role === 'admin' ? VALID_STATUSES : CLIENT_ADDABLE_STATUSES;
        const status: ExpertStatus | undefined =
          typeof rawStatus === 'string' && allowed.has(rawStatus as ExpertStatus)
            ? (rawStatus as ExpertStatus)
            : undefined;
        return { expert, status };
      })
      .filter(Boolean) as Array<{ expert: NonNullable<ReturnType<typeof validateProjectExpert>>; status?: ExpertStatus }>;

    if (validated.length === 0) {
      return Response.json({ error: 'no valid experts in payload', field: 'experts' }, { status: 400 });
    }

    const project = await addExpertsToProject(params.projectId, validated as Parameters<typeof addExpertsToProject>[1]);
    return Response.json({ project: redactProjectForViewer(project, { role }) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('not found')) return Response.json({ error: 'not_found' }, { status: 404 });
    console.error('[api/projects/[id]/experts] POST error:', msg);
    return Response.json({ error: 'failed_to_add_experts' }, { status: 500 });
  }
}
