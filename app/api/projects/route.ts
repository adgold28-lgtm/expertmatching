// GET  /api/projects — the project list behind /app
// POST /api/projects — create a project (the "New research" modal)
//
// Identity comes from the session, never from the body: getSessionUser gives
// the email and role, createProject resolves that email to a profile and to the
// one organization it belongs to, and the owner/organization/firmDomain of the
// new project are derived from that. A caller cannot name an owner, an org, or
// a collaborator here — collaborators are added later through
// /api/projects/[id]/collaborators.
//
// WALKTHROUGH IS THE DEFAULT. validateCreateProjectInput only carries the flag
// through when the client sent an explicit boolean; an absent flag stays absent
// and lib/walkthrough.isWalkthrough reads that as walkthrough, so a project that
// has never been switched live can never send an email.
//
// Both responses go through the redaction chokepoint (lib/redactExpert.ts).
// Access scoping lives in projectStore.listProjectsForUser (owner or explicit
// collaborator; admins see everything) — this route adds no filtering of its own.
//
// Never logs: project names, research questions, expert data.

import { NextRequest } from 'next/server';
import { createProject, listProjectsForUser } from '../../../lib/projectStore';
import { guardReadRequest, guardMutatingRequest } from '../../../lib/projectsGuard';
import { validateCreateProjectInput } from '../../../lib/projectValidation';
import { getSessionUser } from '../../../lib/auth';
import { redactProjectForViewer } from '../../../lib/redactExpert';
import { trackProductEvent } from '../../../lib/productEvents';

export async function GET(request: NextRequest) {
  const err = guardReadRequest(request);
  if (err) return err;

  try {
    const { email, role } = await getSessionUser(request);
    const projects = await listProjectsForUser(email, role);
    return Response.json({ projects });
  } catch (err) {
    console.error('[api/projects] GET error:', err instanceof Error ? err.message : String(err));
    return Response.json({ error: 'failed_to_list_projects' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const result = await guardMutatingRequest(request);
  if ('error' in result) return result.error;
  const { body } = result;

  const validated = validateCreateProjectInput(body);
  if ('errors' in validated) {
    return Response.json({ error: validated.errors[0].error, field: validated.errors[0].field }, { status: 400 });
  }
  const { data } = validated;

  try {
    const { email, role } = await getSessionUser(request);
    const project = await createProject(data, email);
    void trackProductEvent({
      type:       'project_created',
      actorEmail: email,
      projectId:  project.id,
      payload:    { walkthrough: project.walkthrough !== false, hasQuestion: (project.researchQuestion ?? '').trim().length > 0 },
    });
    // ProjectSummary (the GET list above) carries no expert identity, but a
    // freshly created project may already hold experts — redact like any other
    // `{ project }` response.
    return Response.json({ project: redactProjectForViewer(project, { role }) }, { status: 201 });
  } catch (err) {
    console.error('[api/projects] POST error:', err instanceof Error ? err.message : String(err));
    return Response.json({ error: 'failed_to_create_project' }, { status: 500 });
  }
}
