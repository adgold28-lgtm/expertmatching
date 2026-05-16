import { NextRequest } from 'next/server';
import { getProjectForUser, addCollaborator, removeCollaborator } from '../../../../../lib/projectStore';
import { guardMutatingRequest } from '../../../../../lib/projectsGuard';
import { getSessionUser } from '../../../../../lib/auth';
import { getUpstashClient } from '../../../../../lib/upstashRedis';
import { isApprovedDomain } from '../../../../../lib/domainWhitelist';

const ID_RE = /^[a-f0-9]{24}$/;

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Check if email belongs to an existing user or an approved domain.
async function isValidCollaborator(email: string): Promise<boolean> {
  const redis = getUpstashClient();
  if (redis) {
    // Prefer checking for existing user account
    const user = await redis.get(`user:${email}`).catch(() => null);
    if (user) return true;
  }
  // Fall back to approved domain check
  const domain = email.split('@')[1];
  if (!domain) return false;
  return isApprovedDomain(domain).catch(() => false);
}

// POST /api/projects/[projectId]/collaborators
// Body: { email: string }
// Only the project owner (or admin) can add collaborators.
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

  const collaboratorEmail = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!collaboratorEmail || !isValidEmail(collaboratorEmail)) {
    return Response.json({ error: 'valid email required' }, { status: 400 });
  }

  try {
    const { email, role } = await getSessionUser(request);

    const project = await getProjectForUser(params.projectId, email, role);
    if (!project) return Response.json({ error: 'not_found' }, { status: 404 });

    if (role !== 'admin' && project.ownerEmail !== email) {
      return Response.json({ error: 'forbidden', message: 'Only the project owner can add collaborators' }, { status: 403 });
    }

    if (collaboratorEmail === project.ownerEmail) {
      return Response.json({ error: 'owner_cannot_be_collaborator' }, { status: 400 });
    }

    const valid = await isValidCollaborator(collaboratorEmail);
    if (!valid) {
      return Response.json(
        { error: 'invalid_collaborator', message: 'That email does not belong to an existing user or approved firm.' },
        { status: 422 },
      );
    }

    const ownerEmail = role === 'admin' ? project.ownerEmail : email;
    const updated = await addCollaborator(params.projectId, ownerEmail, collaboratorEmail);
    return Response.json({ project: updated });
  } catch (err) {
    console.error('[collaborators] POST error:', err instanceof Error ? err.message : String(err));
    return Response.json({ error: 'failed_to_add_collaborator' }, { status: 500 });
  }
}

// DELETE /api/projects/[projectId]/collaborators
// Body: { email: string }
// Only the project owner (or admin) can remove collaborators.
export async function DELETE(
  request: NextRequest,
  { params }: { params: { projectId: string } },
) {
  const guard = await guardMutatingRequest(request);
  if ('error' in guard) return guard.error;
  const { body } = guard;

  if (!ID_RE.test(params.projectId)) {
    return Response.json({ error: 'invalid_project_id' }, { status: 400 });
  }

  const collaboratorEmail = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!collaboratorEmail) {
    return Response.json({ error: 'email required' }, { status: 400 });
  }

  try {
    const { email, role } = await getSessionUser(request);

    const project = await getProjectForUser(params.projectId, email, role);
    if (!project) return Response.json({ error: 'not_found' }, { status: 404 });

    if (role !== 'admin' && project.ownerEmail !== email) {
      return Response.json({ error: 'forbidden', message: 'Only the project owner can remove collaborators' }, { status: 403 });
    }

    const ownerEmail = role === 'admin' ? project.ownerEmail : email;
    const updated = await removeCollaborator(params.projectId, ownerEmail, collaboratorEmail);
    return Response.json({ project: updated });
  } catch (err) {
    console.error('[collaborators] DELETE error:', err instanceof Error ? err.message : String(err));
    return Response.json({ error: 'failed_to_remove_collaborator' }, { status: 500 });
  }
}
