import { NextRequest } from 'next/server';
import { addExpertsToProject, getProject } from '../../../../../lib/projectStore';
import { guardMutatingRequest } from '../../../../../lib/projectsGuard';
import { validateProjectExpert, MAX_EXPERTS_PER_PROJECT } from '../../../../../lib/projectValidation';
import type { ExpertStatus } from '../../../../../types';

const ID_RE = /^[a-f0-9]{24}$/;

const VALID_STATUSES = new Set<ExpertStatus>([
  'discovered', 'shortlisted', 'rejected', 'contact_found',
  'outreach_drafted', 'contacted', 'replied', 'scheduled', 'completed',
]);

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
    // Check capacity before validating items
    const existing = await getProject(params.projectId);
    if (!existing) return Response.json({ error: 'not_found' }, { status: 404 });

    const incoming = (body.experts as unknown[]).length;
    if (existing.experts.length + incoming > MAX_EXPERTS_PER_PROJECT) {
      return Response.json(
        { error: `project full — max ${MAX_EXPERTS_PER_PROJECT} experts`, field: 'experts' },
        { status: 422 },
      );
    }

    const validated = (body.experts as unknown[])
      .map(raw => {
        if (!raw || typeof raw !== 'object') return null;
        const entry  = raw as Record<string, unknown>;
        const expert = validateProjectExpert(entry.expert);
        if (!expert) return null;
        const rawStatus = entry.status;
        const status: ExpertStatus | undefined =
          typeof rawStatus === 'string' && VALID_STATUSES.has(rawStatus as ExpertStatus)
            ? (rawStatus as ExpertStatus)
            : undefined;
        return { expert, status };
      })
      .filter(Boolean) as Array<{ expert: NonNullable<ReturnType<typeof validateProjectExpert>>; status?: ExpertStatus }>;

    if (validated.length === 0) {
      return Response.json({ error: 'no valid experts in payload', field: 'experts' }, { status: 400 });
    }

    const project = await addExpertsToProject(params.projectId, validated as Parameters<typeof addExpertsToProject>[1]);
    return Response.json({ project });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('not found')) return Response.json({ error: 'not_found' }, { status: 404 });
    console.error('[api/projects/[id]/experts] POST error:', msg);
    return Response.json({ error: 'failed_to_add_experts' }, { status: 500 });
  }
}
