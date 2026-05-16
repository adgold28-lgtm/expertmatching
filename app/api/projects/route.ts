import { NextRequest } from 'next/server';
import { createProject, listProjectsForUser } from '../../../lib/projectStore';
import { guardReadRequest, guardMutatingRequest } from '../../../lib/projectsGuard';
import { validateCreateProjectInput } from '../../../lib/projectValidation';
import { getSessionUser } from '../../../lib/auth';

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
    const { email } = await getSessionUser(request);
    const project = await createProject(data, email);
    return Response.json({ project }, { status: 201 });
  } catch (err) {
    console.error('[api/projects] POST error:', err instanceof Error ? err.message : String(err));
    return Response.json({ error: 'failed_to_create_project' }, { status: 500 });
  }
}
