// POST | DELETE  /api/projects/[projectId]/collaborators — project sharing.
//
// A collaborator gets READ access to the whole project (brief, candidates,
// conversation) and may keep their own notes on an expert; every acting verb —
// bookmark, send, rate, delete, edit the brief — stays with the owner
// (docs/MATCHY_SPEC.md, founder answer 5). Membership itself is a row in
// project_members, written by lib/projectStore.addCollaborator.
//
// THE SAME-ORGANIZATION RULE IS CHECKED THREE TIMES on purpose, and each layer
// exists for a different reason:
//   1. here, against lib/firmStore.getUser — an active account whose firmDomain
//      matches the project's, so the UI gets a clean 422 with a sentence;
//   2. projectStore.addCollaborator, against organization_members — the real
//      check, because firmDomain is derived and membership is authoritative;
//   3. a database trigger, which is what actually makes cross-org sharing
//      impossible if either application check is ever bypassed.
// Both application layers throw/return CollaboratorNotInOrganizationError-shaped
// 422s, so the client handles one error code.
//
// Responses are redacted like any other `{ project }` body.

import { NextRequest } from 'next/server';
import {
  getProjectForUser,
  addCollaborator,
  removeCollaborator,
  CollaboratorNotInOrganizationError,
} from '../../../../../lib/projectStore';
import { guardMutatingRequest } from '../../../../../lib/projectsGuard';
import { getSessionUser } from '../../../../../lib/auth';
import { getUser, isApprovedDomain } from '../../../../../lib/firmStore';
import { redactProjectForViewer } from '../../../../../lib/redactExpert';

const ID_RE = /^[a-f0-9]{24}$/;

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
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

    // Cross-organization sharing is closed: the collaborator must be an active
    // ExpertMatch user in the project's organization. projectStore repeats this
    // check against organization_members; this one gives a clean 422 early.
    const collaborator = await getUser(collaboratorEmail).catch(() => null);
    const projectOrg   = (project.firmDomain ?? '').toLowerCase();
    const sameOrg =
      !!collaborator &&
      collaborator.status !== 'disabled' &&
      (!projectOrg || projectOrg === '*' ||
        (collaborator.firmDomain ?? '').toLowerCase() === projectOrg);

    if (!sameOrg) {
      return Response.json(
        {
          error:   'collaborator_not_in_organization',
          message: 'Collaborators must be active ExpertMatch users in your organization.',
        },
        { status: 422 },
      );
    }

    const ownerEmail = role === 'admin' ? project.ownerEmail : email;
    const updated = await addCollaborator(params.projectId, ownerEmail, collaboratorEmail);
    return Response.json({ project: redactProjectForViewer(updated, { role }) });
  } catch (err) {
    if (err instanceof CollaboratorNotInOrganizationError) {
      return Response.json({ error: err.code, message: err.message }, { status: 422 });
    }
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
    return Response.json({ project: redactProjectForViewer(updated, { role }) });
  } catch (err) {
    console.error('[collaborators] DELETE error:', err instanceof Error ? err.message : String(err));
    return Response.json({ error: 'failed_to_remove_collaborator' }, { status: 500 });
  }
}
