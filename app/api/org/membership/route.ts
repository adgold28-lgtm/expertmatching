// GET /api/org/membership — the caller's own organization membership.
//
// Lightweight companion to /api/auth/me for the app shell's Team link. It reads
// organization_members directly, so it is correct even for a session whose
// app_metadata predates the org claims, and it re-syncs that metadata when it
// finds it missing (self-healing, best effort) so orgAdminGuard sees the same
// answer on the next request.

import { NextRequest } from 'next/server';
import { routeAuthGuard, getSessionUser } from '../../../../lib/auth';
import { getUserOrgMembership, syncUserMetadata } from '../../../../lib/firmStore';

export async function GET(request: NextRequest): Promise<Response> {
  const authError = await routeAuthGuard(request);
  if (authError) return authError;

  const user = await getSessionUser(request);

  try {
    const membership = user.email ? await getUserOrgMembership(user.email) : null;

    // Backfill the session claims when they are missing (accounts created
    // before org_id / org_role were mirrored onto app_metadata).
    if (membership && (!user.orgId || !user.orgRole)) {
      await syncUserMetadata(user.email).catch(() => {});
    }

    return Response.json({
      email:     user.email,
      role:      user.role,
      orgId:     membership?.orgId     ?? user.orgId     ?? null,
      orgName:   membership?.orgName   ?? user.firmName  ?? null,
      orgDomain: membership?.orgDomain ?? user.firmDomain ?? null,
      orgRole:   membership?.orgRole   ?? user.orgRole   ?? null,
      canManageTeam:
        user.role === 'admin' ||
        (membership?.orgRole === 'org_admin' && membership.status === 'active'),
    });
  } catch {
    console.error('[org/membership] failed to resolve membership');
    return Response.json({ error: 'load_failed' }, { status: 500 });
  }
}
