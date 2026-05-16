import { NextRequest } from 'next/server';
import { routeAuthGuard, getSessionUser } from '../../../../lib/auth';

export async function GET(request: NextRequest): Promise<Response> {
  const authError = await routeAuthGuard(request);
  if (authError) return authError;
  const { role, email, firmDomain } = await getSessionUser(request);
  return Response.json({ authenticated: true, role, email, firmDomain });
}
